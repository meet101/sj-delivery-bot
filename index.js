require('dotenv').config();
const { Client, LocalAuth } = require('whatsapp-web.js');
const qrcode = require('qrcode-terminal');
const Anthropic = require('@anthropic-ai/sdk');
const { google } = require('googleapis');

// ─── Config ───────────────────────────────────────────────────────────────────
const GROUP_NAME     = process.env.WHATSAPP_GROUP_NAME;
const SPREADSHEET_ID = process.env.GOOGLE_SPREADSHEET_ID;
const TIMEZONE       = process.env.TIMEZONE || 'Asia/Kolkata';

const ALL_DELIVERIES_TAB = 'All Deliveries';
const SUMMARY_TAB        = 'Summary';

const ALL_DELIVERIES_HEADERS = [
  'Date', 'Order No', 'Seq', 'Delivery To',
  'Category', 'Item Name', 'Item Code', 'Ordered', 'Delivered', 'Variance'
];

const SUMMARY_HEADERS = [
  'Date', 'Order No', 'Seq', 'Delivery To',
  'Total Items', 'Total Ordered', 'Total Delivered', 'Variance'
];

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
    console.log(`   📋 Created tab: "${tabName}"`);
  }
}

async function writeDelivery(items) {
  const sheets = await getSheetsClient();
  await ensureTab(sheets, ALL_DELIVERIES_TAB, ALL_DELIVERIES_HEADERS);
  await ensureTab(sheets, SUMMARY_TAB, SUMMARY_HEADERS);

  const first = items[0] || {};

  // ── All Deliveries rows ──────────────────────────────────────────────────
  const detailRows = items.map(i => {
    const variance = (Number(i.delivered) || 0) - (Number(i.ordered) || 0);
    return [
      i.date         || '',
      i.order_no     || '',
      i.delivery_seq || '',
      i.delivery_to  || '',
      i.category     || '',
      i.item_name    || '',
      i.item_code    || '',
      i.ordered      ?? '',
      i.delivered    ?? '',
      variance
    ];
  });

  await sheets.spreadsheets.values.append({
    spreadsheetId: SPREADSHEET_ID,
    range: `'${ALL_DELIVERIES_TAB}'!A:J`,
    valueInputOption: 'USER_ENTERED',
    resource: { values: detailRows }
  });

  // ── Summary row ──────────────────────────────────────────────────────────
  const totalOrdered   = items.reduce((s, i) => s + (Number(i.ordered)   || 0), 0);
  const totalDelivered = items.reduce((s, i) => s + (Number(i.delivered) || 0), 0);

  await sheets.spreadsheets.values.append({
    spreadsheetId: SPREADSHEET_ID,
    range: `'${SUMMARY_TAB}'!A:H`,
    valueInputOption: 'USER_ENTERED',
    resource: { values: [[
      first.date         || '',
      first.order_no     || '',
      first.delivery_seq || '',
      first.delivery_to  || '',
      items.length,
      totalOrdered,
      totalDelivered,
      totalDelivered - totalOrdered
    ]]}
  });
}

// ─── Claude PDF Extraction ────────────────────────────────────────────────────
const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

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
  const response = await anthropic.messages.create({
    model: 'claude-haiku-4-5',
    max_tokens: 8000,
    messages: [{
      role: 'user',
      content: [
        { type: 'document', source: { type: 'base64', media_type: 'application/pdf', data: base64Data } },
        { type: 'text', text: PROMPT }
      ]
    }]
  });

  const raw   = response.content[0].text.trim();
  const clean = raw.replace(/^```(?:json)?\n?/, '').replace(/\n?```$/, '').trim();

  try {
    return JSON.parse(clean);
  } catch {
    const lastComma = clean.lastIndexOf('},');
    if (lastComma !== -1) {
      try {
        const items = JSON.parse(clean.slice(0, lastComma + 1) + ']');
        console.log(`   ⚠️  Truncated — salvaged ${items.length} items`);
        return items;
      } catch {}
    }
    throw new Error('JSON parse failed');
  }
}

// ─── WhatsApp Bot ─────────────────────────────────────────────────────────────
const client = new Client({
  authStrategy: new LocalAuth({ clientId: 'delivery-bot' }),
  puppeteer: {
    executablePath: '/usr/bin/chromium-browser',
    args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage', '--disable-gpu']
  }
});

client.on('qr', qr => {
  console.log('\n📱 Scan in WhatsApp → Settings → Linked Devices → Link a Device:\n');
  qrcode.generate(qr, { small: true });
});
client.on('ready', () => console.log(`\n✅ Bot is live on Google Cloud! Watching: "${GROUP_NAME}"\n`));
client.on('auth_failure', () => { console.error('❌ Auth failed.'); process.exit(1); });
client.on('disconnected', () => { console.warn('⚠️  Reconnecting...'); setTimeout(() => client.initialize(), 5000); });

client.on('message_create', async msg => {
  if (!msg.hasMedia || msg.fromMe || msg.type !== 'document') return;

  const filename = (msg._data.filename || '').toLowerCase();
  if (!filename.startsWith('delivery_')) {
    console.log(`   ⏭️  Skipping "${msg._data.filename}" — not a delivery PDF`);
    return;
  }

  const chat = await msg.getChat();
  if (!chat.isGroup || chat.name !== GROUP_NAME) return;

  const media = await msg.downloadMedia();
  if (!media || media.mimetype !== 'application/pdf') return;

  const sender = msg._data.notifyName || msg.from;
  console.log(`\n📄 PDF from "${sender}": ${msg._data.filename}`);

  try {
    console.log('   🔍 Reading with Claude...');
    const items = await extractFromPDF(media.data);
    await writeDelivery(items);
    const first = items[0] || {};
    console.log(`   ✅ ${items.length} items → Order ${first.order_no} Seq ${first.delivery_seq}`);
  } catch (err) {
    console.error('   ❌ Error:', err.message);
  }
});

console.log('🚀 Starting bot...');
client.initialize();
