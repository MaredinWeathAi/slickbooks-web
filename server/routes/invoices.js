/**
 * SlickBooks Web - Invoice Generation Routes
 * Generates branded PDF invoices for Schwab advisory clients
 */
const router = require('express').Router();
const { requireAuth } = require('../auth');
const db = require('../db');
const PDFDocument = require('pdfkit');

// Brand colors (Maredin Wealth Advisors)
const NAVY = [13, 31, 60];
const GOLD = [201, 169, 110];
const CREAM = [250, 248, 245];
const DARK_TEXT = [26, 26, 46];
const GRAY_TEXT = [74, 74, 90];
const LIGHT_GRAY = [122, 122, 138];
const BORDER_LIGHT = [232, 228, 223];
const WHITE = [255, 255, 255];

function hexToRgb(arr) { return arr; }

// Company info
const COMPANY = {
  name: 'Maredin Wealth Advisors',
  address1: '16132 SW 74th Place',
  address2: 'Miami, FL 33157',
  phone: '(305) 773-5308',
  email: 'marcelo@maredin.com',
  web: 'www.maredin.com',
  tagline: 'Trusted Fiduciary Wealth Management Since 2005'
};

// GET /api/invoices/clients - list Schwab clients for the dropdown
router.get('/invoices/clients', requireAuth, async (req, res) => {
  try {
    // For now, return the known Schwab client(s) — can expand later
    const clients = [
      { id: 'wilson', name: 'David & Marguerite Wilson', custodian: 'Charles Schwab & Co., Inc.', feeRate: 1.0 }
    ];
    res.json({ success: true, data: clients });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// GET /api/invoices/history - list generated invoices
router.get('/invoices/history', requireAuth, async (req, res) => {
  try {
    const entries = await db.query(
      `SELECT je.id, je.entry_number, je.entry_date, je.description, je.memo,
              je.total_amount, je.created_at
       FROM journal_entries je
       WHERE je.entry_type = 'Invoice' AND je.is_void = false
       ORDER BY je.entry_date DESC
       LIMIT 50`
    );
    res.json({ success: true, data: entries });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// POST /api/invoices/generate - generate a PDF invoice
router.post('/invoices/generate', requireAuth, async (req, res) => {
  try {
    const { clientId, clientName, custodian, month, year, feeAmount, feeRate, createJournalEntry } = req.body;

    if (!clientName || !month || !year || !feeAmount) {
      return res.status(400).json({ success: false, error: 'Missing required fields: clientName, month, year, feeAmount' });
    }

    const monthNum = parseInt(month);
    const yearNum = parseInt(year);
    const amount = parseFloat(feeAmount);
    const rate = parseFloat(feeRate) || 1.0;

    // Build invoice data
    const monthNames = ['January','February','March','April','May','June','July','August','September','October','November','December'];
    const monthName = monthNames[monthNum - 1];
    const lastDay = new Date(yearNum, monthNum, 0).getDate();
    const invoiceNumber = `MWA-${yearNum}-${String(monthNum).padStart(3, '0')}`;
    const invoiceDate = `${monthName} ${lastDay}, ${yearNum}`;
    const billingPeriod = `${monthName} 1 - ${monthName} ${lastDay}, ${yearNum}`;

    // Optionally create a journal entry
    let journalEntry = null;
    if (createJournalEntry) {
      const entryDate = `${yearNum}-${String(monthNum).padStart(2, '0')}-${String(lastDay).padStart(2, '0')}`;
      const jeResult = await db.query(
        `INSERT INTO journal_entries (entry_date, description, entry_type, source, memo, is_posted)
         VALUES ($1, $2, 'Invoice', 'invoice_gen', $3, true)
         RETURNING *`,
        [entryDate, `Invoice — ${clientName}`, `${invoiceNumber} | ${billingPeriod} | Advisory Fee @ ${rate}%`]
      );
      journalEntry = jeResult[0];

      // DR Accounts Receivable (60) / CR Management Fees (1)
      await db.query(
        `INSERT INTO line_items (journal_entry_id, account_id, debit_amount, credit_amount, description)
         VALUES ($1, 60, $2, 0, $3), ($1, 1, 0, $2, $4)`,
        [journalEntry.id, amount, `AR — ${clientName}`, `Advisory fee: ${clientName}`]
      );

      // Generate entry number
      const entryNum = `JE-${String(journalEntry.id + 1000).padStart(5, '0')}`;
      await db.query('UPDATE journal_entries SET entry_number = $1 WHERE id = $2', [entryNum, journalEntry.id]);
      journalEntry.entry_number = entryNum;
    }

    // Generate PDF
    const doc = new PDFDocument({ size: 'letter', margin: 0 });
    const chunks = [];
    doc.on('data', chunk => chunks.push(chunk));
    doc.on('end', () => {
      const pdfBuffer = Buffer.concat(chunks);
      res.setHeader('Content-Type', 'application/pdf');
      res.setHeader('Content-Disposition', `attachment; filename="Invoice_${clientName.replace(/[^a-zA-Z0-9]/g, '_')}_${monthName}_${yearNum}.pdf"`);
      if (journalEntry) {
        res.setHeader('X-Journal-Entry', journalEntry.entry_number);
      }
      res.send(pdfBuffer);
    });

    buildInvoicePDF(doc, {
      clientName: clientName || 'Client',
      custodian: custodian || 'Charles Schwab & Co., Inc.',
      invoiceNumber,
      invoiceDate,
      billingPeriod,
      feeDescription: `Investment Advisory Fee — ${monthName} ${yearNum}`,
      feeAmount: amount,
      feeRate: rate
    });

    doc.end();
  } catch (err) {
    console.error('[Invoices] Generate error:', err);
    res.status(500).json({ success: false, error: err.message });
  }
});


function buildInvoicePDF(doc, data) {
  const w = 612, h = 792;
  const rx = w - 50;

  // ── Navy header ──
  const hh = 115;
  doc.rect(0, 0, w, hh).fill(rgbStr(NAVY));
  doc.moveTo(0, hh).lineTo(w, hh).lineWidth(2.5).strokeColor(rgbStr(GOLD)).stroke();

  // Company name
  doc.fillColor(rgbStr(WHITE)).fontSize(11).font('Helvetica');
  doc.text('M A R E D I N', 50, 23, { lineBreak: false });
  doc.fontSize(8.5).text('W E A L T H   A D V I S O R S', 50, 37, { lineBreak: false });
  doc.moveTo(50, 47).lineTo(210, 47).lineWidth(0.75).strokeColor(rgbStr(GOLD)).stroke();

  // Contact right
  doc.fillColor('#b0b8c4').fontSize(7.5);
  doc.text(COMPANY.address1, 0, 20, { width: rx, align: 'right' });
  doc.text(COMPANY.address2, 0, 31, { width: rx, align: 'right' });
  doc.text(`${COMPANY.phone}  |  ${COMPANY.email}`, 0, 42, { width: rx, align: 'right' });

  // INVOICE title
  doc.fillColor(rgbStr(GOLD)).fontSize(24).font('Helvetica-Bold');
  doc.text('INVOICE', 50, 76, { lineBreak: false });

  // Invoice number/date
  doc.fillColor(rgbStr(WHITE)).fontSize(9).font('Helvetica');
  doc.text(`Invoice No. ${data.invoiceNumber}`, 0, 78, { width: rx, align: 'right' });
  doc.text(`Date: ${data.invoiceDate}`, 0, 91, { width: rx, align: 'right' });

  // ── Bill To / Period ──
  let Y = hh + 30;

  doc.fillColor(rgbStr(GOLD)).fontSize(7.5).font('Helvetica-Bold');
  doc.text('BILL TO', 50, Y, { lineBreak: false });
  doc.moveTo(50, Y + 12).lineTo(105, Y + 12).lineWidth(0.5).strokeColor(rgbStr(GOLD)).stroke();

  Y += 18;
  doc.fillColor(rgbStr(DARK_TEXT)).fontSize(11).font('Helvetica-Bold');
  doc.text(data.clientName, 50, Y, { lineBreak: false });
  Y += 15;
  doc.fillColor(rgbStr(GRAY_TEXT)).fontSize(9).font('Helvetica');
  doc.text(data.custodian, 50, Y, { lineBreak: false });

  // Billing period (right side)
  const pY = hh + 30;
  doc.fillColor(rgbStr(GOLD)).fontSize(7.5).font('Helvetica-Bold');
  doc.text('BILLING PERIOD', 380, pY, { lineBreak: false });
  doc.moveTo(380, pY + 12).lineTo(468, pY + 12).lineWidth(0.5).strokeColor(rgbStr(GOLD)).stroke();
  doc.fillColor(rgbStr(DARK_TEXT)).fontSize(10).font('Helvetica');
  doc.text(data.billingPeriod, 380, pY + 18, { lineBreak: false });

  // ── Fee table ──
  Y += 22;

  // Table header
  doc.rect(50, Y, w - 100, 22).fill(rgbStr(NAVY));
  doc.fillColor(rgbStr(WHITE)).fontSize(8).font('Helvetica-Bold');
  doc.text('DESCRIPTION', 62, Y + 6, { lineBreak: false });
  doc.text('AMOUNT', 0, Y + 6, { width: w - 62, align: 'right' });
  Y += 22;

  // Fee row
  doc.rect(50, Y, w - 100, 24).fill(rgbStr(CREAM));
  doc.fillColor(rgbStr(DARK_TEXT)).fontSize(9.5).font('Helvetica');
  doc.text(data.feeDescription, 62, Y + 7, { lineBreak: false });
  doc.font('Helvetica-Bold').fontSize(10);
  doc.text(`$${data.feeAmount.toLocaleString('en-US', {minimumFractionDigits: 2})}`, 0, Y + 7, { width: w - 62, align: 'right' });
  Y += 24;

  // Separator
  doc.moveTo(350, Y + 4).lineTo(w - 50, Y + 4).lineWidth(0.5).strokeColor(rgbStr(BORDER_LIGHT)).stroke();
  Y += 8;

  // Total bar
  doc.rect(350, Y, w - 400, 22).fill(rgbStr(NAVY));
  doc.fillColor(rgbStr(WHITE)).fontSize(8.5).font('Helvetica-Bold');
  doc.text('TOTAL DUE', 362, Y + 6, { lineBreak: false });
  doc.fontSize(11);
  doc.text(`$${data.feeAmount.toLocaleString('en-US', {minimumFractionDigits: 2})}`, 0, Y + 5, { width: w - 62, align: 'right' });
  Y += 22;

  // ── Fee Calculation ──
  Y += 28;
  doc.fillColor(rgbStr(GOLD)).fontSize(7.5).font('Helvetica-Bold');
  doc.text('FEE CALCULATION METHODOLOGY', 50, Y, { lineBreak: false });
  doc.moveTo(50, Y + 12).lineTo(232, Y + 12).lineWidth(0.5).strokeColor(rgbStr(GOLD)).stroke();

  Y += 18;
  doc.fillColor(rgbStr(GRAY_TEXT)).fontSize(9).font('Helvetica');
  doc.text(`Advisory fees are calculated based on an annual rate of ${data.feeRate.toFixed(2)}% applied to the`, 62, Y, { lineBreak: false });
  Y += 14;
  doc.text('average account value for the billing period.', 62, Y, { lineBreak: false });

  Y += 22;
  doc.fillColor(rgbStr(DARK_TEXT)).font('Helvetica-Bold').fontSize(9);
  doc.text('Average Account Value  =  ( Beginning Balance + Ending Balance )  /  2', 62, Y, { lineBreak: false });

  Y += 20;
  doc.text(`Monthly Fee  =  Average Account Value  x  ${data.feeRate.toFixed(2)}%  /  12`, 62, Y, { lineBreak: false });

  // ── Payment Terms ──
  Y += 30;
  doc.rect(50, Y, w - 100, 34).fill(rgbStr(CREAM));
  doc.fillColor(rgbStr(DARK_TEXT)).fontSize(7.5).font('Helvetica-Bold');
  doc.text('PAYMENT TERMS', 62, Y + 6, { lineBreak: false });
  doc.fillColor(rgbStr(GRAY_TEXT)).fontSize(8.5).font('Helvetica');
  doc.text('Fees are deducted directly from your Schwab account. No action is required on your part.', 62, Y + 20, { lineBreak: false });

  // ── Thank you ──
  Y += 50;
  doc.moveTo(50, Y).lineTo(w - 50, Y).lineWidth(0.5).strokeColor(rgbStr(BORDER_LIGHT)).stroke();
  Y += 16;
  doc.fillColor(rgbStr(GRAY_TEXT)).fontSize(9).font('Helvetica-Oblique');
  doc.text('Thank you for your continued trust in Maredin Wealth Advisors.', 50, Y, { width: w - 100, align: 'center' });

  // ── Footer ──
  const fy = h - 70;
  doc.moveTo(50, fy).lineTo(w - 50, fy).lineWidth(1).strokeColor(rgbStr(GOLD)).stroke();
  doc.fillColor(rgbStr(LIGHT_GRAY)).fontSize(7).font('Helvetica');
  doc.text(`${COMPANY.name}  |  ${COMPANY.address1}, ${COMPANY.address2}  |  ${COMPANY.phone}  |  ${COMPANY.web}`, 50, fy + 8, { width: w - 100, align: 'center' });
  doc.text('Maredin Wealth Advisors is a registered investment advisor. Past performance is not indicative of future results.', 50, fy + 20, { width: w - 100, align: 'center' });

  // Navy bottom band
  doc.rect(0, h - 25, w, 25).fill(rgbStr(NAVY));
  doc.fillColor(rgbStr(GOLD)).fontSize(6.5).font('Helvetica');
  doc.text(COMPANY.tagline, 50, h - 18, { width: w - 100, align: 'center' });
}

function rgbStr(arr) {
  return `#${arr.map(v => v.toString(16).padStart(2, '0')).join('')}`;
}

module.exports = router;
