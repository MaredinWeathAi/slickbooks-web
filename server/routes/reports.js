/**
 * SlickBooks Web - Financial Reports Routes
 */
const router = require('express').Router();
const { requireAuth } = require('../auth');
const db = require('../db');

// Helper: Get account totals for a type within date range
async function getAccountTotals(accountType, startDate, endDate) {
  let jeConditions = 'je.is_posted = true AND je.is_void = false';
  const params = [];

  if (startDate) { params.push(startDate); jeConditions += ` AND je.entry_date >= $${params.length}`; }
  if (endDate) { params.push(endDate); jeConditions += ` AND je.entry_date <= $${params.length}`; }

  params.push(accountType);
  const sql = `
    SELECT coa.id, coa.account_number, coa.account_name, coa.account_type, coa.category, coa.normal_balance,
      COALESCE(SUM(li.debit_amount), 0) as total_debits,
      COALESCE(SUM(li.credit_amount), 0) as total_credits
    FROM chart_of_accounts coa
    LEFT JOIN (
      line_items li
      INNER JOIN journal_entries je ON li.journal_entry_id = je.id AND ${jeConditions}
    ) ON coa.id = li.account_id
    WHERE coa.account_type = $${params.length} AND coa.is_active = true
    GROUP BY coa.id
    HAVING COALESCE(SUM(li.debit_amount), 0) > 0 OR COALESCE(SUM(li.credit_amount), 0) > 0
    ORDER BY coa.account_number
  `;

  const accounts = await db.query(sql, params);
  return accounts.map(a => ({
    ...a,
    total_debits: parseFloat(a.total_debits),
    total_credits: parseFloat(a.total_credits),
    balance: a.normal_balance === 'DEBIT'
      ? Math.round((parseFloat(a.total_debits) - parseFloat(a.total_credits)) * 100) / 100
      : Math.round((parseFloat(a.total_credits) - parseFloat(a.total_debits)) * 100) / 100
  }));
}

// Helper: Get account balances as of date
async function getAccountBalances(accountType, asOfDate) {
  let jeConditions = 'je.is_posted = true AND je.is_void = false';
  const params = [];

  if (asOfDate) { params.push(asOfDate); jeConditions += ` AND je.entry_date <= $${params.length}`; }

  params.push(accountType);
  const sql = `
    SELECT coa.id, coa.account_number, coa.account_name, coa.account_type, coa.category, coa.normal_balance,
      COALESCE(SUM(li.debit_amount), 0) as total_debits,
      COALESCE(SUM(li.credit_amount), 0) as total_credits
    FROM chart_of_accounts coa
    LEFT JOIN (
      line_items li
      INNER JOIN journal_entries je ON li.journal_entry_id = je.id AND ${jeConditions}
    ) ON coa.id = li.account_id
    WHERE coa.account_type = $${params.length} AND coa.is_active = true
    GROUP BY coa.id
    HAVING COALESCE(SUM(li.debit_amount), 0) > 0 OR COALESCE(SUM(li.credit_amount), 0) > 0
    ORDER BY coa.account_number
  `;

  const accounts = await db.query(sql, params);
  return accounts.map(a => ({
    ...a,
    total_debits: parseFloat(a.total_debits),
    total_credits: parseFloat(a.total_credits),
    balance: a.normal_balance === 'DEBIT'
      ? Math.round((parseFloat(a.total_debits) - parseFloat(a.total_credits)) * 100) / 100
      : Math.round((parseFloat(a.total_credits) - parseFloat(a.total_debits)) * 100) / 100
  }));
}

