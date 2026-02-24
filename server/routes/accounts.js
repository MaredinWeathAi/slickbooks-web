/**
 * SlickBooks Web - Chart of Accounts Routes
 */
const router = require('express').Router();
const { requireAuth } = require('../auth');
const db = require('../db');

// GET all accounts
router.get('/accounts', requireAuth, async (req, res) => {
  try {
    const { isActive, type } = req.query;
    let sql = 'SELECT * FROM chart_of_accounts WHERE 1=1';
    const params = [];

    if (isActive !== undefined) {
      params.push(isActive === 'true' || isActive === '1');
      sql += ` AND is_active = $${params.length}`;
    }
    if (type) {
      params.push(type);
      sql += ` AND account_type = $${params.length}`;
    }

    sql += ' ORDER BY account_number, account_name';
    const accounts = await db.query(sql, params);
    res.json({ success: true, data: accounts });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// GET single account
router.get('/accounts/:id', requireAuth, async (req, res) => {
  try {
    const acct = await db.queryOne('SELECT * FROM chart_of_accounts WHERE id = $1', [req.params.id]);
    if (!acct) return res.status(404).json({ success: false, error: 'Account not found' });
    res.json({ success: true, data: acct });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// POST create account
router.post('/accounts', requireAuth, async (req, res) => {
  try {
    const { account_number, account_name, account_type, category, sub_category, normal_balance, description } = req.body;
    if (!account_name || !account_type) return res.status(400).json({ success: false, error: 'Name and type required' });

    const normalBal = normal_balance || (['ASSET', 'EXPENSE'].includes(account_type) ? 'DEBIT' : 'CREDIT');

    const acct = await db.queryOne(
      `INSERT INTO chart_of_accounts (account_number, account_name, account_type, category, sub_category, normal_balance, description)
       VALUES ($1, $2, $3, $4, $5, $6, $7) RETURNING *`,
      [account_number, account_name, account_type, category, sub_category, normalBal, description]
    );

    res.json({ success: true, data: acct });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// PUT update account
router.put('/accounts/:id', requireAuth, async (req, res) => {
  try {
    const { account_number, account_name, account_type, category, sub_category, normal_balance, description, is_active } = req.body;

    const acct = await db.queryOne(
      `UPDATE chart_of_accounts SET
        account_number = COALESCE($1, account_number),
        account_name = COALESCE($2, account_name),
        account_type = COALESCE($3, account_type),
        category = COALESCE($4, category),
        sub_category = COALESCE($5, sub_category),
        normal_balance = COALESCE($6, normal_balance),
        description = COALESCE($7, description),
        is_active = COALESCE($8, is_active),
        updated_at = NOW()
       WHERE id = $9 RETURNING *`,
      [account_number, account_name, account_type, category, sub_category, normal_balance, description, is_active, req.params.id]
    );

    if (!acct) return res.status(404).json({ success: false, error: 'Account not found' });
    res.json({ success: true, data: acct });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// GET accounts grouped by type (for dashboard)
router.get('/accounts-by-type', requireAuth, async (req, res) => {
  try {
    const accounts = await db.query(`
      SELECT coa.*,
        COALESCE(SUM(li.debit_amount), 0) as total_debits,
        COALESCE(SUM(li.credit_amount), 0) as total_credits
      FROM chart_of_accounts coa
      LEFT JOIN (
        line_items li
        INNER JOIN journal_entries je ON li.journal_entry_id = je.id AND je.is_posted = true AND je.is_void = false
      ) ON coa.id = li.account_id
      WHERE coa.is_active = true
      GROUP BY coa.id
      ORDER BY coa.account_number
    `);

    const grouped = {};
    for (const acct of accounts) {
      const balance = acct.normal_balance === 'DEBIT'
        ? parseFloat(acct.total_debits) - parseFloat(acct.total_credits)
        : parseFloat(acct.total_credits) - parseFloat(acct.total_debits);

      if (!grouped[acct.account_type]) grouped[acct.account_type] = { accounts: [], total: 0 };
      grouped[acct.account_type].accounts.push({ ...acct, balance: Math.round(balance * 100) / 100 });
      grouped[acct.account_type].total += balance;
    }

    // Round totals
    for (const type of Object.keys(grouped)) {
      grouped[type].total = Math.round(grouped[type].total * 100) / 100;
    }

    res.json({ success: true, data: grouped });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

module.exports = router;
