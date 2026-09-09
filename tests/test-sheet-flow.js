// End-to-end check of the sheet + manual-segmentation workflow.
//
// Boots the real server against a throwaway data dir, then walks the whole path a
// volunteer and an admin take: register -> receive two sheets of ten lines -> upload
// one image per sheet -> admin draws a rectangle per line -> crops exist on disk and
// in labels.csv -> a rejected sheet is handed back to the volunteer -> a new set can
// be requested once both sheets are in.

const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');

const ROOT = path.join(os.tmpdir(), `ocr-sheet-test-${Date.now()}`);
fs.mkdirSync(ROOT, { recursive: true });

process.env.PERSISTENT_DATA_PATH = ROOT;
process.env.CONTRIBUTOR_SECRET = 'test-secret-for-sheet-flow';
process.env.ADMIN_USERNAME = 'admin';
process.env.PORT = '4137';
process.env.MAX_UPLOADS_PER_IP_PER_MINUTE = '500';
process.env.MAX_UPLOADS_PER_IP_PER_HOUR = '500';

const crypto = require('crypto');
const ADMIN_PASSWORD = 'sheet-test-password';
{
  const salt = crypto.randomBytes(16).toString('hex');
  const hash = crypto.scryptSync(ADMIN_PASSWORD, salt, 64).toString('hex');
  process.env.ADMIN_PASSWORD_HASH = `${salt}:${hash}`;
}

const BASE = `http://127.0.0.1:${process.env.PORT}`;

let passed = 0;
let failed = 0;

function check(name, condition, detail) {
  if (condition) {
    passed++;
    console.log(`  PASS  ${name}`);
  } else {
    failed++;
    console.log(`  FAIL  ${name}${detail ? ` — ${detail}` : ''}`);
  }
}

// A distinguishable page image per sheet, so dedup never collapses the two uploads.
async function makeSheetImage(sharp, seed) {
  const width = 1200;
  const height = 900;
  const svg = Buffer.from(
    `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}">
       <rect width="100%" height="100%" fill="white"/>
       ${Array.from({ length: 10 }, (_, i) =>
         `<text x="60" y="${70 + i * 80}" font-size="34" fill="black">line ${i + 1} seed ${seed}</text>`
       ).join('')}
     </svg>`
  );
  return sharp(svg).jpeg({ quality: 90 }).toBuffer();
}

