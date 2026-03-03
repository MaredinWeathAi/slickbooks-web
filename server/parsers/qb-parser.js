/**
 * SlickBooks Web - QuickBooks Excel Export Parser
 * Parses QuickBooks Desktop/Online export ZIP files containing:
 *   - Trial_balance.xlsx → Chart of Accounts with balances
 *   - Journal.xlsx       → All journal entries (double-entry)
 *   - General_ledger.xlsx → Transaction detail by account
 *   - Profit_and_loss.xlsx → P&L summary
 *   - Balance_sheet.xlsx → Balance sheet summary
 *   - Vendors.xlsx       → Vendor list
 *   - Customers.xlsx     → Customer list
 *   - Employees.xlsx     → Employee list
 */

const XLSX = require('xlsx');

/**
 * Classify a QB account name into account type + normal balance
 */
function classifyAccount(name) {
  const n = (name || '').toLowerCase();

  // EXPENSE accounts — check FIRST to prevent partial word matches on ASSET rules
  // (e.g. "bank charges" must not match the "bank" ASSET rule)
  if (/bank charge|wire fee|interactive brokers fee|finance[:]|finance charge/i.test(n))
    return { type: 'EXPENSE', normal: 'DEBIT', category: 'Finance Charges' };
  if (/admin|overhead|dues|subscription|license|permit|office suppl|postage|software/i.test(n))
    return { type: 'EXPENSE', normal: 'DEBIT', category: 'Administrative Overhead' };
  if (/^auto\b|vehicle|mileage/i.test(n))
    return { type: 'EXPENSE', normal: 'DEBIT', category: 'Auto Expenses' };
  if (/communication|internet|phone|web host|wireless/i.test(n))
    return { type: 'EXPENSE', normal: 'DEBIT', category: 'Communications' };
  if (/education|training|conference/i.test(n))
    return { type: 'EXPENSE', normal: 'DEBIT', category: 'Education & Training' };
  if (/insurance/i.test(n))
    return { type: 'EXPENSE', normal: 'DEBIT', category: 'Insurance' };
  if (/marketing|advertising|hospitality|gift|sponsor|collateral|networking|marketing list/i.test(n))
    return { type: 'EXPENSE', normal: 'DEBIT', category: 'Marketing' };
  if (/rent|repair|maintenance|physical office/i.test(n))
    return { type: 'EXPENSE', normal: 'DEBIT', category: 'Physical Office' };
  if (/professional fee|accounting|compliance|consultant|legal|translation/i.test(n))
    return { type: 'EXPENSE', normal: 'DEBIT', category: 'Professional Fees' };
  if (/research material/i.test(n))
    return { type: 'EXPENSE', normal: 'DEBIT', category: 'Research' };
  if (/taxes? paid|penalt|interest paid/i.test(n))
    return { type: 'EXPENSE', normal: 'DEBIT', category: 'Taxes' };
  if (/travel|airline|hotel|meal|entertainment|parking|shuttle|rental car|baggage/i.test(n))
    return { type: 'EXPENSE', normal: 'DEBIT', category: 'Travel' };
  if (/uncategorized expense|miscellaneous expense/i.test(n))
    return { type: 'EXPENSE', normal: 'DEBIT', category: 'Uncategorized' };
  if (/intern|reimburse.*intern/i.test(n))
    return { type: 'EXPENSE', normal: 'DEBIT', category: 'Reimbursements' };

  // ASSET accounts (checked after expenses to avoid "bank" matching "bank charges")
  if (/operating acct|checking|savings|undeposited funds/i.test(n))
    return { type: 'ASSET', normal: 'DEBIT', category: 'Bank Accounts' };
  if (/\bbank\b/i.test(n) && !/charge|fee/i.test(n))
    return { type: 'ASSET', normal: 'DEBIT', category: 'Bank Accounts' };
  if (/\bcash\b/i.test(n) && !/unapplied cash/i.test(n))
    return { type: 'ASSET', normal: 'DEBIT', category: 'Bank Accounts' };
  if (/fixed asset|computer|equipment|furniture|vehicle/i.test(n))
    return { type: 'ASSET', normal: 'DEBIT', category: 'Fixed Assets' };
  if (/accounts receivable|a\/r/i.test(n))
    return { type: 'ASSET', normal: 'DEBIT', category: 'Accounts Receivable' };
  if (/security deposit|prepaid|organizational cost/i.test(n))
    return { type: 'ASSET', normal: 'DEBIT', category: 'Other Assets' };

  // LIABILITY accounts
  if (/loan payable|notes payable|line of credit/i.test(n))
    return { type: 'LIABILITY', normal: 'CREDIT', category: 'Long-Term Liabilities' };
  if (/accounts payable|a\/p/i.test(n))
    return { type: 'LIABILITY', normal: 'CREDIT', category: 'Accounts Payable' };
  if (/credit card/i.test(n))
    return { type: 'LIABILITY', normal: 'CREDIT', category: 'Credit Cards' };
  if (/payroll liabilit|tax payable/i.test(n))
    return { type: 'LIABILITY', normal: 'CREDIT', category: 'Current Liabilities' };

  // EQUITY accounts
  if (/owner|equity|retained earnings|capital|opening balance/i.test(n))
    return { type: 'EQUITY', normal: 'CREDIT', category: 'Equity' };

  // REVENUE accounts
  if (/income|revenue|sales|fee account|professional services|commissions earned|counter credit|reimbursed expenses(?!-)|interest earned|unapplied cash|uncategorized income|gains/i.test(n))
    return { type: 'REVENUE', normal: 'CREDIT', category: 'Income' };
  if (/client fee/i.test(n))
    return { type: 'REVENUE', normal: 'CREDIT', category: 'Advisory Fee Income' };

  // Default fallback
  return { type: 'EXPENSE', normal: 'DEBIT', category: 'Other' };
}

