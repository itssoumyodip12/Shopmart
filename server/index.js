const express = require("express");
const path = require("path");
const bcrypt = require("bcryptjs");
const { initDB, get, all, run } = require("./db");
const { generateToken, authMiddleware } = require("./auth");
const PRODUCTS = require("./products");

const app = express();
const PORT = process.env.PORT || 3000;

app.use(express.json());
app.use(express.static(path.join(__dirname, "..", "public")));

// ─── AUTH ROUTES ──────────────────────────────────────────────

app.post("/api/auth/signup", (req, res) => {
  const { username, name, email, password } = req.body;
  if (!username || !name || !email || !password) {
    return res.status(400).json({ error: "All fields are required" });
  }
  if (password.length < 6) {
    return res.status(400).json({ error: "Password must be at least 6 characters" });
  }
  const existing = get("SELECT id FROM users WHERE username = ?", [username]);
  if (existing) {
    return res.status(409).json({ error: "Username is already taken" });
  }
  const hash = bcrypt.hashSync(password, 10);
  const result = run("INSERT INTO users (username, name, email, password_hash) VALUES (?, ?, ?, ?)", [username, name, email, hash]);
  run("INSERT INTO address (user_id) VALUES (?)", [result.lastID]);
  const token = generateToken({ id: result.lastID, username });
  res.json({ token, user: { username, name, email } });
});

app.post("/api/auth/login", (req, res) => {
  const { username, password } = req.body;
  if (!username || !password) {
    return res.status(400).json({ error: "Username and password are required" });
  }
  const user = get("SELECT * FROM users WHERE username = ?", [username]);
  if (!user || !bcrypt.compareSync(password, user.password_hash)) {
    return res.status(401).json({ error: "Incorrect username or password" });
  }
  const token = generateToken(user);
  res.json({ token, user: { username: user.username, name: user.name, email: user.email } });
});

app.get("/api/auth/me", authMiddleware, (req, res) => {
  const user = get("SELECT username, name, email FROM users WHERE id = ?", [req.user.id]);
  if (!user) return res.status(404).json({ error: "User not found" });
  res.json({ user });
});

// ─── CART ROUTES ──────────────────────────────────────────────

app.get("/api/cart", authMiddleware, (req, res) => {
  const items = all("SELECT product_id, quantity FROM cart WHERE user_id = ?", [req.user.id]);
  res.json({ cart: items });
});

app.post("/api/cart", authMiddleware, (req, res) => {
  const { productId, quantity } = req.body;
  const qty = quantity || 1;
  const existing = get("SELECT id, quantity FROM cart WHERE user_id = ? AND product_id = ?", [req.user.id, productId]);
  if (existing) {
    run("UPDATE cart SET quantity = quantity + ? WHERE id = ?", [qty, existing.id]);
  } else {
    run("INSERT INTO cart (user_id, product_id, quantity) VALUES (?, ?, ?)", [req.user.id, productId, qty]);
  }
  res.json({ ok: true });
});

app.put("/api/cart/:productId", authMiddleware, (req, res) => {
  const { quantity } = req.body;
  const productId = Number(req.params.productId);
  if (quantity <= 0) {
    run("DELETE FROM cart WHERE user_id = ? AND product_id = ?", [req.user.id, productId]);
  } else {
    run("UPDATE cart SET quantity = ? WHERE user_id = ? AND product_id = ?", [quantity, req.user.id, productId]);
  }
  res.json({ ok: true });
});

app.delete("/api/cart/:productId", authMiddleware, (req, res) => {
  run("DELETE FROM cart WHERE user_id = ? AND product_id = ?", [req.user.id, Number(req.params.productId)]);
  res.json({ ok: true });
});

// ─── WISHLIST ROUTES ──────────────────────────────────────────

app.get("/api/wishlist", authMiddleware, (req, res) => {
  const items = all("SELECT product_id FROM wishlist WHERE user_id = ?", [req.user.id]);
  res.json({ wishlist: items.map((i) => i.product_id) });
});

