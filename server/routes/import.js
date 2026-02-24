/**
 * SlickBooks Web - Bank Statement Import Routes
 */
const router = require('express').Router();
const { requireAuth } = require('../auth');
const db = require('../db');
const multer = require('multer');

// Configure multer for file uploads (in memory)
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 20 * 1024 * 1024 }, // 20MB
  fileFilter: (req, file, cb) => {
    const ext = file.originalname.toLowerCase().split('.').pop();
    if (['pdf', 'csv', 'txt', 'tsv'].includes(ext)) {
      cb(null, true);
    } else {
      cb(new Error('Unsupported file type'), false);
    }
  }
});

// Try to load pdf-parse (optional — not available on all hosts)
let pdfParse = null;
try { pdfParse = require('pdf-parse'); } catch (e) { console.log('[Import] pdf-parse not available — PDF upload disabled'); }

// Parse bank statement PDF
async function parsePDF(buffer) {
  if (!pdfParse) {
    return { success: false, error: 'PDF parsing is not available on this server. Please upload CSV files instead.', transactions: [] };
  }
  try {
    const data = await pdfParse(buffer);
    const text = data.text;

    // Detect bank
    let bank = 'Generic';
    if (text.includes('Bank of America') || text.includes('BANK OF AMERICA')) bank = 'Bank of America';
    else if (text.includes('Interactive Brokers')) bank = 'Interactive Brokers';
    else if (text.includes('JPMorgan Chase') || text.includes('CHASE')) bank = 'Chase';

    // Extract transactions (BoA-focused)
    const transactions = [];
    const lines = text.split('\n');

    // Parse BoA sections
    let currentSection = null;
    const sectionMap = {
      'Deposits and Other Credits': 'deposit',
      'Checks and Substitutes': 'check',
      'Daily Withdrawals and Other Debits': 'withdrawal',
      'Service Charges': 'fee'
    };

    let currentYear = new Date().getFullYear();
    // Try to extract year from statement
    const yearMatch = text.match(/Statement Period[:\s]+\w+\s+\d+[\s,]+(\d{4})/i);
    if (yearMatch) currentYear = parseInt(yearMatch[1]);

    for (const line of lines) {
      // Check for section headers
      for (const [sectionName, type] of Object.entries(sectionMap)) {
        if (line.includes(sectionName)) {
          currentSection = type;
          break;
        }
      }

      if (!currentSection) continue;

      // Look for transaction lines: MM/DD amount description
      const txnMatch = line.match(/^(\d{2}\/\d{2})\s+(.+?)\s+([\d,]+\.\d{2})\s*$/);
      if (txnMatch) {
        const [, dateStr, description, amountStr] = txnMatch;
        const amount = parseFloat(amountStr.replace(/,/g, ''));
        const month = parseInt(dateStr.split('/')[0]);
        const day = parseInt(dateStr.split('/')[1]);
        const date = `${currentYear}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`;

        transactions.push({
          date, description: description.trim(), amount, type: currentSection,
          source: 'pdf_boa'
        });
      }
    }

    return { success: true, bank, transactions, metadata: { pages: data.numpages, year: currentYear } };
  } catch (err) {
    return { success: false, error: err.message, transactions: [] };
  }
}

// Parse CSV
function parseCSV(text) {
  const lines = text.split('\n').filter(l => l.trim());
  if (lines.length < 2) return { success: false, error: 'Empty CSV', transactions: [] };

  const transactions = [];
  const header = lines[0].toLowerCase();

  // Detect BoA CSV format: Date, Description, Amount, Running Balance
  const isBoA = header.includes('date') && header.includes('description') && header.includes('amount');

  for (let i = 1; i < lines.length; i++) {
    const cols = lines[i].split(',').map(c => c.trim().replace(/^"/, '').replace(/"$/, ''));
    if (cols.length < 3) continue;

    if (isBoA) {
      const amount = parseFloat(cols[2]);
      if (isNaN(amount)) continue;
      transactions.push({
        date: cols[0],
        description: cols[1],
        amount: Math.abs(amount),
        type: amount >= 0 ? 'deposit' : 'withdrawal',
        source: 'csv'
      });
    }
  }

  return { success: true, bank: 'CSV Import', transactions };
}

