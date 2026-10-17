require('dotenv').config();
const Anthropic = require('@anthropic-ai/sdk');
const { google } = require('googleapis');
const fs = require('fs');
const path = require('path');

const SPREADSHEET_ID      = process.env.GOOGLE_SPREADSHEET_ID;
const TIMEZONE            = process.env.TIMEZONE || 'Asia/Kolkata';
const PDF_DIR             = path.join(__dirname, 'pdfs');
const TRACKING_FILE       = path.join(__dirname, '.processed.json');
const ALL_DELIVERIES_TAB  = 'All Deliveries';
const SUMMARY_TAB         = 'Summary';

const ALL_DELIVERIES_HEADERS = [
  'Date', 'Order No', 'Seq', 'Delivery To',
  'Category', 'Item Name', 'Item Code', 'Ordered', 'Delivered', 'Variance'
];
const SUMMARY_HEADERS = [
  'Date', 'Order No', 'Seq', 'Delivery To',
  'Total Items', 'Total Ordered', 'Total Delivered', 'Variance'
];

// ─── Tracking ─────────────────────────────────────────────────────────────────
function loadProcessed() {
  try { return new Set(JSON.parse(fs.readFileSync(TRACKING_FILE, 'utf8'))); }
  catch { return new Set(); }
}
function markProcessed(filename) {
  const p = loadProcessed(); p.add(filename);
  fs.writeFileSync(TRACKING_FILE, JSON.stringify([...p], null, 2));
}

// ─── Google Sheets ────────────────────────────────────────────────────────────
async function getSheetsClient() {
  const auth = new google.auth.GoogleAuth({
    keyFile: 'google-credentials.json',
    scopes: ['https://www.googleapis.com/auth/spreadsheets'],
  });
  return google.sheets({ version: 'v4', auth: await auth.getClient() });
}

async function ensureTab(sheets, tabName, headers) {
  const meta = await sheets.spreadsheets.get({ spreadsheetId: SPREADSHEET_ID });
  const exists = meta.data.sheets.some(s => s.properties.title === tabName);
  if (!exists) {
    await sheets.spreadsheets.batchUpdate({
      spreadsheetId: SPREADSHEET_ID,
      resource: { requests: [{ addSheet: { properties: { title: tabName } } }] }
    });
    await sheets.spreadsheets.values.update({
      spreadsheetId: SPREADSHEET_ID,
      range: `'${tabName}'!A1`,
      valueInputOption: 'RAW',
      resource: { values: [headers] }
    });
  }
}

async function writeDelivery(sheets, items) {
  const first = items[0] || {};

  const detailRows = items.map(i => {
    const variance = (Number(i.delivered) || 0) - (Number(i.ordered) || 0);
    return [
      i.date || '', i.order_no || '', i.delivery_seq || '', i.delivery_to || '',
      i.category || '', i.item_name || '', i.item_code || '',
      i.ordered ?? '', i.delivered ?? '', variance
    ];
  });

  await sheets.spreadsheets.values.append({
    spreadsheetId: SPREADSHEET_ID,
    range: `'${ALL_DELIVERIES_TAB}'!A:J`,
    valueInputOption: 'USER_ENTERED',
    resource: { values: detailRows }
  });

  const totalOrdered   = items.reduce((s, i) => s + (Number(i.ordered)   || 0), 0);
  const totalDelivered = items.reduce((s, i) => s + (Number(i.delivered) || 0), 0);

  await sheets.spreadsheets.values.append({
    spreadsheetId: SPREADSHEET_ID,
    range: `'${SUMMARY_TAB}'!A:H`,
    valueInputOption: 'USER_ENTERED',
    resource: { values: [[
      first.date || '', first.order_no || '', first.delivery_seq || '', first.delivery_to || '',
      items.length, totalOrdered, totalDelivered, totalDelivered - totalOrdered
    ]]}
  });
}

