const express = require('express');
const multer = require('multer');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const { parse } = require('csv-parse/sync');
const config = require('./config');
const db = require('./database');
const drive = require('./google-drive');

// --- Setup ---
const app = express();
app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use(express.static('public'));
app.use('/uploads', express.static('uploads'));

// Ensure directories exist
for (const dir of [config.PENDING_DIR, config.APPROVED_DIR]) {
  fs.mkdirSync(dir, { recursive: true });
}

// Request logging
app.use((req, res, next) => {
  if (req.path.startsWith('/api/')) {
    console.log(`[${new Date().toISOString()}] ${req.method} ${req.path}`);
  }
  next();
});

// --- Multer config ---
const storage = multer.diskStorage({
  destination: config.PENDING_DIR,
  filename: (req, file, cb) => {
    const contributorId = req.body.contributor_id || 'unknown';
    const ext = file.mimetype === 'image/png' ? '.png' : file.mimetype === 'image/webp' ? '.webp' : '.jpg';
    const name = `${contributorId.substring(0, 8)}_${Date.now()}_${crypto.randomBytes(2).toString('hex')}${ext}`;
    cb(null, name);
  },
});

const upload = multer({
  storage,
  limits: { fileSize: config.MAX_FILE_SIZE_MB * 1024 * 1024 },
  fileFilter: (req, file, cb) => {
    if (config.ALLOWED_MIME_TYPES.includes(file.mimetype)) {
      cb(null, true);
    } else {
      cb(new Error('فایل تصویری مجاز نیست. فقط JPEG، PNG و WebP پذیرفته می‌شود.'));
    }
  },
});

// Separate multer for CSV uploads (to temp directory)
const csvStorage = multer.diskStorage({
  destination: (req, file, cb) => cb(null, require('os').tmpdir()),
  filename: (req, file, cb) => cb(null, `csv_${Date.now()}_${file.originalname}`),
});
const csvUpload = multer({
  storage: csvStorage,
  limits: { fileSize: 5 * 1024 * 1024 },
  fileFilter: (req, file, cb) => {
    const allowed = ['text/csv', 'text/plain', 'application/vnd.ms-excel'];
    const ext = file.originalname.toLowerCase();
    if (allowed.includes(file.mimetype) || ext.endsWith('.csv') || ext.endsWith('.txt')) {
      cb(null, true);
    } else {
      cb(new Error('فایل CSV یا TXT مجاز است.'));
    }
  },
});

// --- Admin session management (in-memory) ---
const sessions = {};

function createSession() {
  const token = crypto.randomBytes(32).toString('hex');
  sessions[token] = { createdAt: Date.now() };
  return token;
}

function destroySession(token) {
  delete sessions[token];
}

function isAdmin(req) {
  const token = req.cookies?.admin_session;
  if (!token || !sessions[token]) return false;
  if (Date.now() - sessions[token].createdAt > config.SESSION_EXPIRY_MS) {
    delete sessions[token];
    return false;
  }
  return true;
}

function requireAdmin(req, res, next) {
  if (!isAdmin(req)) {
    return res.status(401).json({ success: false, error: 'Unauthorized' });
  }
  next();
}

// Cookie parser middleware (simple, no library needed)
app.use((req, res, next) => {
  req.cookies = {};
  const cookieHeader = req.headers.cookie;
  if (cookieHeader) {
    cookieHeader.split(';').forEach(c => {
      const [key, ...val] = c.split('=');
      req.cookies[key.trim()] = val.join('=').trim();
    });
  }
  next();
});

// --- Password hashing ---
function generatePasswordHash(password) {
  const salt = crypto.randomBytes(16).toString('hex');
  const hash = crypto.scryptSync(password, salt, 64).toString('hex');
  return `${salt}:${hash}`;
}

function verifyPassword(password, stored) {
  if (!stored) return false;
  const [salt, hash] = stored.split(':');
  const hashToVerify = crypto.scryptSync(password, salt, 64).toString('hex');
  return crypto.timingSafeEqual(Buffer.from(hash, 'hex'), Buffer.from(hashToVerify, 'hex'));
}

