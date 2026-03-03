/**
 * SlickBooks Web - Reconciliation Routes
 * Includes: Dashboard, AI Analysis, Uncategorized Items, Category Rule Learning
 */
const router = require('express').Router();
const { requireAuth } = require('../auth');
const db = require('../db');

// Initialize reconciliation + category_rules tables
async function initializeTables() {
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
    const exists = await db.queryOne('SELECT COUNT(*) as count FROM reconciliation_metadata');
    if (!exists || parseInt(exists.count) === 0) {
      await db.query('INSERT INTO reconciliation_metadata DEFAULT VALUES');
    }

    // Category rules table - stores learned vendor→account mappings
    await db.query(`
      CREATE TABLE IF NOT EXISTS category_rules (
        id SERIAL PRIMARY KEY,
        match_pattern VARCHAR(300) NOT NULL,
        match_type VARCHAR(20) DEFAULT 'contains' CHECK (match_type IN ('contains','exact','starts_with')),
        target_account_id INTEGER REFERENCES chart_of_accounts(id),
        applies_to VARCHAR(20) DEFAULT 'both' CHECK (applies_to IN ('expense','income','both')),
        confidence NUMERIC(3,2) DEFAULT 1.00,
        times_applied INTEGER DEFAULT 0,
        created_from_description TEXT,
        is_active BOOLEAN DEFAULT TRUE,
        created_at TIMESTAMPTZ DEFAULT NOW(),
        updated_at TIMESTAMPTZ DEFAULT NOW()
      )
    `);
    await db.query(`CREATE INDEX IF NOT EXISTS idx_category_rules_pattern ON category_rules(match_pattern)`);
    await db.query(`CREATE INDEX IF NOT EXISTS idx_category_rules_active ON category_rules(is_active)`);
  } catch (err) {
    console.error('[Reconciliation] Table init error:', err.message);
  }
}

// Helper: Find matching category rule for a description
async function findMatchingRule(description) {
  if (!description) return null;
  const descUpper = description.toUpperCase().trim();

  // First try exact matches, then starts_with, then contains (sorted by confidence/times_applied)
  const rules = await db.query(`
    SELECT cr.*, coa.account_name, coa.account_type
    FROM category_rules cr
    JOIN chart_of_accounts coa ON cr.target_account_id = coa.id
    WHERE cr.is_active = true
    ORDER BY cr.match_type = 'exact' DESC, cr.confidence DESC, cr.times_applied DESC
  `);

  for (const rule of rules) {
    const pattern = rule.match_pattern.toUpperCase().trim();
    if (rule.match_type === 'exact' && descUpper === pattern) return rule;
    if (rule.match_type === 'starts_with' && descUpper.startsWith(pattern)) return rule;
    if (rule.match_type === 'contains' && descUpper.includes(pattern)) return rule;
  }
  return null;
}

