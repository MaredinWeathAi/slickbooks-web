/**
 * SlickBooks Web - Dashboard Routes
 */
const router = require('express').Router();
const { requireAuth } = require('../auth');
const db = require('../db');

router.get('/dashboard', requireAuth, async (req, res) => {
  try {
    const now = new Date();
    const today = now.toISOString().split('T')[0];
    const currentYear = now.getFullYear();
    const currentMonth = now.getMonth() + 1;
    const yearStart = `${currentYear}-01-01`;

    // Helper for account totals
    async function getPnlTotals(startDate, endDate) {
      const revSql = `
        SELECT COALESCE(SUM(CASE WHEN coa.normal_balance='CREDIT' THEN li.credit_amount - li.debit_amount ELSE li.debit_amount - li.credit_amount END), 0) as total
        FROM line_items li
        JOIN journal_entries je ON li.journal_entry_id = je.id
        JOIN chart_of_accounts coa ON li.account_id = coa.id
        WHERE je.is_posted = true AND je.is_void = false AND coa.account_type = 'REVENUE'
          AND je.entry_date >= $1 AND je.entry_date <= $2
      `;
      const expSql = revSql.replace("'REVENUE'", "'EXPENSE'");

      const rev = await db.queryOne(revSql, [startDate, endDate]);
      const exp = await db.queryOne(expSql, [startDate, endDate]);
      const revenue = Math.round(parseFloat(rev.total) * 100) / 100;
      const expenses = Math.round(parseFloat(exp.total) * 100) / 100;
      return { revenue, expenses, netIncome: Math.round((revenue - expenses) * 100) / 100 };
    }

    // YTD
    const ytd = await getPnlTotals(yearStart, today);

    // This month
    const thisMonthStart = `${currentYear}-${String(currentMonth).padStart(2, '0')}-01`;
    const month = await getPnlTotals(thisMonthStart, today);

    // Prior month
    const priorMonthEnd = new Date(currentYear, currentMonth - 1, 0);
    const priorMonthStart = `${priorMonthEnd.getFullYear()}-${String(priorMonthEnd.getMonth() + 1).padStart(2, '0')}-01`;
    const priorMonth = await getPnlTotals(priorMonthStart, priorMonthEnd.toISOString().split('T')[0]);

    // Current quarter
    const currentQuarter = Math.ceil(currentMonth / 3);
    const qStartMonth = (currentQuarter - 1) * 3 + 1;
    const thisQuarterStart = `${currentYear}-${String(qStartMonth).padStart(2, '0')}-01`;
    const quarter = await getPnlTotals(thisQuarterStart, today);

    // Prior quarter
    const priorQ = currentQuarter === 1 ? 4 : currentQuarter - 1;
    const priorQYear = currentQuarter === 1 ? currentYear - 1 : currentYear;
    const priorQStartMonth = (priorQ - 1) * 3 + 1;
    const priorQEndMonth = priorQ * 3;
    const priorQLastDay = new Date(priorQYear, priorQEndMonth, 0).getDate();
    const priorQuarter = await getPnlTotals(
      `${priorQYear}-${String(priorQStartMonth).padStart(2, '0')}-01`,
      `${priorQYear}-${String(priorQEndMonth).padStart(2, '0')}-${priorQLastDay}`
    );

    // Prior year YTD
    const priorYearSameDay = `${currentYear - 1}-${String(currentMonth).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}`;
    let priorYtd = { revenue: 0, expenses: 0, netIncome: 0 };
    try { priorYtd = await getPnlTotals(`${currentYear - 1}-01-01`, priorYearSameDay); } catch (e) { }

    // Cash position
    const cashResult = await db.queryOne(`
      SELECT COALESCE(SUM(
        CASE WHEN coa.normal_balance = 'DEBIT' THEN li.debit_amount - li.credit_amount
             ELSE li.credit_amount - li.debit_amount END
      ), 0) as total
      FROM line_items li
      JOIN journal_entries je ON li.journal_entry_id = je.id
      JOIN chart_of_accounts coa ON li.account_id = coa.id
      WHERE je.is_posted = true AND je.is_void = false AND coa.account_type = 'ASSET'
        AND (LOWER(coa.account_name) LIKE '%cash%' OR LOWER(coa.account_name) LIKE '%bank%'
             OR LOWER(coa.account_name) LIKE '%checking%' OR LOWER(coa.account_name) LIKE '%operating%'
             OR LOWER(coa.category) LIKE '%cash%' OR LOWER(coa.category) LIKE '%bank%')
    `);

    // Counts
    const totalAccounts = await db.queryOne('SELECT COUNT(*) as cnt FROM chart_of_accounts WHERE is_active = true');
    const totalEntries = await db.queryOne('SELECT COUNT(*) as cnt FROM journal_entries');
    const draftEntries = await db.queryOne('SELECT COUNT(*) as cnt FROM journal_entries WHERE is_posted = false AND is_void = false');

    // Recent entries
    const recentEntries = await db.query(`
      SELECT je.*, COALESCE(SUM(li.debit_amount), 0) as total_amount
      FROM journal_entries je
      LEFT JOIN line_items li ON li.journal_entry_id = je.id
      WHERE je.is_void = false
      GROUP BY je.id
      ORDER BY je.entry_date DESC, je.id DESC LIMIT 15
    `);

    res.json({
      success: true, data: {
        ytdRevenue: ytd.revenue, ytdExpenses: ytd.expenses, ytdNetIncome: ytd.netIncome,
        monthRevenue: month.revenue, monthExpenses: month.expenses, monthNetIncome: month.netIncome,
        priorMonthRevenue: priorMonth.revenue, priorMonthExpenses: priorMonth.expenses, priorMonthNetIncome: priorMonth.netIncome,
        quarterRevenue: quarter.revenue, quarterExpenses: quarter.expenses, quarterNetIncome: quarter.netIncome,
        priorQuarterRevenue: priorQuarter.revenue, priorQuarterExpenses: priorQuarter.expenses, priorQuarterNetIncome: priorQuarter.netIncome,
        priorYtdRevenue: priorYtd.revenue, priorYtdExpenses: priorYtd.expenses, priorYtdNetIncome: priorYtd.netIncome,
        cashPosition: Math.round(parseFloat(cashResult.total) * 100) / 100,
        totalAccounts: parseInt(totalAccounts.cnt),
        totalEntries: parseInt(totalEntries.cnt),
        draftCount: parseInt(draftEntries.cnt),
        recentEntries
      }
    });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

module.exports = router;
