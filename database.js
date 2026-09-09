const initSqlJs = require('sql.js');
const path = require('path');
const fs = require('fs');
const config = require('./config');

let db = null;

async function initDatabase() {
  const SQL = await initSqlJs();

  const dbDir = path.dirname(config.DB_PATH);
  if (!fs.existsSync(dbDir)) fs.mkdirSync(dbDir, { recursive: true });

  // Load existing database or create new one
  if (fs.existsSync(config.DB_PATH)) {
    const buffer = fs.readFileSync(config.DB_PATH);
    db = new SQL.Database(buffer);
  } else {
    db = new SQL.Database();
  }

  // Note: sql.js is a WebAssembly in-memory SQLite. PRAGMA journal_mode and
  // foreign_keys are no-ops. Persistence is handled by manual saveDatabase()
  // calls, and referential integrity is enforced at the application level.

  db.run(`
    CREATE TABLE IF NOT EXISTS contributors (
      id          TEXT PRIMARY KEY,
      created_at  TEXT DEFAULT (datetime('now')),
      user_agent  TEXT
    )
  `);

  db.run(`
    CREATE TABLE IF NOT EXISTS prompts (
      id          INTEGER PRIMARY KEY AUTOINCREMENT,
      text        TEXT NOT NULL,
      category    TEXT DEFAULT 'custom',
      active      INTEGER DEFAULT 1,
      created_at  TEXT DEFAULT (datetime('now'))
    )
  `);

  db.run(`
    CREATE TABLE IF NOT EXISTS images (
      id              INTEGER PRIMARY KEY AUTOINCREMENT,
      filename        TEXT NOT NULL,
      original_name   TEXT,
      prompt_id       INTEGER,
      custom_text     TEXT,
      contributor_id  TEXT NOT NULL,
      status          TEXT DEFAULT 'pending',
      mime_type       TEXT,
      file_size       INTEGER,
      rejection_reason TEXT,
      drive_file_id   TEXT,
      drive_synced_at TEXT,
      created_at      TEXT DEFAULT (datetime('now')),
      reviewed_at     TEXT,
      FOREIGN KEY (prompt_id) REFERENCES prompts(id),
      FOREIGN KEY (contributor_id) REFERENCES contributors(id)
    )
  `);

  db.run(`
    CREATE TABLE IF NOT EXISTS prompt_batches (
      id          INTEGER PRIMARY KEY AUTOINCREMENT,
      filename    TEXT NOT NULL,
      row_count   INTEGER,
      uploaded_at TEXT DEFAULT (datetime('now'))
    )
  `);

  // An assignment is one sheet's worth of work: a fixed set of prompts handed to
  // one contributor, written line-by-line on a single page, uploaded as ONE image.
  db.run(`
    CREATE TABLE IF NOT EXISTS assignments (
      id             INTEGER PRIMARY KEY AUTOINCREMENT,
      contributor_id TEXT NOT NULL,
      category       TEXT NOT NULL,
      status         TEXT DEFAULT 'open',
      image_id       INTEGER,
      created_at     TEXT DEFAULT (datetime('now')),
      submitted_at   TEXT
    )
  `);

  db.run(`
    CREATE TABLE IF NOT EXISTS assignment_items (
      id            INTEGER PRIMARY KEY AUTOINCREMENT,
      assignment_id INTEGER NOT NULL,
      prompt_id     INTEGER NOT NULL,
      line_no       INTEGER NOT NULL
    )
  `);

  // One admin-drawn rectangle per written line. x/y/w/h are pixel coordinates in
  // the ORIGINAL uploaded image, so a crop can always be regenerated from source.
  db.run(`
    CREATE TABLE IF NOT EXISTS segments (
      id         INTEGER PRIMARY KEY AUTOINCREMENT,
      image_id   INTEGER NOT NULL,
      prompt_id  INTEGER,
      line_no    INTEGER NOT NULL,
      text       TEXT NOT NULL,
      x          INTEGER NOT NULL,
      y          INTEGER NOT NULL,
      w          INTEGER NOT NULL,
      h          INTEGER NOT NULL,
      filename   TEXT,
      created_at TEXT DEFAULT (datetime('now')),
      updated_at TEXT
    )
  `);

  db.run(`CREATE INDEX IF NOT EXISTS idx_assignments_contributor ON assignments(contributor_id, category, status)`);
  db.run(`CREATE INDEX IF NOT EXISTS idx_assignment_items_assignment ON assignment_items(assignment_id)`);
  db.run(`CREATE INDEX IF NOT EXISTS idx_assignment_items_prompt ON assignment_items(prompt_id)`);
  db.run(`CREATE INDEX IF NOT EXISTS idx_segments_image ON segments(image_id)`);
  db.run(`CREATE UNIQUE INDEX IF NOT EXISTS idx_segments_image_line ON segments(image_id, line_no)`);

  db.run(`CREATE INDEX IF NOT EXISTS idx_images_status ON images(status)`);
  db.run(`CREATE INDEX IF NOT EXISTS idx_images_contributor ON images(contributor_id)`);
  // Kept for legacy rows: images.prompt_id is only set on pre-sheet uploads.
  db.run(`CREATE INDEX IF NOT EXISTS idx_images_prompt ON images(prompt_id)`);

  // Migrate columns for security & contributor name
  try { db.run(`ALTER TABLE contributors ADD COLUMN name TEXT`); } catch (_) {}
  try { db.run(`ALTER TABLE images ADD COLUMN ip_address TEXT`); } catch (_) {}
  try { db.run(`ALTER TABLE images ADD COLUMN file_hash TEXT`); } catch (_) {}
  // Free-form segment shape. x/y/w/h stay as the bounding box (exports and sharp's
  // extract still need it); `quad` holds the four draggable corners, `erase` the
  // admin's blanking strokes, and `bg_color` the paper colour both are painted in.
  try { db.run(`ALTER TABLE segments ADD COLUMN quad TEXT`); } catch (_) {}
  try { db.run(`ALTER TABLE segments ADD COLUMN erase TEXT`); } catch (_) {}
  try { db.run(`ALTER TABLE segments ADD COLUMN bg_color TEXT`); } catch (_) {}

  // Sheet-era columns: an image is now a whole page of lines, not a single word.
  try { db.run(`ALTER TABLE images ADD COLUMN assignment_id INTEGER`); } catch (_) {}
  try { db.run(`ALTER TABLE images ADD COLUMN sheet_category TEXT`); } catch (_) {}
  try { db.run(`CREATE INDEX IF NOT EXISTS idx_images_assignment ON images(assignment_id)`); } catch (_) {}
  try { db.run(`CREATE INDEX IF NOT EXISTS idx_images_ip ON images(ip_address)`); } catch (_) {}
  try { db.run(`CREATE UNIQUE INDEX IF NOT EXISTS idx_images_file_hash_unique ON images(file_hash) WHERE file_hash IS NOT NULL AND status != 'rejected'`); } catch (_) {}

  // Resync sequence to avoid ID reuse after rollback (closes H11)
  try {
    db.run(`UPDATE sqlite_sequence SET seq = (SELECT COALESCE(MAX(id), 0) FROM images) WHERE name = 'images'`);
  } catch (_) {}

  db.run(`
    CREATE TABLE IF NOT EXISTS settings (
      key   TEXT PRIMARY KEY,
      value TEXT
    )
  `);

  wipeLegacySingleWordData();

  saveDatabase();
  console.log('[DB] Initialized successfully.');
  return db;
}

