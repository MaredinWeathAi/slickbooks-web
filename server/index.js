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

// Temporary diagnostic endpoint (will be removed after analysis)
app.get('/api/diag/revenue-check', async (req, res) => {
  try {
    const db = require('./db');

    // Get all revenue accounts
    const revenueAccounts = await db.query(`
      SELECT id, account_name, is_active
      FROM chart_of_accounts
      WHERE account_type = 'REVENUE' ORDER BY id
    `);

    // Get revenue journal entries for Jan, Feb, Mar, Apr 2025
    const revenueEntries = await db.query(`
      SELECT je.id, je.entry_date, je.description, je.memo,
             li.account_id, coa.account_name, li.debit_amount, li.credit_amount
      FROM journal_entries je
      JOIN line_items li ON li.journal_entry_id = je.id
      JOIN chart_of_accounts coa ON coa.id = li.account_id
      WHERE coa.account_type = 'REVENUE'
        AND je.entry_date >= '2025-01-01' AND je.entry_date <= '2025-04-30'
        AND je.is_void = false
      ORDER BY je.entry_date, je.id
    `);

    // Get all cash/bank deposit entries (debits to asset accounts)
    const deposits = await db.query(`
      SELECT je.id, je.entry_date, je.description, je.memo,
             li.account_id, coa.account_name, li.debit_amount, li.credit_amount
      FROM journal_entries je
      JOIN line_items li ON li.journal_entry_id = je.id
      JOIN chart_of_accounts coa ON coa.id = li.account_id
      WHERE (coa.account_name ILIKE '%cash%' OR coa.account_name ILIKE '%bank%' OR coa.account_name ILIKE '%checking%')
        AND coa.account_type = 'ASSET'
        AND li.debit_amount > 0
        AND je.entry_date >= '2025-01-01' AND je.entry_date <= '2025-04-30'
        AND je.is_void = false
      ORDER BY je.entry_date, je.id
    `);

    // Get ALL journal entries for these months to find wire/deposit descriptions
    const allEntries = await db.query(`
      SELECT je.id, je.entry_date, je.description, je.memo, je.entry_type, je.source
      FROM journal_entries je
      WHERE je.entry_date >= '2025-01-01' AND je.entry_date <= '2025-04-30'
        AND je.is_void = false
        AND (je.description ILIKE '%wire%' OR je.description ILIKE '%deposit%'
             OR je.description ILIKE '%management%' OR je.description ILIKE '%fee%'
             OR je.description ILIKE '%maredin wealth%' OR je.description ILIKE '%wells fargo%'
             OR je.description ILIKE '%interactive broker%' OR je.description ILIKE '%citibank%')
      ORDER BY je.entry_date, je.id
    `);

    res.json({ revenueAccounts, revenueEntries, deposits, allEntries });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

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

    // Migration: Merge "Client Fee Account" + "Professional Services" → "Management Fees"
    const migrationKey = 'merge_revenue_to_management_fees';
    // Use a simple flag table to track migrations
    await db.query(`CREATE TABLE IF NOT EXISTS migrations (key VARCHAR(200) PRIMARY KEY, ran_at TIMESTAMPTZ DEFAULT NOW())`);
    const already = await db.queryOne('SELECT key FROM migrations WHERE key = $1', [migrationKey]);
    if (!already) {
      // Find source accounts
      const sources = await db.query(
        `SELECT id, account_name FROM chart_of_accounts WHERE account_name IN ('Client Fee Account', 'Professional Services') AND is_active = true`
      );
      if (sources.length > 0) {
        const sourceIds = sources.map(s => s.id);
        // Rename the first source to "Management Fees"
        const targetId = sourceIds[0];
        await db.query(`UPDATE chart_of_accounts SET account_name = 'Management Fees', updated_at = NOW() WHERE id = $1`, [targetId]);

        // Move line_items from other sources to target
        const otherIds = sourceIds.filter(id => id !== targetId);
        if (otherIds.length > 0) {
          for (const otherId of otherIds) {
            await db.query(`UPDATE line_items SET account_id = $1 WHERE account_id = $2`, [targetId, otherId]);
            await db.query(`UPDATE chart_of_accounts SET is_active = false, updated_at = NOW() WHERE id = $1`, [otherId]);
          }
        }
        console.log(`[Migration] Merged ${sources.map(s => s.account_name).join(' + ')} → Management Fees (${sourceIds.length} accounts, target id=${targetId})`);
      } else {
        console.log('[Migration] No "Client Fee Account" or "Professional Services" found to merge');
      }
      await db.query('INSERT INTO migrations (key) VALUES ($1) ON CONFLICT DO NOTHING', [migrationKey]);
    }
  } catch (migErr) {
    console.error('[Migration] Error:', migErr.message);
  }
}).catch(err => {
  console.error('[DB] Database initialization failed:', err.message);
});

module.exports = app;
