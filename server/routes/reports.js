/**
 * SlickBooks Web - Financial Reports Routes
 * Updated: CPA year-end adjustments applied
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

// Transaction Detail by Account
router.get('/reports/transaction-detail', requireAuth, async (req, res) => {
  try {
    const { startDate, endDate, accountId } = req.query;

    let accountFilter = '';
    const params = [];

    if (accountId) {
      params.push(parseInt(accountId));
      accountFilter = `AND coa.id = $${params.length}`;
    }

    // Get accounts that have transactions in the period
    let jeConditions = 'je.is_posted = true AND je.is_void = false';
    if (startDate) { params.push(startDate); jeConditions += ` AND je.entry_date >= $${params.length}`; }
    if (endDate) { params.push(endDate); jeConditions += ` AND je.entry_date <= $${params.length}`; }

    // Get all transactions grouped by account
    const sql = `
      SELECT
        coa.id as account_id, coa.account_number, coa.account_name, coa.account_type, coa.normal_balance,
        je.id as je_id, je.entry_number, je.entry_date, je.entry_type, je.description as je_description, je.memo as je_memo,
        li.debit_amount, li.credit_amount, li.description as li_description
      FROM line_items li
      INNER JOIN journal_entries je ON li.journal_entry_id = je.id AND ${jeConditions}
      INNER JOIN chart_of_accounts coa ON li.account_id = coa.id
      WHERE coa.is_active = true ${accountFilter}
      ORDER BY coa.account_number, coa.account_name, je.entry_date, je.id
    `;

    const rows = await db.query(sql, params);

    // Group by account and build transaction detail
    const accountMap = {};
    for (const row of rows) {
      const key = row.account_id;
      if (!accountMap[key]) {
        accountMap[key] = {
          account_id: row.account_id,
          account_number: row.account_number,
          account_name: row.account_name,
          account_type: row.account_type,
          normal_balance: row.normal_balance,
          transactions: [],
          net_amount: 0,
          ending_balance: 0
        };
      }

      const debit = parseFloat(row.debit_amount) || 0;
      const credit = parseFloat(row.credit_amount) || 0;
      // Amount sign depends on normal balance: DEBIT accounts show debit-credit, CREDIT accounts show credit-debit
      const amount = row.normal_balance === 'DEBIT' ? (debit - credit) : (credit - debit);

      // Find split account (other accounts in same journal entry)
      let splitAccount = '';
      const splitRows = rows.filter(r => r.je_id === row.je_id && r.account_id !== row.account_id);
      if (splitRows.length === 1) {
        splitAccount = splitRows[0].account_name;
      } else if (splitRows.length > 1) {
        splitAccount = '-Split-';
      }

      accountMap[key].transactions.push({
        date: row.entry_date,
        transaction_type: row.entry_type,
        entry_number: row.entry_number || '',
        name: row.je_description || '',
        memo: row.li_description || row.je_memo || '',
        split_account: splitAccount,
        amount: Math.round(amount * 100) / 100,
        debit, credit,
        running_balance: 0 // will be calculated below
      });
      accountMap[key].net_amount += amount;
    }

    // Calculate running balances
    const accounts = Object.values(accountMap);
    for (const acct of accounts) {
      let balance = 0;
      for (const txn of acct.transactions) {
        balance += txn.amount;
        txn.running_balance = Math.round(balance * 100) / 100;
      }
      acct.net_amount = Math.round(acct.net_amount * 100) / 100;
      acct.ending_balance = Math.round(balance * 100) / 100;
    }

    res.json({
      success: true,
      data: {
        reportType: 'transaction_detail',
        startDate, endDate,
        accounts
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

// FLOFR Financial Statements (Florida Office of Financial Regulation)
// Statement of Income + Balance Sheet — matches CPA's exact format
router.get('/reports/flofr', requireAuth, async (req, res) => {
  try {
    const { startDate, endDate } = req.query;
    const now = new Date();
    const year = startDate ? startDate.substring(0, 4) : String(now.getFullYear());
    const start = startDate || `${year}-01-01`;
    const end = endDate || `${year}-12-31`;
    const yearNum = parseInt(year);

    // ─── Statement of Income (P&L) ───
    const revenue = await getAccountTotals('REVENUE', start, end);
    const expenses = await getAccountTotals('EXPENSE', start, end);

    const totalRevenue = Math.round(revenue.reduce((s, a) => s + a.balance, 0) * 100) / 100;
    const totalExpenses = Math.round(expenses.reduce((s, a) => s + a.balance, 0) * 100) / 100;
    const netIncome = Math.round((totalRevenue - totalExpenses) * 100) / 100;

    // Group expenses into CPA-style categories for FLOFR format
    // Maps account name patterns to CPA line items (ordered by typical CPA presentation)
    const cpaCategoryRules = [
      { label: 'Officer Salary',       pattern: /officer salary/i },
      { label: 'Professional Fees',    pattern: /professional fee|accounting|legal|tax prep|cpa/i },
      { label: 'Software Leases',      pattern: /software/i },
      { label: 'Meals',                pattern: /meal|restaurant|dining/i },
      { label: 'Taxes & Licenses',     pattern: /tax|license/i },
      { label: 'Marketing',            pattern: /marketing|advertising|client hospitality|business gift/i },
      { label: 'Auto Expenses',        pattern: /auto|vehicle|mileage/i },
      { label: 'Telephone & Internet', pattern: /communi|internet|phone|wireless|web host|telecom/i },
      { label: 'Office Expense',       pattern: /office supply|office expense|administrative|overhead/i },
      { label: 'Insurance',            pattern: /insurance/i },
      { label: 'Depreciation',         pattern: /depreciation/i },
      { label: 'Bank & Wire Fees',     pattern: /bank|wire|finance charge|merchant|payment process/i },
      { label: 'Rent',                 pattern: /\brent\b|lease.*office/i },
    ];

    const groupedExpenses = [];
    const usedAccountIds = new Set();

    for (const rule of cpaCategoryRules) {
      const matching = expenses.filter(e => rule.pattern.test(e.account_name) && !usedAccountIds.has(e.id));
      if (matching.length > 0) {
        const total = Math.round(matching.reduce((s, a) => s + a.balance, 0) * 100) / 100;
        matching.forEach(m => usedAccountIds.add(m.id));
        groupedExpenses.push({ label: rule.label, total, accounts: matching });
      }
    }

    // Catch-all for anything not matched
    const unmatched = expenses.filter(e => !usedAccountIds.has(e.id));
    if (unmatched.length > 0) {
      const total = Math.round(unmatched.reduce((s, a) => s + a.balance, 0) * 100) / 100;
      groupedExpenses.push({ label: 'Other Expenses', total, accounts: unmatched });
    }

    // Sort by total descending
    groupedExpenses.sort((a, b) => b.total - a.total);

    // ─── Balance Sheet ───

    // === Accounts Receivable: from AR account balance ===
    const allAssetsFull = await getAccountBalances('ASSET', end);
    const arAccounts = allAssetsFull.filter(a =>
      /receivable/i.test(a.account_name)
    );
    const accountsReceivable = Math.round(arAccounts.reduce((s, a) => s + a.balance, 0) * 100) / 100;

    // === Cash and other current assets ===
    const allAssets = allAssetsFull;
    const cashAccounts = allAssets.filter(a =>
      /cash|bank|check|operat|money market|savings/i.test(a.account_name) &&
      !/receivable|equipment|furniture|deprec|intangible|amort/i.test(a.account_name)
    );
    const equipmentAccounts = allAssets.filter(a =>
      /equipment|furniture|furnish|computer|vehicle|fixed asset/i.test(a.account_name) &&
      !/deprec|amort/i.test(a.account_name)
    );
    const depreciationAccounts = allAssets.filter(a =>
      /deprec/i.test(a.account_name)
    );
    const intangibleAccounts = allAssets.filter(a =>
      /intangible|amort/i.test(a.account_name)
    );

    const totalCash = Math.round(cashAccounts.reduce((s, a) => s + a.balance, 0) * 100) / 100;
    const totalCurrentAssets = Math.round((accountsReceivable + totalCash) * 100) / 100;
    const totalEquipment = Math.round(equipmentAccounts.reduce((s, a) => s + a.balance, 0) * 100) / 100;
    const totalDepreciation = Math.round(depreciationAccounts.reduce((s, a) => s + Math.abs(a.balance), 0) * 100) / 100;
    const netEquipment = Math.round((totalEquipment - totalDepreciation) * 100) / 100;
    const totalIntangibles = Math.round(intangibleAccounts.reduce((s, a) => s + a.balance, 0) * 100) / 100;
    const totalAssets = Math.round((totalCurrentAssets + netEquipment + totalIntangibles) * 100) / 100;

    // === Liabilities ===
    const allLiabilities = await getAccountBalances('LIABILITY', end);
    const filteredLiabilities = allLiabilities.filter(a => a.balance > 0);
    const totalLiabilities = Math.round(filteredLiabilities.reduce((s, a) => s + a.balance, 0) * 100) / 100;

    // === Shareholders' Equity with full retained earnings breakdown ===
    const allEquity = await getAccountBalances('EQUITY', end);

    // Common Stock and Paid-in-Capital
    const commonStock = allEquity.filter(a => /common stock/i.test(a.account_name));
    const paidInCapital = allEquity.filter(a => /paid.in.capital|additional paid/i.test(a.account_name));
    const ownerDistributions = allEquity.filter(a => /distribution|draw/i.test(a.account_name));

    const commonStockTotal = Math.round(commonStock.reduce((s, a) => s + a.balance, 0) * 100) / 100;
    const paidInCapitalTotal = Math.round(paidInCapital.reduce((s, a) => s + a.balance, 0) * 100) / 100;

    // Beginning Retained Earnings = Retained Earnings account balance as of report period end
    // (The RE account balance reflects CPA-adjusted beginning retained earnings via AJEs)
    const retainedEarningsAcct = allEquity.filter(a => /retained earning/i.test(a.account_name));
    const beginningRetainedEarnings = Math.round(retainedEarningsAcct.reduce((s, a) => s + a.balance, 0) * 100) / 100;

    // Current year distributions (only for the report year)
    let currentYearDistAmount = 0;
    if (ownerDistributions.length > 0) {
      const distIds = ownerDistributions.map(a => a.id);
      const currentYearEquityTotals = await getAccountTotals('EQUITY', start, end);
      for (const distId of distIds) {
        const distAcct = currentYearEquityTotals.filter(a => a.id === distId);
        if (distAcct.length > 0) {
          currentYearDistAmount += Math.abs(distAcct[0].balance);
        }
      }
      currentYearDistAmount = Math.round(currentYearDistAmount * 100) / 100;
    }

    // Ending retained earnings = beginning + net income - distributions
    const endingRetainedEarnings = Math.round((beginningRetainedEarnings + netIncome - currentYearDistAmount) * 100) / 100;

    const totalShareholdersEquity = Math.round((commonStockTotal + paidInCapitalTotal + endingRetainedEarnings) * 100) / 100;
    const totalLiabAndEquity = Math.round((totalLiabilities + totalShareholdersEquity) * 100) / 100;

    res.json({
      success: true,
      data: {
        reportType: 'flofr',
        period: { startDate: start, endDate: end, year },
        statementOfIncome: {
          revenue: { accounts: revenue, total: totalRevenue },
          expenses: {
            accounts: expenses,
            total: totalExpenses,
            grouped: groupedExpenses
          },
          netIncome
        },
        balanceSheet: {
          currentAssets: {
            accountsReceivable,
            cash: totalCash,
            cashAccounts,
            totalCurrentAssets
          },
          equipmentAndFurnishings: {
            gross: totalEquipment,
            accounts: equipmentAccounts,
            accumulatedDepreciation: totalDepreciation,
            depreciationAccounts,
            net: netEquipment
          },
          intangibleAssets: totalIntangibles,
          totalAssets,
          currentLiabilities: {
            accounts: filteredLiabilities,
            total: totalLiabilities
          },
          shareholdersEquity: {
            commonStock: commonStockTotal,
            paidInCapital: paidInCapitalTotal,
            retainedEarnings: endingRetainedEarnings,
            retainedEarningsDetail: {
              beginningRetainedEarnings,
              priorYearLabel: `Beginning Retained Earnings`,
              currentYearNetIncome: netIncome,
              currentYearDistributions: currentYearDistAmount,
              endingRetainedEarnings
            },
            totalShareholdersEquity
          },
          totalLiabilitiesAndEquity: totalLiabAndEquity
        }
      }
    });
  } catch (err) {
    console.error('[FLOFR Report] Error:', err);
    res.status(500).json({ success: false, error: err.message });
  }
});

module.exports = router;
