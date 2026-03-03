/**
 * SlickBooks Web - Advisory Fee PDF Parser
 * Parses fee statements from:
 *   1. Interactive Brokers (IBKR) — multi-page "Activity Statement" PDFs (Melody Quicksilver)
 *   2. Charles Schwab — "Management Fees" reports
 *
 * Uses pdfjs-dist (pure JS, no native deps) so it works on Railway.
 */

const pdfjsLib = require('pdfjs-dist/legacy/build/pdf.mjs');

/**
 * Extract all text from a PDF buffer, page by page
 */
async function extractPagesText(buffer) {
  const uint8 = new Uint8Array(buffer);
  const doc = await pdfjsLib.getDocument({ data: uint8, useSystemFonts: true }).promise;
  const pages = [];

  for (let i = 1; i <= doc.numPages; i++) {
    const page = await doc.getPage(i);
    const content = await page.getTextContent();
    const text = content.items.map(item => item.str).join(' ');
    // Also build line-based version (group items by y-position)
    const lineMap = {};
    for (const item of content.items) {
      const y = Math.round(item.transform[5]); // y-position
      if (!lineMap[y]) lineMap[y] = [];
      lineMap[y].push({ x: item.transform[4], text: item.str });
    }
    const lines = Object.keys(lineMap)
      .sort((a, b) => Number(b) - Number(a)) // top to bottom
      .map(y => lineMap[y].sort((a, b) => a.x - b.x).map(i => i.text).join(' ').trim())
      .filter(l => l.length > 0);

    pages.push({ pageNum: i, text, lines });
  }

  await doc.destroy();
  return pages;
}

/**
 * Detect which broker/custodian the PDF is from
 */
function detectSource(allText) {
  const t = allText.toLowerCase();
  if (t.includes('interactive brokers') || t.includes('activity statement') || t.includes('fa fee')) {
    return 'IBKR';
  }
  if (t.includes('schwab') || t.includes('charles schwab') || t.includes('management fees')) {
    return 'SCHWAB';
  }
  if (t.includes('fidelity')) return 'FIDELITY';
  if (t.includes('td ameritrade')) return 'TDA';
  return 'UNKNOWN';
}

/**
 * Parse IBKR Activity Statement — extract advisor fees per account
 *
 * Structure: Each page = one client account.
 * Pages WITH fees have an "Advisor Fees" section containing:
 *   Date | Description | Amount | Code
 *   e.g. "2026-02-02  FA Fee: Percent of Equity, Posted Monthly  -373.12"
 *
 * Pages WITHOUT fees just show account info.
 */