// Auto-generate default admin password if not set
if (!config.ADMIN_PASSWORD_HASH) {
  const defaultHash = generatePasswordHash('admin123');
  console.log('[Admin] No password hash configured. Default password: admin123');
  console.log('[Admin] Hash:', defaultHash);
  console.log('[Admin] Add ADMIN_PASSWORD_HASH=' + defaultHash + ' to .env file');
  config.ADMIN_PASSWORD_HASH = defaultHash;
}

// ======================
// USER-FACING ROUTES
// ======================

// Register or acknowledge a contributor
app.post('/api/contributors', (req, res) => {
  try {
    const { id } = req.body;
    if (!id) return res.status(400).json({ success: false, error: 'id is required' });
    db.createContributor(id, req.headers['user-agent']);
    res.json({ success: true });
  } catch (err) {
    console.error('[API] POST /api/contributors:', err.message);
    res.status(500).json({ success: false, error: 'Server error' });
  }
});

// Get next prompt
app.get('/api/prompts/next', (req, res) => {
  try {
    const { contributor_id } = req.query;
    const prompt = db.getRandomPrompt(contributor_id);
    if (!prompt) {
      return res.status(404).json({ success: false, error: 'هیچ متنی برای نمایش وجود ندارد. لطفاً منتظر بمانید تا ادمین متن‌ها را اضافه کند.' });
    }
    res.json({ id: prompt.id, text: prompt.text, category: prompt.category });
  } catch (err) {
    console.error('[API] GET /api/prompts/next:', err.message);
    res.status(500).json({ success: false, error: 'Server error' });
  }
});

// Upload image
app.post('/api/images', upload.single('image'), (req, res) => {
  try {
    if (!req.file) {
      return res.status(400).json({ success: false, error: 'تصویری ارسال نشد.' });
    }

    const { prompt_id, custom_text, contributor_id } = req.body;

    if (!contributor_id) {
      fs.unlinkSync(req.file.path);
      return res.status(400).json({ success: false, error: 'contributor_id is required' });
    }

    if (!prompt_id && !custom_text) {
      fs.unlinkSync(req.file.path);
      return res.status(400).json({ success: false, error: 'Either prompt_id or custom_text is required' });
    }

    // Rate limit check
    const uploadCount = db.countContributorUploadsLastHour(contributor_id);
    if (uploadCount >= config.MAX_UPLOADS_PER_CONTRIBUTOR_PER_HOUR) {
      fs.unlinkSync(req.file.path);
      return res.status(429).json({ success: false, error: 'تعداد آپلودهای شما در ساعت گذشته بیش از حد مجاز است. لطفاً بعداً تلاش کنید.' });
    }

    const result = db.createImage({
      filename: req.file.filename,
      originalName: req.file.originalname,
      promptId: prompt_id || null,
      customText: custom_text || null,
      contributorId: contributor_id,
      mimeType: req.file.mimetype,
      fileSize: req.file.size,
    });

    res.json({ success: true, image_id: result.lastInsertRowid });
  } catch (err) {
    console.error('[API] POST /api/images:', err.message);
    if (req.file && fs.existsSync(req.file.path)) {
      fs.unlinkSync(req.file.path);
    }
    res.status(500).json({ success: false, error: 'Server error' });
  }
});

// Contributor upload count
app.get('/api/contributors/:id/count', (req, res) => {
  try {
    const count = db.getContributorUploadCount(req.params.id);
    res.json({ count });
  } catch (err) {
    console.error('[API] GET /api/contributors/:id/count:', err.message);
    res.status(500).json({ success: false, error: 'Server error' });
  }
});

// ======================
// ADMIN ROUTES
// ======================