app.post("/api/wishlist/:productId", authMiddleware, (req, res) => {
  const productId = Number(req.params.productId);
  const existing = get("SELECT id FROM wishlist WHERE user_id = ? AND product_id = ?", [req.user.id, productId]);
  if (existing) {
    run("DELETE FROM wishlist WHERE id = ?", [existing.id]);
    res.json({ wishlist: false });
  } else {
    run("INSERT INTO wishlist (user_id, product_id) VALUES (?, ?)", [req.user.id, productId]);
    res.json({ wishlist: true });
  }
});

// ─── ADDRESS ROUTES ───────────────────────────────────────────

app.get("/api/address", authMiddleware, (req, res) => {
  const addr = get("SELECT full_name, street, city, zip, card FROM address WHERE user_id = ?", [req.user.id]);
  res.json({ address: addr || { full_name: "", street: "", city: "", zip: "", card: "" } });
});

app.put("/api/address", authMiddleware, (req, res) => {
  const { full_name, street, city, zip, card } = req.body;
  run("UPDATE address SET full_name = ?, street = ?, city = ?, zip = ?, card = ? WHERE user_id = ?",
    [full_name || "", street || "", city || "", zip || "", card || "", req.user.id]);
  res.json({ ok: true });
});

// ─── ORDER ROUTES ─────────────────────────────────────────────

app.get("/api/orders", authMiddleware, (req, res) => {
  const orders = all("SELECT id, order_id, total, created_at FROM orders WHERE user_id = ? ORDER BY created_at DESC", [req.user.id]);
  const result = orders.map((o) => {
    const items = all("SELECT product_id, name, emoji, price, quantity FROM order_items WHERE order_id = ?", [o.id]);
    return { id: o.order_id, total: o.total, date: o.created_at, items };
  });
  res.json({ orders: result });
});

app.post("/api/orders", authMiddleware, (req, res) => {
  const cartItems = all("SELECT product_id, quantity FROM cart WHERE user_id = ?", [req.user.id]);
  if (cartItems.length === 0) {
    return res.status(400).json({ error: "Cart is empty" });
  }

  let subtotal = 0;
  const orderItems = [];
  for (const ci of cartItems) {
    const product = PRODUCTS.find((p) => p.id === ci.product_id);
    if (!product) continue;
    const lineTotal = product.price * ci.quantity;
    subtotal += lineTotal;
    orderItems.push({ product_id: product.id, name: product.name, emoji: product.emoji, price: product.price, quantity: ci.quantity });
  }

  const shipping = subtotal > 35 ? 0 : 4.99;
  const tax = subtotal * 0.0725;
  const total = Math.round((subtotal + shipping + tax) * 100) / 100;

  const orderId = "SM-" + Math.floor(100000 + Math.random() * 900000);

  const orderResult = run("INSERT INTO orders (user_id, order_id, total) VALUES (?, ?, ?)", [req.user.id, orderId, total]);
  const oid = orderResult.lastID;
  for (const item of orderItems) {
    run("INSERT INTO order_items (order_id, product_id, name, emoji, price, quantity) VALUES (?, ?, ?, ?, ?, ?)",
      [oid, item.product_id, item.name, item.emoji, item.price, item.quantity]);
  }
  run("DELETE FROM cart WHERE user_id = ?", [req.user.id]);

  res.json({ order: { id: orderId, total, items: orderItems } });
});

// ─── PRODUCTS (static data served via API) ────────────────────

app.get("/api/products", (req, res) => {
  res.json({ products: PRODUCTS });
});

// ─── SPA FALLBACK ─────────────────────────────────────────────

app.get("*", (req, res) => {
  res.sendFile(path.join(__dirname, "..", "public", "index.html"));
});

// ─── START SERVER ─────────────────────────────────────────────

async function start() {
  await initDB();
  console.log("Database initialized.");
  app.listen(PORT, () => {
    console.log(`ShopMart server running at http://localhost:${PORT}`);
  });
}

start().catch((err) => {
  console.error("Failed to start server:", err);
  process.exit(1);
});