// ─── GET reconciliation dashboard ───
router.get('/reconciliation/dashboard', requireAuth, async (req, res) => {
  try {
    await initializeTables();
    const metadata = await db.queryOne('SELECT * FROM reconciliation_metadata LIMIT 1');

    const recentBankImports = await db.query(`
      SELECT * FROM bank_imports WHERE metadata->>'import_type' IS DISTINCT FROM 'cc'
      ORDER BY import_date DESC LIMIT 10
    `);
    const recentCCImports = await db.query(`
      SELECT * FROM bank_imports WHERE metadata->>'import_type' = 'cc'
      ORDER BY import_date DESC LIMIT 10
    `);

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
    const glBalance = await db.query(`
      SELECT COALESCE(SUM(li.debit_amount), 0) as total_debits,
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

// ─── GET uncategorized items (expenses + income without proper accounts) ───
router.get('/reconciliation/uncategorized', requireAuth, async (req, res) => {
  try {
    await initializeTables();

    // Find line items where the account name contains "Uncategorized" or is a catch-all
    // Also find items that have no clear expense/income classification
    const uncategorized = await db.query(`
      SELECT
        li.id as line_item_id,
        li.description as line_description,
        li.debit_amount,
        li.credit_amount,
        je.id as journal_entry_id,
        je.entry_date,
        je.description as je_description,
        je.source,
        coa.id as account_id,
        coa.account_name,
        coa.account_type
      FROM line_items li
      JOIN journal_entries je ON li.journal_entry_id = je.id
      JOIN chart_of_accounts coa ON li.account_id = coa.id
      WHERE je.is_void = false
        AND (
          LOWER(coa.account_name) LIKE '%uncategorized%'
          OR LOWER(coa.account_name) LIKE '%unclassified%'
          OR LOWER(coa.account_name) LIKE '%unapplied%'
          OR LOWER(coa.account_name) LIKE '%ask my accountant%'
          OR LOWER(coa.account_name) LIKE '%suspense%'
        )
      ORDER BY je.entry_date DESC, li.id
      LIMIT 500
    `);

    // For each item, check if we have a learned rule that could auto-categorize it
    const itemsWithSuggestions = [];
    for (const item of uncategorized) {
      const desc = item.line_description || item.je_description || '';
      const rule = await findMatchingRule(desc);
      itemsWithSuggestions.push({
        ...item,
        amount: parseFloat(item.debit_amount || 0) - parseFloat(item.credit_amount || 0),
        suggestedAccount: rule ? {
          accountId: rule.target_account_id,
          accountName: rule.account_name,
          ruleId: rule.id,
          confidence: parseFloat(rule.confidence),
          matchPattern: rule.match_pattern
        } : null
      });
    }

    // Get available accounts for the dropdown
    const accounts = await db.query(`
      SELECT id, account_name, account_type, category, sub_category
      FROM chart_of_accounts
      WHERE is_active = true
      ORDER BY account_type, account_name
    `);

    // Get rule stats
    const ruleCount = await db.queryOne('SELECT COUNT(*) as count FROM category_rules WHERE is_active = true');

    res.json({
      success: true,
      data: {
        items: itemsWithSuggestions,
        totalCount: itemsWithSuggestions.length,
        accounts,
        ruleCount: parseInt(ruleCount?.count || 0)
      }
    });
  } catch (err) {
    console.error('[Reconciliation] Uncategorized fetch error:', err);
    res.status(500).json({ success: false, error: err.message });
  }
});

// ─── POST categorize an item and optionally learn the rule ───
router.post('/reconciliation/categorize', requireAuth, async (req, res) => {
  try {
    const { lineItemId, newAccountId, learnRule, matchPattern, matchType } = req.body;

    if (!lineItemId || !newAccountId) {
      return res.status(400).json({ success: false, error: 'lineItemId and newAccountId required' });
    }

    // Get the line item to know its description
    const lineItem = await db.queryOne(`
      SELECT li.*, je.description as je_description
      FROM line_items li
      JOIN journal_entries je ON li.journal_entry_id = je.id
      WHERE li.id = $1
    `, [lineItemId]);

    if (!lineItem) {
      return res.status(404).json({ success: false, error: 'Line item not found' });
    }

    // Update the line item's account
    await db.query('UPDATE line_items SET account_id = $1 WHERE id = $2', [newAccountId, lineItemId]);

    let ruleCreated = null;

    // Learn the rule if requested
    if (learnRule) {
      const desc = lineItem.description || lineItem.je_description || '';
      const pattern = matchPattern || desc.trim();
      const type = matchType || 'contains';

      if (pattern) {
        // Check if a similar rule already exists
        const existingRule = await db.queryOne(`
          SELECT id FROM category_rules
          WHERE UPPER(match_pattern) = UPPER($1) AND target_account_id = $2
        `, [pattern, newAccountId]);

        if (existingRule) {
          // Update existing rule confidence
          await db.query(`
            UPDATE category_rules
            SET times_applied = times_applied + 1, confidence = LEAST(confidence + 0.05, 1.00), updated_at = NOW()
            WHERE id = $1
          `, [existingRule.id]);
          ruleCreated = { id: existingRule.id, updated: true };
        } else {
          // Create new rule
          const newRule = await db.queryOne(`
            INSERT INTO category_rules (match_pattern, match_type, target_account_id, created_from_description, applies_to)
            VALUES ($1, $2, $3, $4, $5)
            RETURNING id
          `, [pattern, type, newAccountId, desc, 'both']);
          ruleCreated = { id: newRule.id, created: true };
        }
      }
    }

    res.json({ success: true, data: { lineItemId, newAccountId, ruleCreated } });
  } catch (err) {
    console.error('[Reconciliation] Categorize error:', err);
    res.status(500).json({ success: false, error: err.message });
  }
});

// ─── POST auto-apply all learned rules to uncategorized items ───
router.post('/reconciliation/auto-categorize', requireAuth, async (req, res) => {
  try {
    await initializeTables();

    // Get all uncategorized line items
    const uncategorized = await db.query(`
      SELECT li.id, li.description as line_desc, je.description as je_desc
      FROM line_items li
      JOIN journal_entries je ON li.journal_entry_id = je.id
      JOIN chart_of_accounts coa ON li.account_id = coa.id
      WHERE je.is_void = false
        AND (
          LOWER(coa.account_name) LIKE '%uncategorized%'
          OR LOWER(coa.account_name) LIKE '%unclassified%'
          OR LOWER(coa.account_name) LIKE '%unapplied%'
          OR LOWER(coa.account_name) LIKE '%ask my accountant%'
          OR LOWER(coa.account_name) LIKE '%suspense%'
        )
    `);

    let applied = 0;
    let skipped = 0;
    const details = [];

    for (const item of uncategorized) {
      const desc = item.line_desc || item.je_desc || '';
      const rule = await findMatchingRule(desc);

      if (rule) {
        await db.query('UPDATE line_items SET account_id = $1 WHERE id = $2', [rule.target_account_id, item.id]);
        await db.query('UPDATE category_rules SET times_applied = times_applied + 1, updated_at = NOW() WHERE id = $1', [rule.id]);
        applied++;
        details.push({
          lineItemId: item.id,
          description: desc.substring(0, 60),
          appliedRule: rule.match_pattern,
          targetAccount: rule.account_name
        });
      } else {
        skipped++;
      }
    }

    res.json({
      success: true,
      data: { totalProcessed: uncategorized.length, applied, skipped, details }
    });
  } catch (err) {
    console.error('[Reconciliation] Auto-categorize error:', err);
    res.status(500).json({ success: false, error: err.message });
  }
});

// ─── GET category rules ───
router.get('/reconciliation/rules', requireAuth, async (req, res) => {
  try {
    await initializeTables();
    const rules = await db.query(`
      SELECT cr.*, coa.account_name, coa.account_type
      FROM category_rules cr
      JOIN chart_of_accounts coa ON cr.target_account_id = coa.id
      WHERE cr.is_active = true
      ORDER BY cr.times_applied DESC, cr.match_pattern
    `);
    res.json({ success: true, data: { rules } });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// ─── DELETE a category rule ───
router.delete('/reconciliation/rules/:id', requireAuth, async (req, res) => {
  try {
    await db.query('UPDATE category_rules SET is_active = false, updated_at = NOW() WHERE id = $1', [req.params.id]);
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// ─── GET reconciliation analysis with findings ───
router.get('/reconciliation/analysis', requireAuth, async (req, res) => {
  try {
    const findings = [];

    // Check for uncategorized items count
    const uncatCount = await db.queryOne(`
      SELECT COUNT(*) as count FROM line_items li
      JOIN journal_entries je ON li.journal_entry_id = je.id
      JOIN chart_of_accounts coa ON li.account_id = coa.id
      WHERE je.is_void = false AND (
        LOWER(coa.account_name) LIKE '%uncategorized%'
        OR LOWER(coa.account_name) LIKE '%unclassified%'
        OR LOWER(coa.account_name) LIKE '%unapplied%'
        OR LOWER(coa.account_name) LIKE '%ask my accountant%'
      )
    `);

    if (parseInt(uncatCount?.count || 0) > 0) {
      findings.push({
        severity: 'HIGH',
        category: 'Uncategorized Items',
        issue: uncatCount.count + ' transactions need to be categorized. Review them below and assign proper accounts.',
        recommendation: 'Use the Uncategorized Items section to classify each item. The system will learn your choices and auto-apply to similar future transactions.',
        itemCount: parseInt(uncatCount.count)
      });
    }

    // Check for CC imports not in GL
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

    // Check for learned rules that could be auto-applied
    const autoApplicable = await db.queryOne(`
      SELECT COUNT(*) as count FROM category_rules WHERE is_active = true AND times_applied > 0
    `);

    if (parseInt(autoApplicable?.count || 0) > 0 && parseInt(uncatCount?.count || 0) > 0) {
      findings.push({
        severity: 'LOW',
        category: 'Auto-Categorization Available',
        issue: 'You have ' + autoApplicable.count + ' learned rules that may match uncategorized items.',
        recommendation: 'Click "Auto-Apply Rules" to automatically categorize matching transactions.',
        itemCount: parseInt(autoApplicable.count)
      });
    }

    res.json({ success: true, data: { findings } });
  } catch (err) {
    console.error('[Reconciliation] Analysis error:', err);
    res.status(500).json({ success: false, error: err.message });
  }
});

// ─── POST update import tracking metadata ───
router.post('/reconciliation/update-import-date', requireAuth, async (req, res) => {
  try {
    const { importType } = req.body;
    await initializeTables();

    if (importType === 'bank') {
      await db.query(`UPDATE reconciliation_metadata SET last_bank_import = NOW(), updated_at = NOW() WHERE id = (SELECT id FROM reconciliation_metadata LIMIT 1)`);
    } else if (importType === 'cc') {
      await db.query(`UPDATE reconciliation_metadata SET last_cc_import = NOW(), updated_at = NOW() WHERE id = (SELECT id FROM reconciliation_metadata LIMIT 1)`);
    }

    const metadata = await db.queryOne('SELECT * FROM reconciliation_metadata LIMIT 1');
    res.json({ success: true, data: metadata });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// ─── POST run reconciliation ───
router.post('/reconciliation/run', requireAuth, async (req, res) => {
  try {
    await initializeTables();
    await db.query(`UPDATE reconciliation_metadata SET last_reconciliation_run = NOW(), updated_at = NOW() WHERE id = (SELECT id FROM reconciliation_metadata LIMIT 1)`);
    const metadata = await db.queryOne('SELECT * FROM reconciliation_metadata LIMIT 1');
    res.json({ success: true, data: { runAt: metadata.last_reconciliation_run } });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

module.exports = router;