function parseIBKR(pages) {
  const fees = [];
  let statementPeriod = '';

  for (const page of pages) {
    const text = page.text;
    const lines = page.lines;

    // Extract statement period from first page
    if (!statementPeriod) {
      const periodMatch = text.match(/(?:February|January|March|April|May|June|July|August|September|October|November|December)\s+\d+,?\s*\d{4}\s*-\s*(?:February|January|March|April|May|June|July|August|September|October|November|December)\s+\d+,?\s*\d{4}/i);
      if (periodMatch) statementPeriod = periodMatch[0];
      // Also try format: "Month DD, YYYY - Month DD, YYYY"
      if (!statementPeriod) {
        const altMatch = text.match(/(\w+\s+\d+\s*,\s*\d{4})\s*-\s*(\w+\s+\d+\s*,\s*\d{4})/);
        if (altMatch) statementPeriod = altMatch[0];
      }
    }

    // Check if this page has advisor fees
    if (!text.includes('Advisor Fees') && !text.includes('FA Fee')) continue;

    // Extract account info
    let clientName = '';
    let accountAlias = '';
    let accountType = '';

    // Find "Name" field — text after "Name" on the page
    const nameMatch = text.match(/Name\s+(.+?)(?:\s+Account Alias|\s+Investment Advisor)/);
    if (nameMatch) clientName = nameMatch[1].trim();

    // Find "Account Alias"
    const aliasMatch = text.match(/Account Alias\s+(.+?)(?:\s+Investment Advisor|\s+Account Type)/);
    if (aliasMatch) accountAlias = aliasMatch[1].trim();

    // Find "Customer Type"
    const custMatch = text.match(/Customer Type\s+(.+?)(?:\s+Account Capabilities|\s+Base Currency)/);
    if (custMatch) accountType = custMatch[1].trim();

    // Extract fee amount(s)
    // Pattern: date followed by "FA Fee: ..." followed by negative number
    const feePattern = /(\d{4}-\d{2}-\d{2})\s+FA Fee[:\s]+([^\-\d]*?)\s+(-?[\d,]+\.\d{2})/g;
    let match;
    while ((match = feePattern.exec(text)) !== null) {
      const amount = parseFloat(match[3].replace(/,/g, ''));
      fees.push({
        date: match[1],
        clientName: clientName,
        accountAlias: accountAlias,
        accountType: accountType,
        description: 'FA Fee: ' + match[2].trim(),
        amount: Math.abs(amount),
        rawAmount: amount,
        source: 'IBKR',
        pageNum: page.pageNum
      });
    }

    // Fallback: look for amount on lines near "Advisor Fees" / "FA Fee"
    if (fees.filter(f => f.pageNum === page.pageNum).length === 0) {
      for (let i = 0; i < lines.length; i++) {
        const line = lines[i];
        if (line.includes('FA Fee') || line.includes('Advisor Fee')) {
          // Look for monetary amount in this line or adjacent lines
          const amtMatch = line.match(/(-?[\d,]+\.\d{2})/);
          if (amtMatch) {
            const amount = parseFloat(amtMatch[1].replace(/,/g, ''));
            // Look for date in the same line or nearby
            const dateMatch = line.match(/(\d{4}-\d{2}-\d{2})/);
            const feeDate = dateMatch ? dateMatch[1] : '';

            // Only add if we haven't already captured this
            const alreadyCaptured = fees.some(f =>
              f.pageNum === page.pageNum && Math.abs(f.amount - Math.abs(amount)) < 0.01
            );
            if (!alreadyCaptured && Math.abs(amount) > 0) {
              fees.push({
                date: feeDate,
                clientName,
                accountAlias,
                accountType,
                description: 'FA Fee: Percent of Equity, Posted Monthly',
                amount: Math.abs(amount),
                rawAmount: amount,
                source: 'IBKR',
                pageNum: page.pageNum
              });
            }
          }
        }
      }
    }

    // Second fallback: scan all lines for negative amounts preceded by a date
    if (fees.filter(f => f.pageNum === page.pageNum).length === 0) {
      const feeSection = text.includes('Advisor Fees');
      if (feeSection) {
        // Find Total line with amount
        const totalMatch = text.match(/Total\s+(-?[\d,]+\.\d{2})/);
        if (totalMatch) {
          const amount = parseFloat(totalMatch[1].replace(/,/g, ''));
          if (Math.abs(amount) > 0) {
            // Find the date from the fee section
            const dateMatch = text.match(/(\d{4}-\d{2}-\d{2})\s+FA Fee/);
            fees.push({
              date: dateMatch ? dateMatch[1] : '',
              clientName,
              accountAlias,
              accountType,
              description: 'FA Fee: Percent of Equity, Posted Monthly',
              amount: Math.abs(amount),
              rawAmount: amount,
              source: 'IBKR',
              pageNum: page.pageNum
            });
          }
        }
      }
    }
  }

  return {
    source: 'IBKR',
    reportType: 'Activity Statement',
    statementPeriod,
    fees,
    totalFees: fees.reduce((sum, f) => sum + f.amount, 0),
    clientCount: new Set(fees.map(f => f.clientName)).size
  };
}

/**
 * Parse Schwab Management Fee Report
 *
 * Structure: Single page with a table:
 *   Master Account | # of Fees | Total Amount
 *   Then per-account rows: Account# | Fee Amount | Account Name
 */
