// The legacy-wipe migration must never touch current sheet uploads.
//
// It is gated on a settings flag, but a settings row is not a safe guarantee: restore
// an older database file, or lose the settings table, and the flag disappears while
// the images do not. Before this was fixed the migration then selected EVERY row in
// `images`, moved the files into uploads/legacy/ and deleted the rows — taking live
// sheet uploads with it. The WHERE clause, not the flag, has to be what makes it safe.
//
// This builds exactly that situation: sheet-format rows present, migration flag ABSENT.

const fs = require('fs');
const os = require('os');
const path = require('path');
const assert = require('assert');

const ROOT = path.join(os.tmpdir(), `ocr-migration-test-${Date.now()}`);
fs.mkdirSync(path.join(ROOT, 'data'), { recursive: true });
fs.mkdirSync(path.join(ROOT, 'uploads', 'pending'), { recursive: true });
fs.mkdirSync(path.join(ROOT, 'uploads', 'approved'), { recursive: true });

process.env.PERSISTENT_DATA_PATH = ROOT;
process.env.CONTRIBUTOR_SECRET = 'migration-safety-test';

let passed = 0;
let failed = 0;
function check(name, condition, detail) {
  if (condition) { passed++; console.log(`  PASS  ${name}`); }
  else { failed++; console.log(`  FAIL  ${name}${detail ? ` — ${detail}` : ''}`); }
}

async function main() {
  const initSqlJs = require('sql.js');
  const config = require('../config');

  // --- Hand-build a database in the dangerous state -------------------------
  {
    const SQL = await initSqlJs();
    const db = new SQL.Database();
    db.run(`CREATE TABLE prompts (id INTEGER PRIMARY KEY AUTOINCREMENT, text TEXT NOT NULL, category TEXT DEFAULT 'custom', active INTEGER DEFAULT 1, created_at TEXT)`);
    db.run(`CREATE TABLE images (
      id INTEGER PRIMARY KEY AUTOINCREMENT, filename TEXT NOT NULL, original_name TEXT,
      prompt_id INTEGER, custom_text TEXT, contributor_id TEXT NOT NULL,
      status TEXT DEFAULT 'pending', mime_type TEXT, file_size INTEGER,
      rejection_reason TEXT, drive_file_id TEXT, drive_synced_at TEXT,
      created_at TEXT, reviewed_at TEXT, assignment_id INTEGER, sheet_category TEXT)`);
    db.run(`CREATE TABLE contributors (id TEXT PRIMARY KEY, created_at TEXT, user_agent TEXT, name TEXT)`);
    db.run(`CREATE TABLE settings (key TEXT PRIMARY KEY, value TEXT)`);
    db.run(`CREATE TABLE assignments (id INTEGER PRIMARY KEY AUTOINCREMENT, contributor_id TEXT NOT NULL, category TEXT NOT NULL, status TEXT DEFAULT 'open', image_id INTEGER, created_at TEXT, submitted_at TEXT)`);
    db.run(`CREATE TABLE assignment_items (id INTEGER PRIMARY KEY AUTOINCREMENT, assignment_id INTEGER NOT NULL, prompt_id INTEGER NOT NULL, line_no INTEGER NOT NULL)`);
    db.run(`CREATE TABLE segments (id INTEGER PRIMARY KEY AUTOINCREMENT, image_id INTEGER NOT NULL, prompt_id INTEGER, line_no INTEGER NOT NULL, text TEXT NOT NULL, x INTEGER NOT NULL, y INTEGER NOT NULL, w INTEGER NOT NULL, h INTEGER NOT NULL, filename TEXT, created_at TEXT, updated_at TEXT)`);
    db.run(`CREATE TABLE prompt_batches (id INTEGER PRIMARY KEY AUTOINCREMENT, filename TEXT NOT NULL, row_count INTEGER, uploaded_at TEXT)`);

    db.run(`INSERT INTO contributors (id, name) VALUES ('writer_a', 'نویسنده')`);
    db.run(`INSERT INTO assignments (id, contributor_id, category, status, image_id) VALUES (1, 'writer_a', 'sentences', 'submitted', 1)`);

    // A CURRENT sheet upload — has an assignment_id. Must survive.
    db.run(`INSERT INTO images (id, filename, contributor_id, status, assignment_id, sheet_category) VALUES (1, 'sheet_live.jpg', 'writer_a', 'approved', 1, 'sentences')`);
    db.run(`INSERT INTO segments (image_id, line_no, text, x, y, w, h, filename) VALUES (1, 1, 'یک سطر', 0, 0, 10, 10, 'seg_live.jpg')`);

    // A genuinely pre-sheet row — no assignment_id. Should be migrated away.
    db.run(`INSERT INTO images (id, filename, contributor_id, status, prompt_id) VALUES (2, 'old_word.jpg', 'writer_a', 'approved', 7)`);

    // NOTE: deliberately no sheet_migration_done row — this is the whole point.
    fs.writeFileSync(config.DB_PATH, Buffer.from(db.export()));
    db.close();
  }

  fs.writeFileSync(path.join(ROOT, 'uploads', 'approved', 'sheet_live.jpg'), 'LIVE SHEET BYTES');
  fs.writeFileSync(path.join(ROOT, 'uploads', 'approved', 'old_word.jpg'), 'OLD WORD BYTES');

  // --- Boot the real database layer against it ------------------------------
  const db = require('../database');
  await db.initDatabase();

  const images = db.getImages({ page: 1, limit: 50 });
  const ids = images.images.map(i => i.id);

  check('the live sheet upload survives a migration re-run', ids.includes(1), `rows: ${JSON.stringify(ids)}`);
  check('the genuine legacy row is migrated away', !ids.includes(2), `rows: ${JSON.stringify(ids)}`);
  check('exactly one image remains', images.total === 1, `${images.total}`);

  check('the live sheet FILE is left where it was',
    fs.existsSync(path.join(ROOT, 'uploads', 'approved', 'sheet_live.jpg')),
    'sheet_live.jpg was moved or deleted');
  check('the legacy file is moved to uploads/legacy rather than deleted',
    fs.existsSync(path.join(ROOT, 'uploads', 'legacy', 'old_word.jpg')),
    'old_word.jpg is not in uploads/legacy');

  check("the live sheet's segments survive", db.countSegments(1) === 1, `${db.countSegments(1)}`);
  check('assignments are not wiped', !!db.getAssignment(1), 'assignment 1 is gone');

  console.log(`\n${passed} passed, ${failed} failed\n`);
  process.exit(failed === 0 ? 0 : 1);
}

main().catch(err => { console.error('Test run crashed:', err); process.exit(1); });
