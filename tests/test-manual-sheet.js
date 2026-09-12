// Manual recovery of a sheet: admin uploads the image, files it under a writer id,
// and either types the line labels or parks it in the waiting state to label later.
//
// This is the only route back for sheets that were still awaiting review when their
// rows were lost — an export only ever contains approved rows, so no labels for them
// exist anywhere. The checks that matter most here are that the waiting state really
// is usable later, that the writer id groups sheets in the same handwriting, and that
// an admin-uploaded image goes through the SAME processing as a volunteer upload.

const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');

const ROOT = path.join(os.tmpdir(), `ocr-manual-test-${Date.now()}`);
fs.mkdirSync(ROOT, { recursive: true });

process.env.PERSISTENT_DATA_PATH = ROOT;
process.env.CONTRIBUTOR_SECRET = 'manual-sheet-test';
process.env.ADMIN_USERNAME = 'admin';
process.env.PORT = '4145';
process.env.MAX_UPLOADS_PER_IP_PER_MINUTE = '500';
process.env.MAX_UPLOADS_PER_IP_PER_HOUR = '500';

const ADMIN_PASSWORD = 'manual-sheet-password';
{
  const salt = crypto.randomBytes(16).toString('hex');
  const hash = crypto.scryptSync(ADMIN_PASSWORD, salt, 64).toString('hex');
  process.env.ADMIN_PASSWORD_HASH = `${salt}:${hash}`;
}

const BASE = `http://127.0.0.1:${process.env.PORT}`;
let passed = 0;
let failed = 0;

function check(name, condition, detail) {
  if (condition) { passed++; console.log(`  PASS  ${name}`); }
  else { failed++; console.log(`  FAIL  ${name}${detail ? ` — ${detail}` : ''}`); }
}

const sharp = require('sharp');