function parseSchwab(pages) {
  const fees = [];
  let masterAccount = '';
  let reportDate = '';

  for (const page of pages) {
    const text = page.text;
    const lines = page.lines;

    // Extract report date
    const dateMatch = text.match(/Data as of\s+(.+?(?:ET|CT|PT|MT)),?\s*(\d{1,2}\/\d{1,2}\/\d{4})/);
    if (dateMatch) reportDate = dateMatch[2];
    if (!reportDate) {
      const altDate = text.match(/(\d{1,2}\/\d{1,2}\/\d{4})/);
      if (altDate) reportDate = altDate[1];
    }

    // Extract master account
    const masterMatch = text.match(/Master Account\s*[\n\r]?\s*\d+\s+\$[\d,.]+\s+([\d\-]+)/);
    if (masterMatch) masterAccount = masterMatch[1];
    // Alternative: look for the pattern on lines
    if (!masterAccount) {
      for (const line of lines) {
        const mm = line.match(/(\d{4}-\d{4})/);
        if (mm) { masterAccount = mm[1]; break; }
      }
    }

    // Extract fee rows
    // Pattern: Account# | $Amount | Account Name
    // e.g. "94560377 $4,158.39 DAVID L WILSON &"
    for (const line of lines) {
      const feeMatch = line.match(/(\d{6,12})\s+\$?([\d,]+\.\d{2})\s+(.+?)(?:\s+(?:Errors|©|$))?$/);
      if (feeMatch) {
        const accountNum = feeMatch[1];
        const amount = parseFloat(feeMatch[2].replace(/,/g, ''));
        let clientName = feeMatch[3].trim();
        // Clean up trailing ampersand or partial text
        clientName = clientName.replace(/\s*&\s*$/, '').replace(/\s*©.*$/, '').trim();

        if (amount > 0) {
          fees.push({
            date: reportDate ? formatSchwabDate(reportDate) : '',
            clientName,
            accountNumber: accountNum,
            masterAccount,
            accountAlias: '',
            accountType: 'Schwab Managed',
            description: 'Schwab Management Fee',
            amount,
            rawAmount: -amount,
            source: 'SCHWAB',
            pageNum: page.pageNum
          });
        }
      }
    }

    // Fallback: try to find fee amounts from the full text
    if (fees.length === 0) {
      // Look for patterns like "94560377" followed by "$4,158.39"
      const acctFeePattern = /(\d{7,10})\s+\$?([\d,]+\.\d{2})\s+([A-Z][A-Z\s]+)/g;
      let m;
      while ((m = acctFeePattern.exec(text)) !== null) {
        const amount = parseFloat(m[2].replace(/,/g, ''));
        if (amount > 0) {
          fees.push({
            date: reportDate ? formatSchwabDate(reportDate) : '',
            clientName: m[3].trim().replace(/\s*&\s*$/, ''),
            accountNumber: m[1],
            masterAccount,
            accountAlias: '',
            accountType: 'Schwab Managed',
            description: 'Schwab Management Fee',
            amount,
            rawAmount: -amount,
            source: 'SCHWAB',
            pageNum: page.pageNum
          });
        }
      }
    }
  }

  return {
    source: 'SCHWAB',
    reportType: 'Management Fees',
    reportDate,
    masterAccount,
    fees,
    totalFees: fees.reduce((sum, f) => sum + f.amount, 0),
    clientCount: new Set(fees.map(f => f.clientName)).size
  };
}

/**
 * Convert Schwab date "MM/DD/YYYY" → "YYYY-MM-DD"
 */
function formatSchwabDate(dateStr) {
  const parts = dateStr.split('/');
  if (parts.length === 3) {
    return `${parts[2]}-${parts[0].padStart(2, '0')}-${parts[1].padStart(2, '0')}`;
  }
  return dateStr;
}

/**
 * Main entry point — parse any fee PDF
 * Returns { source, fees[], totalFees, clientCount, ... }
 */
async function parseFees(buffer) {
  try {
    const pages = await extractPagesText(buffer);
    if (!pages || pages.length === 0) {
      return { success: false, error: 'Could not read PDF — no text extracted', fees: [] };
    }

    const allText = pages.map(p => p.text).join(' ');
    const source = detectSource(allText);

    let result;
    switch (source) {
      case 'IBKR':
        result = parseIBKR(pages);
        break;
      case 'SCHWAB':
        result = parseSchwab(pages);
        break;
      default:
        return {
          success: false,
          error: `Unrecognized fee document format. Detected: ${source}. Supported: Interactive Brokers, Charles Schwab.`,
          fees: [],
          detectedSource: source
        };
    }

    return {
      success: true,
      ...result
    };
  } catch (err) {
    console.error('[FeeParser] Error:', err.message);
    return { success: false, error: err.message, fees: [] };
  }
}

module.exports = { parseFees, extractPagesText, detectSource, parseIBKR, parseSchwab };