/**
 * Parse a cell value — handle formulas like "=43780.43"
 */
function parseNum(val) {
  if (val == null) return 0;
  if (typeof val === 'number') return val;
  const s = String(val).replace(/^=/, '').replace(/,/g, '').trim();
  const n = parseFloat(s);
  return isNaN(n) ? 0 : n;
}

/**
 * Parse Trial Balance → Chart of Accounts
 */
function parseTrialBalance(buffer) {
  const wb = XLSX.read(buffer, { type: 'buffer' });
  const ws = wb.Sheets[wb.SheetNames[0]];
  const rows = XLSX.utils.sheet_to_json(ws, { header: 1, defval: null });

  const accounts = [];
  let accountNum = 1000;

  for (let i = 5; i < rows.length; i++) {
    const row = rows[i];
    const name = row[0];
    if (!name || typeof name !== 'string') continue;
    if (/^TOTAL$/i.test(name.trim())) break;
    if (/^monday|^tuesday|^wednesday|^thursday|^friday|^saturday|^sunday/i.test(name.trim())) break;

    const debitBal = parseNum(row[1]);
    const creditBal = parseNum(row[2]);
    const classification = classifyAccount(name);

    // Clean up the account name — remove leading spaces (sub-accounts in QB)
    const cleanName = name.replace(/^\s+/, '').trim();
    const isSubAccount = name.startsWith('   ') || name.includes(':');

    // Extract parent:child relationship from colon notation
    let parentName = null;
    let displayName = cleanName;
    if (cleanName.includes(':')) {
      const parts = cleanName.split(':');
      parentName = parts[0].trim();
      displayName = parts[parts.length - 1].trim();
    }

    accounts.push({
      accountNumber: String(accountNum),
      accountName: cleanName,
      displayName,
      parentName,
      accountType: classification.type,
      normalBalance: classification.normal,
      category: classification.category,
      subCategory: isSubAccount ? parentName : null,
      debitBalance: debitBal,
      creditBalance: creditBal,
      balance: debitBal - creditBal
    });

    accountNum += 10;
  }

  return accounts;
}

