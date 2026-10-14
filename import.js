// ─── Local PDF Importer ───────────────────────────────────────────────────────
// Run on your own PC to process old delivery PDFs.
// Put all your PDFs in a ./pdfs/ folder, then: node import.js
// Uses the same .env and google-credentials.json as the bot.

require('dotenv').config();
const { GoogleGenerativeAI } = require('@google/generative-ai');
const { google } = require('googleapis');
const fs = require('fs');
const path = require('path');

const SPREADSHEET_ID = process.env.GOOGLE_SPREADSHEET_ID;
const TIMEZONE       = process.env.TIMEZONE || 'Asia/Kolkata';
const PDF_DIR        = path.join(__dirname, 'pdfs');

const HEADERS = [
  'Received At', 'Date', 'Order No', 'Delivery Seq No',
  'Requested By', 'Delivery To', 'Category', 'Item Name',
  'Item Code', 'Ordered', 'Delivered'
];

// ─── Google Sheets ────────────────────────────────────────────────────────────
async function getSheetsClient() {
  const auth = new google.auth.GoogleAuth({
    keyFile: 'google-credentials.json',
    scopes: ['https://www.googleapis.com/auth/spreadsheets'],
  });
  return google.sheets({ version: 'v4', auth: await auth.getClient() });
}

async function listExistingTabs(sheets) {
  const meta = await sheets.spreadsheets.get({ spreadsheetId: SPREADSHEET_ID });
  return meta.data.sheets.map(s => s.properties.title);
}

async function createTab(sheets, tabName) {
  await sheets.spreadsheets.batchUpdate({
    spreadsheetId: SPREADSHEET_ID,
    resource: { requests: [{ addSheet: { properties: { title: tabName } } }] }
  });
  await sheets.spreadsheets.values.update({
    spreadsheetId: SPREADSHEET_ID,
    range: `'${tabName}'!A1`,
    valueInputOption: 'RAW',
    resource: { values: [HEADERS] }
  });
}

async function appendToTab(sheets, tabName, rows) {
  await sheets.spreadsheets.values.append({
    spreadsheetId: SPREADSHEET_ID,
    range: `'${tabName}'!A:K`,
    valueInputOption: 'USER_ENTERED',
    resource: { values: rows }
  });
}

// ─── Gemini ───────────────────────────────────────────────────────────────────
const genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY);

const PROMPT = `Extract all data from this delivery order PDF.
Return ONLY a valid JSON array — no markdown, no explanation.
Each element is one line item with exactly these keys:
{
  "date":          "document date as written",
  "order_no":      "SellOrder No value",
  "delivery_seq":  "Delivery Sequence No value",
  "requested_by":  "RequestedBy value",
  "delivery_to":   "delivery destination name",
  "category":      "section heading this item falls under (e.g. Sweet, Gathiya, Sev)",
  "item_name":     "item name without the code",
  "item_code":     "digits only from parentheses e.g. 53001",
  "ordered":       ordered quantity as a number,
  "delivered":     delivered quantity as a number
}
Header fields repeat on every row. One object per line item.`;

async function extractFromPDF(base64Data) {
  const model = genAI.getGenerativeModel({ model: 'gemini-2.0-flash' });
  const result = await model.generateContent([
    { inlineData: { mimeType: 'application/pdf', data: base64Data } },
    PROMPT
  ]);
  const raw   = result.response.text().trim();
  const clean = raw.replace(/^```(?:json)?\n?/, '').replace(/\n?```$/, '').trim();
  return JSON.parse(clean);
}

function formatTabDate(dateStr) {
  if (!dateStr) return '';
  try {
    const d = new Date(dateStr);
    if (isNaN(d)) return '';
    const day = d.getDate().toString().padStart(2, '0');
    const mon = d.toLocaleString('en', { month: 'short' });
    return `${day} ${mon} ${d.getFullYear()}`;
  } catch { return ''; }
}

function makeTabName(items) {
  const first   = items[0] || {};
  const orderNo = (first.order_no     || 'Unknown').toString().replace(/[\/\\?*[\]:]/g, '-');
  const seq     = (first.delivery_seq || '').toString().replace(/[\/\\?*[\]:]/g, '-');
  const date    = formatTabDate(first.date || '');
  return [
    `Order ${orderNo}`,
    seq  ? `Seq ${seq}` : null,
    date || null
  ].filter(Boolean).join(' - ').slice(0, 100);
}

// ─── Main ─────────────────────────────────────────────────────────────────────
async function main() {
  // Ensure pdfs/ folder exists
  if (!fs.existsSync(PDF_DIR)) {
    fs.mkdirSync(PDF_DIR);
    console.log('\n📁 Created a "pdfs" folder next to this script.');
    console.log('   Put your delivery PDFs inside it, then run:  node import.js\n');
    return;
  }

  const files = fs.readdirSync(PDF_DIR)
    .filter(f => f.toLowerCase().endsWith('.pdf'))
    .sort();

  if (files.length === 0) {
    console.log('\n⚠️  No PDFs found in the ./pdfs/ folder.');
    console.log('   Add your files and run again.\n');
    return;
  }

  console.log(`\n📂 Found ${files.length} PDF(s) to import:\n`);
  files.forEach((f, i) => console.log(`   ${i + 1}. ${f}`));
  console.log('');

  const sheets       = await getSheetsClient();
  const existingTabs = await listExistingTabs(sheets);

  let done = 0, skipped = 0, failed = 0;

  for (let i = 0; i < files.length; i++) {
    const filename = files[i];
    const filepath = path.join(PDF_DIR, filename);
    process.stdout.write(`[${i + 1}/${files.length}] ${filename} … `);

    try {
      const base64 = fs.readFileSync(filepath).toString('base64');
      const items   = await extractFromPDF(base64);
      const tabName = makeTabName(items);

      // Skip if this tab already exists (avoids duplicates on re-runs)
      if (existingTabs.includes(tabName)) {
        console.log(`skipped — tab "${tabName}" already exists`);
        skipped++;
        continue;
      }

      const receivedAt = new Date().toLocaleString('en-IN', { timeZone: TIMEZONE });
      const rows = items.map(item => [
        receivedAt,
        item.date         || '',
        item.order_no     || '',
        item.delivery_seq || '',
        item.requested_by || '',
        item.delivery_to  || '',
        item.category     || '',
        item.item_name    || '',
        item.item_code    || '',
        item.ordered      ?? '',
        item.delivered    ?? ''
      ]);

      await createTab(sheets, tabName);
      await appendToTab(sheets, tabName, rows);
      existingTabs.push(tabName); // track for rest of this run

      console.log(`✅  ${rows.length} items → "${tabName}"`);
      done++;

    } catch (err) {
      console.log(`❌  ${err.message}`);
      failed++;
    }

    // Pause between files to stay within Gemini free-tier rate limits
    if (i < files.length - 1) await new Promise(r => setTimeout(r, 2000));
  }

  console.log(`\n─────────────────────────────`);
  console.log(`  Imported : ${done}`);
  if (skipped) console.log(`  Skipped  : ${skipped} (already in sheet)`);
  if (failed)  console.log(`  Failed   : ${failed}`);
  console.log(`─────────────────────────────\n`);
}

main().catch(err => {
  console.error('\n❌ Fatal error:', err.message);
  process.exit(1);
});