// One-time migration to the sheet format.
//
// Every pre-existing image row is one photo of ONE word, keyed by images.prompt_id.
// The sheet workflow keys a photo to an assignment of 10 lines and derives labels
// from segments, so the two shapes cannot be mixed in one export. The old rows are
// removed; their files are moved to uploads/legacy/ rather than unlinked, so a
// mistake here is recoverable by hand.
function wipeLegacySingleWordData() {
  if (getSetting('sheet_migration_done') === '1') return;

  const legacyDir = path.join(config.UPLOAD_DIR, 'legacy');
  const rows = all(`SELECT id, filename FROM images`);

  if (rows.length > 0) {
    fs.mkdirSync(legacyDir, { recursive: true });
    for (const row of rows) {
      for (const dir of [config.PENDING_DIR, config.APPROVED_DIR]) {
        const src = path.join(dir, row.filename);
        if (fs.existsSync(src)) {
          try { fs.renameSync(src, path.join(legacyDir, row.filename)); } catch (_) {}
        }
      }
    }
    db.run(`DELETE FROM images`);
    db.run(`DELETE FROM segments`);
    db.run(`DELETE FROM assignment_items`);
    db.run(`DELETE FROM assignments`);
    try {
      db.run(`UPDATE sqlite_sequence SET seq = 0 WHERE name IN ('images','segments','assignments','assignment_items')`);
    } catch (_) {}
  }

  setSetting('sheet_migration_done', '1');
  saveDatabase();
  console.log(`[DB] Sheet-format migration: cleared ${rows.length} legacy single-word image row(s); files moved to uploads/legacy/.`);
}

function saveDatabase() {
  if (!db) return;
  const data = db.export();
  const buffer = Buffer.from(data);
  const tempPath = config.DB_PATH + '.tmp';
  fs.writeFileSync(tempPath, buffer);
  fs.renameSync(tempPath, config.DB_PATH);
}

// --- Debounced persistence: mark dirty on every write, flush at most every 5s ---
let _dbDirty = false;
let _saveTimer = null;

function markDirty() {
  _dbDirty = true;
  if (!_saveTimer) {
    _saveTimer = setTimeout(() => {
      _saveTimer = null;
      flushIfDirty();
    }, 5000);
    _saveTimer.unref();
  }
}

function flushIfDirty() {
  if (_saveTimer) {
    clearTimeout(_saveTimer);
    _saveTimer = null;
  }
  if (_dbDirty && db) {
    _dbDirty = false;
    saveDatabase();
  }
}

// Periodic safety-net save every 30s (catches edge cases where markDirty timer was GC'd)
setInterval(() => { flushIfDirty(); }, 30000).unref();

// Save on exit
process.on('exit', () => { if (db) saveDatabase(); });
process.on('SIGINT', () => { flushIfDirty(); process.exit(); });
process.on('SIGTERM', () => { flushIfDirty(); process.exit(); });

// Helper: run a query and return all rows
function all(sql, params = []) {
  const stmt = db.prepare(sql);
  stmt.bind(params);
  const rows = [];
  while (stmt.step()) {
    rows.push(stmt.getAsObject());
  }
  stmt.free();
  return rows;
}

