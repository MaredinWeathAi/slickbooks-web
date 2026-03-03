/**
 * SlickBooks Web - Credit Card Statement Import Routes
 * Handles BofA CC statement imports with account mapping
 */
const router = require('express').Router();
const { requireAuth } = require('../auth');
const db = require('../db');
const multer = require('multer');

// Configure multer for file uploads (in memory)
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 20 * 1024 * 1024 },
  fileFilter: (req, file, cb) => {
    const ext = file.originalname.toLowerCase().split('.').pop();
    if (['csv', 'txt'].includes(ext)) {
      cb(null, true);
    } else {
      cb(new Error('Unsupported file type for CC import'), false);
    }
  }
});

// Suggested account mappings based on keywords
const suggestedMappings = {
  'COMPLY': { category: 'Professional Fees', subCategory: 'Compliance', accountName: 'Professional Fees:Compliance' },
  'MONEYGUIDE': { category: 'Professional Fees', subCategory: 'Financial Planning Software', accountName: 'Professional Fees:Financial Planning Software' },
  'RMTLY': { category: 'Professional Fees', subCategory: 'Contract Services', accountName: 'Professional Fees:Contract Services' },
  'DROPBOX': { category: 'Admin Overhead', subCategory: 'Software Leases', accountName: 'Admin Overhead:Software Leases' },
  'X CORP': { category: 'Marketing', subCategory: 'Advertising', accountName: 'Marketing:Advertising' },
  'TWEETDELETE': { category: 'Marketing', subCategory: 'Advertising', accountName: 'Marketing:Advertising' },
  'YOURWEEKEND': { category: 'Marketing', subCategory: 'Advertising', accountName: 'Marketing:Advertising' },
  'PINECREST': { category: 'Marketing', subCategory: 'Client Hospitality', accountName: 'Marketing:Client Hospitality' },
  'CASH EQUIVALENT': { category: 'Finance', subCategory: 'Bank Charges', accountName: 'Finance:Bank Charges' }
};

// Parse BofA CC CSV format
function parseCCCSV(text) {
  const lines = text.split('\n').filter(l => l.trim());
  if (lines.length < 2) return { success: false, error: 'Empty CSV', transactions: [] };

  const transactions = [];
  const header = lines[0].toLowerCase();

  // Expected BofA CC format: Cardholder Name, Account/Card Number, Posting Date, Trans. Date, Reference ID, Description, Amount, MCC, Merchant Category, Transaction Type, Expense Category
  const hasCCFormat = header.includes('posting date') || header.includes('cardholder') || header.includes('amount');

  if (!hasCCFormat) {
    return { success: false, error: 'CSV does not appear to be Bank of America credit card format', transactions: [] };
  }

  // Parse header to find column indices
  const headers = lines[0].split(',').map(h => h.trim().toLowerCase());
  const indices = {
    cardholderName: headers.findIndex(h => h.includes('cardholder')),
    accountNumber: headers.findIndex(h => h.includes('account')),
    postingDate: headers.findIndex(h => h.includes('posting')),
    transDate: headers.findIndex(h => h.includes('trans.')),
    referenceId: headers.findIndex(h => h.includes('reference')),
    description: headers.findIndex(h => h.includes('description')),
    amount: headers.findIndex(h => h.includes('amount') && !h.includes('mcc')),
    mcc: headers.findIndex(h => h.includes('mcc')),
    merchantCategory: headers.findIndex(h => h.includes('merchant')),
    transactionType: headers.findIndex(h => h.includes('transaction')),
    expenseCategory: headers.findIndex(h => h.includes('expense'))
  };

  for (let i = 1; i < lines.length; i++) {
    const cols = lines[i].split(',').map(c => c.trim().replace(/^"/, '').replace(/"$/, ''));
    if (cols.length < 2) continue;

    const date = indices.postingDate >= 0 ? cols[indices.postingDate] : (indices.transDate >= 0 ? cols[indices.transDate] : '');
    const description = indices.description >= 0 ? cols[indices.description] : '';
    const amountStr = indices.amount >= 0 ? cols[indices.amount] : '0';
    const amount = parseFloat(amountStr.replace(/[^0-9.-]/g, ''));

    if (isNaN(amount) || !date) continue;

    // Suggest account based on merchant keywords
    let suggestedAccount = null;
    for (const [keyword, mapping] of Object.entries(suggestedMappings)) {
      if (description.toUpperCase().includes(keyword)) {
        suggestedAccount = mapping;
        break;
      }
    }

    transactions.push({
      date,
      description,
      amount: Math.abs(amount),
      mcc: indices.mcc >= 0 ? cols[indices.mcc] : '',
      merchantCategory: indices.merchantCategory >= 0 ? cols[indices.merchantCategory] : '',
      transactionType: indices.transactionType >= 0 ? cols[indices.transactionType] : 'debit',
      expenseCategory: indices.expenseCategory >= 0 ? cols[indices.expenseCategory] : '',
      source: 'csv_bofa_cc',
      suggestedMapping: suggestedAccount
    });
  }

  return { success: true, bank: 'Bank of America', cardType: 'Credit Card', transactions };
}

