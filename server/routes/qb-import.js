/**
 * SlickBooks Web - QuickBooks Import Routes
 * Handles importing QB Desktop/Online Excel exports
 */
const router = require('express').Router();
const { requireAuth } = require('../auth');
const db = require('../db');
const multer = require('multer');
const { parseTrialBalance, parseJournal, parseVendors, parseCustomers, classifyAccount } = require('../parsers/qb-parser');

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 50 * 1024 * 1024 }
});

/**
 * POST /api/qb/parse — Upload and parse QB Excel files
 * Accepts: Trial_balance.xlsx, Journal.xlsx, Vendors.xlsx, Customers.xlsx
 */
router.post('/qb/parse', requireAuth, upload.array('files', 10), async (req, res) => {
  try {
    if (!req.files || req.files.length === 0) {
      return res.status(400).json({ success: false, error: 'No files uploaded' });
    }

    const result = { accounts: [], entries: [], vendors: [], customers: [], summary: {} };

    for (const file of req.files) {
      const fname = file.originalname.toLowerCase();
      console.log(`[QB Import] Parsing: ${file.originalname} (${(file.size / 1024).toFixed(1)}KB)`);

      try {
        if (fname.includes('trial_balance') || fname.includes('trial balance')) {
          result.accounts = parseTrialBalance(file.buffer);
          result.summary.accountCount = result.accounts.length;
        } else if (fname.includes('journal')) {
          result.entries = parseJournal(file.buffer);
          result.summary.entryCount = result.entries.length;
          result.summary.lineItemCount = result.entries.reduce((s, e) => s + e.lines.length, 0);
          if (result.entries.length > 0) {
            result.summary.dateRange = { from: result.entries[0].date, to: result.entries[result.entries.length - 1].date };
          }
        } else if (fname.includes('vendor')) {
          result.vendors = parseVendors(file.buffer);
          result.summary.vendorCount = result.vendors.length;
        } else if (fname.includes('customer')) {
          result.customers = parseCustomers(file.buffer);
          result.summary.customerCount = result.customers.length;
        } else {
          console.log(`[QB Import] Skipping unrecognized file: ${file.originalname}`);
        }
      } catch (parseErr) {
        console.error(`[QB Import] Error parsing ${file.originalname}:`, parseErr.message);
        result.summary[`error_${fname}`] = parseErr.message;
      }
    }

    res.json({ success: true, data: result });
  } catch (err) {
    console.error('[QB Import] Parse error:', err.message);
    res.status(500).json({ success: false, error: err.message });
  }
});

/**
 * POST /api/qb/import — Execute the full QB import into the database
 * Body: { accounts, entries, vendors, customers }
 */