// Helper: run a query and return first row
function get(sql, params = []) {
  const stmt = db.prepare(sql);
  stmt.bind(params);
  let row = null;
  if (stmt.step()) {
    row = stmt.getAsObject();
  }
  stmt.free();
  return row;
}

// Helper: run an insert/update/delete
function run(sql, params = []) {
  db.run(sql, params);
  const lastId = db.exec("SELECT last_insert_rowid() as id")[0]?.values[0][0] || 0;
  const changes = db.getRowsModified();
  markDirty();
  return { lastInsertRowid: lastId, changes };
}

// --- Contributors ---

function createContributor(id, name, userAgent) {
  run(`
    INSERT INTO contributors (id, name, user_agent) VALUES (?, ?, ?)
    ON CONFLICT(id) DO UPDATE SET
      name = COALESCE(excluded.name, contributors.name),
      user_agent = COALESCE(excluded.user_agent, contributors.user_agent)
  `, [id, name || null, userAgent || null]);
}

function getContributor(id) {
  return get(`SELECT * FROM contributors WHERE id = ?`, [id]);
}

function countContributorUploadsLastHour(id) {
  const row = get(`SELECT COUNT(*) as count FROM images WHERE contributor_id = ? AND created_at > datetime('now', '-1 hour')`, [id]);
  return row ? row.count : 0;
}

// --- Prompts ---

// --- Assignments (one sheet = one fixed set of prompts) ---
//
// A contributor is handed SENTENCES_PER_SHEET sentence/word prompts and, separately,
// NUMBERS_PER_SHEET number prompts. They write each set line-by-line on one page and
// upload that page as a single image. The prompt list must therefore be STABLE for
// the whole time the page sits on the contributor's desk, which is why the selection
// is persisted in `assignments` / `assignment_items` instead of being redrawn on
// every request the way the old one-word-per-photo flow did.
//
// Prompts are still picked LEAST-COLLECTED first: with a designed prompt list the
// value of the collection is that every line gets written at least once, and uniform
// random draws are coupon-collector (at N sheets over N prompts roughly 37% of
// prompts are never written while others are written three or four times).
//
// "Collected" counts a prompt that sits on a sheet whose image exists and was not
// rejected. A rejected sheet returns all ten of its prompts to the front of the
// queue; a pending one keeps them out of it, so ten volunteers online at once are
// not all handed the same page.

const SHEET_CATEGORIES = ['sentences', 'numbers'];

function sheetSize(category) {
  return category === 'numbers'
    ? (config.NUMBERS_PER_SHEET || 10)
    : (config.SENTENCES_PER_SHEET || 10);
}

// SQL fragment matching prompts belonging to a sheet category. Everything that is
// not explicitly categorised as 'numbers' counts as a sentence/word.
function categoryCondition(category) {
  return category === 'numbers' ? `p.category = 'numbers'` : `p.category != 'numbers'`;
}

// Least-collected prompts for a category, skipping ones this contributor has been
// assigned before (in any set, submitted or not).
function pickPromptsForSheet(contributorId, category, count) {
  const excluded = all(`
    SELECT DISTINCT ai.prompt_id
    FROM assignment_items ai
    JOIN assignments a ON a.id = ai.assignment_id
    WHERE a.contributor_id = ?
  `, [contributorId]).map(r => r.prompt_id);

  const select = (excludeIds) => {
    const exclude = excludeIds.length
      ? `AND p.id NOT IN (${excludeIds.map(() => '?').join(',')})`
      : '';
    return all(`
      SELECT p.*, COUNT(i.id) AS collected
      FROM prompts p
      LEFT JOIN assignment_items ai ON ai.prompt_id = p.id
      LEFT JOIN assignments a ON a.id = ai.assignment_id
      LEFT JOIN images i ON i.id = a.image_id AND i.status != 'rejected'
      WHERE p.active = 1 AND ${categoryCondition(category)} ${exclude}
      GROUP BY p.id
      ORDER BY collected ASC, RANDOM()
      LIMIT ?
    `, [...excludeIds, count]);
  };

  let rows = select(excluded);

  // A long-running volunteer can exhaust the pool of prompts they have never seen.
  // Rather than hand them a short sheet, top it up with repeats they have written
  // before, still least-collected first.
  if (rows.length < count) {
    const have = new Set(rows.map(r => r.id));
    for (const row of select([])) {
      if (rows.length >= count) break;
      if (!have.has(row.id)) {
        have.add(row.id);
        rows.push(row);
      }
    }
  }

  return rows.slice(0, count);
}

function getAssignmentItems(assignmentId) {
  return all(`
    SELECT ai.id, ai.line_no, ai.prompt_id, p.text, p.category
    FROM assignment_items ai
    LEFT JOIN prompts p ON p.id = ai.prompt_id
    WHERE ai.assignment_id = ?
    ORDER BY ai.line_no ASC
  `, [assignmentId]);
}

function getOpenAssignment(contributorId, category) {
  return get(`
    SELECT * FROM assignments
    WHERE contributor_id = ? AND category = ? AND status = 'open'
    ORDER BY id DESC LIMIT 1
  `, [contributorId, category]);
}

function getAssignment(id) {
  return get(`SELECT * FROM assignments WHERE id = ?`, [id]);
}