// Upload and parse CC statement
router.post('/cc-import/upload', requireAuth, upload.array('files', 10), async (req, res) => {
  try {
    if (!req.files || req.files.length === 0) {
      return res.status(400).json({ success: false, error: 'No files uploaded' });
    }

    const results = [];
    for (const file of req.files) {
      const ext = file.originalname.toLowerCase().split('.').pop();
      let parseResult;

      if (['csv', 'txt'].includes(ext)) {
        parseResult = parseCCCSV(file.buffer.toString('utf8'));
      } else {
        parseResult = { success: false, error: 'Unsupported file type for CC import', transactions: [] };
      }

      results.push({
        fileName: file.originalname,
        fileType: ext,
        ...parseResult
      });

      // Log import
      if (parseResult.success) {
        await db.query(
          `INSERT INTO bank_imports (file_name, file_type, bank, transaction_count, status, metadata)
           VALUES ($1, $2, $3, $4, $5, $6)`,
          [
            file.originalname,
            ext,
            parseResult.bank || 'Bank of America',
            parseResult.transactions.length,
            'parsed',
            JSON.stringify({ import_type: 'cc', card_type: 'credit_card' })
          ]
        );
      }
    }

    res.json({ success: true, files: results });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// Get or create CC Payable liability account
async function getOrCreateCCPayableAccount() {
  try {
    let account = await db.queryOne(
      `SELECT * FROM chart_of_accounts WHERE account_name = 'Credit Card Payable'
       AND account_type = 'LIABILITY'`
    );

    if (!account) {
      // Find max account number for liabilities
      const maxAcct = await db.queryOne(
        `SELECT account_number FROM chart_of_accounts WHERE account_type = 'LIABILITY'
         ORDER BY account_number DESC LIMIT 1`
      );

      let nextNumber = '2500';
      if (maxAcct && maxAcct.account_number) {
        const num = parseInt(maxAcct.account_number) + 1;
        nextNumber = num.toString();
      }

      account = await db.queryOne(
        `INSERT INTO chart_of_accounts
         (account_number, account_name, account_type, category, normal_balance, description)
         VALUES ($1, $2, $3, $4, $5, $6) RETURNING *`,
        [nextNumber, 'Credit Card Payable', 'LIABILITY', 'Payables', 'CREDIT', 'Auto-created for CC statement imports']
      );
    }

    return account;
  } catch (err) {
    console.error('[CC Import] Error managing CC Payable account:', err);
    throw err;
  }
}

// Import CC transactions to ledger
router.post('/cc-import/to-ledger', requireAuth, async (req, res) => {
  try {
    const { transactions, mappings } = req.body;
    if (!transactions || !Array.isArray(transactions) || transactions.length === 0) {
      return res.status(400).json({ success: false, error: 'Transactions required' });
    }

    if (!mappings || typeof mappings !== 'object') {
      return res.status(400).json({ success: false, error: 'Account mappings required' });
    }

    // Get or create CC Payable account
    const ccPayable = await getOrCreateCCPayableAccount();

    const results = { created: 0, skipped: 0, errors: [] };

    for (const txn of transactions) {
      try {
        const accountId = mappings[txn.description];
        if (!accountId) {
          results.skipped++;
          results.errors.push(`Skipped "${txn.description}" - no account mapping provided`);
          continue;
        }

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
           VALUES ($1, $2, $3, 'IMPORT', 'cc_statement', $4, true, NOW()) RETURNING id`,
          [entryNumber, txn.date, txn.description, `CC import: ${txn.description}`]
        );

        // Create journal entry: DR expense account, CR CC Payable
        await db.query(
          'INSERT INTO line_items (journal_entry_id, account_id, debit_amount, credit_amount, description) VALUES ($1, $2, $3, 0, $4)',
          [entry.id, accountId, txn.amount, `CC charge: ${txn.description}`]
        );

        await db.query(
          'INSERT INTO line_items (journal_entry_id, account_id, debit_amount, credit_amount, description) VALUES ($1, $2, 0, $3, $4)',
          [entry.id, ccPayable.id, txn.amount, `CC charge: ${txn.description}`]
        );

        results.created++;
      } catch (txnErr) {
        results.skipped++;
        results.errors.push(`Error processing "${txn.description}": ${txnErr.message}`);
      }
    }

    // Update last CC import timestamp
    try {
      await db.query(`
        UPDATE reconciliation_metadata SET last_cc_import = NOW(), updated_at = NOW()
        WHERE id = (SELECT id FROM reconciliation_metadata LIMIT 1)
      `);
    } catch (e) {
      // Reconciliation table may not exist yet, ignore
    }

    res.json({ success: true, data: results });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

module.exports = router;
