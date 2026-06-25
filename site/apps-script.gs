/**
 * Slicely waitlist — Google Apps Script backend.
 *
 * Appends each landing-page form submission as a row in the bound Google Sheet.
 * See site/README.md for the full setup walkthrough.
 *
 * Quick version:
 *   1. Create a Google Sheet. Row 1 headers:  Timestamp | Name | Email | Usage | Comments
 *   2. Extensions ▸ Apps Script, paste this file, Save.
 *   3. Deploy ▸ New deployment ▸ type "Web app".
 *        Execute as: Me     Who has access: Anyone
 *   4. Copy the Web app URL and paste it into WAITLIST_ENDPOINT in site/main.js.
 */

function doPost(e) {
  try {
    var sheet = SpreadsheetApp.getActiveSpreadsheet().getSheets()[0];
    var p = (e && e.parameter) || {};
    sheet.appendRow([
      new Date(),
      p.name || '',
      p.email || '',
      p.usage || '',
      p.comments || ''
    ]);
    return ContentService
      .createTextOutput(JSON.stringify({ ok: true }))
      .setMimeType(ContentService.MimeType.JSON);
  } catch (err) {
    return ContentService
      .createTextOutput(JSON.stringify({ ok: false, error: String(err) }))
      .setMimeType(ContentService.MimeType.JSON);
  }
}

// Lets you sanity-check the deployment in a browser (returns a friendly note).
function doGet() {
  return ContentService.createTextOutput('Slicely waitlist endpoint is live.');
}