// Create an open assignment and fill it with prompts. Returns null when the prompt
// bank for that category is empty (admin has not uploaded the texts yet).
function createAssignment(contributorId, category) {
  const size = sheetSize(category);
  const prompts = pickPromptsForSheet(contributorId, category, size);
  if (prompts.length === 0) return null;

  const result = run(
    `INSERT INTO assignments (contributor_id, category) VALUES (?, ?)`,
    [contributorId, category]
  );
  const assignmentId = result.lastInsertRowid;

  prompts.forEach((prompt, index) => {
    db.run(
      `INSERT INTO assignment_items (assignment_id, prompt_id, line_no) VALUES (?, ?, ?)`,
      [assignmentId, prompt.id, index + 1]
    );
  });
  markDirty();

  return getAssignment(assignmentId);
}

function getLatestAssignment(contributorId, category) {
  return get(`
    SELECT * FROM assignments
    WHERE contributor_id = ? AND category = ?
    ORDER BY id DESC LIMIT 1
  `, [contributorId, category]);
}

// The contributor's CURRENT sheet for a category — the most recent one, whatever
// its state. Only a contributor who has never had a sheet in this category gets one
// created here; a submitted sheet must keep reporting as submitted until the
// volunteer explicitly asks for a new set, otherwise merely loading the page would
// hand out fresh prompts and the "both sheets done" state could never be reached.
function getOrCreateAssignment(contributorId, category) {
  const latest = getLatestAssignment(contributorId, category);
  if (latest) return latest;
  return createAssignment(contributorId, category);
}

function markAssignmentSubmitted(assignmentId, imageId) {
  return run(
    `UPDATE assignments SET status = 'submitted', image_id = ?, submitted_at = datetime('now') WHERE id = ?`,
    [imageId, assignmentId]
  );
}

// A rejected or purged sheet frees its assignment so the contributor can rewrite
// exactly the same ten lines rather than being handed a different page.
function reopenAssignmentForImage(imageId) {
  return run(
    `UPDATE assignments SET status = 'open', image_id = NULL, submitted_at = NULL WHERE image_id = ?`,
    [imageId]
  );
}

// Full state of a contributor's current sheets, for the volunteer-facing page.
function getContributorSheetState(contributorId) {
  const sheets = {};
  for (const category of SHEET_CATEGORIES) {
    const assignment = getOrCreateAssignment(contributorId, category);
    if (!assignment) {
      sheets[category] = { available: false, size: sheetSize(category) };
      continue;
    }
    const image = assignment.image_id ? get(`SELECT id, status, filename FROM images WHERE id = ?`, [assignment.image_id]) : null;
    sheets[category] = {
      available: true,
      assignment_id: assignment.id,
      status: assignment.status,
      size: sheetSize(category),
      items: getAssignmentItems(assignment.id).map(item => ({
        line_no: item.line_no,
        prompt_id: item.prompt_id,
        text: item.text,
      })),
      image: image ? { id: image.id, status: image.status } : null,
    };
  }

  const completed = get(`
    SELECT COUNT(*) AS c FROM assignments a
    JOIN images i ON i.id = a.image_id
    WHERE a.contributor_id = ? AND a.status = 'submitted' AND i.status != 'rejected'
  `, [contributorId]);

  return {
    sheets,
    completedSheets: completed ? completed.c : 0,
  };
}

// Both sheets done -> the volunteer may ask for a fresh set of ten and ten.
function startNewSheetSet(contributorId) {
  const created = [];
  for (const category of SHEET_CATEGORIES) {
    if (getOpenAssignment(contributorId, category)) continue;
    const assignment = createAssignment(contributorId, category);
    if (assignment) created.push(category);
  }
  return created;
}

// Legacy-compatible progress summary, now counted in sheets rather than photos.
function getContributorProgress(contributorId) {
  if (!contributorId) return { sentences: 0, numbers: 0, total: 0 };
  const rows = all(`
    SELECT a.category, COUNT(*) AS c
    FROM assignments a
    JOIN images i ON i.id = a.image_id
    WHERE a.contributor_id = ? AND a.status = 'submitted' AND i.status != 'rejected'
    GROUP BY a.category
  `, [contributorId]);

  let sentences = 0;
  let numbers = 0;
  for (const row of rows) {
    if (row.category === 'numbers') numbers = row.c;
    else sentences = row.c;
  }
  return { sentences, numbers, total: sentences + numbers };
}

// --- Segments (admin-drawn crops) ---

// `quad` and `erase` are stored as JSON text. Callers work with real arrays, so
// parse on the way out and stringify on the way in, in one place.
function hydrateSegment(row) {
  if (!row) return row;
  let quad = null;
  let erase = [];
  try { if (row.quad) quad = JSON.parse(row.quad); } catch (_) {}
  try { if (row.erase) erase = JSON.parse(row.erase); } catch (_) {}
  // A segment saved before free-form shapes existed has no quad: its shape is its
  // bounding box, so synthesise the four corners rather than special-casing callers.
  if (!Array.isArray(quad) || quad.length !== 4) {
    quad = [
      [row.x, row.y],
      [row.x + row.w, row.y],
      [row.x + row.w, row.y + row.h],
      [row.x, row.y + row.h],
    ];
  }
  return { ...row, quad, erase: Array.isArray(erase) ? erase : [] };
}