// ─── Claude ───────────────────────────────────────────────────────────────────
const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

const PROMPT = `Extract all data from this delivery order PDF.
Return ONLY a valid JSON array — no markdown, no explanation.
Each element is one line item with exactly these keys:
{
  "date": "document date as written", "order_no": "SellOrder No value",
  "delivery_seq": "Delivery Sequence No value", "requested_by": "RequestedBy value",
  "delivery_to": "delivery destination name",
  "category": "section heading this item falls under (e.g. Sweet, Gathiya, Sev)",
  "item_name": "item name without the code",
  "item_code": "digits only from parentheses e.g. 53001",
  "ordered": ordered quantity as a number, "delivered": delivered quantity as a number
}
Header fields repeat on every row. One object per line item.`;

async function extractFromPDF(base64Data) {
  const response = await anthropic.messages.create({
    model: 'claude-haiku-4-5', max_tokens: 8000,
    messages: [{ role: 'user', content: [
      { type: 'document', source: { type: 'base64', media_type: 'application/pdf', data: base64Data } },
      { type: 'text', text: PROMPT }
    ]}]
  });
  const raw   = response.content[0].text.trim();
  const clean = raw.replace(/^```(?:json)?\n?/, '').replace(/\n?```$/, '').trim();
  try { return JSON.parse(clean); } catch {
    const i = clean.lastIndexOf('},');
    if (i !== -1) { try { const r = JSON.parse(clean.slice(0,i+1)+']'); console.log(`   ⚠️  Salvaged ${r.length} items`); return r; } catch {} }
    throw new Error('JSON parse failed');
  }
}

// ─── Main ─────────────────────────────────────────────────────────────────────
async function main() {
  if (!fs.existsSync(PDF_DIR)) {
    fs.mkdirSync(PDF_DIR);
    console.log('\n📁 Created "pdfs" folder. Add your PDFs and run again.\n');
    return;
  }

  const files = fs.readdirSync(PDF_DIR)
    .filter(f => f.toLowerCase().endsWith('.pdf') && f.toLowerCase().startsWith('delivery_'))
    .sort();

  if (!files.length) { console.log('\n⚠️  No Delivery_*.pdf files found in ./pdfs/\n'); return; }

  console.log(`\n📂 Found ${files.length} PDF(s):\n`);
  files.forEach((f, i) => console.log(`   ${i+1}. ${f}`));
  console.log('');

  const processed = loadProcessed();
  const sheets    = await getSheetsClient();
  await ensureTab(sheets, ALL_DELIVERIES_TAB, ALL_DELIVERIES_HEADERS);
  await ensureTab(sheets, SUMMARY_TAB, SUMMARY_HEADERS);

  let done = 0, skipped = 0, failed = 0;

  for (let i = 0; i < files.length; i++) {
    const filename = files[i];
    process.stdout.write(`[${i+1}/${files.length}] ${filename} … `);

    if (processed.has(filename)) { console.log('skipped (already done)'); skipped++; continue; }

    try {
      const base64 = fs.readFileSync(path.join(PDF_DIR, filename)).toString('base64');
      const items  = await extractFromPDF(base64);
      await writeDelivery(sheets, items);
      markProcessed(filename);
      const f = items[0] || {};
      console.log(`✅  ${items.length} items → Order ${f.order_no} Seq ${f.delivery_seq}`);
      done++;
    } catch (err) {
      console.log(`❌  ${err.message}`);
      failed++;
    }

    if (i < files.length - 1) await new Promise(r => setTimeout(r, 3000));
  }

  console.log(`\n─────────────────────────────`);
  console.log(`  Imported : ${done}`);
  if (skipped) console.log(`  Skipped  : ${skipped}`);
  if (failed)  console.log(`  Failed   : ${failed}`);
  console.log(`─────────────────────────────\n`);
}

main().catch(err => { console.error('\n❌', err.message); process.exit(1); });
