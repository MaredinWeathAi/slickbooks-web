/**
 * SlickBooks Web - Recurring Entry Routes
 * Manages recurring journal entry templates and auto-generation
 */
const router = require('express').Router();
const { requireAuth } = require('../auth');
const db = require('../db');

// GET all recurring entries
router.get('/recurring-entries', requireAuth, async (req, res) => {
  try {
    const { isActive } = req.query;
    let sql = 'SELECT * FROM recurring_entries WHERE 1=1';
    const params = [];
    if (isActive !== undefined) {
      params.push(isActive === 'true');
      sql += ` AND is_active = $${params.length}`;
    }
    sql += ' ORDER BY next_run_date ASC';
    const entries = await db.query(sql, params);
    res.json({ success: true, data: entries });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// POST create a recurring entry template
router.post('/recurring-entries', requireAuth, async (req, res) => {
  try {
    const { description, entry_template, frequency, next_run_date, end_date } = req.body;
    if (!entry_template || !frequency || !next_run_date) {
      return res.status(400).json({ success: false, error: 'Template, frequency, and start date required' });
    }

    // Validate the template has balanced line items
    const lines = entry_template.line_items || [];
    if (lines.length < 1) {
      return res.status(400).json({ success: false, error: 'Template must have at least 1 line item' });
    }
    const totalD = lines.reduce((s, li) => s + (parseFloat(li.debit_amount) || 0), 0);
    const totalC = lines.reduce((s, li) => s + (parseFloat(li.credit_amount) || 0), 0);
    if (Math.abs(totalD - totalC) > 0.01) {
      return res.status(400).json({ success: false, error: 'Template line items must be balanced' });
    }

    const userId = req.session.user ? req.session.user.id : null;
    const entry = await db.queryOne(
      `INSERT INTO recurring_entries (description, entry_template, frequency, next_run_date, end_date, created_by)
       VALUES ($1, $2, $3, $4, $5, $6) RETURNING *`,
      [description || 'Recurring entry', JSON.stringify(entry_template), frequency, next_run_date, end_date || null, userId]
    );
    res.json({ success: true, data: entry });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// POST process due recurring entries — generates journal entries
router.post('/recurring-entries/process', requireAuth, async (req, res) => {
  try {
    const today = new Date().toISOString().split('T')[0];
    const dueEntries = await db.query(
      'SELECT * FROM recurring_entries WHERE is_active = true AND next_run_date <= $1',
      [today]
    );

    let created = 0;
    for (const rec of dueEntries) {
      // Check end_date
      if (rec.end_date && rec.next_run_date > rec.end_date) {
        await db.query('UPDATE recurring_entries SET is_active = false, updated_at = NOW() WHERE id = $1', [rec.id]);
        continue;
      }

      const template = typeof rec.entry_template === 'string'
        ? JSON.parse(rec.entry_template)
        : rec.entry_template;

      // Generate entry number
      const lastEntry = await db.queryOne('SELECT entry_number FROM journal_entries ORDER BY id DESC LIMIT 1');
      let nextNum = 1;
      if (lastEntry && lastEntry.entry_number) {
        const match = lastEntry.entry_number.match(/(\d+)/);
        if (match) nextNum = parseInt(match[1]) + 1;
      }
      const entryNumber = `JE-${String(nextNum).padStart(5, '0')}`;

      // Create journal entry using the next_run_date as the entry_date
      const entry = await db.queryOne(
        `INSERT INTO journal_entries (entry_number, entry_date, description, entry_type, source, memo, is_posted, posted_at)
         VALUES ($1, $2, $3, $4, 'recurring', $5, $6, $7) RETURNING *`,
        [
          entryNumber,
          rec.next_run_date,
          template.description || rec.description,
          template.entry_type || 'RECURRING',
          template.memo || null,
          template.is_posted || false,
          template.is_posted ? new Date() : null
        ]
      );

      // Insert line items
      for (const li of (template.line_items || [])) {
        await db.query(
          'INSERT INTO line_items (journal_entry_id, account_id, debit_amount, credit_amount, description) VALUES ($1, $2, $3, $4, $5)',
          [entry.id, li.account_id, li.debit_amount || 0, li.credit_amount || 0, li.description || null]
        );
      }

      // Calculate next run date
      let nextDate = new Date(rec.next_run_date + 'T00:00:00');
      if (rec.frequency === 'MONTHLY') nextDate.setMonth(nextDate.getMonth() + 1);
      else if (rec.frequency === 'QUARTERLY') nextDate.setMonth(nextDate.getMonth() + 3);
      else if (rec.frequency === 'ANNUALLY') nextDate.setFullYear(nextDate.getFullYear() + 1);

      const nextDateStr = nextDate.toISOString().split('T')[0];
      const stillActive = !rec.end_date || nextDateStr <= rec.end_date;

      await db.query(
        `UPDATE recurring_entries SET next_run_date = $1, last_run_date = $2, run_count = run_count + 1,
         is_active = $3, updated_at = NOW() WHERE id = $4`,
        [nextDateStr, rec.next_run_date, stillActive, rec.id]
      );

      created++;
      console.log(`[Recurring] Generated ${entryNumber} from template #${rec.id} (${rec.description})`);
    }

    res.json({ success: true, data: { processed: dueEntries.length, created } });
  } catch (err) {
    console.error('[Recurring] Process error:', err.message);
    res.status(500).json({ success: false, error: err.message });
  }
});

// DELETE (deactivate) a recurring entry
router.delete('/recurring-entries/:id', requireAuth, async (req, res) => {
  try {
    await db.query('UPDATE recurring_entries SET is_active = false, updated_at = NOW() WHERE id = $1', [req.params.id]);
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

module.exports = router;