router.post('/qb/import', requireAuth, async (req, res) => {
  try {
    const { accounts, entries, vendors, customers } = req.body;
    const results = {
      accounts: { created: 0, skipped: 0, errors: [] },
      entries: { created: 0, skipped: 0, errors: [] },
      vendors: { created: 0, skipped: 0 },
      customers: { created: 0, skipped: 0 }
    };

    // ── Step 1: Import Chart of Accounts ────────────────
    const accountMap = {}; // QB account name → DB account id

    if (accounts && accounts.length > 0) {
      for (const acct of accounts) {
        try {
          // Check if account already exists
          const existing = await db.queryOne(
            'SELECT id FROM chart_of_accounts WHERE account_name = $1',
            [acct.accountName]
          );
          if (existing) {
            accountMap[acct.accountName] = existing.id;
            results.accounts.skipped++;
            continue;
          }

          const created = await db.queryOne(
            `INSERT INTO chart_of_accounts (account_number, account_name, account_type, category, sub_category, normal_balance, description, is_active)
             VALUES ($1, $2, $3, $4, $5, $6, $7, TRUE) RETURNING id`,
            [acct.accountNumber, acct.accountName, acct.accountType, acct.category, acct.subCategory || null, acct.normalBalance, `QB Import: ${acct.category}`]
          );
          accountMap[acct.accountName] = created.id;
          results.accounts.created++;
        } catch (acctErr) {
          results.accounts.errors.push(`${acct.accountName}: ${acctErr.message}`);
        }
      }
    }

    // ── Step 2: Import Vendors ──────────────────────────
    if (vendors && vendors.length > 0) {
      for (const v of vendors) {
        try {
          const existing = await db.queryOne('SELECT id FROM vendors WHERE name = $1', [v.name]);
          if (existing) { results.vendors.skipped++; continue; }
          await db.query(
            'INSERT INTO vendors (name, full_name, email, phone, address, account_number) VALUES ($1,$2,$3,$4,$5,$6)',
            [v.name, v.fullName, v.email, v.phone, v.address, v.accountNumber]
          );
          results.vendors.created++;
        } catch (e) { results.vendors.skipped++; }
      }
    }

    // ── Step 3: Import Customers ────────────────────────
    if (customers && customers.length > 0) {
      for (const c of customers) {
        try {
          const existing = await db.queryOne('SELECT id FROM customers WHERE name = $1', [c.name]);
          if (existing) { results.customers.skipped++; continue; }
          await db.query(
            'INSERT INTO customers (name, full_name, email, phone, billing_address, shipping_address) VALUES ($1,$2,$3,$4,$5,$6)',
            [c.name, c.fullName, c.email, c.phone, c.billingAddress, c.shippingAddress]
          );
          results.customers.created++;
        } catch (e) { results.customers.skipped++; }
      }
    }

    // ── Step 4: Import Journal Entries ───────────────────
    if (entries && entries.length > 0) {
      // First, ensure all referenced accounts exist
      const allAcctNames = new Set();
      entries.forEach(e => e.lines.forEach(l => allAcctNames.add(l.account)));

      for (const acctName of allAcctNames) {
        if (!accountMap[acctName]) {
          // Check DB
          const existing = await db.queryOne('SELECT id FROM chart_of_accounts WHERE account_name = $1', [acctName]);
          if (existing) {
            accountMap[acctName] = existing.id;
          } else {
            // Auto-create account
            const classification = classifyAccount(acctName);
            const nextNum = await db.queryOne("SELECT COALESCE(MAX(CAST(account_number AS INTEGER)), 1999) + 10 as next FROM chart_of_accounts WHERE account_number ~ '^[0-9]+$'");
            const num = nextNum ? String(nextNum.next) : '9000';
            const created = await db.queryOne(
              `INSERT INTO chart_of_accounts (account_number, account_name, account_type, category, normal_balance, description, is_active)
               VALUES ($1, $2, $3, $4, $5, $6, TRUE) RETURNING id`,
              [num, acctName, classification.type, classification.category, classification.normal, `Auto-created from QB Journal`]
            );
            accountMap[acctName] = created.id;
            results.accounts.created++;
          }
        }
      }

      // Now import entries in batches
      const BATCH_SIZE = 100;
      for (let batch = 0; batch < entries.length; batch += BATCH_SIZE) {
        const batchEntries = entries.slice(batch, batch + BATCH_SIZE);

        for (const entry of batchEntries) {
          try {
            // Resolve account IDs for all lines
            const resolvedLines = entry.lines.map(l => ({
              ...l,
              accountId: accountMap[l.account]
            }));

            // Skip if any account is unresolved
            if (resolvedLines.some(l => !l.accountId)) {
              results.entries.skipped++;
              const missing = resolvedLines.filter(l => !l.accountId).map(l => l.account);
              results.entries.errors.push(`${entry.entryNumber}: Missing account(s): ${missing.join(', ')}`);
              continue;
            }

            // Create journal entry
            const je = await db.queryOne(
              `INSERT INTO journal_entries (entry_number, entry_date, description, entry_type, source, memo, is_posted, posted_at)
               VALUES ($1, $2, $3, $4, 'quickbooks', $5, true, NOW()) RETURNING id`,
              [entry.entryNumber, entry.date, entry.description, entry.transactionType || 'QB_IMPORT', entry.memo || null]
            );

            // Create line items
            for (const line of resolvedLines) {
              await db.query(
                'INSERT INTO line_items (journal_entry_id, account_id, debit_amount, credit_amount, description) VALUES ($1, $2, $3, $4, $5)',
                [je.id, line.accountId, line.debit || 0, line.credit || 0, line.description || null]
              );
            }

            results.entries.created++;
          } catch (entryErr) {
            results.entries.skipped++;
            if (results.entries.errors.length < 50) {
              results.entries.errors.push(`${entry.entryNumber}: ${entryErr.message}`);
            }
          }
        }

        // Log progress
        const pct = Math.min(100, Math.round((batch + batchEntries.length) / entries.length * 100));
        console.log(`[QB Import] Journal entries: ${pct}% (${Math.min(batch + BATCH_SIZE, entries.length)}/${entries.length})`);
      }
    }

    // Log activity
    await db.query(
      `INSERT INTO activity_feed (user_id, action, entity_type, details) VALUES ($1, 'qb_import', 'system', $2)`,
      [req.session.user.id, JSON.stringify({
        accounts: results.accounts.created,
        entries: results.entries.created,
        vendors: results.vendors.created,
        customers: results.customers.created
      })]
    );

    res.json({ success: true, data: results });
  } catch (err) {
    console.error('[QB Import] Import error:', err.message);
    res.status(500).json({ success: false, error: err.message });
  }
});