async function sheetImage(seed) {
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="900" height="700">
    <rect width="900" height="700" fill="rgb(245,242,232)"/>
    ${Array.from({ length: 5 }, (_, i) =>
      `<text x="70" y="${110 + i * 120}" font-size="44" fill="rgb(20,20,20)">line ${i + 1} ${seed}</text>`
    ).join('')}
  </svg>`;
  return sharp(Buffer.from(svg)).png().toBuffer();
}

async function main() {
  require('../server.js');
  await new Promise(r => setTimeout(r, 2500));

  const db = require('../database');
  db.createPromptsBatch(['سطر بانکی یک', 'سطر بانکی دو'], 'words');
  db.flushIfDirty();

  const loginRes = await fetch(`${BASE}/api/admin/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ username: 'admin', password: ADMIN_PASSWORD }),
  });
  const cookie = (loginRes.headers.get('set-cookie') || '').split(';')[0];
  const jsonHeaders = { Cookie: cookie, 'Content-Type': 'application/json' };
  check('admin login succeeds', !!cookie);

  const uploadManual = async ({ seed, writerId, writerName, category, labels }) => {
    const fd = new FormData();
    fd.append('image', new Blob([await sheetImage(seed)], { type: 'image/png' }), 'sheet.png');
    if (category) fd.append('category', category);
    if (writerId) fd.append('contributor_id', writerId);
    if (writerName) fd.append('contributor_name', writerName);
    if (labels) fd.append('labels', labels.join('\n'));
    const res = await fetch(`${BASE}/api/admin/sheets/manual`, {
      method: 'POST', headers: { Cookie: cookie }, body: fd,
    });
    return { status: res.status, body: await res.json() };
  };

  // --- 1. Upload WITH labels -----------------------------------------------
  const LABELS = ['خط بازیابی یک', 'خط بازیابی دو', 'خط بازیابی سه'];
  let labelled;
  {
    const r = await uploadManual({ seed: 'A', writerName: 'کاتب بازیابی', category: 'sentences', labels: LABELS });
    labelled = r.body;
    check('a labelled manual sheet uploads', r.body.success, JSON.stringify(r.body).slice(0, 200));
    check('its line count matches what was typed', r.body.lines === 3, `${r.body.lines}`);
    check('it is not reported as waiting', r.body.waiting === false);

    const lines = await (await fetch(`${BASE}/api/admin/images/${r.body.image_id}/lines`, { headers: { Cookie: cookie } })).json();
    check('the typed labels come back as the sheet lines',
      JSON.stringify(lines.lines.map(l => l.text)) === JSON.stringify(LABELS),
      JSON.stringify(lines.lines.map(l => l.text)));
    check('the sheet lands in pending for review', lines.image.status === 'pending', lines.image.status);
  }

  // --- 2. Labels created this way must not be served to volunteers ---------
  {
    const prompts = await (await fetch(`${BASE}/api/admin/prompts`, { headers: { Cookie: cookie } })).json();
    const recovered = prompts.filter(p => LABELS.includes(p.text));
    check('hand-typed labels become prompt rows', recovered.length === 3, `${recovered.length}`);
    check('...but are inactive, so they are never handed to a volunteer',
      recovered.every(p => !p.active), JSON.stringify(recovered.map(p => p.active)));
  }

  // --- 3. Upload WITHOUT labels: the waiting state -------------------------
  let waiting;
  {
    const r = await uploadManual({ seed: 'B', writerName: 'کاتب بازیابی', category: 'numbers' });
    waiting = r.body;
    check('an unlabelled manual sheet uploads', r.body.success, JSON.stringify(r.body).slice(0, 200));
    check('it is reported as waiting', r.body.waiting === true);
    check('it has no lines yet', r.body.lines === 0, `${r.body.lines}`);

    const lines = await (await fetch(`${BASE}/api/admin/images/${r.body.image_id}/lines`, { headers: { Cookie: cookie } })).json();
    check('a waiting sheet reports an empty line list', lines.lines.length === 0, `${lines.lines.length}`);
    check('a waiting sheet still shows up as pending', lines.image.status === 'pending');
  }

  // --- 4. Label the waiting sheet afterwards -------------------------------
  {
    const later = ['عدد بازیابی یک', 'عدد بازیابی دو'];
    const res = await fetch(`${BASE}/api/admin/images/${waiting.image_id}/lines`, {
      method: 'PUT', headers: jsonHeaders, body: JSON.stringify({ labels: later }),
    });
    const data = await res.json();
    check('a waiting sheet can be labelled later', data.success && data.lines === 2, JSON.stringify(data).slice(0, 200));
    check('the new labels are returned immediately',
      JSON.stringify(data.lineList.map(l => l.text)) === JSON.stringify(later),
      JSON.stringify(data.lineList.map(l => l.text)));
  }

  // --- 5. It can then be segmented like any other sheet --------------------
  {
    const r = await fetch(`${BASE}/api/admin/images/${waiting.image_id}/segments`, {
      method: 'POST', headers: jsonHeaders,
      body: JSON.stringify({ line_no: 1, x: 60, y: 80, w: 500, h: 70 }),
    });
    const data = await r.json();
    check('a manually labelled sheet segments normally', data.success, JSON.stringify(data).slice(0, 200));
    check('its crop file is written',
      !!data.segment && fs.existsSync(path.join(ROOT, 'uploads', 'segments', data.segment.filename)));
    check('the crop carries the hand-typed label',
      data.segment.text === 'عدد بازیابی یک', data.segment.text);
  }

  // --- 6. Shrinking the line list drops the orphaned crops ----------------
  {
    const before = fs.readdirSync(path.join(ROOT, 'uploads', 'segments')).length;
    const res = await fetch(`${BASE}/api/admin/images/${waiting.image_id}/lines`, {
      method: 'PUT', headers: jsonHeaders, body: JSON.stringify({ labels: [] }),
    });
    const data = await res.json();
    const after = fs.readdirSync(path.join(ROOT, 'uploads', 'segments')).length;
    check('clearing the lines removes their crops too',
      data.success && after === before - 1, `${before} -> ${after}`);
  }

  // --- 7. Writer identity groups sheets in the same handwriting -----------
  {
    const writers = await (await fetch(`${BASE}/api/admin/contributors`, { headers: { Cookie: cookie } })).json();
    const scribe = writers.find(w => w.name === 'کاتب بازیابی');
    check('the writer list is available for filing sheets', !!scribe, JSON.stringify(writers).slice(0, 200));
    check('both sheets are filed under the same writer id', scribe && scribe.sheet_count === 2, scribe && `${scribe.sheet_count}`);

    // Filing a third sheet under the existing id must reuse it, not make a new writer.
    const r = await uploadManual({ seed: 'C', writerId: scribe.id, category: 'sentences', labels: ['خط سوم'] });
    check('an existing writer id can be reused', r.body.success && r.body.contributor_id === scribe.id,
      JSON.stringify(r.body).slice(0, 200));
    const after = await (await fetch(`${BASE}/api/admin/contributors`, { headers: { Cookie: cookie } })).json();
    check('reusing a writer does not create a duplicate',
      after.filter(w => w.id === scribe.id).length === 1);
    check('the writer now has three sheets',
      after.find(w => w.id === scribe.id).sheet_count === 3,
      `${after.find(w => w.id === scribe.id).sheet_count}`);
  }

  // --- 8. Same image pipeline as a volunteer upload -----------------------
  {
    // The route re-encodes through sharp exactly like /api/images does. A PNG in must
    // come out as a PNG the server wrote itself, not the original bytes, or these
    // sheets would carry a different encoding signature from every other sheet.
    const lines = await (await fetch(`${BASE}/api/admin/images/${labelled.image_id}/lines`, { headers: { Cookie: cookie } })).json();
    const onDisk = path.join(ROOT, 'uploads', 'pending', lines.image.filename);
    check('the uploaded sheet is on disk', fs.existsSync(onDisk), onDisk);
    const meta = await sharp(onDisk).metadata();
    check('the image was re-encoded by the server', meta.format === 'png', meta.format);
    check('the stored file is not the raw upload',
      !fs.readFileSync(onDisk).equals(await sheetImage('A')));
  }

  // --- 9. Rejections -------------------------------------------------------
  {
    const dup = await uploadManual({ seed: 'A', writerName: 'کاتب بازیابی', category: 'sentences', labels: ['x'] });
    check('re-uploading an identical image is refused as a duplicate', dup.status === 409, `status ${dup.status}`);

    const noWriter = await uploadManual({ seed: 'D', category: 'sentences' });
    check('a sheet with no writer is refused', noWriter.status === 400, `status ${noWriter.status}`);
  }

  // --- 10. The manual sheet survives a migration re-run -------------------
  {
    // It has an assignment_id, so the legacy wipe must not touch it.
    db.db.get().run("DELETE FROM settings WHERE key = 'sheet_migration_done'");
    db.markDirty();
    db.flushIfDirty();
    const before = db.getImages({ page: 1, limit: 50 }).total;
    await db.initDatabase();
    const after = db.getImages({ page: 1, limit: 50 }).total;
    check('manually recovered sheets survive a legacy migration re-run',
      after === before && after > 0, `${before} -> ${after}`);
  }

  console.log(`\n${passed} passed, ${failed} failed\n`);
  process.exit(failed === 0 ? 0 : 1);
}

main().catch(err => { console.error('Test run crashed:', err); process.exit(1); });
