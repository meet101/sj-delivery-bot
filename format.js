// ─── format.js ────────────────────────────────────────────────────────────────
// Applies formatting to "All Deliveries" and "Summary" tabs.
// Safe to run multiple times — clears existing formatting first.
// Usage: node format.js

require('dotenv').config();
const { google } = require('googleapis');

const SPREADSHEET_ID     = process.env.GOOGLE_SPREADSHEET_ID;
const ALL_DELIVERIES_TAB = 'All Deliveries';
const SUMMARY_TAB        = 'Summary';

// Colors
const C = {
  headerBg:    { red: 0.102, green: 0.451, blue: 0.251 }, // dark green
  headerText:  { red: 1,     green: 1,     blue: 1     }, // white
  bandOdd:     { red: 1,     green: 1,     blue: 1     }, // white
  bandEven:    { red: 0.91,  green: 0.961, blue: 0.914 }, // very light green
  positive:    { red: 0.718, green: 0.882, blue: 0.804 }, // green
  negative:    { red: 0.957, green: 0.780, blue: 0.765 }, // red
  zero:        { red: 0.95,  green: 0.95,  blue: 0.95  }, // light gray
};

async function getSheetsClient() {
  const auth = new google.auth.GoogleAuth({
    keyFile: 'google-credentials.json',
    scopes: ['https://www.googleapis.com/auth/spreadsheets'],
  });
  return google.sheets({ version: 'v4', auth: await auth.getClient() });
}

function headerRequest(sheetId, numCols) {
  return {
    repeatCell: {
      range: { sheetId, startRowIndex: 0, endRowIndex: 1, startColumnIndex: 0, endColumnIndex: numCols },
      cell: {
        userEnteredFormat: {
          backgroundColor: C.headerBg,
          textFormat: { foregroundColor: C.headerText, bold: true, fontSize: 11 },
          horizontalAlignment: 'CENTER',
          verticalAlignment: 'MIDDLE',
          wrapStrategy: 'CLIP'
        }
      },
      fields: 'userEnteredFormat(backgroundColor,textFormat,horizontalAlignment,verticalAlignment,wrapStrategy)'
    }
  };
}

function freezeRequest(sheetId) {
  return {
    updateSheetProperties: {
      properties: { sheetId, gridProperties: { frozenRowCount: 1 } },
      fields: 'gridProperties.frozenRowCount'
    }
  };
}

function filterRequest(sheetId, numCols) {
  return {
    setBasicFilter: {
      filter: { range: { sheetId, startRowIndex: 0, startColumnIndex: 0, endColumnIndex: numCols } }
    }
  };
}

function bandingRequest(sheetId, numCols) {
  return {
    addBanding: {
      bandedRange: {
        range: { sheetId, startRowIndex: 1, endRowIndex: 2000, startColumnIndex: 0, endColumnIndex: numCols },
        rowProperties: {
          firstBandColor:  C.bandOdd,
          secondBandColor: C.bandEven
        }
      }
    }
  };
}

function varianceColorRequests(sheetId, colIndex) {
  return [
    {
      addConditionalFormatRule: {
        rule: {
          ranges: [{ sheetId, startRowIndex: 1, startColumnIndex: colIndex, endColumnIndex: colIndex + 1 }],
          booleanRule: {
            condition: { type: 'NUMBER_GREATER', values: [{ userEnteredValue: '0' }] },
            format: { backgroundColor: C.positive }
          }
        }, index: 0
      }
    },
    {
      addConditionalFormatRule: {
        rule: {
          ranges: [{ sheetId, startRowIndex: 1, startColumnIndex: colIndex, endColumnIndex: colIndex + 1 }],
          booleanRule: {
            condition: { type: 'NUMBER_LESS', values: [{ userEnteredValue: '0' }] },
            format: { backgroundColor: C.negative }
          }
        }, index: 1
      }
    },
    {
      addConditionalFormatRule: {
        rule: {
          ranges: [{ sheetId, startRowIndex: 1, startColumnIndex: colIndex, endColumnIndex: colIndex + 1 }],
          booleanRule: {
            condition: { type: 'NUMBER_EQ', values: [{ userEnteredValue: '0' }] },
            format: { backgroundColor: C.zero }
          }
        }, index: 2
      }
    }
  ];
}