function getSegments(imageId) {
  return all(`SELECT * FROM segments WHERE image_id = ? ORDER BY line_no ASC`, [imageId])
    .map(hydrateSegment);
}

function getSegment(imageId, lineNo) {
  return hydrateSegment(get(`SELECT * FROM segments WHERE image_id = ? AND line_no = ?`, [imageId, lineNo]));
}

function upsertSegment(data) {
  const existing = getSegment(data.imageId, data.lineNo);
  const quadJson = data.quad ? JSON.stringify(data.quad) : null;
  const eraseJson = JSON.stringify(data.erase || []);
  const bgColor = data.bgColor || null;

  if (existing) {
    run(`
      UPDATE segments
      SET prompt_id = ?, text = ?, x = ?, y = ?, w = ?, h = ?, filename = ?,
          quad = ?, erase = ?, bg_color = ?, updated_at = datetime('now')
      WHERE id = ?
    `, [
      data.promptId || null, data.text,
      data.x, data.y, data.w, data.h,
      data.filename || null,
      quadJson, eraseJson, bgColor, existing.id,
    ]);
    return { id: existing.id, previousFilename: existing.filename };
  }

  const result = run(`
    INSERT INTO segments (image_id, prompt_id, line_no, text, x, y, w, h, filename, quad, erase, bg_color, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, datetime('now'))
  `, [
    data.imageId, data.promptId || null, data.lineNo, data.text,
    data.x, data.y, data.w, data.h, data.filename || null,
    quadJson, eraseJson, bgColor,
  ]);
  return { id: result.lastInsertRowid, previousFilename: null };
}

function deleteSegment(imageId, lineNo) {
  const existing = getSegment(imageId, lineNo);
  if (!existing) return null;
  run(`DELETE FROM segments WHERE id = ?`, [existing.id]);
  return existing;
}

function deleteSegmentsForImages(imageIds) {
  if (!imageIds || !imageIds.length) return [];
  const placeholders = imageIds.map(() => '?').join(',');
  const rows = all(`SELECT id, filename FROM segments WHERE image_id IN (${placeholders})`, imageIds);
  db.run(`DELETE FROM segments WHERE image_id IN (${placeholders})`, imageIds);
  markDirty();
  return rows;
}

function countSegments(imageId) {
  const row = get(`SELECT COUNT(*) AS c FROM segments WHERE image_id = ?`, [imageId]);
  return row ? row.c : 0;
}

// The expected line list for a sheet, each line paired with its saved rectangle
// (or null when the admin has not drawn it yet). Legacy rows that predate the
// sheet format fall back to their single prompt/custom text as line 1.
function getImageLines(imageId) {
  const image = get(`SELECT * FROM images WHERE id = ?`, [imageId]);
  if (!image) return [];

  let lines;
  if (image.assignment_id) {
    lines = getAssignmentItems(image.assignment_id).map(item => ({
      line_no: item.line_no,
      prompt_id: item.prompt_id,
      text: item.text,
    }));
  } else {
    lines = [{ line_no: 1, prompt_id: image.prompt_id || null, text: image.custom_text || '' }];
  }

  const segments = getSegments(imageId);
  const byLine = new Map(segments.map(s => [s.line_no, s]));
  return lines.map(line => ({
    ...line,
    segment: byLine.get(line.line_no) || null,
  }));
}

// --- Prompts ---

function getAllPrompts(activeOnly) {
  if (activeOnly) {
    return all(`SELECT * FROM prompts WHERE active = 1 ORDER BY id DESC`);
  }
  return all(`SELECT * FROM prompts ORDER BY id DESC`);
}

function createPrompt(text, category) {
  return run(`INSERT INTO prompts (text, category) VALUES (?, ?)`, [text, category || 'custom']);
}

function togglePrompt(id, active) {
  return run(`UPDATE prompts SET active = ? WHERE id = ?`, [active ? 1 : 0, id]);
}

// A prompt is "in use" once it has been placed on any sheet — images no longer
// reference prompts directly, assignment_items does.
function countPromptImages(promptId) {
  const legacy = get(`SELECT COUNT(*) as c FROM images WHERE prompt_id = ?`, [promptId]);
  const assigned = get(`SELECT COUNT(*) as c FROM assignment_items WHERE prompt_id = ?`, [promptId]);
  return (legacy ? legacy.c : 0) + (assigned ? assigned.c : 0);
}

function deletePrompt(id) {
  const imageCount = countPromptImages(id);
  if (imageCount > 0) {
    const error = new Error('این متن در تصاویر ارسالی استفاده شده است و نمی‌توان آن را حذف کرد. به جای حذف، می‌توانید آن را غیرفعال کنید.');
    error.statusCode = 400;
    throw error;
  }
  return run(`DELETE FROM prompts WHERE id = ?`, [id]);
}

function createPromptsBatch(texts, category) {
  if (!texts || texts.length === 0) return 0;
  db.run('BEGIN TRANSACTION');
  let count = 0;
  try {
    for (const text of texts) {
      if (text && text.trim()) {
        db.run(`INSERT INTO prompts (text, category) VALUES (?, ?)`, [text.trim(), category || 'custom']);
        count++;
      }
    }
    db.run('COMMIT');
  } catch (err) {
    db.run('ROLLBACK');
    throw err;
  }
  markDirty();
  return count;
}

function createPromptBatch(filename, rowCount) {
  return run(`INSERT INTO prompt_batches (filename, row_count) VALUES (?, ?)`, [filename, rowCount]);
}