/**
 * Parse Journal.xlsx → Journal Entries
 *
 * QB Journal format:
 *   Row with Date = new entry header
 *   Following rows without Date = line items
 *   Row with totals (both Debit & Credit filled) = entry total (skip)
 *   Empty row = separator
 *
 * Columns: [0]=unused, [1]=Date, [2]=TransType, [3]=Num, [4]=Name, [5]=Memo, [6]=Account, [7]=Debit, [8]=Credit
 */
function parseJournal(buffer) {
  const wb = XLSX.read(buffer, { type: 'buffer' });
  const ws = wb.Sheets[wb.SheetNames[0]];
  const rows = XLSX.utils.sheet_to_json(ws, { header: 1, defval: null });

  const entries = [];
  let currentEntry = null;
  let entryCount = 0;

  for (let i = 5; i < rows.length; i++) {
    const row = rows[i];

    // Skip empty rows and footer
    const allNull = row.every(c => c == null || String(c).trim() === '');
    if (allNull) {
      // Finalize current entry if valid
      if (currentEntry && currentEntry.lines.length >= 2) {
        entries.push(currentEntry);
      }
      currentEntry = null;
      continue;
    }

    // Skip footer/timestamp rows
    if (row[0] && /^(monday|tuesday|wednesday|thursday|friday|saturday|sunday)/i.test(String(row[0]).trim())) break;

    const date = row[1];
    const txnType = row[2];
    const num = row[3];
    const name = row[4];
    const memo = row[5];
    const account = row[6];
    const debit = parseNum(row[7]);
    const credit = parseNum(row[8]);

    // Check if this is a totals row (both debit and credit are non-zero, no account)
    if (!account && debit > 0 && credit > 0 && Math.abs(debit - credit) < 0.02) {
      // This is the entry total line — finalize the entry
      if (currentEntry && currentEntry.lines.length >= 2) {
        entries.push(currentEntry);
      }
      currentEntry = null;
      continue;
    }

    // New entry (has a date)
    if (date && String(date).trim()) {
      // Save previous entry
      if (currentEntry && currentEntry.lines.length >= 2) {
        entries.push(currentEntry);
      }

      entryCount++;
      const dateStr = parseQBDate(date);

      currentEntry = {
        entryNumber: `QB-${String(entryCount).padStart(5, '0')}`,
        date: dateStr,
        transactionType: String(txnType || '').trim(),
        refNumber: num ? String(num) : null,
        name: name ? String(name).trim() : null,
        memo: memo ? String(memo).trim() : null,
        description: buildDescription(txnType, name, memo),
        lines: [],
        source: 'quickbooks'
      };

      // First line of entry also has account data
      if (account && (debit > 0 || credit > 0)) {
        currentEntry.lines.push({
          account: String(account).trim(),
          debit: debit,
          credit: credit,
          description: memo ? String(memo).trim() : null
        });
      }
    } else if (currentEntry && account) {
      // Continuation line — add as line item
      currentEntry.lines.push({
        account: String(account).trim(),
        debit: debit,
        credit: credit,
        description: (memo || name) ? String(memo || name || '').trim() : null
      });
    }
  }

  // Don't forget the last entry
  if (currentEntry && currentEntry.lines.length >= 2) {
    entries.push(currentEntry);
  }

  return entries;
}

/**
 * Parse Vendors.xlsx
 */
function parseVendors(buffer) {
  const wb = XLSX.read(buffer, { type: 'buffer' });
  const ws = wb.Sheets[wb.SheetNames[0]];
  const rows = XLSX.utils.sheet_to_json(ws, { header: 1, defval: null });

  const vendors = [];
  for (let i = 5; i < rows.length; i++) {
    const row = rows[i];
    const name = row[1];
    if (!name || typeof name !== 'string' || !name.trim()) continue;
    if (/^(monday|tuesday)/i.test(name.trim())) break;

    vendors.push({
      name: String(name).trim(),
      phone: row[2] ? String(row[2]).trim() : null,
      email: row[3] ? String(row[3]).trim() : null,
      fullName: row[4] ? String(row[4]).trim() : null,
      address: row[5] ? String(row[5]).trim() : null,
      accountNumber: row[6] ? String(row[6]).trim() : null
    });
  }
  return vendors;
}

