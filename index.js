require('dotenv').config();
const { default: makeWASocket, useMultiFileAuthState, DisconnectReason, makeInMemoryStore } = require('@whiskeysockets/baileys');
const { Boom } = require('@hapi/boom');
const Anthropic = require('@anthropic-ai/sdk');
const { google } = require('googleapis');
const qrcode = require('qrcode-terminal');
const pino = require('pino');
const path = require('path');

// ─── Config ───────────────────────────────────────────────────────────────────
const GROUP_NAME          = process.env.WHATSAPP_GROUP_NAME;
const SPREADSHEET_ID      = process.env.GOOGLE_SPREADSHEET_ID;
const TIMEZONE            = process.env.TIMEZONE || 'Asia/Kolkata';
const AUTH_FOLDER         = path.join(__dirname, 'wa_auth');
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

async function isDuplicate(sheets, orderNo, deliverySeq) {
  try {
    const res = await sheets.spreadsheets.values.get({
      spreadsheetId: SPREADSHEET_ID,
      range: `'${SUMMARY_TAB}'!B:C`  // Order No, Seq columns
    });
    const rows = res.data.values || [];
    return rows.some(r => String(r[0]) === String(orderNo) && String(r[1]) === String(deliverySeq));
  } catch {
    return false;
  }
}

async function writeDelivery(items) {
  const sheets = await getSheetsClient();
  await ensureTab(sheets, ALL_DELIVERIES_TAB, ALL_DELIVERIES_HEADERS);
  await ensureTab(sheets, SUMMARY_TAB, SUMMARY_HEADERS);

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

// ─── Claude PDF Extraction ────────────────────────────────────────────────────
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
    const i = clean.lastIndexOf('},');
    if (i !== -1) {
      try {
        const r = JSON.parse(clean.slice(0, i + 1) + ']');
        console.log(`   ⚠️  Truncated — salvaged ${r.length} items`);
        return r;
      } catch {}
    }
    throw new Error('JSON parse failed');
  }
}

// ─── WhatsApp Bot (Baileys — no browser needed) ───────────────────────────────
async function startBot() {
  const { state, saveCreds } = await useMultiFileAuthState(AUTH_FOLDER);

  const sock = makeWASocket({
    auth: state,
    logger: pino({ level: 'silent' }), // suppress Baileys internal logs
    printQRInTerminal: false
  });

  sock.ev.on('creds.update', saveCreds);

  sock.ev.on('connection.update', ({ connection, lastDisconnect, qr }) => {
    if (qr) {
      console.log('\n📱 Scan in WhatsApp → Settings → Linked Devices → Link a Device:\n');
      qrcode.generate(qr, { small: true });
    }
    if (connection === 'open') {
      console.log(`\n✅ Bot is live! Watching: "${GROUP_NAME}"\n`);
    }
    if (connection === 'close') {
      const code = new Boom(lastDisconnect?.error)?.output?.statusCode;
      const shouldReconnect = code !== DisconnectReason.loggedOut;
      console.log(`⚠️  Disconnected (${code}). ${shouldReconnect ? 'Reconnecting...' : 'Logged out.'}`);
      if (shouldReconnect) setTimeout(startBot, 5000);
    }
  });

  sock.ev.on('messages.upsert', async ({ messages, type }) => {
    if (type !== 'notify') return;

    for (const msg of messages) {
      try {
        // Only handle messages with document attachments
        const content = msg.message;
        if (!content) continue;

        const docMsg = content.documentMessage;
        if (!docMsg) continue;

        const filename = docMsg.fileName || '';
        const mimetype = docMsg.mimetype || '';

        console.log(`📨 file="${filename}" mimetype="${mimetype}" group=${msg.key.remoteJid}`);

        // Only PDFs
        if (mimetype !== 'application/pdf') continue;

        // Only Delivery_ files
        if (!filename.toLowerCase().startsWith('delivery_')) {
          console.log(`   ⏭️  Skipping — filename doesn't start with Delivery_`);
          continue;
        }

        // Get group name
        const jid = msg.key.remoteJid;
        if (!jid.endsWith('@g.us')) {
          console.log(`   ⏭️  Skipping — not a group message`);
          continue;
        }

        const groupMeta = await sock.groupMetadata(jid);
        const groupName = groupMeta.subject;

        console.log(`   Group: "${groupName}"`);

        if (groupName !== GROUP_NAME) {
          console.log(`   ⏭️  Skipping — group doesn't match "${GROUP_NAME}"`);
          continue;
        }

        console.log(`\n📄 PDF: ${filename}`);

        // Download the PDF
        const { downloadMediaMessage } = require('@whiskeysockets/baileys');
        const buffer = await downloadMediaMessage(msg, 'buffer', {});
        const base64 = buffer.toString('base64');

        console.log('   🔍 Reading with Claude...');
        const items = await extractFromPDF(base64);
        const first = items[0] || {};

        // Check for duplicate before writing
        const sheets = await getSheetsClient();
        const dup = await isDuplicate(sheets, first.order_no, first.delivery_seq);
        if (dup) {
          console.log(`   ⏭️  Skipping — Order ${first.order_no} Seq ${first.delivery_seq} already in sheet`);
          return;
        }

        await writeDelivery(items);
        console.log(`   ✅ ${items.length} items → Order ${first.order_no} Seq ${first.delivery_seq}`);

      } catch (err) {
        console.error('   ❌ Error:', err.message);
      }
    }
  });
}

console.log('🚀 Starting bot (Baileys — no browser needed)...');
startBot();
