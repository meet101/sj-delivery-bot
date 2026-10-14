require('dotenv').config();
const { Client, LocalAuth } = require('whatsapp-web.js');
const qrcode = require('qrcode-terminal');
const Anthropic = require('@anthropic-ai/sdk');
const { google } = require('googleapis');

// ─── Config ───────────────────────────────────────────────────────────────────
const GROUP_NAME     = process.env.WHATSAPP_GROUP_NAME;
const SPREADSHEET_ID = process.env.GOOGLE_SPREADSHEET_ID;
const TIMEZONE       = process.env.TIMEZONE || 'Asia/Kolkata';

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

// Format date string e.g. "October 08, 2026" → "08 Oct 2026"
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

// Build tab name e.g. "Order 149 - Seq 5 - 08 Oct 2026"
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

// Create a new tab with headers, or skip if it already exists
async function getOrCreateTab(sheets, tabName) {
  const meta = await sheets.spreadsheets.get({ spreadsheetId: SPREADSHEET_ID });
  const exists = meta.data.sheets.some(s => s.properties.title === tabName);

  if (!exists) {
    await sheets.spreadsheets.batchUpdate({
      spreadsheetId: SPREADSHEET_ID,
      resource: { requests: [{ addSheet: { properties: { title: tabName } } }] }
    });
    // Write headers on the new tab
    await sheets.spreadsheets.values.update({
      spreadsheetId: SPREADSHEET_ID,
      range: `'${tabName}'!A1`,
      valueInputOption: 'RAW',
      resource: { values: [HEADERS] }
    });
    console.log(`   📋 Created new tab: "${tabName}"`);
  } else {
    console.log(`   📋 Tab already exists: "${tabName}" — appending`);
  }
}

async function writeToTab(tabName, rows) {
  const sheets = await getSheetsClient();
  await getOrCreateTab(sheets, tabName);
  await sheets.spreadsheets.values.append({
    spreadsheetId: SPREADSHEET_ID,
    range: `'${tabName}'!A:K`,
    valueInputOption: 'USER_ENTERED',
    resource: { values: rows }
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
  } catch (err) {
    // Try to salvage a truncated response by closing the array
    const lastComma = clean.lastIndexOf('},');
    if (lastComma !== -1) {
      const salvaged = clean.slice(0, lastComma + 1) + ']';
      try {
        const items = JSON.parse(salvaged);
        console.log(`   ⚠️  Response truncated — salvaged ${items.length} items`);
        return items;
      } catch {}
    }
    console.error('   Raw response snippet:', clean.slice(-200));
    throw new Error(`JSON parse failed: ${err.message}`);
  }
}

// ─── WhatsApp Bot ─────────────────────────────────────────────────────────────
const client = new Client({
  authStrategy: new LocalAuth({ clientId: 'delivery-bot' }),
  puppeteer: {
    executablePath: '/usr/bin/chromium-browser',
    args: [
      '--no-sandbox',
      '--disable-setuid-sandbox',
      '--disable-dev-shm-usage',
      '--disable-gpu'
    ]
  }
});

client.on('qr', qr => {
  console.log('\n📱 Open WhatsApp → Settings → Linked Devices → Link a Device, then scan:\n');
  qrcode.generate(qr, { small: true });
});

client.on('ready', () => {
  console.log(`\n✅ Bot is live on Google Cloud! Watching: "${GROUP_NAME}"\n`);
});

client.on('auth_failure', () => {
  console.error('❌ Auth failed. Delete .wwebjs_auth and restart.');
  process.exit(1);
});

client.on('disconnected', () => {
  console.warn('⚠️  Disconnected. Reconnecting in 5s...');
  setTimeout(() => client.initialize(), 5000);
});

client.on('message_create', async msg => {
  if (!msg.hasMedia || msg.fromMe || msg.type !== 'document') return;

  const chat = await msg.getChat();
  if (!chat.isGroup || chat.name !== GROUP_NAME) return;

  const filename = (msg._data.filename || '').toLowerCase();
  if (!filename.startsWith('delivery_')) {
    console.log(`   ⏭️  Skipping "${msg._data.filename}" — not a delivery PDF`);
    return;
  }

  const media = await msg.downloadMedia();
  if (!media || media.mimetype !== 'application/pdf') return;

  const sender = msg._data.notifyName || msg.from;
  console.log(`\n📄 PDF from "${sender}": ${msg._data.filename || 'document.pdf'}`);

  try {
    console.log('   🔍 Reading with Claude...');
    const items = await extractFromPDF(media.data);

    const tabName    = makeTabName(items);
    const receivedAt = new Date().toLocaleString('en-IN', { timeZone: TIMEZONE });

    const rows = items.map(i => [
      receivedAt,
      i.date         || '',
      i.order_no     || '',
      i.delivery_seq || '',
      i.requested_by || '',
      i.delivery_to  || '',
      i.category     || '',
      i.item_name    || '',
      i.item_code    || '',
      i.ordered      ?? '',
      i.delivered    ?? ''
    ]);

    await writeToTab(tabName, rows);
    console.log(`   ✅ ${rows.length} rows → tab "${tabName}"`);

  } catch (err) {
    console.error('   ❌ Error:', err.message);
  }
});

console.log('🚀 Starting bot...');
client.initialize();
