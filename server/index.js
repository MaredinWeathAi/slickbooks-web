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
const recurringRoutes = require('./routes/recurring');
const ccImportRoutes = require('./routes/cc-import');
const reconciliationRoutes = require('./routes/reconciliation');

app.use('/api', authRoutes);
app.use('/api', accountsRoutes);
app.use('/api', journalRoutes);
app.use('/api', reportsRoutes);
app.use('/api', dashboardRoutes);
app.use('/api', importRoutes);
app.use('/api', feesRoutes);
app.use('/api', qbImportRoutes);
app.use('/api', recurringRoutes);
app.use('/api', ccImportRoutes);
app.use('/api', reconciliationRoutes);

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
initializeDatabase().then(async () => {
  console.log('[DB] Database ready');

  // ─── One-time migrations ───
  try {
    const db = require('./db');
    await db.query(`CREATE TABLE IF NOT EXISTS migrations (key VARCHAR(200) PRIMARY KEY, ran_at TIMESTAMPTZ DEFAULT NOW())`);

    // Migration v1: Original merge (may have already run)
    const migrationKey = 'merge_revenue_to_management_fees';
    const already = await db.queryOne('SELECT key FROM migrations WHERE key = $1', [migrationKey]);
    if (!already) {
      const sources = await db.query(
        `SELECT id, account_name FROM chart_of_accounts WHERE account_name IN ('Client Fee Account', 'Professional Services') AND is_active = true`
      );
      if (sources.length > 0) {
        const sourceIds = sources.map(s => s.id);
        const targetId = sourceIds[0];
        await db.query(`UPDATE chart_of_accounts SET account_name = 'Management Fees', updated_at = NOW() WHERE id = $1`, [targetId]);
        const otherIds = sourceIds.filter(id => id !== targetId);
        for (const otherId of otherIds) {
          await db.query(`UPDATE line_items SET account_id = $1 WHERE account_id = $2`, [targetId, otherId]);
          await db.query(`UPDATE chart_of_accounts SET is_active = false, updated_at = NOW() WHERE id = $1`, [otherId]);
        }
        console.log(`[Migration] Merged ${sources.map(s => s.account_name).join(' + ')} → Management Fees`);
      }
      await db.query('INSERT INTO migrations (key) VALUES ($1) ON CONFLICT DO NOTHING', [migrationKey]);
    }

    // Migration v2: Force rename if v1 didn't stick (accounts may still be named "Client Fee Account")
    const migV2Key = 'force_rename_management_fees_v2';
    const alreadyV2 = await db.queryOne('SELECT key FROM migrations WHERE key = $1', [migV2Key]);
    if (!alreadyV2) {
      // Rename "Client Fee Account" (ID 1) to "Management Fees"
      await db.query(`UPDATE chart_of_accounts SET account_name = 'Management Fees', updated_at = NOW() WHERE id = 1 AND account_name = 'Client Fee Account'`);
      // Move all line_items from "Professional Services" (ID 12) to "Management Fees" (ID 1) and deactivate
      const profSvc = await db.queryOne(`SELECT id FROM chart_of_accounts WHERE id = 12 AND account_name = 'Professional Services' AND is_active = true`);
      if (profSvc) {
        await db.query(`UPDATE line_items SET account_id = 1 WHERE account_id = 12`);
        await db.query(`UPDATE chart_of_accounts SET is_active = false, updated_at = NOW() WHERE id = 12`);
        console.log('[Migration v2] Moved Professional Services line_items to Management Fees, deactivated ID 12');
      }
      const cfa = await db.queryOne(`SELECT id, account_name FROM chart_of_accounts WHERE id = 1`);
      console.log(`[Migration v2] Account ID 1 is now: ${cfa ? cfa.account_name : 'not found'}`);
      await db.query('INSERT INTO migrations (key) VALUES ($1) ON CONFLICT DO NOTHING', [migV2Key]);
    }

    // Cleanup: Remove temporary diagnostic user
    const cleanupKey = 'cleanup_diag_user';
    const alreadyCleanup = await db.queryOne('SELECT key FROM migrations WHERE key = $1', [cleanupKey]);
    if (!alreadyCleanup) {
      await db.query(`DELETE FROM users WHERE username = 'diagtemp'`);
      console.log('[Migration] Removed temporary diagnostic user');
      await db.query('INSERT INTO migrations (key) VALUES ($1) ON CONFLICT DO NOTHING', [cleanupKey]);
    }

  } catch (migErr) {
    console.error('[Migration] Error:', migErr.message);
  }
}).catch(err => {
  console.error('[DB] Database initialization failed:', err.message);
});

module.exports = app;