// Simple JS mutex queue to serialize hash-check + insert (prevents duplicate race, Bug 11)
let _imageInsertQueue = Promise.resolve();

function createImage(data) {
  // Application-level FK enforcement (Bug 6: sql.js doesn't enforce FOREIGN KEY)
  if (!data.contributorId) {
    throw Object.assign(new Error('شناسه مشارکت‌کننده الزامی است.'), { statusCode: 400 });
  }
  const contributor = get(`SELECT id FROM contributors WHERE id = ?`, [data.contributorId]);
  if (!contributor) {
    throw Object.assign(new Error('شناسه مشارکت‌کننده در سامانه یافت نشد.'), { statusCode: 400 });
  }
  // The sheet must still be open and must belong to this contributor: re-checked
  // here, inside the insert mutex, so two parallel uploads cannot both claim it.
  const assignment = getAssignment(data.assignmentId);
  if (!assignment) {
    throw Object.assign(new Error('برگه انتخابی در سامانه یافت نشد.'), { statusCode: 400 });
  }
  if (assignment.contributor_id !== data.contributorId) {
    throw Object.assign(new Error('این برگه متعلق به شما نیست.'), { statusCode: 403 });
  }
  if (assignment.status !== 'open') {
    throw Object.assign(new Error('برای این برگه قبلاً تصویری ارسال شده است.'), { statusCode: 409 });
  }

  // Atomic duplicate-hash guard: re-check inside lock to close the race window
  if (data.fileHash) {
    const dup = findByFileHash(data.fileHash);
    if (dup) {
      throw Object.assign(new Error('DUPLICATE_IMAGE'), { statusCode: 409 });
    }
  }

  const result = run(`
    INSERT INTO images (filename, original_name, contributor_id, mime_type, file_size, ip_address, file_hash, assignment_id, sheet_category)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
  `, [
    data.filename,
    data.originalName || null,
    data.contributorId,
    data.mimeType || null,
    data.fileSize || 0,
    data.ipAddress || null,
    data.fileHash || null,
    assignment.id,
    assignment.category,
  ]);

  markAssignmentSubmitted(assignment.id, result.lastInsertRowid);
  return result;
}

// Serialize createImage calls so two concurrent uploads with the same hash
// cannot both pass findByFileHash before either row is inserted.
function createImageSafe(data) {
  return new Promise((resolve, reject) => {
    _imageInsertQueue = _imageInsertQueue
      .catch(() => {}) // don't let a prior rejection block the queue
      .then(() => {
        try {
          const result = createImage(data);
          resolve(result);
        } catch (err) {
          reject(err);
        }
      });
  });
}

function getImages({ status, page, limit }) {
  page = page || 1;
  limit = limit || 20;
  const offset = (page - 1) * limit;

  let where = '';
  const params = [];
  if (status) {
    where = 'WHERE i.status = ?';
    params.push(status);
  }

  const countRow = get(`SELECT COUNT(*) as total FROM images i ${where}`, params);
  const images = all(`
    SELECT i.*, p.text as prompt_text, p.category as prompt_category, c.name as contributor_name,
           (SELECT COUNT(*) FROM assignment_items ai WHERE ai.assignment_id = i.assignment_id) AS line_count,
           (SELECT COUNT(*) FROM segments s WHERE s.image_id = i.id) AS segment_count
    FROM images i
    LEFT JOIN prompts p ON i.prompt_id = p.id
    LEFT JOIN contributors c ON i.contributor_id = c.id
    ${where}
    ORDER BY i.created_at DESC
    LIMIT ? OFFSET ?
  `, [...params, limit, offset]);

  return {
    images,
    total: countRow ? countRow.total : 0,
    page,
    pages: Math.ceil((countRow ? countRow.total : 0) / limit),
  };
}

function getImage(id) {
  return get(`
    SELECT i.*, p.text as prompt_text, p.category as prompt_category, c.name as contributor_name,
           (SELECT COUNT(*) FROM assignment_items ai WHERE ai.assignment_id = i.assignment_id) AS line_count,
           (SELECT COUNT(*) FROM segments s WHERE s.image_id = i.id) AS segment_count
    FROM images i
    LEFT JOIN prompts p ON i.prompt_id = p.id
    LEFT JOIN contributors c ON i.contributor_id = c.id
    WHERE i.id = ?
  `, [id]);
}

function updateImageStatus(id, status, rejectionReason) {
  const result = run(
    `UPDATE images SET status = ?, rejection_reason = ?, reviewed_at = datetime('now') WHERE id = ?`,
    [status, rejectionReason || null, id]
  );
  // A rejected sheet hands its ten lines back to the volunteer to rewrite.
  if (status === 'rejected') reopenAssignmentForImage(id);
  else run(`UPDATE assignments SET status = 'submitted', image_id = ? WHERE id = (SELECT assignment_id FROM images WHERE id = ?)`, [id, id]);
  return result;
}

function setDriveFileId(id, driveFileId) {
  return run(`UPDATE images SET drive_file_id = ?, drive_synced_at = datetime('now') WHERE id = ?`, [driveFileId, id]);
}

