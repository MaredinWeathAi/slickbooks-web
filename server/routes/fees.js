/**
 * SlickBooks Web - Advisory Fee Import Routes
 * Handles parsing and importing fee PDFs from IBKR and Schwab
 */
const router = require('express').Router();
const { requireAuth } = require('../auth');
const db = require('../db');
const multer = require('multer');
const { parseFees } = require('../parsers/fee-parser');

// Configure multer for PDF uploads
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 30 * 1024 * 1024 }, // 30MB
  fileFilter: (req, file, cb) => {
    const ext = file.originalname.toLowerCase().split('.').pop();
    if (ext === 'pdf') {
      cb(null, true);
    } else {
      cb(new Error('Only PDF files are supported for fee imports'), false);
    }
  }
});

/**
 * POST /api/fees/parse — Upload and parse fee PDF(s)
 * Returns parsed fee data for review before importing
 */
router.post('/fees/parse', requireAuth, upload.array('files', 10), async (req, res) => {
  try {
    if (!req.files || req.files.length === 0) {
      return res.status(400).json({ success: false, error: 'No files uploaded' });
    }

    const results = [];
    for (const file of req.files) {
      console.log(`[Fees] Parsing: ${file.originalname} (${(file.size / 1024).toFixed(1)}KB)`);
      const parseResult = await parseFees(file.buffer);

      results.push({
        fileName: file.originalname,
        fileSize: file.size,
        ...parseResult
      });

      // Log the parse in the database
      if (parseResult.success) {
        await db.query(
          `INSERT INTO fee_imports (file_name, source, report_type, statement_period, fee_count, total_amount, fees_data, status, imported_by)
           VALUES ($1, $2, $3, $4, $5, $6, $7, 'parsed', $8)`,
          [
            file.originalname,
            parseResult.source,
            parseResult.reportType,
            parseResult.statementPeriod || parseResult.reportDate || '',
            parseResult.fees.length,
            parseResult.totalFees,
            JSON.stringify(parseResult.fees),
            req.session.user.id
          ]
        );
      }
    }

    res.json({ success: true, files: results });
  } catch (err) {
    console.error('[Fees] Parse error:', err.message);
    res.status(500).json({ success: false, error: err.message });
  }
});

/**
 * POST /api/fees/import — Import parsed fees as journal entries
 * Creates journal entries: DR Advisory Fee Revenue, CR Client Account (Accounts Receivable)
 *
 * Body: { fees: [...], revenueAccountId, receivableAccountId, feeImportId? }
 */
router.post('/fees/import', requireAuth, async (req, res) => {
  try {
    const { fees, revenueAccountId, receivableAccountId, feeImportId } = req.body;

    if (!fees || !Array.isArray(fees) || fees.length === 0) {
      return res.status(400).json({ success: false, error: 'No fees to import' });
    }
    if (!revenueAccountId) {
      return res.status(400).json({ success: false, error: 'Revenue account is required' });
    }

    const results = { created: 0, skipped: 0, errors: [], journalEntryIds: [] };

    for (const fee of fees) {
      try {
        if (!fee.amount || fee.amount <= 0) {
          results.skipped++;
          continue;
        }

        // Generate next entry number
        const last = await db.queryOne('SELECT entry_number FROM journal_entries ORDER BY id DESC LIMIT 1');
        let nextNum = 1;
        if (last && last.entry_number) {
          const m = last.entry_number.match(/(\d+)/);
          if (m) nextNum = parseInt(m[1]) + 1;
        }
        const entryNumber = `JE-${String(nextNum).padStart(5, '0')}`;

        // Determine fee date
        const feeDate = fee.date || new Date().toISOString().split('T')[0];

        // Build description
        const desc = `Advisory Fee — ${fee.accountAlias || fee.clientName} (${fee.source})`;
        const memo = `${fee.description} | Client: ${fee.clientName} | Account: ${fee.accountAlias || fee.accountNumber || 'N/A'} | Source: ${fee.source}`;

        // Create journal entry
        const entry = await db.queryOne(
          `INSERT INTO journal_entries (entry_number, entry_date, description, entry_type, source, memo, is_posted, posted_at)
           VALUES ($1, $2, $3, 'FEE_IMPORT', $4, $5, true, NOW()) RETURNING id`,
          [entryNumber, feeDate, desc, `fee_import_${fee.source.toLowerCase()}`, memo]
        );

        // Line items:
        // DR: Revenue (Advisory Fee Income) — this is a CREDIT-normal account, so a CREDIT increases it
        // Actually for fee REVENUE recognition:
        //   DR Accounts Receivable (or Cash if already collected)  →  fee amount
        //   CR Advisory Fee Revenue                                 →  fee amount
        //
        // Since IBKR/Schwab deducted fees from client accounts (already collected):
        //   DR Cash/Custodian Account   →  fee amount
        //   CR Advisory Fee Revenue     →  fee amount

        const targetAccountId = receivableAccountId || revenueAccountId;

        // Debit: Cash/Receivable (ASSET — debit increases it)
        await db.query(
          'INSERT INTO line_items (journal_entry_id, account_id, debit_amount, credit_amount, description) VALUES ($1, $2, $3, 0, $4)',
          [entry.id, targetAccountId, fee.amount, `Fee collected: ${fee.accountAlias || fee.clientName}`]
        );

        // Credit: Advisory Fee Revenue (REVENUE — credit increases it)
        await db.query(
          'INSERT INTO line_items (journal_entry_id, account_id, debit_amount, credit_amount, description) VALUES ($1, $2, 0, $3, $4)',
          [entry.id, revenueAccountId, fee.amount, `Advisory fee: ${fee.accountAlias || fee.clientName}`]
        );

        results.created++;
        results.journalEntryIds.push(entry.id);
      } catch (feeErr) {
        results.skipped++;
        results.errors.push(`${fee.clientName}: ${feeErr.message}`);
      }
    }

    // Update fee_import record if provided
    if (feeImportId) {
      await db.query(
        `UPDATE fee_imports SET status = 'imported', journal_entry_ids = $1 WHERE id = $2`,
        [JSON.stringify(results.journalEntryIds), feeImportId]
      );
    }

    // Log activity
    await db.query(
      `INSERT INTO activity_feed (user_id, action, entity_type, details)
       VALUES ($1, 'fee_import', 'journal_entry', $2)`,
      [req.session.user.id, JSON.stringify({
        entriesCreated: results.created,
        totalAmount: fees.reduce((s, f) => s + (f.amount || 0), 0),
        source: fees[0]?.source || 'unknown'
      })]
    );

    res.json({ success: true, data: results });
  } catch (err) {
    console.error('[Fees] Import error:', err.message);
    res.status(500).json({ success: false, error: err.message });
  }
});

/**
 * GET /api/fees/history — Get fee import history
 */
router.get('/fees/history', requireAuth, async (req, res) => {
  try {
    const imports = await db.query(
      `SELECT id, file_name, source, report_type, statement_period, fee_count, total_amount, status, created_at
       FROM fee_imports ORDER BY created_at DESC LIMIT 50`
    );
    res.json({ success: true, data: imports });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

/**
 * GET /api/fees/import/:id — Get specific fee import details
 */
router.get('/fees/import/:id', requireAuth, async (req, res) => {
  try {
    const record = await db.queryOne('SELECT * FROM fee_imports WHERE id = $1', [req.params.id]);
    if (!record) return res.status(404).json({ success: false, error: 'Fee import not found' });
    res.json({ success: true, data: record });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

module.exports = router;
