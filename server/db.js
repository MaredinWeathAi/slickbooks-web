/**
 * SlickBooks Web - PostgreSQL Database Module
 * Same architecture as Apex CRM db.js
 */

const { Pool } = require('pg');

const isRailway = !!process.env.RAILWAY_ENVIRONMENT;
const isProduction = process.env.NODE_ENV === 'production' || isRailway;

let pool;

if (process.env.DATABASE_URL) {
  pool = new Pool({
    connectionString: process.env.DATABASE_URL,
    ssl: isProduction ? { rejectUnauthorized: false } : false,
    max: 10,
    idleTimeoutMillis: 30000,
    connectionTimeoutMillis: 5000,
  });
} else {
  console.warn('[DB] No DATABASE_URL found — database features will not work');
  pool = null;
}

/**
 * Initialize all database tables
 */
async function initializeDatabase() {
  if (!pool) {
    console.warn('[DB] Skipping database initialization (no pool)');
    return;
  }

  const client = await pool.connect();
  try {
    // Users table
    await client.query(`
      CREATE TABLE IF NOT EXISTS users (
        id SERIAL PRIMARY KEY,
        username VARCHAR(100) UNIQUE NOT NULL,
        password_hash VARCHAR(255) NOT NULL,
        full_name VARCHAR(200),
        role VARCHAR(50) DEFAULT 'user',
        created_at TIMESTAMPTZ DEFAULT NOW()
      )
    `);

    // Chart of Accounts
    await client.query(`
      CREATE TABLE IF NOT EXISTS chart_of_accounts (
        id SERIAL PRIMARY KEY,
        account_number VARCHAR(20),
        account_name VARCHAR(200) NOT NULL,
        account_type VARCHAR(20) NOT NULL CHECK (account_type IN ('ASSET','LIABILITY','EQUITY','REVENUE','EXPENSE')),
        category VARCHAR(100),
        sub_category VARCHAR(100),
        normal_balance VARCHAR(10) DEFAULT 'DEBIT' CHECK (normal_balance IN ('DEBIT','CREDIT')),
        description TEXT,
        is_active BOOLEAN DEFAULT TRUE,
        parent_account_id INTEGER REFERENCES chart_of_accounts(id),
        created_at TIMESTAMPTZ DEFAULT NOW(),
        updated_at TIMESTAMPTZ DEFAULT NOW()
      )
    `);

    // Journal Entries
    await client.query(`
      CREATE TABLE IF NOT EXISTS journal_entries (
        id SERIAL PRIMARY KEY,
        entry_number VARCHAR(20),
        entry_date DATE NOT NULL,
        description TEXT,
        entry_type VARCHAR(50) DEFAULT 'STANDARD',
        source VARCHAR(100),
        memo TEXT,
        is_posted BOOLEAN DEFAULT FALSE,
        is_void BOOLEAN DEFAULT FALSE,
        created_at TIMESTAMPTZ DEFAULT NOW(),
        updated_at TIMESTAMPTZ DEFAULT NOW(),
        posted_at TIMESTAMPTZ,
        voided_at TIMESTAMPTZ
      )
    `);

    // Line Items
    await client.query(`
      CREATE TABLE IF NOT EXISTS line_items (
        id SERIAL PRIMARY KEY,
        journal_entry_id INTEGER NOT NULL REFERENCES journal_entries(id) ON DELETE CASCADE,
        account_id INTEGER NOT NULL REFERENCES chart_of_accounts(id),
        debit_amount NUMERIC(15,2) DEFAULT 0,
        credit_amount NUMERIC(15,2) DEFAULT 0,
        description TEXT,
        created_at TIMESTAMPTZ DEFAULT NOW()
      )
    `);

    // Bank Reconciliations
    await client.query(`
      CREATE TABLE IF NOT EXISTS bank_reconciliations (
        id SERIAL PRIMARY KEY,
        account_id INTEGER REFERENCES chart_of_accounts(id),
        reconciliation_date DATE,
        statement_ending_balance NUMERIC(15,2),
        calculated_balance NUMERIC(15,2),
        difference NUMERIC(15,2),
        status VARCHAR(20) DEFAULT 'in_progress',
        cleared_items JSONB DEFAULT '[]',
        notes TEXT,
        created_at TIMESTAMPTZ DEFAULT NOW(),
        completed_at TIMESTAMPTZ
      )
    `);

    // Bank Statement Imports
    await client.query(`
      CREATE TABLE IF NOT EXISTS bank_imports (
        id SERIAL PRIMARY KEY,
        file_name VARCHAR(255),
        file_type VARCHAR(20),
        bank VARCHAR(100),
        import_date TIMESTAMPTZ DEFAULT NOW(),
        transaction_count INTEGER DEFAULT 0,
        status VARCHAR(20) DEFAULT 'pending',
        metadata JSONB DEFAULT '{}',
        created_at TIMESTAMPTZ DEFAULT NOW()
      )
    `);

    // Fee Imports — tracks parsed advisory fee statements
    await client.query(`
      CREATE TABLE IF NOT EXISTS fee_imports (
        id SERIAL PRIMARY KEY,
        file_name VARCHAR(255),
        source VARCHAR(50),
        report_type VARCHAR(100),
        statement_period VARCHAR(200),
        fee_count INTEGER DEFAULT 0,
        total_amount NUMERIC(15,2) DEFAULT 0,
        fees_data JSONB DEFAULT '[]',
        status VARCHAR(20) DEFAULT 'parsed',
        journal_entry_ids JSONB DEFAULT '[]',
        imported_by INTEGER REFERENCES users(id),
        created_at TIMESTAMPTZ DEFAULT NOW()
      )
    `);

    // Vendors
    await client.query(`
      CREATE TABLE IF NOT EXISTS vendors (
        id SERIAL PRIMARY KEY,
        name VARCHAR(255) NOT NULL,
        full_name VARCHAR(255),
        email VARCHAR(255),
        phone VARCHAR(100),
        address TEXT,
        account_number VARCHAR(100),
        is_active BOOLEAN DEFAULT TRUE,
        created_at TIMESTAMPTZ DEFAULT NOW()
      )
    `);

    // Customers / Clients
    await client.query(`
      CREATE TABLE IF NOT EXISTS customers (
        id SERIAL PRIMARY KEY,
        name VARCHAR(255) NOT NULL,
        full_name VARCHAR(255),
        email VARCHAR(255),
        phone VARCHAR(100),
        billing_address TEXT,
        shipping_address TEXT,
        is_active BOOLEAN DEFAULT TRUE,
        created_at TIMESTAMPTZ DEFAULT NOW()
      )
    `);

    // Activity Feed
    await client.query(`
      CREATE TABLE IF NOT EXISTS activity_feed (
        id SERIAL PRIMARY KEY,
        user_id INTEGER REFERENCES users(id),
        action VARCHAR(100),
        entity_type VARCHAR(50),
        entity_id INTEGER,
        details JSONB DEFAULT '{}',
        created_at TIMESTAMPTZ DEFAULT NOW()
      )
    `);

    // Create indexes for performance
    await client.query(`CREATE INDEX IF NOT EXISTS idx_line_items_je ON line_items(journal_entry_id)`);
    await client.query(`CREATE INDEX IF NOT EXISTS idx_line_items_acct ON line_items(account_id)`);
    await client.query(`CREATE INDEX IF NOT EXISTS idx_je_date ON journal_entries(entry_date)`);
    await client.query(`CREATE INDEX IF NOT EXISTS idx_je_posted ON journal_entries(is_posted)`);
    await client.query(`CREATE INDEX IF NOT EXISTS idx_coa_type ON chart_of_accounts(account_type)`);
    await client.query(`CREATE INDEX IF NOT EXISTS idx_coa_active ON chart_of_accounts(is_active)`);

    console.log('[DB] All tables initialized successfully');
  } catch (err) {
    console.error('[DB] Error initializing tables:', err.message);
  } finally {
    client.release();
  }
}

/**
 * Query helper — returns rows
 */
async function query(text, params) {
  if (!pool) throw new Error('No database connection');
  const result = await pool.query(text, params);
  return result.rows;
}

/**
 * Query helper — returns single row
 */
async function queryOne(text, params) {
  const rows = await query(text, params);
  return rows[0] || null;
}

/**
 * Get the pool for session store
 */
function getPool() {
  return pool;
}

module.exports = { initializeDatabase, query, queryOne, getPool, pool };
