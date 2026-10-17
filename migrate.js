// ─── migrate.js ───────────────────────────────────────────────────────────────
// Reads all existing "Order X - Seq Y - Date" tabs and consolidates them
// into the new "All Deliveries" and "Summary" tabs, then deletes the old ones.
// Run once: node migrate.js

require('dotenv').config();
const { google } = require('googleapis');
const readline = require('readline');

const SPREADSHEET_ID      = process.env.GOOGLE_SPREADSHEET_ID;
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

async function getSheetsClient() {
  const auth = new google.auth.GoogleAuth({
    keyFile: 'google-credentials.json',
    scopes: ['https://www.googleapis.com/auth/spreadsheets'],
  });
  return google.sheets({ version: 'v4', auth: await auth.getClient() });
}

async function confirm(question) {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  return new Promise(resolve => rl.question(question, ans => { rl.close(); resolve(ans.toLowerCase() === 'y'); }));
}

async function main() {
  const sheets = await getSheetsClient();

  // Get all tabs
  const meta = await sheets.spreadsheets.get({ spreadsheetId: SPREADSHEET_ID });
  const allTabs = meta.data.sheets.map(s => ({
    id: s.properties.sheetId,
    title: s.properties.title
  }));

  // Find old-style delivery tabs (Order X - Seq Y or Order X - Seq Y - Date)
  const oldTabs = allTabs.filter(t => /^Order\s+\d+/.test(t.title));

  if (!oldTabs.length) {
    console.log('\n✅ No old-style tabs found — nothing to migrate.\n');
    return;
  }

  console.log(`\n📋 Found ${oldTabs.length} old tab(s) to migrate:`);
  oldTabs.forEach(t => console.log(`   • ${t.title}`));
  console.log('');

  const go = await confirm('Migrate all to "All Deliveries" + "Summary" tabs? (y/n): ');
  if (!go) { console.log('Aborted.\n'); return; }

  // Create new tabs if they don't exist
  const existingTitles = allTabs.map(t => t.title);
  for (const [tabName, headers] of [[ALL_DELIVERIES_TAB, ALL_DELIVERIES_HEADERS], [SUMMARY_TAB, SUMMARY_HEADERS]]) {
    if (!existingTitles.includes(tabName)) {
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
      console.log(`📋 Created tab: "${tabName}"`);
    }
  }

  let migratedTabs = 0;

  for (const tab of oldTabs) {
    process.stdout.write(`\n⏳ Migrating "${tab.title}" … `);

    try {
      // Read all rows from the old tab (skip header row)
      const res = await sheets.spreadsheets.values.get({
        spreadsheetId: SPREADSHEET_ID,
        range: `'${tab.title}'!A2:K`
      });

      const rows = res.data.values || [];
      if (!rows.length) { console.log('empty, skipping'); continue; }

      // Old columns: Received At, Date, Order No, Delivery Seq No, Requested By,
      //              Delivery To, Category, Item Name, Item Code, Ordered, Delivered
      // Indices:     0            1     2         3              4
      //              5            6         7          8          9        10

      const detailRows = rows.map(r => {
        const ordered   = Number(r[9])  || 0;
        const delivered = Number(r[10]) || 0;
        return [
          r[1] || '',   // Date
          r[2] || '',   // Order No
          r[3] || '',   // Seq
          r[5] || '',   // Delivery To
          r[6] || '',   // Category
          r[7] || '',   // Item Name
          r[8] || '',   // Item Code
          ordered,
          delivered,
          delivered - ordered
        ];
      });

      // Append to All Deliveries
      await sheets.spreadsheets.values.append({
        spreadsheetId: SPREADSHEET_ID,
        range: `'${ALL_DELIVERIES_TAB}'!A:J`,
        valueInputOption: 'USER_ENTERED',
        resource: { values: detailRows }
      });

      // Build summary row
      const first         = rows[0] || [];
      const totalOrdered   = detailRows.reduce((s, r) => s + (Number(r[7]) || 0), 0);
      const totalDelivered = detailRows.reduce((s, r) => s + (Number(r[8]) || 0), 0);

      await sheets.spreadsheets.values.append({
        spreadsheetId: SPREADSHEET_ID,
        range: `'${SUMMARY_TAB}'!A:H`,
        valueInputOption: 'USER_ENTERED',
        resource: { values: [[
          first[1] || '', first[2] || '', first[3] || '', first[5] || '',
          rows.length, totalOrdered, totalDelivered, totalDelivered - totalOrdered
        ]]}
      });

      console.log(`✅  ${rows.length} items`);
      migratedTabs++;

    } catch (err) {
      console.log(`❌  ${err.message}`);
    }
  }

  // Ask to delete old tabs
  console.log('');
  const del = await confirm(`Delete ${migratedTabs} old tab(s) from the sheet? (y/n): `);
  if (del) {
    const deleteRequests = oldTabs.map(t => ({ deleteSheet: { sheetId: t.id } }));
    await sheets.spreadsheets.batchUpdate({
      spreadsheetId: SPREADSHEET_ID,
      resource: { requests: deleteRequests }
    });
    console.log('🗑️  Old tabs deleted.');
  }

  console.log(`\n✅ Migration complete — ${migratedTabs} deliveries moved to new structure.\n`);
}

main().catch(err => { console.error('\n❌', err.message); process.exit(1); });
