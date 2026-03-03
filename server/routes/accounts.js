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

// POST merge accounts: reassign all line_items from source accounts into target, deactivate sources
router.post('/accounts/merge', requireAuth, async (req, res) => {
  try {
    const { sourceAccountNames, targetAccountName, targetAccountNumber } = req.body;
    if (!sourceAccountNames || !targetAccountName) {
      return res.status(400).json({ success: false, error: 'sourceAccountNames and targetAccountName required' });
    }

    // Find source accounts
    const placeholders = sourceAccountNames.map((_, i) => `$${i + 1}`).join(',');
    const sources = await db.query(
      `SELECT id, account_name, account_type, normal_balance FROM chart_of_accounts WHERE account_name IN (${placeholders})`,
      sourceAccountNames
    );

    if (sources.length === 0) {
      return res.status(404).json({ success: false, error: 'No matching source accounts found' });
    }

    // Check if target already exists
    let target = await db.queryOne(
      'SELECT id, account_name FROM chart_of_accounts WHERE account_name = $1',
      [targetAccountName]
    );

    const sourceIds = sources.map(s => s.id);
    const sourceType = sources[0].account_type;
    const sourceNormalBalance = sources[0].normal_balance;

    if (target && sourceIds.includes(target.id)) {
      // Target is one of the sources — just rename it and merge others into it
      await db.query(
        `UPDATE chart_of_accounts SET account_name = $1, account_number = COALESCE($2, account_number), updated_at = NOW() WHERE id = $3`,
        [targetAccountName, targetAccountNumber || null, target.id]
      );
      // Move line items from OTHER source accounts to this one
      const otherSourceIds = sourceIds.filter(id => id !== target.id);
      if (otherSourceIds.length > 0) {
        const idPlaceholders = otherSourceIds.map((_, i) => `$${i + 1}`).join(',');
        const movedItems = await db.query(
          `UPDATE line_items SET account_id = $${otherSourceIds.length + 1} WHERE account_id IN (${idPlaceholders}) RETURNING id`,
          [...otherSourceIds, target.id]
        );
        // Deactivate the merged-away source accounts
        await db.query(
          `UPDATE chart_of_accounts SET is_active = false, updated_at = NOW() WHERE id IN (${idPlaceholders})`,
          otherSourceIds
        );
      }
    } else if (target) {
      // Target exists but is a different account — merge sources into it
      const idPlaceholders = sourceIds.map((_, i) => `$${i + 1}`).join(',');
      await db.query(
        `UPDATE line_items SET account_id = $${sourceIds.length + 1} WHERE account_id IN (${idPlaceholders}) RETURNING id`,
        [...sourceIds, target.id]
      );
      await db.query(
        `UPDATE chart_of_accounts SET is_active = false, updated_at = NOW() WHERE id IN (${idPlaceholders})`,
        sourceIds
      );
    } else {
      // Target doesn't exist — rename the first source, merge the rest into it
      target = sources[0];
      await db.query(
        `UPDATE chart_of_accounts SET account_name = $1, account_number = COALESCE($2, account_number), updated_at = NOW() WHERE id = $3`,
        [targetAccountName, targetAccountNumber || null, target.id]
      );
      const otherSourceIds = sourceIds.filter(id => id !== target.id);
      if (otherSourceIds.length > 0) {
        const idPlaceholders = otherSourceIds.map((_, i) => `$${i + 1}`).join(',');
        await db.query(
          `UPDATE line_items SET account_id = $${otherSourceIds.length + 1} WHERE account_id IN (${idPlaceholders})`,
          [...otherSourceIds, target.id]
        );
        await db.query(
          `UPDATE chart_of_accounts SET is_active = false, updated_at = NOW() WHERE id IN (${idPlaceholders})`,
          otherSourceIds
        );
      }
    }

    // Count line items now on target
    const count = await db.queryOne('SELECT COUNT(*) as count FROM line_items WHERE account_id = $1', [target.id]);

    res.json({
      success: true,
      data: {
        targetAccountId: target.id,
        targetAccountName,
        mergedFrom: sources.map(s => s.account_name),
        totalLineItems: parseInt(count.count)
      }
    });
  } catch (err) {
    console.error('[Accounts] Merge error:', err);
    res.status(500).json({ success: false, error: err.message });
  }
});

module.exports = router;
