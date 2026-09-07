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

  db.run('PRAGMA journal_mode = WAL');
  db.run('PRAGMA foreign_keys = ON');

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

  db.run(`CREATE INDEX IF NOT EXISTS idx_images_status ON images(status)`);
  db.run(`CREATE INDEX IF NOT EXISTS idx_images_contributor ON images(contributor_id)`);

  db.run(`
    CREATE TABLE IF NOT EXISTS settings (
      key   TEXT PRIMARY KEY,
      value TEXT
    )
  `);

  saveDatabase();
  console.log('[DB] Initialized successfully.');
  return db;
}

function saveDatabase() {
  if (!db) return;
  const data = db.export();
  const buffer = Buffer.from(data);
  const tempPath = config.DB_PATH + '.tmp';
  fs.writeFileSync(tempPath, buffer);
  fs.renameSync(tempPath, config.DB_PATH);
}

// Auto-save every 30 seconds (unrefed so it doesn't block shutdown or test scripts)
setInterval(() => { if (db) saveDatabase(); }, 30000).unref();

// Save on exit
process.on('exit', () => { if (db) saveDatabase(); });
process.on('SIGINT', () => { if (db) saveDatabase(); process.exit(); });
process.on('SIGTERM', () => { if (db) saveDatabase(); process.exit(); });

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
  saveDatabase();
  return { lastInsertRowid: lastId, changes };
}

// --- Contributors ---

function createContributor(id, userAgent) {
  run(`INSERT OR IGNORE INTO contributors (id, user_agent) VALUES (?, ?)`, [id, userAgent || null]);
}

function getContributor(id) {
  return get(`SELECT * FROM contributors WHERE id = ?`, [id]);
}

function countContributorUploadsLastHour(id) {
  const row = get(`SELECT COUNT(*) as count FROM images WHERE contributor_id = ? AND created_at > datetime('now', '-1 hour')`, [id]);
  return row ? row.count : 0;
}

// --- Prompts ---

function getRandomPrompt(contributorId) {
  let recentIds = [];
  if (contributorId) {
    recentIds = all(`SELECT prompt_id FROM images WHERE contributor_id = ? AND prompt_id IS NOT NULL ORDER BY created_at DESC LIMIT 5`, [contributorId]).map(r => r.prompt_id);
  }

  let prompt;
  if (recentIds.length > 0) {
    const placeholders = recentIds.map(() => '?').join(',');
    prompt = get(`SELECT * FROM prompts WHERE active = 1 AND id NOT IN (${placeholders}) ORDER BY RANDOM() LIMIT 1`, recentIds);
  }

  if (!prompt) {
    prompt = get(`SELECT * FROM prompts WHERE active = 1 ORDER BY RANDOM() LIMIT 1`);
  }

  return prompt;
}

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

function countPromptImages(promptId) {
  const row = get(`SELECT COUNT(*) as c FROM images WHERE prompt_id = ?`, [promptId]);
  return row ? row.c : 0;
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
  saveDatabase();
  return count;
}

function createPromptBatch(filename, rowCount) {
  return run(`INSERT INTO prompt_batches (filename, row_count) VALUES (?, ?)`, [filename, rowCount]);
}

// --- Images ---

function createImage(data) {
  return run(`
    INSERT INTO images (filename, original_name, prompt_id, custom_text, contributor_id, mime_type, file_size)
    VALUES (?, ?, ?, ?, ?, ?, ?)
  `, [data.filename, data.originalName, data.promptId || null, data.customText || null, data.contributorId, data.mimeType, data.fileSize]);
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
    SELECT i.*, p.text as prompt_text, p.category as prompt_category
    FROM images i
    LEFT JOIN prompts p ON i.prompt_id = p.id
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
    SELECT i.*, p.text as prompt_text, p.category as prompt_category
    FROM images i
    LEFT JOIN prompts p ON i.prompt_id = p.id
    WHERE i.id = ?
  `, [id]);
}

function updateImageStatus(id, status, rejectionReason) {
  return run(`UPDATE images SET status = ?, rejection_reason = ?, reviewed_at = datetime('now') WHERE id = ?`, [status, rejectionReason || null, id]);
}

function setDriveFileId(id, driveFileId) {
  return run(`UPDATE images SET drive_file_id = ?, drive_synced_at = datetime('now') WHERE id = ?`, [driveFileId, id]);
}

function getApprovedUnsynced() {
  return all(`SELECT * FROM images WHERE status = 'approved' AND drive_file_id IS NULL ORDER BY created_at ASC`);
}

function getStats() {
  const total = get(`SELECT COUNT(*) as c FROM images`).c;
  const pending = get(`SELECT COUNT(*) as c FROM images WHERE status = 'pending'`).c;
  const approved = get(`SELECT COUNT(*) as c FROM images WHERE status = 'approved'`).c;
  const rejected = get(`SELECT COUNT(*) as c FROM images WHERE status = 'rejected'`).c;
  const synced = get(`SELECT COUNT(*) as c FROM images WHERE drive_file_id IS NOT NULL`).c;
  const contributors = get(`SELECT COUNT(*) as c FROM contributors`).c;
  const prompts = get(`SELECT COUNT(*) as c FROM prompts WHERE active = 1`).c;
  return { total, pending, approved, rejected, synced, contributors, prompts };
}

function getContributorUploadCount(contributorId) {
  return get(`SELECT COUNT(*) as c FROM images WHERE contributor_id = ?`, [contributorId]).c;
}

function getApprovedForExport() {
  return all(`
    SELECT i.filename, i.custom_text, i.contributor_id, i.created_at, i.drive_file_id,
           p.text as prompt_text
    FROM images i
    LEFT JOIN prompts p ON i.prompt_id = p.id
    WHERE i.status = 'approved'
    ORDER BY i.created_at ASC
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

module.exports = {
  db: { get: () => db },
  initDatabase,
  createContributor,
  getContributor,
  countContributorUploadsLastHour,
  getRandomPrompt,
  getAllPrompts,
  createPrompt,
  createPromptsBatch,
  countPromptImages,
  togglePrompt,
  deletePrompt,
  createPromptBatch,
  createImage,
  getImages,
  getImage,
  updateImageStatus,
  setDriveFileId,
  getApprovedUnsynced,
  getStats,
  getContributorUploadCount,
  getApprovedForExport,
  getSetting,
  setSetting,
};