async function main() {
  const sharp = require('sharp');

  // The server starts listening as a side effect of require().
  require('../server.js');
  await new Promise(r => setTimeout(r, 2500));

  const db = require('../database');

  // --- Seed the prompt bank -------------------------------------------------
  db.createPromptsBatch(
    Array.from({ length: 30 }, (_, i) => `جمله آزمایشی شماره ${i + 1}`),
    'sentences'
  );
  db.createPromptsBatch(
    Array.from({ length: 30 }, (_, i) => `${1000 + i}`),
    'numbers'
  );
  db.flushIfDirty();

  // --- Volunteer registers --------------------------------------------------
  const regRes = await fetch(`${BASE}/api/contributors/register`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ name: 'تست کاربر' }),
  });
  const reg = await regRes.json();
  check('contributor registration succeeds', reg.success && !!reg.token, JSON.stringify(reg));
  const token = reg.token;
  const authHeaders = { 'X-Contributor-Token': token };

  // --- Sheets ---------------------------------------------------------------
  const sheetsRes = await fetch(`${BASE}/api/sheets`, { headers: authHeaders });
  const sheets = await sheetsRes.json();

  check('GET /api/sheets returns both categories',
    sheets.success && sheets.sheets.sentences && sheets.sheets.numbers,
    JSON.stringify(sheets).slice(0, 300));
  check('sentence sheet has exactly 10 lines',
    sheets.sheets.sentences.items.length === 10,
    `got ${sheets.sheets.sentences?.items?.length}`);
  check('number sheet has exactly 10 lines',
    sheets.sheets.numbers.items.length === 10,
    `got ${sheets.sheets.numbers?.items?.length}`);
  check('sentence lines are numbered 1..10 in order',
    sheets.sheets.sentences.items.every((it, i) => it.line_no === i + 1));
  check('number sheet holds only number prompts',
    sheets.sheets.numbers.items.every(it => /^\d+$/.test(it.text)),
    JSON.stringify(sheets.sheets.numbers.items.map(i => i.text)));
  check('no prompt appears on both sheets',
    new Set([
      ...sheets.sheets.sentences.items.map(i => i.prompt_id),
      ...sheets.sheets.numbers.items.map(i => i.prompt_id),
    ]).size === 20);

  // The sheet list must be stable across requests — the volunteer is writing it down.
  const sheets2 = await (await fetch(`${BASE}/api/sheets`, { headers: authHeaders })).json();
  check('sheet contents are stable across requests',
    JSON.stringify(sheets2.sheets.sentences.items) === JSON.stringify(sheets.sheets.sentences.items));

  // --- Cannot request a new set while sheets are open ------------------------
  const earlyNew = await fetch(`${BASE}/api/sheets/new`, { method: 'POST', headers: authHeaders });
  check('new set refused while sheets are still open', earlyNew.status === 400, `status ${earlyNew.status}`);

  // --- Upload the two sheet images -----------------------------------------
  async function uploadSheet(assignmentId, seed) {
    const buffer = await makeSheetImage(sharp, seed);
    const form = new FormData();
    form.append('contributor_id', reg.contributor_id);
    form.append('contributor_name', 'تست کاربر');
    form.append('assignment_id', String(assignmentId));
    form.append('image', new Blob([buffer], { type: 'image/jpeg' }), 'sheet.jpg');
    const res = await fetch(`${BASE}/api/images`, { method: 'POST', headers: authHeaders, body: form });
    return { status: res.status, body: await res.json() };
  }

  const up1 = await uploadSheet(sheets.sheets.sentences.assignment_id, 'A');
  check('sentence sheet upload succeeds', up1.body.success, JSON.stringify(up1.body));
  const sentenceImageId = up1.body.image_id;

  check('sentence sheet is marked submitted in the response',
    up1.body.sheets?.sentences?.status === 'submitted');
  check('number sheet is still open after the first upload',
    up1.body.sheets?.numbers?.status === 'open');

  const dupe = await uploadSheet(sheets.sheets.sentences.assignment_id, 'A2');
  check('second upload to the same sheet is refused', dupe.status === 409, `status ${dupe.status}`);

  const up2 = await uploadSheet(sheets.sheets.numbers.assignment_id, 'B');
  check('number sheet upload succeeds', up2.body.success, JSON.stringify(up2.body));
  const numberImageId = up2.body.image_id;

  // --- Foreign sheet ownership ---------------------------------------------
  const other = await (await fetch(`${BASE}/api/contributors/register`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ name: 'کاربر دیگر' }),
  })).json();
  const otherSheets = await (await fetch(`${BASE}/api/sheets`, {
    headers: { 'X-Contributor-Token': other.token },
  })).json();
  {
    const buffer = await makeSheetImage(sharp, 'X');
    const form = new FormData();
    form.append('assignment_id', String(otherSheets.sheets.sentences.assignment_id));
    form.append('image', new Blob([buffer], { type: 'image/jpeg' }), 'sheet.jpg');
    const res = await fetch(`${BASE}/api/images`, { method: 'POST', headers: authHeaders, body: form });
    check("uploading to another contributor's sheet is refused", res.status === 403, `status ${res.status}`);
  }

  // --- Admin login ----------------------------------------------------------
  const loginRes = await fetch(`${BASE}/api/admin/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ username: 'admin', password: ADMIN_PASSWORD }),
  });
  const setCookie = loginRes.headers.get('set-cookie') || '';
  const adminCookie = setCookie.split(';')[0];
  check('admin login succeeds', (await loginRes.json()).success && !!adminCookie);
  const adminHeaders = { Cookie: adminCookie, 'Content-Type': 'application/json' };

  // --- Lines for review -----------------------------------------------------
  const linesRes = await fetch(`${BASE}/api/admin/images/${sentenceImageId}/lines`, { headers: { Cookie: adminCookie } });
  const linesData = await linesRes.json();
  check('admin sees 10 lines for the sheet', linesData.lines?.length === 10, `got ${linesData.lines?.length}`);
  check('lines carry their expected texts and no rectangles yet',
    linesData.lines.every(l => typeof l.text === 'string' && l.text.length > 0 && l.segment === null));
  check('line texts match what the volunteer was shown',
    JSON.stringify(linesData.lines.map(l => l.text)) ===
    JSON.stringify(sheets.sheets.sentences.items.map(i => i.text)));

  // --- Draw a rectangle for each line ---------------------------------------
  for (let i = 0; i < 10; i++) {
    const res = await fetch(`${BASE}/api/admin/images/${sentenceImageId}/segments`, {
      method: 'POST',
      headers: adminHeaders,
      body: JSON.stringify({ line_no: i + 1, x: 40, y: 40 + i * 80, w: 700, h: 60 }),
    });
    const body = await res.json();
    if (i === 0) check('first segment saves and returns its crop filename', body.success && !!body.segment.filename, JSON.stringify(body));
    if (i === 9) check('tenth segment reports 10 of 10 done', body.segmentCount === 10 && body.totalLines === 10, JSON.stringify(body));
  }

  const segFiles = fs.readdirSync(path.join(ROOT, 'uploads', 'segments'));
  check('ten crop files exist on disk', segFiles.length === 10, `got ${segFiles.length}`);

  {
    const meta = await sharp(path.join(ROOT, 'uploads', 'segments', segFiles[0])).metadata();
    check('a crop has the drawn dimensions', meta.width === 700 && meta.height === 60, `${meta.width}x${meta.height}`);
  }

  // Out-of-range boxes are clamped, not rejected, so a drag off the canvas edge works.
  {
    const res = await fetch(`${BASE}/api/admin/images/${sentenceImageId}/segments`, {
      method: 'POST',
      headers: adminHeaders,
      body: JSON.stringify({ line_no: 1, x: 1100, y: 800, w: 5000, h: 5000 }),
    });
    const body = await res.json();
    check('a box overflowing the image is clamped to its bounds',
      body.success && body.segment.x + body.segment.w <= 1200 && body.segment.y + body.segment.h <= 900,
      JSON.stringify(body.segment));
    check('redrawing a line does not add a second crop', body.segmentCount === 10, `got ${body.segmentCount}`);
  }
  check('redrawing replaced the old crop file rather than leaking one',
    fs.readdirSync(path.join(ROOT, 'uploads', 'segments')).length === 10);

  {
    const res = await fetch(`${BASE}/api/admin/images/${sentenceImageId}/segments`, {
      method: 'POST',
      headers: adminHeaders,
      body: JSON.stringify({ line_no: 99, x: 10, y: 10, w: 100, h: 100 }),
    });
    check('a line number outside the sheet is refused', res.status === 400, `status ${res.status}`);
  }

  // --- Delete one rectangle -------------------------------------------------
  {
    const res = await fetch(`${BASE}/api/admin/images/${sentenceImageId}/segments/3`, {
      method: 'DELETE',
      headers: { Cookie: adminCookie },
    });
    const body = await res.json();
    check('deleting a rectangle drops it to 9 of 10', body.segmentCount === 9, JSON.stringify(body));
    check('the deleted crop file is gone', fs.readdirSync(path.join(ROOT, 'uploads', 'segments')).length === 9);

    // Put it back so the export assertions below see a full sheet.
    await fetch(`${BASE}/api/admin/images/${sentenceImageId}/segments`, {
      method: 'POST',
      headers: adminHeaders,
      body: JSON.stringify({ line_no: 3, x: 40, y: 200, w: 700, h: 60 }),
    });
  }

  // --- Approve and export ---------------------------------------------------
  await fetch(`${BASE}/api/admin/images/${sentenceImageId}`, {
    method: 'PATCH',
    headers: adminHeaders,
    body: JSON.stringify({ status: 'approved' }),
  });

  const csv = await (await fetch(`${BASE}/api/admin/export`, { headers: { Cookie: adminCookie } })).text();
  const csvLines = csv.trim().split('\n');
  check('labels.csv has one header + ten segment rows', csvLines.length === 11, `got ${csvLines.length}`);
  check('labels.csv is line-level (has text_label and line_no columns)',
    csvLines[0].includes('text_label') && csvLines[0].includes('line_no'), csvLines[0]);
  check('every expected sentence appears in labels.csv',
    sheets.sheets.sentences.items.every(item => csv.includes(item.text)));

  // A crop must still be cuttable after the sheet moved from pending/ to approved/.
  {
    const res = await fetch(`${BASE}/api/admin/images/${sentenceImageId}/segments`, {
      method: 'POST',
      headers: adminHeaders,
      body: JSON.stringify({ line_no: 5, x: 50, y: 360, w: 600, h: 55 }),
    });
    check('segmentation still works after the sheet is approved', (await res.json()).success);
  }

  // sheets.csv must carry real counts, not blanks — a 0 is a meaningful value there.
  {
    const zipRes = await fetch(`${BASE}/api/admin/export-zip`, { headers: { Cookie: adminCookie } });
    const zipBuf = Buffer.from(await zipRes.arrayBuffer());
    check('export-zip returns a non-trivial archive', zipBuf.length > 1000, `${zipBuf.length} bytes`);
    check('archive is a real zip', zipBuf.slice(0, 2).toString() === 'PK');
  }
  {
    const sheetsCsv = require('../database').getApprovedForExport();
    check('approved sheets report their line count', sheetsCsv.every(r => r.line_count === 10),
      JSON.stringify(sheetsCsv.map(r => r.line_count)));
  }

  // --- Reject hands the sheet back -----------------------------------------
  await fetch(`${BASE}/api/admin/images/${numberImageId}`, {
    method: 'PATCH',
    headers: adminHeaders,
    body: JSON.stringify({ status: 'rejected', rejection_reason: 'تست' }),
  });

  const afterReject = await (await fetch(`${BASE}/api/sheets`, { headers: authHeaders })).json();
  check('a rejected sheet reopens for the volunteer',
    afterReject.sheets.numbers.status === 'open',
    afterReject.sheets.numbers.status);
  check('the reopened sheet keeps the same ten lines',
    JSON.stringify(afterReject.sheets.numbers.items.map(i => i.prompt_id)) ===
    JSON.stringify(sheets.sheets.numbers.items.map(i => i.prompt_id)));

  // Re-upload it so both sheets are in again.
  const up3 = await uploadSheet(afterReject.sheets.numbers.assignment_id, 'C');
  check('the reopened sheet accepts a fresh upload', up3.body.success, JSON.stringify(up3.body));

  // --- New set --------------------------------------------------------------
  const newSetRes = await fetch(`${BASE}/api/sheets/new`, { method: 'POST', headers: authHeaders });
  const newSet = await newSetRes.json();
  check('a new set is granted once both sheets are submitted', newSet.success, JSON.stringify(newSet).slice(0, 200));
  check('the new set has 10 + 10 lines',
    newSet.sheets.sentences.items.length === 10 && newSet.sheets.numbers.items.length === 10);
  check('the new set reuses none of the first set\'s prompts',
    newSet.sheets.sentences.items.every(item =>
      !sheets.sheets.sentences.items.some(old => old.prompt_id === item.prompt_id)));

  console.log(`\n${passed} passed, ${failed} failed\n`);
  process.exit(failed === 0 ? 0 : 1);
}

main().catch(err => {
  console.error('Test run crashed:', err);
  process.exit(1);
});
