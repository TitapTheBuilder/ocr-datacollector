const Database = require('better-sqlite3');
const path = require('path');
const fs = require('fs');
const config = require('./config');

const dbDir = path.dirname(config.DB_PATH);
if (!fs.existsSync(dbDir)) fs.mkdirSync(dbDir, { recursive: true });

const db = new Database(config.DB_PATH);
db.pragma('journal_mode = WAL');
db.pragma('foreign_keys = ON');

db.exec(`
  CREATE TABLE IF NOT EXISTS contributors (
    id          TEXT PRIMARY KEY,
    created_at  TEXT DEFAULT (datetime('now')),
    user_agent  TEXT
  );

  CREATE TABLE IF NOT EXISTS prompts (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    text        TEXT NOT NULL,
    category    TEXT DEFAULT 'custom',
    active      INTEGER DEFAULT 1,
    created_at  TEXT DEFAULT (datetime('now'))
  );

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
  );

  CREATE TABLE IF NOT EXISTS prompt_batches (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    filename    TEXT NOT NULL,
    row_count   INTEGER,
    uploaded_at TEXT DEFAULT (datetime('now'))
  );

  CREATE INDEX IF NOT EXISTS idx_images_status ON images(status);
  CREATE INDEX IF NOT EXISTS idx_images_contributor ON images(contributor_id);
`);

// --- Contributors ---

function createContributor(id, userAgent) {
  const stmt = db.prepare(`INSERT OR IGNORE INTO contributors (id, user_agent) VALUES (?, ?)`);
  return stmt.run(id, userAgent || null);
}

function getContributor(id) {
  return db.prepare(`SELECT * FROM contributors WHERE id = ?`).get(id);
}

function countContributorUploadsLastHour(id) {
  const row = db.prepare(`
    SELECT COUNT(*) as count FROM images
    WHERE contributor_id = ? AND created_at > datetime('now', '-1 hour')
  `).get(id);
  return row.count;
}

// --- Prompts ---

function getRandomPrompt(contributorId) {
  let recentIds = [];
  if (contributorId) {
    recentIds = db.prepare(`
      SELECT prompt_id FROM images
      WHERE contributor_id = ? AND prompt_id IS NOT NULL
      ORDER BY created_at DESC LIMIT 5
    `).all(contributorId).map(r => r.prompt_id);
  }

  let prompt;
  if (recentIds.length > 0) {
    const placeholders = recentIds.map(() => '?').join(',');
    prompt = db.prepare(`
      SELECT * FROM prompts WHERE active = 1 AND id NOT IN (${placeholders})
      ORDER BY RANDOM() LIMIT 1
    `).get(...recentIds);
  }

  if (!prompt) {
    prompt = db.prepare(`SELECT * FROM prompts WHERE active = 1 ORDER BY RANDOM() LIMIT 1`).get();
  }

  return prompt;
}

function getAllPrompts(activeOnly) {
  if (activeOnly) {
    return db.prepare(`SELECT * FROM prompts WHERE active = 1 ORDER BY id DESC`).all();
  }
  return db.prepare(`SELECT * FROM prompts ORDER BY id DESC`).all();
}

function createPrompt(text, category) {
  return db.prepare(`INSERT INTO prompts (text, category) VALUES (?, ?)`).run(text, category || 'custom');
}

function togglePrompt(id, active) {
  return db.prepare(`UPDATE prompts SET active = ? WHERE id = ?`).run(active ? 1 : 0, id);
}

function deletePrompt(id) {
  return db.prepare(`DELETE FROM prompts WHERE id = ?`).run(id);
}

function createPromptBatch(filename, rowCount) {
  return db.prepare(`INSERT INTO prompt_batches (filename, row_count) VALUES (?, ?)`).run(filename, rowCount);
}

// --- Images ---

function createImage(data) {
  return db.prepare(`
    INSERT INTO images (filename, original_name, prompt_id, custom_text, contributor_id, mime_type, file_size)
    VALUES (?, ?, ?, ?, ?, ?, ?)
  `).run(data.filename, data.originalName, data.promptId || null, data.customText || null, data.contributorId, data.mimeType, data.fileSize);
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

  const countRow = db.prepare(`SELECT COUNT(*) as total FROM images i ${where}`).get(...params);
  const images = db.prepare(`
    SELECT i.*, p.text as prompt_text, p.category as prompt_category
    FROM images i
    LEFT JOIN prompts p ON i.prompt_id = p.id
    ${where}
    ORDER BY i.created_at DESC
    LIMIT ? OFFSET ?
  `).all(...params, limit, offset);

  return {
    images,
    total: countRow.total,
    page,
    pages: Math.ceil(countRow.total / limit),
  };
}

function getImage(id) {
  return db.prepare(`
    SELECT i.*, p.text as prompt_text, p.category as prompt_category
    FROM images i
    LEFT JOIN prompts p ON i.prompt_id = p.id
    WHERE i.id = ?
  `).get(id);
}

function updateImageStatus(id, status, rejectionReason) {
  return db.prepare(`
    UPDATE images SET status = ?, rejection_reason = ?, reviewed_at = datetime('now') WHERE id = ?
  `).run(status, rejectionReason || null, id);
}

function setDriveFileId(id, driveFileId) {
  return db.prepare(`
    UPDATE images SET drive_file_id = ?, drive_synced_at = datetime('now') WHERE id = ?
  `).run(driveFileId, id);
}

function getApprovedUnsynced() {
  return db.prepare(`
    SELECT * FROM images WHERE status = 'approved' AND drive_file_id IS NULL
    ORDER BY created_at ASC
  `).all();
}

function getStats() {
  const total = db.prepare(`SELECT COUNT(*) as c FROM images`).get().c;
  const pending = db.prepare(`SELECT COUNT(*) as c FROM images WHERE status = 'pending'`).get().c;
  const approved = db.prepare(`SELECT COUNT(*) as c FROM images WHERE status = 'approved'`).get().c;
  const rejected = db.prepare(`SELECT COUNT(*) as c FROM images WHERE status = 'rejected'`).get().c;
  const synced = db.prepare(`SELECT COUNT(*) as c FROM images WHERE drive_file_id IS NOT NULL`).get().c;
  const contributors = db.prepare(`SELECT COUNT(*) as c FROM contributors`).get().c;
  const prompts = db.prepare(`SELECT COUNT(*) as c FROM prompts WHERE active = 1`).get().c;
  return { total, pending, approved, rejected, synced, contributors, prompts };
}

function getContributorUploadCount(contributorId) {
  return db.prepare(`SELECT COUNT(*) as c FROM images WHERE contributor_id = ?`).get(contributorId).c;
}

function getApprovedForExport() {
  return db.prepare(`
    SELECT i.filename, i.custom_text, i.contributor_id, i.created_at, i.drive_file_id,
           p.text as prompt_text
    FROM images i
    LEFT JOIN prompts p ON i.prompt_id = p.id
    WHERE i.status = 'approved'
    ORDER BY i.created_at ASC
  `).all();
}

module.exports = {
  db,
  createContributor,
  getContributor,
  countContributorUploadsLastHour,
  getRandomPrompt,
  getAllPrompts,
  createPrompt,
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
};
