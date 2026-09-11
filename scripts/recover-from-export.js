#!/usr/bin/env node
//
// Rebuild the database from a dataset export (the ZIP the admin panel produces).
//
//   node scripts/recover-from-export.js "C:\\path\\to\\persian_ocr_dataset_YYYY-MM-DD.zip"
//   node scripts/recover-from-export.js ./some-extracted-folder
//   node scripts/recover-from-export.js <path> --dry-run     # report only, change nothing
//
// STOP THE SERVER FIRST. The server keeps the whole database in memory and rewrites
// the file on its own schedule, so anything written here while it runs is discarded.
// The script refuses to start if something is still listening on the configured port.
//
// What it restores, from labels.csv + sheets.csv + the image folders in the export:
//   contributors, assignments, assignment_items, images (approved), segments,
//   the sheet images themselves, and every line crop.
//
// What it cannot restore: sheets that were still WAITING for review when the export
// was taken. An export only contains approved rows, so those sheets have no labels
// anywhere. Their image files are still on disk and the script finds and reports
// them rather than leaving you to guess.
//
// Safe to run twice: every insert is skipped if the row already exists, and a
// timestamped backup of the database is written before anything changes.

const fs = require('fs');
const path = require('path');
const zlib = require('zlib');
const net = require('net');
const crypto = require('crypto');

const config = require('../config');

// ---------------------------------------------------------------------------
// Minimal ZIP reader (central directory + stored/deflate), so the export can be
// handed over as-is without extracting it first and without a new dependency.
// ---------------------------------------------------------------------------
function readZip(zipPath) {
  const buf = fs.readFileSync(zipPath);

  let eocd = -1;
  for (let i = buf.length - 22; i >= 0 && i > buf.length - 66000; i--) {
    if (buf.readUInt32LE(i) === 0x06054b50) { eocd = i; break; }
  }
  if (eocd === -1) throw new Error('Not a ZIP file (no end-of-central-directory record).');

  const entryCount = buf.readUInt16LE(eocd + 10);
  let ptr = buf.readUInt32LE(eocd + 16);

  const files = new Map();
  for (let n = 0; n < entryCount; n++) {
    if (buf.readUInt32LE(ptr) !== 0x02014b50) break;
    const method = buf.readUInt16LE(ptr + 10);
    const compressedSize = buf.readUInt32LE(ptr + 20);
    const nameLen = buf.readUInt16LE(ptr + 28);
    const extraLen = buf.readUInt16LE(ptr + 30);
    const commentLen = buf.readUInt16LE(ptr + 32);
    const localOffset = buf.readUInt32LE(ptr + 42);
    const name = buf.slice(ptr + 46, ptr + 46 + nameLen).toString('utf8');

    if (!name.endsWith('/')) {
      // The local header repeats the name/extra lengths, and they can differ from
      // the central directory's, so the data offset must be read from it.
      const lNameLen = buf.readUInt16LE(localOffset + 26);
      const lExtraLen = buf.readUInt16LE(localOffset + 28);
      const dataStart = localOffset + 30 + lNameLen + lExtraLen;
      const raw = buf.slice(dataStart, dataStart + compressedSize);
      files.set(name, method === 0 ? raw : zlib.inflateRawSync(raw));
    }
    ptr += 46 + nameLen + extraLen + commentLen;
  }
  return files;
}

// A folder is accepted too, so an already-extracted export works the same way.
function readSource(src) {
  const stat = fs.statSync(src);
  if (stat.isFile()) return readZip(src);

  const files = new Map();
  const walk = (dir, prefix) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      const rel = prefix ? `${prefix}/${entry.name}` : entry.name;
      if (entry.isDirectory()) walk(full, rel);
      else files.set(rel, fs.readFileSync(full));
    }
  };
  walk(src, '');
  return files;
}

// ---------------------------------------------------------------------------
function parseCsv(text) {
  const rows = [];
  let row = [];
  let cur = '';
  let quoted = false;
  const s = text.replace(/^\uFEFF/, '');

  for (let i = 0; i < s.length; i++) {
    const ch = s[i];
    if (quoted) {
      if (ch !== '"') cur += ch;
      else if (s[i + 1] === '"') { cur += '"'; i++; }
      else quoted = false;
    } else if (ch === '"') quoted = true;
    else if (ch === ',') { row.push(cur); cur = ''; }
    else if (ch === '\n') { row.push(cur); rows.push(row); row = []; cur = ''; }
    else if (ch !== '\r') cur += ch;
  }
  if (cur !== '' || row.length) { row.push(cur); rows.push(row); }

  const header = rows.shift() || [];
  return rows
    .filter(r => r.length && r.some(v => v !== ''))
    .map(r => Object.fromEntries(header.map((h, i) => [h, r[i] ?? ''])));
}