/**
 * POST /api/qb/fix-classifications — Re-run account classifier to fix misclassified accounts
 */
router.post('/qb/fix-classifications', requireAuth, async (req, res) => {
  try {
    const accounts = await db.query('SELECT id, account_name, account_type, category, normal_balance FROM chart_of_accounts');
    const fixes = [];

    for (const acct of accounts) {
      const correct = classifyAccount(acct.account_name);
      if (acct.account_type !== correct.type || acct.normal_balance !== correct.normal) {
        await db.query(
          'UPDATE chart_of_accounts SET account_type = $1, category = $2, normal_balance = $3 WHERE id = $4',
          [correct.type, correct.category, correct.normal, acct.id]
        );
        fixes.push({
          account: acct.account_name,
          oldType: acct.account_type,
          newType: correct.type,
          oldNormal: acct.normal_balance,
          newNormal: correct.normal
        });
      }
    }

    res.json({ success: true, data: { fixed: fixes.length, details: fixes } });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

/**
 * GET /api/qb/data-quality — Check data integrity and find gaps
 */
router.get('/qb/data-quality', requireAuth, async (req, res) => {
  try {
    // Date range and gap analysis
    const dateRange = await db.queryOne(`
      SELECT MIN(entry_date) as earliest, MAX(entry_date) as latest, COUNT(*) as total_entries
      FROM journal_entries WHERE is_void = false
    `);

    // Monthly entry counts to find gaps
    const monthlyData = await db.query(`
      SELECT TO_CHAR(entry_date, 'YYYY-MM') as month,
        COUNT(*) as entry_count,
        COALESCE(SUM(li_agg.total_debit), 0) as total_debits
      FROM journal_entries je
      LEFT JOIN (
        SELECT journal_entry_id, SUM(debit_amount) as total_debit
        FROM line_items GROUP BY journal_entry_id
      ) li_agg ON li_agg.journal_entry_id = je.id
      WHERE je.is_void = false
      GROUP BY TO_CHAR(entry_date, 'YYYY-MM')
      ORDER BY month
    `);

    // Find months with no entries (gaps)
    const gaps = [];
    if (monthlyData.length > 1) {
      for (let i = 1; i < monthlyData.length; i++) {
        const prev = new Date(monthlyData[i - 1].month + '-01');
        const curr = new Date(monthlyData[i].month + '-01');
        const diffMonths = (curr.getFullYear() - prev.getFullYear()) * 12 + (curr.getMonth() - prev.getMonth());
        if (diffMonths > 1) {
          for (let m = 1; m < diffMonths; m++) {
            const gapDate = new Date(prev);
            gapDate.setMonth(gapDate.getMonth() + m);
            gaps.push(gapDate.toISOString().substring(0, 7));
          }
        }
      }
    }

    // Entries with missing data
    const missingData = await db.queryOne(`
      SELECT
        COUNT(*) FILTER (WHERE description IS NULL OR description = '') as missing_description,
        COUNT(*) FILTER (WHERE entry_date IS NULL) as missing_date,
        COUNT(*) FILTER (WHERE memo IS NULL OR memo = '') as missing_memo
      FROM journal_entries WHERE is_void = false
    `);

    // Unbalanced entries
    const unbalanced = await db.query(`
      SELECT je.id, je.entry_number, je.entry_date, je.description,
        SUM(li.debit_amount) as total_debits, SUM(li.credit_amount) as total_credits
      FROM journal_entries je
      JOIN line_items li ON li.journal_entry_id = je.id
      WHERE je.is_void = false
      GROUP BY je.id
      HAVING ABS(SUM(li.debit_amount) - SUM(li.credit_amount)) > 0.01
      LIMIT 50
    `);

    // Entries with only 1 line item (should have at least 2 for double-entry)
    const singleLine = await db.queryOne(`
      SELECT COUNT(*) as cnt FROM journal_entries je
      WHERE je.is_void = false AND (SELECT COUNT(*) FROM line_items WHERE journal_entry_id = je.id) < 2
    `);

    // Account classification summary
    const accountSummary = await db.query(`
      SELECT account_type, COUNT(*) as cnt FROM chart_of_accounts GROUP BY account_type ORDER BY account_type
    `);

    // Trial balance check
    const trialBalance = await db.queryOne(`
      SELECT
        COALESCE(SUM(li.debit_amount), 0) as total_debits,
        COALESCE(SUM(li.credit_amount), 0) as total_credits
      FROM line_items li
      JOIN journal_entries je ON li.journal_entry_id = je.id
      WHERE je.is_void = false AND je.is_posted = true
    `);

    res.json({
      success: true,
      data: {
        dateRange: {
          earliest: dateRange.earliest,
          latest: dateRange.latest,
          totalEntries: parseInt(dateRange.total_entries)
        },
        monthlyActivity: monthlyData,
        dateGaps: gaps,
        missingData: {
          missingDescription: parseInt(missingData.missing_description),
          missingDate: parseInt(missingData.missing_date),
          missingMemo: parseInt(missingData.missing_memo)
        },
        unbalancedEntries: unbalanced,
        singleLineEntries: parseInt(singleLine.cnt),
        accountSummary,
        trialBalanceCheck: {
          totalDebits: parseFloat(trialBalance.total_debits),
          totalCredits: parseFloat(trialBalance.total_credits),
          difference: Math.abs(parseFloat(trialBalance.total_debits) - parseFloat(trialBalance.total_credits)),
          balanced: Math.abs(parseFloat(trialBalance.total_debits) - parseFloat(trialBalance.total_credits)) < 0.02
        }
      }
    });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

/**
 * DELETE /api/qb/clear — Clear all imported data (for re-import)
 */
router.delete('/qb/clear', requireAuth, async (req, res) => {
  try {
    await db.query('DELETE FROM line_items');
    await db.query('DELETE FROM journal_entries');
    await db.query('DELETE FROM chart_of_accounts');
    await db.query('DELETE FROM vendors');
    await db.query('DELETE FROM customers');
    await db.query('DELETE FROM fee_imports');
    await db.query('DELETE FROM bank_imports');
    res.json({ success: true, message: 'All data cleared' });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

module.exports = router;