/**
 * Parse Customers.xlsx
 */
function parseCustomers(buffer) {
  const wb = XLSX.read(buffer, { type: 'buffer' });
  const ws = wb.Sheets[wb.SheetNames[0]];
  const rows = XLSX.utils.sheet_to_json(ws, { header: 1, defval: null });

  const customers = [];
  for (let i = 5; i < rows.length; i++) {
    const row = rows[i];
    const name = row[1];
    if (!name || typeof name !== 'string' || !name.trim()) continue;
    if (/^(monday|tuesday)/i.test(name.trim())) break;

    customers.push({
      name: String(name).trim(),
      phone: row[2] ? String(row[2]).trim() : null,
      email: row[3] ? String(row[3]).trim() : null,
      fullName: row[4] ? String(row[4]).trim() : null,
      billingAddress: row[5] ? String(row[5]).trim() : null,
      shippingAddress: row[6] ? String(row[6]).trim() : null
    });
  }
  return customers;
}

/**
 * Parse a QB date like "12/31/2013" or "03/06/2014" → "YYYY-MM-DD"
 */
function parseQBDate(val) {
  if (!val) return null;
  const s = String(val).trim();
  // MM/DD/YYYY
  const m = s.match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})$/);
  if (m) return `${m[3]}-${m[1].padStart(2, '0')}-${m[2].padStart(2, '0')}`;
  // Already ISO
  if (/^\d{4}-\d{2}-\d{2}$/.test(s)) return s;
  // Excel serial number
  if (typeof val === 'number') {
    const d = new Date((val - 25569) * 86400 * 1000);
    return d.toISOString().split('T')[0];
  }
  return s;
}

/**
 * Build a human-readable description from QB fields
 */
function buildDescription(type, name, memo) {
  const parts = [];
  if (type) parts.push(String(type).trim());
  if (name) parts.push(String(name).trim());
  if (memo) {
    // Truncate long bank memos
    let m = String(memo).trim();
    if (m.length > 100) m = m.substring(0, 100) + '...';
    parts.push(m);
  }
  return parts.join(' — ') || 'QuickBooks Import';
}

/**
 * Parse an entire QB export ZIP file
 */
function parseQBZip(zipBuffer) {
  const JSZip = require('jszip') || null;
  // We'll handle ZIP extraction in the route, not here
  throw new Error('Use individual file parsers instead of ZIP');
}

/**
 * Parse all QB export files from individual buffers
 */
function parseQBExport(files) {
  const result = {
    accounts: [],
    entries: [],
    vendors: [],
    customers: [],
    summary: {}
  };

  if (files.trialBalance) {
    result.accounts = parseTrialBalance(files.trialBalance);
    result.summary.accountCount = result.accounts.length;
  }

  if (files.journal) {
    result.entries = parseJournal(files.journal);
    result.summary.entryCount = result.entries.length;
    result.summary.lineItemCount = result.entries.reduce((s, e) => s + e.lines.length, 0);
    if (result.entries.length > 0) {
      result.summary.dateRange = {
        from: result.entries[0].date,
        to: result.entries[result.entries.length - 1].date
      };
    }
  }

  if (files.vendors) {
    result.vendors = parseVendors(files.vendors);
    result.summary.vendorCount = result.vendors.length;
  }

  if (files.customers) {
    result.customers = parseCustomers(files.customers);
    result.summary.customerCount = result.customers.length;
  }

  return result;
}

module.exports = {
  parseTrialBalance,
  parseJournal,
  parseVendors,
  parseCustomers,
  parseQBExport,
  classifyAccount,
  parseQBDate
};