function getApprovedUnsynced() {
  return all(`
    SELECT i.*, p.text as prompt_text, p.category as prompt_category, c.name as contributor_name
    FROM images i
    LEFT JOIN prompts p ON i.prompt_id = p.id
    LEFT JOIN contributors c ON i.contributor_id = c.id
    WHERE i.status = 'approved' AND i.drive_file_id IS NULL
    ORDER BY i.created_at ASC
  `);
}

function getStats() {
  const total = get(`SELECT COUNT(*) as c FROM images`).c;
  const pending = get(`SELECT COUNT(*) as c FROM images WHERE status = 'pending'`).c;
  const approved = get(`SELECT COUNT(*) as c FROM images WHERE status = 'approved'`).c;
  const rejected = get(`SELECT COUNT(*) as c FROM images WHERE status = 'rejected'`).c;
  const synced = get(`SELECT COUNT(*) as c FROM images WHERE drive_file_id IS NOT NULL`).c;
  const contributors = get(`SELECT COUNT(*) as c FROM contributors`).c;
  const prompts = get(`SELECT COUNT(*) as c FROM prompts WHERE active = 1`).c;
  const segments = get(`SELECT COUNT(*) as c FROM segments`).c;
  const segmentsApproved = get(`
    SELECT COUNT(*) as c FROM segments s
    JOIN images i ON i.id = s.image_id
    WHERE i.status = 'approved'
  `).c;
  return { total, pending, approved, rejected, synced, contributors, prompts, segments, segmentsApproved };
}

function getContributorUploadCount(contributorId) {
  return get(`SELECT COUNT(*) as c FROM images WHERE contributor_id = ?`, [contributorId]).c;
}

// One row per approved SHEET (the full page image).
function getApprovedForExport() {
  return all(`
    SELECT i.filename, i.custom_text, i.contributor_id, c.name as contributor_name, i.created_at, i.drive_file_id,
           i.sheet_category, p.text as prompt_text,
           (SELECT COUNT(*) FROM assignment_items ai WHERE ai.assignment_id = i.assignment_id) AS line_count,
           (SELECT COUNT(*) FROM segments s WHERE s.image_id = i.id) AS segment_count
    FROM images i
    LEFT JOIN prompts p ON i.prompt_id = p.id
    LEFT JOIN contributors c ON i.contributor_id = c.id
    WHERE i.status = 'approved'
    ORDER BY i.created_at ASC
  `);
}

// One row per admin-cropped LINE of an approved sheet. This is the actual training
// dataset: a tight image of one word/sentence/number paired with its exact label.
function getApprovedSegmentsForExport() {
  return all(`
    SELECT s.filename, s.text, s.line_no, s.x, s.y, s.w, s.h,
           i.filename AS sheet_filename, i.sheet_category, i.contributor_id,
           c.name AS contributor_name, i.created_at
    FROM segments s
    JOIN images i ON i.id = s.image_id
    LEFT JOIN contributors c ON c.id = i.contributor_id
    WHERE i.status = 'approved' AND s.filename IS NOT NULL
    ORDER BY i.created_at ASC, s.line_no ASC
  `);
}

// --- Settings ---

function getSetting(key) {
  const row = get(`SELECT value FROM settings WHERE key = ?`, [key]);
  return row ? row.value : null;
}

function setSetting(key, value) {
  return run(`INSERT OR REPLACE INTO settings (key, value) VALUES (?, ?)`, [key, value]);
}

// --- Security & Quota Queries ---

function countIpUploadsLastHour(ip) {
  if (!ip) return 0;
  const row = get(`SELECT COUNT(*) as count FROM images WHERE ip_address = ? AND created_at > datetime('now', '-1 hour')`, [ip]);
  return row ? row.count : 0;
}

function countIpUploadsLastMinute(ip) {
  if (!ip) return 0;
  const row = get(`SELECT COUNT(*) as count FROM images WHERE ip_address = ? AND created_at > datetime('now', '-1 minute')`, [ip]);
  return row ? row.count : 0;
}

function findByFileHash(hash) {
  if (!hash) return null;
  return get(`SELECT id, filename, status FROM images WHERE file_hash = ? AND status != 'rejected' LIMIT 1`, [hash]);
}

function getPendingCount() {
  const row = get(`SELECT COUNT(*) as count FROM images WHERE status = 'pending'`);
  return row ? row.count : 0;
}

function getOldRejectedImages(olderThanSeconds = 60) {
  return all(`
    SELECT id, filename, status, reviewed_at
    FROM images
    WHERE status = 'rejected'
      AND (reviewed_at IS NULL OR reviewed_at <= datetime('now', '-' || ? || ' seconds'))
  `, [olderThanSeconds]);
}

function getAllRejectedImages() {
  return all(`SELECT id, filename, status FROM images WHERE status = 'rejected'`);
}

// Returns the segment rows removed with the image, so the caller can unlink their
// crop files; an image row must never outlive its children or vice versa.
function deleteImage(id) {
  const removedSegments = deleteSegmentsForImages([id]);
  reopenAssignmentForImage(id);
  run(`DELETE FROM images WHERE id = ?`, [id]);
  return removedSegments;
}

