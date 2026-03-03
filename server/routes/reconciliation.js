/**
 * SlickBooks Web - Reconciliation Routes
 */
const router = require('express').Router();
const { requireAuth } = require('../auth');
const db = require('../db');

// Initialize reconciliation metadata table
async function initializeReconciliationTable() {
  try {
    await db.query(`
      CREATE TABLE IF NOT EXISTS reconciliation_metadata (
        id SERIAL PRIMARY KEY,
        last_bank_import TIMESTAMPTZ,
        last_cc_import TIMESTAMPTZ,
        last_reconciliation_run TIMESTAMPTZ,
        updated_at TIMESTAMPTZ DEFAULT NOW()
      )
    `);

    // Ensure at least one row exists
    const exists = await db.queryOne('SELECT COUNT(*) as count FROM reconciliation_metadata');
    if (!exists || parseInt(exists.count) === 0) {
      await db.query('INSERT INTO reconciliation_metadata DEFAULT VALUES');
    }
  } catch (err) {
    console.error('[Reconciliation] Error initializing metadata table:', err.message);
  }
}

// GET reconciliation dashboard
router.get('/reconciliation/dashboard', requireAuth, async (req, res) => {
  try {
    await initializeReconciliationTable();

    // Get metadata
    const metadata = await db.queryOne('SELECT * FROM reconciliation_metadata LIMIT 1');

    // Get recent bank imports
    const recentBankImports = await db.query(`
      SELECT * FROM bank_imports WHERE metadata->>'import_type' IS DISTINCT FROM 'cc'
      ORDER BY import_date DESC LIMIT 10
    `);

    // Get recent CC imports
    const recentCCImports = await db.query(`
      SELECT * FROM bank_imports WHERE metadata->>'import_type' = 'cc'
      ORDER BY import_date DESC LIMIT 10
    `);

    // Count GL entries vs bank transactions
    const glEntryCount = await db.queryOne(`
      SELECT COUNT(DISTINCT je.id) as count FROM journal_entries je
      WHERE je.is_posted = true AND je.is_void = false
    `);

    const bankTxnCount = await db.queryOne(`
      SELECT COALESCE(SUM(transaction_count), 0) as total FROM bank_imports
      WHERE metadata->>'import_type' IS DISTINCT FROM 'cc'
    `);

    const ccTxnCount = await db.queryOne(`
      SELECT COALESCE(SUM(transaction_count), 0) as total FROM bank_imports
      WHERE metadata->>'import_type' = 'cc'
    `);

    // Get all journal entries for GL balance
    const glBalance = await db.query(`
      SELECT
        COALESCE(SUM(li.debit_amount), 0) as total_debits,
        COALESCE(SUM(li.credit_amount), 0) as total_credits
      FROM line_items li
      INNER JOIN journal_entries je ON li.journal_entry_id = je.id
      WHERE je.is_posted = true AND je.is_void = false
    `);

    res.json({
      success: true,
      data: {
        metadata: metadata ? {
          lastBankImport: metadata.last_bank_import,
          lastCCImport: metadata.last_cc_import,
          lastReconciliationRun: metadata.last_reconciliation_run
        } : null,
        summary: {
          glEntryCount: parseInt(glEntryCount?.count || 0),
          bankTransactionCount: parseInt(bankTxnCount?.total || 0),
          ccTransactionCount: parseInt(ccTxnCount?.total || 0),
          glDebits: parseFloat(glBalance[0]?.total_debits || 0),
          glCredits: parseFloat(glBalance[0]?.total_credits || 0)
        },
        recentBankImports: recentBankImports || [],
        recentCCImports: recentCCImports || []
      }
    });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// GET reconciliation analysis with findings
router.get('/reconciliation/analysis', requireAuth, async (req, res) => {
  try {
    const findings = [];

    // Get all expenses posted to GL
    const expenseAccounts = await db.query(`
      SELECT coa.id, coa.account_name, coa.category, coa.sub_category,
        COALESCE(SUM(li.debit_amount), 0) as balance
      FROM chart_of_accounts coa
      LEFT JOIN line_items li ON coa.id = li.account_id
      LEFT JOIN journal_entries je ON li.journal_entry_id = je.id
        AND je.is_posted = true AND je.is_void = false
      WHERE coa.account_type = 'EXPENSE'
      GROUP BY coa.id
      ORDER BY coa.account_name
    `);

    // Check for large missing GL entries (AI-like analysis)
    const largeImportedItems = await db.query(`
      SELECT COUNT(*) as count FROM bank_imports
      WHERE metadata->>'import_type' = 'cc' AND transaction_count > 5
      AND import_date > NOW() - INTERVAL '30 days'
    `);

    if (parseInt(largeImportedItems[0]?.count || 0) > 0) {
      findings.push({
        severity: 'HIGH',
        category: 'Missing GL Entries',
        issue: 'Recent CC statement imports may not be fully recorded in GL',
        recommendation: 'Review recent CC transactions and ensure all expenses are journalized',
        itemCount: parseInt(largeImportedItems[0]?.count || 0)
      });
    }

    // Check for misclassified transactions (generic categorization)
    const uncategorizedExpenses = await db.query(`
      SELECT COUNT(DISTINCT coa.id) as count FROM chart_of_accounts coa
      LEFT JOIN line_items li ON coa.id = li.account_id
      WHERE coa.account_type = 'EXPENSE' AND (coa.category IS NULL OR coa.category = '')
    `);

    if (parseInt(uncategorizedExpenses[0]?.count || 0) > 0) {
      findings.push({
        severity: 'MEDIUM',
        category: 'Misclassified Transactions',
        issue: uncategorizedExpenses[0].count + ' expense accounts are not properly categorized',
        recommendation: 'Update account categories in Chart of Accounts for better reporting',
        itemCount: parseInt(uncategorizedExpenses[0]?.count || 0)
      });
    }

    // Check for unposted entries
    const unpostedCount = await db.queryOne(`
      SELECT COUNT(*) as count FROM journal_entries WHERE is_posted = false AND is_void = false
    `);

    if (parseInt(unpostedCount?.count || 0) > 0) {
      findings.push({
        severity: 'MEDIUM',
        category: 'Unposted Entries',
        issue: unpostedCount.count + ' journal entries are in draft status',
        recommendation: 'Review and post pending journal entries',
        itemCount: parseInt(unpostedCount?.count || 0)
      });
    }

    // Check for balanced entries
    const unbalancedCount = await db.queryOne(`
      SELECT COUNT(DISTINCT je.id) as count FROM journal_entries je
      WHERE je.is_posted = false
      GROUP BY je.id
      HAVING ABS(COALESCE(SUM(CASE WHEN li.debit_amount IS NOT NULL THEN li.debit_amount ELSE 0 END), 0) -
                 COALESCE(SUM(CASE WHEN li.credit_amount IS NOT NULL THEN li.credit_amount ELSE 0 END), 0)) > 0.01
    `);

    if (unbalancedCount && parseInt(unbalancedCount.count) > 0) {
      findings.push({
        severity: 'CRITICAL',
        category: 'Unbalanced Entries',
        issue: 'Some entries have debits that do not equal credits',
        recommendation: 'Fix balancing issues before posting',
        itemCount: parseInt(unbalancedCount.count)
      });
    }

    res.json({ success: true, data: { findings } });
  } catch (err) {
    console.error('[Reconciliation] Analysis error:', err);
    res.status(500).json({ success: false, error: err.message });
  }
});

// POST update import tracking metadata
router.post('/reconciliation/update-import-date', requireAuth, async (req, res) => {
  try {
    const { importType } = req.body; // 'bank' or 'cc'

    await initializeReconciliationTable();

    if (importType === 'bank') {
      await db.query(`
        UPDATE reconciliation_metadata SET last_bank_import = NOW(), updated_at = NOW()
        WHERE id = (SELECT id FROM reconciliation_metadata LIMIT 1)
      `);
    } else if (importType === 'cc') {
      await db.query(`
        UPDATE reconciliation_metadata SET last_cc_import = NOW(), updated_at = NOW()
        WHERE id = (SELECT id FROM reconciliation_metadata LIMIT 1)
      `);
    }

    const metadata = await db.queryOne('SELECT * FROM reconciliation_metadata LIMIT 1');
    res.json({ success: true, data: metadata });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// POST run reconciliation
router.post('/reconciliation/run', requireAuth, async (req, res) => {
  try {
    await initializeReconciliationTable();

    await db.query(`
      UPDATE reconciliation_metadata SET last_reconciliation_run = NOW(), updated_at = NOW()
      WHERE id = (SELECT id FROM reconciliation_metadata LIMIT 1)
    `);

    const metadata = await db.queryOne('SELECT * FROM reconciliation_metadata LIMIT 1');
    res.json({ success: true, data: { runAt: metadata.last_reconciliation_run } });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

module.exports = router;