// Upload and parse bank statement
router.post('/import/upload', requireAuth, upload.array('files', 10), async (req, res) => {
  try {
    if (!req.files || req.files.length === 0) {
      return res.status(400).json({ success: false, error: 'No files uploaded' });
    }

    const results = [];
    for (const file of req.files) {
      const ext = file.originalname.toLowerCase().split('.').pop();
      let parseResult;

      if (ext === 'pdf') {
        parseResult = await parsePDF(file.buffer);
      } else {
        parseResult = parseCSV(file.buffer.toString('utf8'));
      }

      results.push({
        fileName: file.originalname,
        fileType: ext,
        ...parseResult
      });

      // Log import
      if (parseResult.success) {
        await db.query(
          'INSERT INTO bank_imports (file_name, file_type, bank, transaction_count, status) VALUES ($1, $2, $3, $4, $5)',
          [file.originalname, ext, parseResult.bank || 'Unknown', parseResult.transactions.length, 'parsed']
        );
      }
    }

    res.json({ success: true, files: results });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// Import transactions to ledger
router.post('/import/to-ledger', requireAuth, async (req, res) => {
  try {
    const { transactions, bankAccountId } = req.body;
    if (!transactions || !bankAccountId) {
      return res.status(400).json({ success: false, error: 'Transactions and bank account required' });
    }

    const results = { created: 0, skipped: 0, errors: [] };

    for (const txn of transactions) {
      try {
        const offsetAcct = txn.accountId || txn.suggestedAccountId;
        if (!offsetAcct) {
          results.skipped++;
          results.errors.push(`Skipped "${txn.description}" - no account assigned`);
          continue;
        }

        const isDeposit = txn.type === 'deposit';

        // Generate entry number
        const last = await db.queryOne('SELECT entry_number FROM journal_entries ORDER BY id DESC LIMIT 1');
        let nextNum = 1;
        if (last && last.entry_number) {
          const m = last.entry_number.match(/(\d+)/);
          if (m) nextNum = parseInt(m[1]) + 1;
        }
        const entryNumber = `JE-${String(nextNum).padStart(5, '0')}`;

        const entry = await db.queryOne(
          `INSERT INTO journal_entries (entry_number, entry_date, description, entry_type, source, memo, is_posted, posted_at)
           VALUES ($1, $2, $3, 'IMPORT', 'bank_statement', $4, true, NOW()) RETURNING id`,
          [entryNumber, txn.date, txn.description, `Bank import: ${txn.type} - ${txn.description}`]
        );

        if (isDeposit) {
          await db.query('INSERT INTO line_items (journal_entry_id, account_id, debit_amount, credit_amount, description) VALUES ($1, $2, $3, 0, $4)', [entry.id, bankAccountId, txn.amount, txn.description]);
          await db.query('INSERT INTO line_items (journal_entry_id, account_id, debit_amount, credit_amount, description) VALUES ($1, $2, 0, $3, $4)', [entry.id, offsetAcct, txn.amount, txn.description]);
        } else {
          await db.query('INSERT INTO line_items (journal_entry_id, account_id, debit_amount, credit_amount, description) VALUES ($1, $2, $3, 0, $4)', [entry.id, offsetAcct, txn.amount, txn.description]);
          await db.query('INSERT INTO line_items (journal_entry_id, account_id, debit_amount, credit_amount, description) VALUES ($1, $2, 0, $3, $4)', [entry.id, bankAccountId, txn.amount, txn.description]);
        }

        results.created++;
      } catch (txnErr) {
        results.skipped++;
        results.errors.push(`Error: ${txnErr.message}`);
      }
    }

    res.json({ success: true, data: results });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// Get import history
router.get('/import/history', requireAuth, async (req, res) => {
  try {
    const imports = await db.query('SELECT * FROM bank_imports ORDER BY created_at DESC LIMIT 50');
    res.json({ success: true, data: imports });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

module.exports = router;