// Returns the segment rows that were removed alongside the images, so the caller
// can unlink their crop files.
function deleteImagesBatch(ids) {
  if (!ids || !ids.length) return 0;
  for (let i = 0; i < ids.length; i += 500) {
    const chunk = ids.slice(i, i + 500);
    const placeholders = chunk.map(() => '?').join(',');
    // Detach the assignment first: an image row about to disappear must not leave
    // a submitted assignment pointing at a missing sheet.
    db.run(`UPDATE assignments SET status = 'open', image_id = NULL, submitted_at = NULL WHERE image_id IN (${placeholders})`, chunk);
  }
  for (let i = 0; i < ids.length; i += 500) {
    const chunk = ids.slice(i, i + 500);
    const placeholders = chunk.map(() => '?').join(',');
    db.run(`DELETE FROM images WHERE id IN (${placeholders})`, chunk);
  }
  markDirty();
  return ids.length;
}

function updateImagesStatusBatch(ids, status, rejectionReason) {
  if (!ids || !ids.length) return [];
  const placeholders = ids.map(() => '?').join(',');
  const images = all(`SELECT id, filename, status FROM images WHERE id IN (${placeholders})`, ids);
  if (!images.length) return [];

  for (let i = 0; i < ids.length; i += 500) {
    const chunk = ids.slice(i, i + 500);
    const chunkPlaceholders = chunk.map(() => '?').join(',');
    db.run(`
      UPDATE images
      SET status = ?, rejection_reason = ?, reviewed_at = datetime('now')
      WHERE id IN (${chunkPlaceholders})
    `, [status, rejectionReason || null, ...chunk]);

    // Rejecting a sheet hands its ten lines back to the volunteer to rewrite.
    if (status === 'rejected') {
      db.run(`
        UPDATE assignments SET status = 'open', image_id = NULL, submitted_at = NULL
        WHERE image_id IN (${chunkPlaceholders})
      `, chunk);
    }
  }
  markDirty();
  return images;
}

function getPromptById(id) {
  if (!id) return null;
  return get(`SELECT * FROM prompts WHERE id = ?`, [id]);
}

function cleanupPlantedData() {
  const sqlPredicate = `
    contributor_id LIKE 'redteam%' OR contributor_id LIKE 'rt-deep%' OR contributor_id LIKE 'mass-%'
    OR contributor_id LIKE 'fullchain-%' OR contributor_id LIKE 'poly-probe%' OR contributor_id LIKE 'magic-probe%' OR contributor_id LIKE 'dedup%' OR contributor_id LIKE 'xsreflect%'
    OR contributor_id LIKE 'errrefl%' OR contributor_id LIKE 'quota-rst%' OR contributor_id LIKE 'rst-race%' OR contributor_id LIKE 'trimtest%' OR contributor_id LIKE 'freshhot%'
    OR contributor_id LIKE 'finale%' OR contributor_id LIKE 'seq%' OR contributor_id LIKE 'idreuse%' OR contributor_id LIKE 'burst%' OR contributor_id LIKE 'multi%' OR contributor_id LIKE 'hdr%'
    OR contributor_id LIKE 'diff-%' OR contributor_id LIKE 'htmltest%' OR contributor_id LIKE 'ads-probe%' OR contributor_id LIKE 'trav2%' OR contributor_id LIKE 'dbint%'
    OR contributor_id IN ('trav-test-id','verify-check-999','attacker-uuid-123','csrf-test-uuid','collide','format-check-1','11111111-2222-3333-4444-555555555555','test_contrib')
  `;

  const images = all(`SELECT id, filename FROM images WHERE ${sqlPredicate}`);
  for (const img of images) {
    for (const d of [config.PENDING_DIR, config.APPROVED_DIR]) {
      const p = path.join(d, img.filename);
      if (fs.existsSync(p)) {
        try { fs.unlinkSync(p); } catch (_) {}
      }
    }
  }

  run(`DELETE FROM images WHERE ${sqlPredicate}`);
  const contribPredicate = sqlPredicate.replace(/contributor_id/g, 'id');
  run(`DELETE FROM contributors WHERE ${contribPredicate}`);
  return images.length;
}

module.exports = {
  db: { get: () => db },
  initDatabase,
  cleanupPlantedData,
  createContributor,
  getContributor,
  countContributorUploadsLastHour,
  countIpUploadsLastHour,
  countIpUploadsLastMinute,
  findByFileHash,
  getPendingCount,
  getOldRejectedImages,
  getAllRejectedImages,
  deleteImage,
  deleteImagesBatch,
  updateImagesStatusBatch,
  // Sheets / assignments
  SHEET_CATEGORIES,
  sheetSize,
  getAssignment,
  getOpenAssignment,
  getLatestAssignment,
  getOrCreateAssignment,
  getAssignmentItems,
  createAssignment,
  markAssignmentSubmitted,
  reopenAssignmentForImage,
  getContributorSheetState,
  startNewSheetSet,
  // Segments
  getSegments,
  getSegment,
  upsertSegment,
  deleteSegment,
  deleteSegmentsForImages,
  countSegments,
  getImageLines,
  getApprovedSegmentsForExport,
  getAllPrompts,
  getPromptById,
  createPrompt,
  createPromptsBatch,
  countPromptImages,
  togglePrompt,
  deletePrompt,
  createPromptBatch,
  createImage,
  createImageSafe,
  getImages,
  getImage,
  updateImageStatus,
  setDriveFileId,
  getApprovedUnsynced,
  getStats,
  getContributorUploadCount,
  getContributorProgress,
  getApprovedForExport,
  getSetting,
  setSetting,
  saveDatabase,
  flushIfDirty,
  markDirty,
};