// Login
app.post('/api/admin/login', (req, res) => {
  try {
    const { username, password } = req.body;
    if (username === config.ADMIN_USERNAME && verifyPassword(password, config.ADMIN_PASSWORD_HASH)) {
      const token = createSession();
      res.setHeader('Set-Cookie', `admin_session=${token}; HttpOnly; Path=/; Max-Age=${config.SESSION_EXPIRY_MS / 1000}`);
      return res.json({ success: true });
    }
    res.status(401).json({ success: false, error: 'نام کاربری یا رمز عبور اشتباه است.' });
  } catch (err) {
    console.error('[API] POST /api/admin/login:', err.message);
    res.status(500).json({ success: false, error: 'Server error' });
  }
});

// Logout
app.post('/api/admin/logout', (req, res) => {
  const token = req.cookies?.admin_session;
  if (token) destroySession(token);
  res.setHeader('Set-Cookie', 'admin_session=; HttpOnly; Path=/; Max-Age=0');
  res.json({ success: true });
});

// Check auth
app.get('/api/admin/me', (req, res) => {
  res.json({ authenticated: isAdmin(req) });
});

// Stats
app.get('/api/admin/stats', requireAdmin, (req, res) => {
  try {
    res.json(db.getStats());
  } catch (err) {
    console.error('[API] GET /api/admin/stats:', err.message);
    res.status(500).json({ success: false, error: 'Server error' });
  }
});

// List images
app.get('/api/admin/images', requireAdmin, (req, res) => {
  try {
    const { status, page, limit } = req.query;
    res.json(db.getImages({ status, page: parseInt(page) || 1, limit: parseInt(limit) || 20 }));
  } catch (err) {
    console.error('[API] GET /api/admin/images:', err.message);
    res.status(500).json({ success: false, error: 'Server error' });
  }
});

// Approve/reject image
app.patch('/api/admin/images/:id', requireAdmin, (req, res) => {
  try {
    const { status, rejection_reason } = req.body;
    if (!['approved', 'rejected'].includes(status)) {
      return res.status(400).json({ success: false, error: 'Invalid status' });
    }

    const image = db.getImage(req.params.id);
    if (!image) return res.status(404).json({ success: false, error: 'Image not found' });

    db.updateImageStatus(req.params.id, status, rejection_reason);

    // If approved, move file to approved directory
    if (status === 'approved') {
      const srcPath = path.join(config.PENDING_DIR, image.filename);
      const dstPath = path.join(config.APPROVED_DIR, image.filename);
      if (fs.existsSync(srcPath)) {
        fs.renameSync(srcPath, dstPath);
      }
    }

    res.json({ success: true });
  } catch (err) {
    console.error('[API] PATCH /api/admin/images/:id:', err.message);
    res.status(500).json({ success: false, error: 'Server error' });
  }
});

// Sync single image to Drive
app.post('/api/admin/images/:id/sync', requireAdmin, async (req, res) => {
  try {
    if (!drive.isConfigured()) {
      return res.status(400).json({ success: false, error: 'Google Drive پیکربندی نشده است.' });
    }

    const image = db.getImage(req.params.id);
    if (!image) return res.status(404).json({ success: false, error: 'Image not found' });
    if (image.status !== 'approved') return res.status(400).json({ success: false, error: 'Only approved images can be synced' });
    if (image.drive_file_id) return res.status(400).json({ success: false, error: 'Already synced' });

    const localPath = path.join(config.APPROVED_DIR, image.filename);
    if (!fs.existsSync(localPath)) {
      return res.status(404).json({ success: false, error: 'File not found on disk' });
    }

    const driveFileId = await drive.syncImageToDrive(localPath, image.filename, image.mime_type);
    db.setDriveFileId(image.id, driveFileId);

    res.json({ success: true, drive_file_id: driveFileId });
  } catch (err) {
    console.error('[API] POST /api/admin/images/:id/sync:', err.message);
    res.status(500).json({ success: false, error: 'Sync failed: ' + err.message });
  }
});

// Sync all approved to Drive
app.post('/api/admin/images/sync-all', requireAdmin, async (req, res) => {
  try {
    if (!drive.isConfigured()) {
      return res.status(400).json({ success: false, error: 'Google Drive پیکربندی نشده است.' });
    }

    const result = await drive.syncAllApproved(db.getApprovedUnsynced, db.setDriveFileId);
    res.json({ success: true, ...result });
  } catch (err) {
    console.error('[API] POST /api/admin/images/sync-all:', err.message);
    res.status(500).json({ success: false, error: 'Sync failed: ' + err.message });
  }
});