// Profit & Loss
router.get('/reports/pnl', requireAuth, async (req, res) => {
  try {
    const { startDate, endDate } = req.query;
    const revenue = await getAccountTotals('REVENUE', startDate, endDate);
    const expenses = await getAccountTotals('EXPENSE', startDate, endDate);

    const totalRevenue = Math.round(revenue.reduce((s, a) => s + a.balance, 0) * 100) / 100;
    const totalExpenses = Math.round(expenses.reduce((s, a) => s + a.balance, 0) * 100) / 100;

    res.json({
      success: true, data: {
        reportType: 'profit_and_loss', startDate, endDate,
        revenue: { accounts: revenue, total: totalRevenue },
        expenses: { accounts: expenses, total: totalExpenses },
        netIncome: Math.round((totalRevenue - totalExpenses) * 100) / 100
      }
    });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// Balance Sheet
router.get('/reports/balance-sheet', requireAuth, async (req, res) => {
  try {
    const { asOfDate } = req.query;
    const date = asOfDate || new Date().toISOString().split('T')[0];

    const assets = await getAccountBalances('ASSET', date);
    const liabilities = await getAccountBalances('LIABILITY', date);
    const equity = await getAccountBalances('EQUITY', date);

    // Current earnings = YTD revenue - expenses
    const year = date.substring(0, 4);
    const revenue = await getAccountTotals('REVENUE', `${year}-01-01`, date);
    const expenses = await getAccountTotals('EXPENSE', `${year}-01-01`, date);
    const currentEarnings = Math.round((revenue.reduce((s, a) => s + a.balance, 0) - expenses.reduce((s, a) => s + a.balance, 0)) * 100) / 100;

    const totalAssets = Math.round(assets.reduce((s, a) => s + a.balance, 0) * 100) / 100;
    const totalLiabilities = Math.round(liabilities.reduce((s, a) => s + a.balance, 0) * 100) / 100;
    const totalEquity = Math.round(equity.reduce((s, a) => s + a.balance, 0) * 100) / 100;

    res.json({
      success: true, data: {
        reportType: 'balance_sheet', asOfDate: date,
        assets: { accounts: assets, total: totalAssets },
        liabilities: { accounts: liabilities, total: totalLiabilities },
        equity: { accounts: equity, total: totalEquity, currentEarnings, totalWithEarnings: totalEquity + currentEarnings },
        totalLiabilitiesAndEquity: Math.round((totalLiabilities + totalEquity + currentEarnings) * 100) / 100
      }
    });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// Trial Balance
router.get('/reports/trial-balance', requireAuth, async (req, res) => {
  try {
    const { asOfDate } = req.query;
    const date = asOfDate || new Date().toISOString().split('T')[0];

    const accounts = await db.query(`
      SELECT coa.id, coa.account_number, coa.account_name, coa.account_type, coa.normal_balance,
        COALESCE(SUM(li.debit_amount), 0) as total_debits,
        COALESCE(SUM(li.credit_amount), 0) as total_credits
      FROM chart_of_accounts coa
      LEFT JOIN (
        line_items li
        INNER JOIN journal_entries je ON li.journal_entry_id = je.id
          AND je.is_posted = true AND je.is_void = false AND je.entry_date <= $1
      ) ON coa.id = li.account_id
      WHERE coa.is_active = true
      GROUP BY coa.id
      HAVING COALESCE(SUM(li.debit_amount), 0) > 0 OR COALESCE(SUM(li.credit_amount), 0) > 0
      ORDER BY coa.account_number
    `, [date]);

    let totalDebits = 0, totalCredits = 0;
    const rows = accounts.map(a => {
      const debits = parseFloat(a.total_debits);
      const credits = parseFloat(a.total_credits);
      const debitBalance = a.normal_balance === 'DEBIT' ? Math.max(0, debits - credits) : 0;
      const creditBalance = a.normal_balance === 'CREDIT' ? Math.max(0, credits - debits) : 0;
      totalDebits += debitBalance || (debits > credits ? debits - credits : 0);
      totalCredits += creditBalance || (credits > debits ? credits - debits : 0);
      return { ...a, debitBalance: Math.round(debitBalance * 100) / 100, creditBalance: Math.round(creditBalance * 100) / 100 };
    });

    res.json({
      success: true, data: {
        reportType: 'trial_balance', asOfDate: date, accounts: rows,
        totalDebits: Math.round(totalDebits * 100) / 100,
        totalCredits: Math.round(totalCredits * 100) / 100
      }
    });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// Dashboard Analytics (monthly/quarterly data for charts)
router.get('/reports/analytics', requireAuth, async (req, res) => {
  try {
    const { yearsBack = 2 } = req.query;
    const now = new Date();
    const currentYear = now.getFullYear();
    const currentMonth = now.getMonth() + 1;
    const startYear = currentYear - parseInt(yearsBack);

    const monthlyData = [];
    for (let year = startYear; year <= currentYear; year++) {
      for (let month = 1; month <= 12; month++) {
        if (year === currentYear && month > currentMonth) break;

        const startDate = `${year}-${String(month).padStart(2, '0')}-01`;
        const lastDay = new Date(year, month, 0).getDate();
        const endDate = `${year}-${String(month).padStart(2, '0')}-${lastDay}`;

        const revenue = await getAccountTotals('REVENUE', startDate, endDate);
        const expenses = await getAccountTotals('EXPENSE', startDate, endDate);
        const totalRevenue = Math.round(revenue.reduce((s, a) => s + a.balance, 0) * 100) / 100;
        const totalExpenses = Math.round(expenses.reduce((s, a) => s + a.balance, 0) * 100) / 100;

        monthlyData.push({
          year, month, label: `${year}-${String(month).padStart(2, '0')}`,
          totalRevenue, totalExpenses, netIncome: Math.round((totalRevenue - totalExpenses) * 100) / 100
        });
      }
    }

    // Quarterly aggregation
    const quarterlyData = [];
    for (let year = startYear; year <= currentYear; year++) {
      for (let q = 1; q <= 4; q++) {
        const qMonths = monthlyData.filter(m => m.year === year && Math.ceil(m.month / 3) === q);
        if (qMonths.length === 0) continue;
        quarterlyData.push({
          year, quarter: q, label: `${year} Q${q}`,
          totalRevenue: Math.round(qMonths.reduce((s, m) => s + m.totalRevenue, 0) * 100) / 100,
          totalExpenses: Math.round(qMonths.reduce((s, m) => s + m.totalExpenses, 0) * 100) / 100,
          netIncome: Math.round(qMonths.reduce((s, m) => s + m.netIncome, 0) * 100) / 100
        });
      }
    }

    // Top expense categories YTD
    const ytdExpenses = await getAccountTotals('EXPENSE', `${currentYear}-01-01`, now.toISOString().split('T')[0]);
    const categoryTotals = {};
    for (const exp of ytdExpenses) {
      const cat = exp.category || 'Other';
      categoryTotals[cat] = (categoryTotals[cat] || 0) + exp.balance;
    }
    const topExpenseCategories = Object.entries(categoryTotals)
      .map(([category, total]) => ({ category, total: Math.round(total * 100) / 100 }))
      .sort((a, b) => b.total - a.total).slice(0, 10);

    res.json({ success: true, data: { monthlyData, quarterlyData, topExpenseCategories } });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

module.exports = router;
