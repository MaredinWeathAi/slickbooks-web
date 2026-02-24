/**
 * SlickBooks Web - Auth Routes
 */
const router = require('express').Router();
const bcrypt = require('bcryptjs');
const db = require('../db');

// Login
router.post('/login', async (req, res) => {
  try {
    const { username, password } = req.body;
    if (!username || !password) return res.status(400).json({ error: 'Username and password required' });

    const user = await db.queryOne('SELECT * FROM users WHERE username = $1', [username]);
    if (!user) return res.status(401).json({ error: 'Invalid credentials' });

    const valid = await bcrypt.compare(password, user.password_hash);
    if (!valid) return res.status(401).json({ error: 'Invalid credentials' });

    req.session.user = { id: user.id, username: user.username, fullName: user.full_name, role: user.role };
    req.session.save((saveErr) => {
      if (saveErr) console.error('[Auth] Session save error:', saveErr.message);
      res.json({ success: true, user: req.session.user });
    });
  } catch (err) {
    console.error('[Auth Login Error]', err.message);
    res.status(500).json({ error: err.message });
  }
});

// Logout
router.post('/logout', (req, res) => {
  req.session.destroy();
  res.json({ success: true });
});

// Current user
router.get('/me', (req, res) => {
  if (req.session && req.session.user) {
    res.json({ authenticated: true, user: req.session.user });
  } else {
    res.json({ authenticated: false });
  }
});

// Register (admin setup)
router.post('/register', async (req, res) => {
  try {
    const { username, password, fullName } = req.body;
    if (!username || !password) return res.status(400).json({ error: 'Username and password required' });

    const existing = await db.queryOne('SELECT id FROM users WHERE username = $1', [username]);
    if (existing) return res.status(409).json({ error: 'Username already exists' });

    const hash = await bcrypt.hash(password, 10);
    const user = await db.queryOne(
      'INSERT INTO users (username, password_hash, full_name, role) VALUES ($1, $2, $3, $4) RETURNING id, username, full_name, role',
      [username, hash, fullName || username, 'admin']
    );

    req.session.user = { id: user.id, username: user.username, fullName: user.full_name, role: user.role };
    req.session.save((saveErr) => {
      if (saveErr) console.error('[Auth] Session save error:', saveErr.message);
      res.json({ success: true, user: req.session.user });
    });
  } catch (err) {
    console.error('[Auth Register Error]', err.message);
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;