// --- Prompt Management ---

// List prompts
app.get('/api/admin/prompts', requireAdmin, (req, res) => {
  try {
    const activeOnly = req.query.active === '1';
    res.json(db.getAllPrompts(activeOnly));
  } catch (err) {
    console.error('[API] GET /api/admin/prompts:', err.message);
    res.status(500).json({ success: false, error: 'Server error' });
  }
});

// Upload CSV of prompts
app.post('/api/admin/prompts/upload', requireAdmin, csvUpload.single('csv'), (req, res) => {
  try {
    if (!req.file) return res.status(400).json({ success: false, error: 'فایل CSV ارسال نشد.' });

    const content = fs.readFileSync(req.file.path, 'utf-8');
    fs.unlinkSync(req.file.path); // clean up uploaded temp file

    let records;
    try {
      records = parse(content, { columns: false, skip_empty_lines: true, trim: true });
    } catch (e) {
      return res.status(400).json({ success: false, error: 'خطا در خواندن فایل CSV: ' + e.message });
    }

    const category = req.body.category || 'csv-batch';
    let imported = 0;

    const insertMany = db.db.transaction((rows) => {
      for (const row of rows) {
        const text = Array.isArray(row) ? row[0] : row.text;
        if (text && text.trim()) {
          db.createPrompt(text.trim(), category);
          imported++;
        }
      }
    });

    insertMany(records);

    const batch = db.createPromptBatch(req.file.originalname, imported);

    res.json({ success: true, imported, batch_id: batch.lastInsertRowid });
  } catch (err) {
    console.error('[API] POST /api/admin/prompts/upload:', err.message);
    res.status(500).json({ success: false, error: 'Server error' });
  }
});

// Toggle prompt active/inactive
app.patch('/api/admin/prompts/:id', requireAdmin, (req, res) => {
  try {
    const { active } = req.body;
    db.togglePrompt(req.params.id, active);
    res.json({ success: true });
  } catch (err) {
    console.error('[API] PATCH /api/admin/prompts/:id:', err.message);
    res.status(500).json({ success: false, error: 'Server error' });
  }
});

// Delete prompt
app.delete('/api/admin/prompts/:id', requireAdmin, (req, res) => {
  try {
    db.deletePrompt(req.params.id);
    res.json({ success: true });
  } catch (err) {
    console.error('[API] DELETE /api/admin/prompts/:id:', err.message);
    res.status(500).json({ success: false, error: 'Server error' });
  }
});

// Export approved images as CSV manifest
app.get('/api/admin/export', requireAdmin, (req, res) => {
  try {
    const images = db.getApprovedForExport();
    let csv = 'filename,text_label,contributor_id,created_at,drive_file_id\n';
    for (const img of images) {
      const text = (img.prompt_text || img.custom_text || '').replace(/"/g, '""');
      csv += `"${img.filename}","${text}","${img.contributor_id}","${img.created_at}","${img.drive_file_id || ''}"\n`;
    }
    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader('Content-Disposition', 'attachment; filename=ocr_labels.csv');
    res.send('﻿' + csv); // BOM for Excel compatibility
  } catch (err) {
    console.error('[API] GET /api/admin/export:', err.message);
    res.status(500).json({ success: false, error: 'Server error' });
  }
});

// Health check
app.get('/api/health', (req, res) => {
  res.json({ status: 'ok' });
});

// --- Start server ---
const driveReady = drive.initialize();

app.listen(config.PORT, config.HOST, () => {
  console.log(`\n========================================`);
  console.log(`  OCR Data Collector is running!`);
  console.log(`  http://localhost:${config.PORT}`);
  console.log(`  Google Drive sync: ${driveReady ? 'ENABLED' : 'DISABLED'}`);
  console.log(`========================================\n`);
});
