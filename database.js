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
  // getRandomPrompt LEFT JOINs images by prompt_id on every request.
  db.run(`CREATE INDEX IF NOT EXISTS idx_images_prompt ON images(prompt_id)`);

  // Migrate columns for security: ip_address and file_hash
  try { db.run(`ALTER TABLE images ADD COLUMN ip_address TEXT`); } catch (_) {}
  try { db.run(`ALTER TABLE images ADD COLUMN file_hash TEXT`); } catch (_) {}
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

// Serve the LEAST-COLLECTED prompt, not a uniformly random one.
//
// Why: with a designed prompt list (every word above a coverage floor, every
// confusion pair forced in), the value of the collection is that each line gets
// written. Uniform random draws are coupon-collector: at N uploads over N
// prompts roughly 37% of prompts are never written at all, while others are
// written three or four times. Ordering by how many images a prompt already has
// turns that into near-perfect one-each coverage.
//
// This also replaces any need to assign each volunteer a fixed block of 20.
// Block assignment loses a volunteer's whole remainder when they stop after
// five; least-collected simply hands those lines to whoever comes next.
//
// Rejected images do NOT count as collected, so a rejected prompt returns to
// the front of the queue. Pending ones DO count, so five people online at once
// are not all sent the same line while it waits for review.
//
// The contributor's own last 5 are still excluded, so nobody is asked to write
// the same line twice in a row. If that exclusion empties the pool (a tiny
// prompt list), the fallback drops it rather than returning nothing.
function getRandomPrompt(contributorId) {
  let recentIds = [];
  if (contributorId) {
    recentIds = all(`SELECT prompt_id FROM images WHERE contributor_id = ? AND prompt_id IS NOT NULL ORDER BY created_at DESC LIMIT 5`, [contributorId]).map(r => r.prompt_id);
  }

  // RANDOM() breaks ties, so concurrent users on an all-zero pool get
  // different lines instead of colliding on the lowest id.
  const leastCollected = (excludeIds) => {
    const exclude = excludeIds.length
      ? `AND p.id NOT IN (${excludeIds.map(() => '?').join(',')})`
      : '';
    return get(`
      SELECT p.*, COUNT(i.id) AS collected
      FROM prompts p
      LEFT JOIN images i ON i.prompt_id = p.id AND i.status != 'rejected'
      WHERE p.active = 1 ${exclude}
      GROUP BY p.id
      ORDER BY collected ASC, RANDOM()
      LIMIT 1
    `, excludeIds);
  };

  return leastCollected(recentIds) || leastCollected([]);
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
    INSERT INTO images (filename, original_name, prompt_id, custom_text, contributor_id, mime_type, file_size, ip_address, file_hash)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
  `, [
    data.filename,
    data.originalName,
    data.promptId || null,
    data.customText || null,
    data.contributorId,
    data.mimeType,
    data.fileSize,
    data.ipAddress || null,
    data.fileHash || null
  ]);
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

function deleteImage(id) {
  return run(`DELETE FROM images WHERE id = ?`, [id]);
}

function deleteImagesBatch(ids) {
  if (!ids || !ids.length) return 0;
  for (let i = 0; i < ids.length; i += 500) {
    const chunk = ids.slice(i, i + 500);
    const placeholders = chunk.map(() => '?').join(',');
    db.run(`DELETE FROM images WHERE id IN (${placeholders})`, chunk);
  }
  saveDatabase();
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
  }
  saveDatabase();
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
  getRandomPrompt,
  getAllPrompts,
  getPromptById,
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