function columnWidthRequests(sheetId, widths) {
  return widths.map((width, i) => ({
    updateDimensionProperties: {
      range: { sheetId, dimension: 'COLUMNS', startIndex: i, endIndex: i + 1 },
      properties: { pixelSize: width },
      fields: 'pixelSize'
    }
  }));
}

async function clearExistingFormatting(sheets, sheetId) {
  // Get existing banded ranges to delete
  const meta = await sheets.spreadsheets.get({ spreadsheetId: SPREADSHEET_ID });
  const sheet = meta.data.sheets.find(s => s.properties.sheetId === sheetId);
  const bands = sheet?.bandedRanges || [];
  const rules = sheet?.conditionalFormats || [];

  const requests = [];

  // Delete existing bands
  bands.forEach(b => requests.push({ deleteBanding: { bandedRangeId: b.bandedRangeId } }));

  // Delete conditional format rules (delete from highest index first)
  rules.forEach((_, i) => requests.push({
    deleteConditionalFormatRule: { sheetId, index: 0 } // always delete index 0 as they shift
  }));

  if (requests.length) {
    // Delete bands first, then rules separately to avoid index conflicts
    const bandReqs  = requests.filter(r => r.deleteBanding);
    const ruleReqs  = rules.map(() => ({ deleteConditionalFormatRule: { sheetId, index: 0 } }));

    if (bandReqs.length) {
      await sheets.spreadsheets.batchUpdate({ spreadsheetId: SPREADSHEET_ID, resource: { requests: bandReqs } });
    }
    for (let i = 0; i < ruleReqs.length; i++) {
      await sheets.spreadsheets.batchUpdate({ spreadsheetId: SPREADSHEET_ID, resource: { requests: [ruleReqs[i]] } });
    }
  }
}

async function formatSheet(sheets, sheetId, numCols, varianceColIndex, colWidths, label) {
  process.stdout.write(`Formatting "${label}" … `);

  await clearExistingFormatting(sheets, sheetId);

  const requests = [
    headerRequest(sheetId, numCols),
    freezeRequest(sheetId),
    filterRequest(sheetId, numCols),
    bandingRequest(sheetId, numCols),
    ...varianceColorRequests(sheetId, varianceColIndex),
    ...columnWidthRequests(sheetId, colWidths)
  ];

  await sheets.spreadsheets.batchUpdate({ spreadsheetId: SPREADSHEET_ID, resource: { requests } });
  console.log('✅');
}

async function main() {
  const sheets = await getSheetsClient();
  const meta   = await sheets.spreadsheets.get({ spreadsheetId: SPREADSHEET_ID });

  const find = name => meta.data.sheets.find(s => s.properties.title === name);

  const allTab = find(ALL_DELIVERIES_TAB);
  const sumTab = find(SUMMARY_TAB);

  if (!allTab) { console.log(`❌ Tab "${ALL_DELIVERIES_TAB}" not found. Run import.js or migrate.js first.`); process.exit(1); }
  if (!sumTab)  { console.log(`❌ Tab "${SUMMARY_TAB}" not found. Run import.js or migrate.js first.`); process.exit(1); }

  console.log('\n🎨 Applying formatting to Google Sheet...\n');

  // All Deliveries: Date Order Seq DeliveryTo Category ItemName Code Ordered Delivered Variance
  // Cols:           0    1     2   3          4        5        6    7       8         9
  await formatSheet(sheets, allTab.properties.sheetId, 10, 9,
    [90, 70, 45, 160, 80, 150, 60, 65, 70, 70],
    ALL_DELIVERIES_TAB
  );

  // Summary: Date Order Seq DeliveryTo TotalItems TotalOrdered TotalDelivered Variance
  // Cols:    0    1     2   3          4          5            6              7
  await formatSheet(sheets, sumTab.properties.sheetId, 8, 7,
    [90, 70, 45, 160, 80, 100, 110, 70],
    SUMMARY_TAB
  );

  console.log('\n✅ Done! Open your Google Sheet to see the changes.\n');
}

main().catch(err => { console.error('\n❌', err.message); process.exit(1); });
