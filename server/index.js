/**
 * SlickBooks Web - Express Server
 * Architecture mirrors Apex CRM exactly
 */

require('dotenv').config();

const express = require('express');
const session = require('express-session');
const compression = require('compression');
const cors = require('cors');
const path = require('path');
const { initializeDatabase, getPool } = require('./db');

const app = express();
const PORT = process.env.PORT || 3000;
const isProduction = process.env.NODE_ENV === 'production' || !!process.env.RAILWAY_ENVIRONMENT;

// Trust Railway's reverse proxy
if (isProduction) app.set('trust proxy', 1);

// Middleware
app.use(compression());
app.use(cors({ origin: true, credentials: true }));
app.use(express.json({ limit: '50mb' }));
app.use(express.urlencoded({ extended: true, limit: '50mb' }));

// Session store — PostgreSQL (same as Apex CRM)
const pgSession = require('connect-pg-simple')(session);
const pool = getPool();

const sessionConfig = {
  secret: process.env.SESSION_SECRET || 'slickbooks-dev-secret-change-in-prod',
  resave: false,
  saveUninitialized: false,
  cookie: {
    secure: isProduction,
    httpOnly: true,
    maxAge: 7 * 24 * 60 * 60 * 1000, // 7 days
    sameSite: isProduction ? 'none' : 'lax'
  }
};

if (pool) {
  sessionConfig.store = new pgSession({
    pool: pool,
    tableName: 'session',
    createTableIfMissing: true
  });
}

app.use(session(sessionConfig));

// Health check (Railway needs this BEFORE DB init)
app.get('/api/health', (req, res) => {
  res.json({ status: 'ok', service: 'slickbooks-web', timestamp: new Date().toISOString() });
});


// Static files — serve the SPA
app.use(express.static(path.join(__dirname, '..', 'public'), {
  maxAge: isProduction ? '1h' : 0,
  setHeaders: (res, filePath) => {
    if (filePath.endsWith('.html')) {
      res.setHeader('Cache-Control', 'no-cache, must-revalidate');
    }
    if (filePath.endsWith('sw.js')) {
      res.setHeader('Cache-Control', 'no-store');
    }
  }
}));

// API Routes
const authRoutes = require('./routes/auth');
const accountsRoutes = require('./routes/accounts');
const journalRoutes = require('./routes/journal');
const reportsRoutes = require('./routes/reports');
const dashboardRoutes = require('./routes/dashboard');
const importRoutes = require('./routes/import');
const feesRoutes = require('./routes/fees');
const qbImportRoutes = require('./routes/qb-import');

app.use('/api', authRoutes);
app.use('/api', accountsRoutes);
app.use('/api', journalRoutes);
app.use('/api', reportsRoutes);
app.use('/api', dashboardRoutes);
app.use('/api', importRoutes);
app.use('/api', feesRoutes);
app.use('/api', qbImportRoutes);

// SPA fallback — serve index.html for all non-API routes
app.get('*', (req, res) => {
  if (!req.path.startsWith('/api')) {
    res.sendFile(path.join(__dirname, '..', 'public', 'index.html'));
  }
});

// Error handler
app.use((err, req, res, next) => {
  console.error('[Error]', req.method, req.path, err.message);
  res.status(500).json({ error: err.message || 'Internal server error' });
});

// Start server (health check available immediately)
const server = app.listen(PORT, '0.0.0.0', () => {
  console.log(`SlickBooks Web running on port ${PORT}`);
  console.log(`Environment: ${isProduction ? 'production' : 'development'}`);
});

// Initialize database after server starts (Railway pattern)
initializeDatabase().then(() => {
  console.log('[DB] Database ready');
}).catch(err => {
  console.error('[DB] Database initialization failed:', err.message);
});

module.exports = app;
