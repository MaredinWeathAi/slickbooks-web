/**
 * SlickBooks Web - Journal Entry Routes
 * Includes period locking, double-entry validation, and audit trail
 */
const router = require('express').Router();
const { requireAuth } = require('../auth');
const db = require('../db');

// Helper: Check if a date falls within a locked period
async function isDateLocked(date) {
  const lock = await db.queryOne(
    'SELECT id, period_end FROM period_locks WHERE period_end >= $1 ORDER BY period_end LIMIT 1',
    [date]
  );
  return lock ? lock.period_end : null;
}

// Helper: Log audit trail
async function logAudit(action, entityType, entityId, oldData, newData, userId) {
  try {
    await db.query(
      'INSERT INTO audit_log (action, entity_type, entity_id, old_data, new_data, user_id) VALUES ($1, $2, $3, $4, $5, $6)',
      [action, entityType, entityId, oldData ? JSON.stringify(oldData) : null, newData ? JSON.stringify(newData) : null, userId || null]
    );
  } catch (e) {
    console.error('[Audit] Failed to log:', e.message);
  }
}

// GET journal entries (paginated)
router.get('/journal-entries', requireAuth, async (req, res) => {
  try {
    const { limit = 50, offset = 0, isPosted, startDate, endDate, search } = req.query;

    // Build WHERE clause separately so we can reuse for count query
    let whereClauses = ['1=1'];
    const params = [];

    if (isPosted !== undefined) {
      params.push(isPosted === 'true');
      whereClauses.push(`je.is_posted = $${params.length}`);
    }
    if (startDate) {
      params.push(startDate);
      whereClauses.push(`je.entry_date >= $${params.length}`);
    }
    if (endDate) {
      params.push(endDate);
      whereClauses.push(`je.entry_date <= $${params.length}`);
    }
    if (search) {
      // Map common keywords to account types for JE filter too
      const typeMap = {
        'expense': 'EXPENSE', 'expenses': 'EXPENSE',
        'revenue': 'REVENUE', 'revenues': 'REVENUE', 'income': 'REVENUE',
        'asset': 'ASSET', 'assets': 'ASSET',
        'liability': 'LIABILITY', 'liabilities': 'LIABILITY',
        'equity': 'EQUITY'
      };
      const mappedType = typeMap[search.toLowerCase().trim()];
      if (mappedType) {
        params.push(mappedType);
        whereClauses.push(`EXISTS (SELECT 1 FROM line_items li2 JOIN chart_of_accounts coa ON li2.account_id = coa.id WHERE li2.journal_entry_id = je.id AND coa.account_type = $${params.length})`);
      } else {
        params.push(`%${search}%`);
        whereClauses.push(`(je.description ILIKE $${params.length} OR je.memo ILIKE $${params.length} OR je.entry_number ILIKE $${params.length})`);
      }
    }

    const whereStr = whereClauses.join(' AND ');

    // Count total (simple query, no JOIN needed)
    const countSql = `SELECT COUNT(*) as total FROM journal_entries je WHERE ${whereStr}`;
    const countResult = await db.queryOne(countSql, params);
    const total = countResult ? parseInt(countResult.total) : 0;

    // Main query with line item aggregates
    const limitVal = parseInt(limit);
    const offsetVal = parseInt(offset);
    params.push(limitVal);
    const limitParam = params.length;
    params.push(offsetVal);
    const offsetParam = params.length;

    const sql = `SELECT je.*,
      COALESCE(SUM(li.debit_amount), 0) as total_amount,
      COUNT(li.id) as line_count,
      (SELECT coa.account_type FROM line_items li2
       JOIN chart_of_accounts coa ON li2.account_id = coa.id
       WHERE li2.journal_entry_id = je.id
       AND coa.account_type IN ('REVENUE','EXPENSE','EQUITY')
       ORDER BY GREATEST(li2.debit_amount, li2.credit_amount) DESC
       LIMIT 1) as primary_type
      FROM journal_entries je
      LEFT JOIN line_items li ON li.journal_entry_id = je.id
      WHERE ${whereStr}
      GROUP BY je.id
      ORDER BY je.entry_date DESC, je.id DESC
      LIMIT $${limitParam} OFFSET $${offsetParam}`;

    const entries = await db.query(sql, params);

    res.json({ success: true, data: { entries, total, limit: limitVal, offset: offsetVal } });
  } catch (err) {
    console.error('[Journal] Error loading entries:', err.message);
    res.status(500).json({ success: false, error: err.message });
  }
});