function portInUse(port) {
  return new Promise(resolve => {
    const sock = net.connect({ port, host: '127.0.0.1' });
    const done = (v) => { sock.destroy(); resolve(v); };
    sock.setTimeout(1200);
    sock.on('connect', () => done(true));
    sock.on('timeout', () => done(false));
    sock.on('error', () => done(false));
  });
}

function mimeFor(filename) {
  const ext = path.extname(filename).toLowerCase();
  if (ext === '.png') return 'image/png';
  if (ext === '.webp') return 'image/webp';
  return 'image/jpeg';
}

async function main() {
  const src = process.argv[2];
  const dryRun = process.argv.includes('--dry-run');

  if (!src) {
    console.error('Usage: node scripts/recover-from-export.js <export.zip | folder> [--dry-run]');
    process.exit(1);
  }
  if (!fs.existsSync(src)) {
    console.error(`Export not found: ${src}`);
    process.exit(1);
  }

  if (await portInUse(config.PORT)) {
    console.error(`\nSomething is listening on port ${config.PORT} — the server looks like it is still running.`);
    console.error('Stop it first, or this recovery will be overwritten by the copy it holds in memory.\n');
    process.exit(1);
  }

  console.log(`Reading export: ${src}`);
  const files = readSource(src);

  if (!files.has('labels.csv') || !files.has('sheets.csv')) {
    console.error('That export has no labels.csv / sheets.csv at its top level.');
    console.error(`Found: ${[...files.keys()].filter(n => !n.includes('/')).join(', ') || '(nothing)'}`);
    process.exit(1);
  }

  const labels = parseCsv(files.get('labels.csv').toString('utf8'));
  const sheets = parseCsv(files.get('sheets.csv').toString('utf8'));
  console.log(`  labels.csv : ${labels.length} line crops`);
  console.log(`  sheets.csv : ${sheets.length} sheets`);

  const db = require('../database');
  await db.initDatabase();
  const raw = db.db.get();

  const backup = `${config.DB_PATH}.${new Date().toISOString().replace(/[:.]/g, '-')}.pre-recovery.bak`;
  if (!dryRun) {
    fs.copyFileSync(config.DB_PATH, backup);
    console.log(`\nBackup written: ${backup}`);
  } else {
    console.log('\n*** DRY RUN — nothing will be written ***');
  }

  const one = (sql, params = []) => {
    const st = raw.prepare(sql);
    st.bind(params);
    const r = st.step() ? st.getAsObject() : null;
    st.free();
    return r;
  };
  const many = (sql, params = []) => {
    const st = raw.prepare(sql);
    st.bind(params);
    const out = [];
    while (st.step()) out.push(st.getAsObject());
    st.free();
    return out;
  };
  const exec = (sql, params = []) => { if (!dryRun) raw.run(sql, params); };

  for (const dir of [config.PENDING_DIR, config.APPROVED_DIR, config.SEGMENTS_DIR]) {
    fs.mkdirSync(dir, { recursive: true });
  }

  // --- Prompt lookup, so assignment_items point at the real prompt rows -----
  const promptByKey = new Map();
  for (const p of many('SELECT id, text FROM prompts')) {
    promptByKey.set(db.promptDedupKey(p.text), p.id);
  }
  let promptsCreated = 0;
  const seenContributors = new Set();

  function resolvePrompt(text, category) {
    const key = db.promptDedupKey(text);
    if (promptByKey.has(key)) return promptByKey.get(key);
    // The prompt existed when this line was written but is not in the bank now.
    // Recreate it so coverage accounting and the sheet still line up.
    exec('INSERT INTO prompts (text, category) VALUES (?, ?)', [text, category || 'custom']);
    const row = dryRun ? null : one('SELECT id FROM prompts WHERE text = ? ORDER BY id DESC LIMIT 1', [text]);
    const id = row ? row.id : null;
    // Cache the key either way: on a dry run nothing is inserted, and without this
    // every repeat of the same line would be counted as another creation.
    promptByKey.set(key, id);
    promptsCreated++;
    return id;
  }

  // --- Restore files --------------------------------------------------------
  const legacyDir = path.join(config.UPLOAD_DIR, 'legacy');
  const stats = {
    sheetFiles: 0, segmentFiles: 0, filesFromLegacy: 0,
    contributors: 0, assignments: 0, items: 0, images: 0, segments: 0,
    skippedExisting: 0, missingSheetFile: 0, missingSegmentFile: 0,
  };

  function restoreFile(zipName, destDir, filename) {
    const dest = path.join(destDir, filename);
    if (fs.existsSync(dest)) return 'present';

    // Prefer whatever is already on the machine (the original bytes); fall back to
    // the copy inside the export.
    const legacy = path.join(legacyDir, filename);
    if (fs.existsSync(legacy)) {
      if (!dryRun) fs.copyFileSync(legacy, dest);
      stats.filesFromLegacy++;
      return 'legacy';
    }
    if (files.has(zipName)) {
      if (!dryRun) fs.writeFileSync(dest, files.get(zipName));
      return 'export';
    }
    return 'missing';
  }

  const labelsBySheet = new Map();
  for (const l of labels) {
    if (!labelsBySheet.has(l.sheet_filename)) labelsBySheet.set(l.sheet_filename, []);
    labelsBySheet.get(l.sheet_filename).push(l);
  }

  console.log('\nRestoring...');

  for (const sheet of sheets) {
    const filename = sheet.filename;
    const lines = (labelsBySheet.get(filename) || [])
      .slice()
      .sort((a, b) => Number(a.line_no) - Number(b.line_no));

    const existing = one('SELECT id FROM images WHERE filename = ?', [filename]);
    if (existing) { stats.skippedExisting++; continue; }

    const placed = restoreFile(`sheets/${filename}`, config.APPROVED_DIR, filename);
    if (placed === 'missing') {
      stats.missingSheetFile++;
      console.log(`  ! sheet image not found anywhere: ${filename}`);
      continue;
    }
    stats.sheetFiles++;

    // Contributor
    const cid = sheet.contributor_id || 'recovered';
    // seenContributors covers the dry run, where the INSERT does not happen and the
    // existence check would therefore miss every writer after their first sheet.
    if (!seenContributors.has(cid) && !one('SELECT id FROM contributors WHERE id = ?', [cid])) {
      exec('INSERT INTO contributors (id, name) VALUES (?, ?)', [cid, sheet.contributor_name || null]);
      stats.contributors++;
    }
    seenContributors.add(cid);

    // Assignment + its items
    const category = sheet.category === 'numbers' ? 'numbers' : 'sentences';
    exec(
      `INSERT INTO assignments (contributor_id, category, status, created_at, submitted_at)
       VALUES (?, ?, 'submitted', ?, ?)`,
      [cid, category, sheet.created_at || null, sheet.created_at || null]
    );
    const assignmentId = dryRun
      ? -1
      : one('SELECT last_insert_rowid() AS id').id;
    stats.assignments++;

    for (const line of lines) {
      const promptId = resolvePrompt(line.text_label, category);
      exec(
        'INSERT INTO assignment_items (assignment_id, prompt_id, line_no) VALUES (?, ?, ?)',
        [assignmentId, promptId, Number(line.line_no)]
      );
      stats.items++;
    }

    // Image row
    const diskPath = path.join(config.APPROVED_DIR, filename);
    let size = 0;
    let hash = null;
    if (fs.existsSync(diskPath)) {
      const bytes = fs.readFileSync(diskPath);
      size = bytes.length;
      hash = crypto.createHash('sha256').update(bytes).digest('hex');
    }
    exec(
      `INSERT INTO images (filename, contributor_id, status, mime_type, file_size, file_hash,
                           assignment_id, sheet_category, created_at, reviewed_at)
       VALUES (?, ?, 'approved', ?, ?, ?, ?, ?, ?, ?)`,
      [filename, cid, mimeFor(filename), size, hash, assignmentId, category,
       sheet.created_at || null, sheet.created_at || null]
    );
    const imageId = dryRun ? -1 : one('SELECT last_insert_rowid() AS id').id;
    exec('UPDATE assignments SET image_id = ? WHERE id = ?', [imageId, assignmentId]);
    stats.images++;

    // Segments
    for (const line of lines) {
      const segFile = line.filename;
      const segPlaced = restoreFile(`segments/${segFile}`, config.SEGMENTS_DIR, segFile);
      if (segPlaced === 'missing') {
        stats.missingSegmentFile++;
        continue;
      }
      stats.segmentFiles++;

      // The export records the quad relative to the CROP, and the crop's position
      // inside the sheet is not part of the export. Storing x/y = 0 with w/h taken
      // from the crop keeps the label, the crop and the quad exactly consistent —
      // and makes a re-export byte-identical to this one. Only the ability to
      // re-cut from the sheet is lost, which the dataset does not need.
      const coords = String(line.quad || '').trim().split(/\s+/).map(Number);
      let w = 0;
      let h = 0;
      if (coords.length === 8 && coords.every(Number.isFinite)) {
        w = Math.max(...coords.filter((_, i) => i % 2 === 0));
        h = Math.max(...coords.filter((_, i) => i % 2 === 1));
      }
      const quadJson = coords.length === 8 && coords.every(Number.isFinite)
        ? JSON.stringify([[coords[0], coords[1]], [coords[2], coords[3]], [coords[4], coords[5]], [coords[6], coords[7]]])
        : null;
      const inkAngle = line.angle_source === 'ink' && line.baseline_angle_deg !== ''
        ? Number(line.baseline_angle_deg)
        : null;

      exec(
        `INSERT INTO segments (image_id, prompt_id, line_no, text, x, y, w, h, filename,
                               quad, erase, bg_color, masked_fraction, ink_angle_deg, updated_at)
         VALUES (?, ?, ?, ?, 0, 0, ?, ?, ?, ?, '[]', NULL, ?, ?, datetime('now'))`,
        [imageId, resolvePrompt(line.text_label, category), Number(line.line_no), line.text_label,
         w, h, segFile, quadJson,
         line.masked_fraction === '' ? null : Number(line.masked_fraction),
         Number.isFinite(inkAngle) ? inkAngle : null]
      );
      stats.segments++;
    }
  }

  // The migration flag must be set, or a restart could treat all of this as legacy.
  exec(`INSERT OR REPLACE INTO settings (key, value) VALUES ('sheet_migration_done', '1')`);

  if (!dryRun) {
    db.saveDatabase();
  }

  // --- Anything on disk the export never knew about ------------------------
  const known = new Set(sheets.map(s => s.filename));
  const orphans = [];
  for (const dir of [legacyDir, config.PENDING_DIR]) {
    if (!fs.existsSync(dir)) continue;
    for (const f of fs.readdirSync(dir)) {
      if (!/^img_/.test(f)) continue;
      if (known.has(f)) continue;
      if (one('SELECT id FROM images WHERE filename = ?', [f])) continue;
      orphans.push(path.join(dir, f));
    }
  }

  // --- Report ---------------------------------------------------------------
  const line = '-'.repeat(60);
  console.log(`\n${line}`);
  console.log('RECOVERY SUMMARY');
  console.log(line);
  console.log(`sheets restored        : ${stats.images}`);
  console.log(`line crops restored    : ${stats.segments}`);
  console.log(`sheet image files      : ${stats.sheetFiles}  (${stats.filesFromLegacy} taken from uploads/legacy)`);
  console.log(`crop image files       : ${stats.segmentFiles}`);
  console.log(`assignments rebuilt    : ${stats.assignments}  (${stats.items} lines)`);
  console.log(`contributors restored  : ${stats.contributors}`);
  console.log(`prompts re-created     : ${promptsCreated}`);
  if (stats.skippedExisting) console.log(`already present, skipped: ${stats.skippedExisting}`);
  if (stats.missingSheetFile) console.log(`MISSING sheet files    : ${stats.missingSheetFile}`);
  if (stats.missingSegmentFile) console.log(`MISSING crop files     : ${stats.missingSegmentFile}`);

  console.log(`\nunlabelled sheets found on disk: ${orphans.length}`);
  if (orphans.length) {
    console.log('These were still waiting for review when the export was taken, so the');
    console.log('export holds no labels for them. The image files are safe:');
    for (const o of orphans.slice(0, 20)) console.log(`   ${o}`);
    if (orphans.length > 20) console.log(`   ... and ${orphans.length - 20} more`);
  }

  const reportPath = path.join(path.dirname(config.DB_PATH), 'recovery-report.txt');
  if (!dryRun) {
    fs.writeFileSync(reportPath, [
      `Recovery run ${new Date().toISOString()}`,
      `Export: ${src}`,
      `Backup: ${backup}`,
      '',
      JSON.stringify({ ...stats, promptsCreated }, null, 2),
      '',
      'Unlabelled sheets still on disk:',
      ...orphans,
    ].join('\n'));
    console.log(`\nFull report: ${reportPath}`);
  }

  console.log(`${line}`);
  console.log(dryRun ? 'DRY RUN complete — nothing was written.' : 'Done. You can start the server again.');
  process.exit(0);
}

main().catch(err => {
  console.error('\nRecovery failed:', err.message);
  console.error(err.stack);
  process.exit(1);
});