// GET single journal entry with line items
router.get('/journal-entries/:id', requireAuth, async (req, res) => {
  try {
    const entry = await db.queryOne('SELECT * FROM journal_entries WHERE id = $1', [req.params.id]);
    if (!entry) return res.status(404).json({ success: false, error: 'Entry not found' });

    const lines = await db.query(`
      SELECT li.*, coa.account_name, coa.account_number, coa.account_type
      FROM line_items li
      JOIN chart_of_accounts coa ON li.account_id = coa.id
      WHERE li.journal_entry_id = $1
      ORDER BY li.id
    `, [req.params.id]);

    res.json({ success: true, data: { ...entry, line_items: lines } });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// POST create journal entry
router.post('/journal-entries', requireAuth, async (req, res) => {
  try {
    const { entry_date, description, entry_type, source, memo, is_posted, line_items } = req.body;

    if (!entry_date || !line_items || line_items.length < 1) {
      return res.status(400).json({ success: false, error: 'Date and at least 1 line item required' });
    }

    // Period lock check
    const lockedUntil = await isDateLocked(entry_date);
    if (lockedUntil) {
      return res.status(403).json({ success: false, error: `Period is locked through ${lockedUntil}. Cannot create entries in a closed period.` });
    }

    // Double-entry validation: debits must equal credits
    const totalDebits = line_items.reduce((s, li) => s + (parseFloat(li.debit_amount) || 0), 0);
    const totalCredits = line_items.reduce((s, li) => s + (parseFloat(li.credit_amount) || 0), 0);
    if (Math.abs(totalDebits - totalCredits) > 0.01) {
      return res.status(400).json({ success: false, error: `Entry not balanced: debits $${totalDebits.toFixed(2)} != credits $${totalCredits.toFixed(2)}` });
    }

    // Generate entry number
    const lastEntry = await db.queryOne('SELECT entry_number FROM journal_entries ORDER BY id DESC LIMIT 1');
    let nextNum = 1;
    if (lastEntry && lastEntry.entry_number) {
      const match = lastEntry.entry_number.match(/(\d+)/);
      if (match) nextNum = parseInt(match[1]) + 1;
    }
    const entryNumber = `JE-${String(nextNum).padStart(5, '0')}`;

    const entry = await db.queryOne(
      `INSERT INTO journal_entries (entry_number, entry_date, description, entry_type, source, memo, is_posted, posted_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8) RETURNING *`,
      [entryNumber, entry_date, description, entry_type || 'STANDARD', source, memo, is_posted || false, is_posted ? new Date() : null]
    );

    // Insert line items
    for (const li of line_items) {
      await db.query(
        'INSERT INTO line_items (journal_entry_id, account_id, debit_amount, credit_amount, description) VALUES ($1, $2, $3, $4, $5)',
        [entry.id, li.account_id, li.debit_amount || 0, li.credit_amount || 0, li.description]
      );
    }

    // Audit trail
    await logAudit('CREATE', 'journal_entry', entry.id, null, { entry_number: entryNumber, entry_date, description, line_items }, req.session?.userId);

    res.json({ success: true, data: entry });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// PUT update journal entry
router.put('/journal-entries/:id', requireAuth, async (req, res) => {
  try {
    const { entry_date, description, memo, is_posted, line_items } = req.body;

    const existing = await db.queryOne('SELECT * FROM journal_entries WHERE id = $1', [req.params.id]);
    if (!existing) return res.status(404).json({ success: false, error: 'Entry not found' });

    // Period lock check (check both existing and new date)
    const checkDate = entry_date || existing.entry_date;
    const lockedUntil = await isDateLocked(typeof checkDate === 'string' ? checkDate : checkDate.toISOString().split('T')[0]);
    if (lockedUntil) {
      return res.status(403).json({ success: false, error: `Period is locked through ${lockedUntil}. Cannot modify entries in a closed period.` });
    }

    // Double-entry validation if line items are being replaced
    if (line_items && line_items.length > 0) {
      const totalDebits = line_items.reduce((s, li) => s + (parseFloat(li.debit_amount) || 0), 0);
      const totalCredits = line_items.reduce((s, li) => s + (parseFloat(li.credit_amount) || 0), 0);
      if (Math.abs(totalDebits - totalCredits) > 0.01) {
        return res.status(400).json({ success: false, error: `Entry not balanced: debits $${totalDebits.toFixed(2)} != credits $${totalCredits.toFixed(2)}` });
      }
    }

    // Save old state for audit
    const oldLines = await db.query('SELECT * FROM line_items WHERE journal_entry_id = $1', [req.params.id]);

    await db.query(
      `UPDATE journal_entries SET
        entry_date = COALESCE($1, entry_date),
        description = COALESCE($2, description),
        memo = COALESCE($3, memo),
        is_posted = COALESCE($4, is_posted),
        posted_at = CASE WHEN $4 = true AND is_posted = false THEN NOW() ELSE posted_at END,
        updated_at = NOW()
       WHERE id = $5`,
      [entry_date, description, memo, is_posted, req.params.id]
    );

    // Replace line items if provided
    if (line_items && line_items.length > 0) {
      await db.query('DELETE FROM line_items WHERE journal_entry_id = $1', [req.params.id]);
      for (const li of line_items) {
        await db.query(
          'INSERT INTO line_items (journal_entry_id, account_id, debit_amount, credit_amount, description) VALUES ($1, $2, $3, $4, $5)',
          [req.params.id, li.account_id, li.debit_amount || 0, li.credit_amount || 0, li.description]
        );
      }
    }

    const updated = await db.queryOne('SELECT * FROM journal_entries WHERE id = $1', [req.params.id]);
    await logAudit('UPDATE', 'journal_entry', parseInt(req.params.id),
      { ...existing, line_items: oldLines },
      { ...updated, line_items: line_items || oldLines },
      req.session?.userId
    );

    res.json({ success: true, data: updated });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// DELETE (void) journal entry — immutable: voids rather than deletes
router.delete('/journal-entries/:id', requireAuth, async (req, res) => {
  try {
    const existing = await db.queryOne('SELECT * FROM journal_entries WHERE id = $1', [req.params.id]);
    if (!existing) return res.status(404).json({ success: false, error: 'Entry not found' });

    // Period lock check
    const entryDate = typeof existing.entry_date === 'string' ? existing.entry_date : existing.entry_date.toISOString().split('T')[0];
    const lockedUntil = await isDateLocked(entryDate);
    if (lockedUntil) {
      return res.status(403).json({ success: false, error: `Period is locked through ${lockedUntil}. Cannot void entries in a closed period.` });
    }

    await db.query('UPDATE journal_entries SET is_void = true, voided_at = NOW(), updated_at = NOW() WHERE id = $1', [req.params.id]);
    await logAudit('VOID', 'journal_entry', parseInt(req.params.id), existing, null, req.session?.userId);

    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// ─── Period Locks ───
router.get('/period-locks', requireAuth, async (req, res) => {
  try {
    const locks = await db.query('SELECT * FROM period_locks ORDER BY period_end DESC');
    res.json({ success: true, data: locks });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

router.post('/period-locks', requireAuth, async (req, res) => {
  try {
    const { periodEnd, notes } = req.body;
    if (!periodEnd) return res.status(400).json({ success: false, error: 'periodEnd is required' });
    const lock = await db.queryOne(
      'INSERT INTO period_locks (period_end, locked_by, notes) VALUES ($1, $2, $3) RETURNING *',
      [periodEnd, req.session?.userId || null, notes || null]
    );
    await logAudit('LOCK_PERIOD', 'period_lock', lock.id, null, { period_end: periodEnd }, req.session?.userId);
    res.json({ success: true, data: lock });
  } catch (err) {
    if (err.message.includes('duplicate')) {
      return res.status(400).json({ success: false, error: 'This period is already locked' });
    }
    res.status(500).json({ success: false, error: err.message });
  }
});

router.delete('/period-locks/:id', requireAuth, async (req, res) => {
  try {
    const lock = await db.queryOne('SELECT * FROM period_locks WHERE id = $1', [req.params.id]);
    if (!lock) return res.status(404).json({ success: false, error: 'Lock not found' });
    await db.query('DELETE FROM period_locks WHERE id = $1', [req.params.id]);
    await logAudit('UNLOCK_PERIOD', 'period_lock', parseInt(req.params.id), lock, null, req.session?.userId);
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// ─── Audit Log ───
router.get('/audit-log', requireAuth, async (req, res) => {
  try {
    const { limit = 100, entityType, entityId } = req.query;
    let sql = 'SELECT * FROM audit_log';
    const params = [];
    const conditions = [];

    if (entityType) { params.push(entityType); conditions.push(`entity_type = $${params.length}`); }
    if (entityId) { params.push(parseInt(entityId)); conditions.push(`entity_id = $${params.length}`); }
    if (conditions.length > 0) sql += ' WHERE ' + conditions.join(' AND ');
    sql += ' ORDER BY created_at DESC';
    params.push(parseInt(limit)); sql += ` LIMIT $${params.length}`;

    const logs = await db.query(sql, params);
    res.json({ success: true, data: logs });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// POST journal entry search
router.post('/journal-entries/search', requireAuth, async (req, res) => {
  try {
    const { query: searchQuery, accountId, startDate, endDate, limit = 100, offset = 0 } = req.body;
    let sql = `SELECT je.*, li.id as line_item_id, li.account_id, li.debit_amount, li.credit_amount, li.description as line_description,
      coa.account_name, coa.account_number, coa.account_type
      FROM journal_entries je
      JOIN line_items li ON li.journal_entry_id = je.id
      JOIN chart_of_accounts coa ON li.account_id = coa.id
      WHERE je.is_void = false`;
    const params = [];

    if (accountId) { params.push(accountId); sql += ` AND li.account_id = $${params.length}`; }
    if (startDate) { params.push(startDate); sql += ` AND je.entry_date >= $${params.length}`; }
    if (endDate) { params.push(endDate); sql += ` AND je.entry_date <= $${params.length}`; }
    if (searchQuery) {
      // Map common keywords to account types
      const typeMap = {
        'expense': 'EXPENSE', 'expenses': 'EXPENSE',
        'revenue': 'REVENUE', 'revenues': 'REVENUE', 'income': 'REVENUE',
        'asset': 'ASSET', 'assets': 'ASSET',
        'liability': 'LIABILITY', 'liabilities': 'LIABILITY',
        'equity': 'EQUITY'
      };
      const mappedType = typeMap[searchQuery.toLowerCase().trim()];
      if (mappedType) {
        params.push(mappedType);
        sql += ` AND coa.account_type = $${params.length}`;
      } else {
        params.push(`%${searchQuery}%`);
        sql += ` AND (je.description ILIKE $${params.length} OR li.description ILIKE $${params.length} OR coa.account_name ILIKE $${params.length} OR je.memo ILIKE $${params.length} OR coa.account_type ILIKE $${params.length})`;
      }
    }

    sql += ' ORDER BY je.entry_date DESC, je.id DESC';
    params.push(parseInt(limit)); sql += ` LIMIT $${params.length}`;
    params.push(parseInt(offset)); sql += ` OFFSET $${params.length}`;

    const results = await db.query(sql, params);
    // Get actual total count (without limit/offset) for pagination
    const countSql = sql.replace(/SELECT .* FROM/, 'SELECT COUNT(*) as count FROM').replace(/ ORDER BY.*$/, '').replace(/ LIMIT.*$/, '').replace(/ OFFSET.*$/, '');
    let total = results.length;
    try {
      const countParams = params.slice(0, -2); // Remove limit & offset params
      const countResult = await db.query(countSql, countParams);
      total = parseInt(countResult[0]?.count || results.length);
    } catch(e) { /* fallback to results.length */ }
    res.json({ success: true, data: { results, total } });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

module.exports = router;
