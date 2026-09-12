const express = require('express');
const multer = require('multer');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const sharp = require('sharp');
const { parse } = require('csv-parse/sync');
const archiver = require('archiver');
const config = require('./config');
const db = require('./database');
const drive = require('./google-drive');
const githubSync = require('./github-sync');
const security = require('./security');

// --- CSV formula injection protection (Bug 5) ---
// Prefix values starting with formula-trigger characters so Excel/Sheets
// won't interpret them as formulas when the admin opens the export.
function csvSafeCell(value) {
  if (value === null || value === undefined) return '';
  const str = String(value);
  if (/^\s*[=+\-@\t\r]/.test(str)) {
    return "'" + str;
  }
  return str;
}

// --- Setup ---
const app = express();
app.set('trust proxy', process.env.TRUST_PROXY === 'true');

// 1. Edge Middleware: Block Control Characters & Null-Bytes (Closes Finding H6/H7)
app.use(security.sanitizeUrlControlChars);

// 2. Strict Security Headers & Content-Security-Policy (Closes Finding L1/L2)
app.use((req, res, next) => {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('X-Frame-Options', 'SAMEORIGIN');
  res.setHeader('X-XSS-Protection', '1; mode=block');
  res.setHeader('Strict-Transport-Security', 'max-age=31536000; includeSubDomains');
  // style-src/font-src allow fonts.googleapis.com + fonts.gstatic.com so the
  // Vazirmatn Persian webfont imported by css/style.css actually loads.
  res.setHeader('Content-Security-Policy', "default-src 'self'; script-src 'self' 'unsafe-inline'; style-src 'self' 'unsafe-inline' https://fonts.googleapis.com; img-src 'self' data: blob:; font-src 'self' data: https://fonts.gstatic.com; connect-src 'self'; frame-ancestors 'none'; form-action 'self'");
  next();
});

app.use(express.json({ limit: '2mb' }));
app.use(express.urlencoded({ extended: true, limit: '2mb' }));

// 3. Strict Input Type Guard & Central Normalization (Closes Finding H4 & H12)
app.use((req, res, next) => {
  const validateTypes = (obj) => {
    if (!obj || typeof obj !== 'object') return true;
    for (const key of Object.keys(obj)) {
      if (key === '__proto__' || key === 'constructor' || key === 'prototype') return false;
      const val = obj[key];
      if (typeof val === 'object' && val !== null) {
        if (!validateTypes(val)) return false;
      }
    }
    return true;
  };

  if (!validateTypes(req.body) || !validateTypes(req.query)) {
    return res.status(400).json({ success: false, error: 'ساختار داده‌های ورودی نامعتبر است.' });
  }

  // Normalize contributor_id
  if (typeof req.body?.contributor_id === 'string') {
    req.body.contributor_id = req.body.contributor_id.trim().toLowerCase();
  }
  next();
});

app.use(express.static('public'));
app.use('/uploads', (req, res, next) => {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('Content-Security-Policy', "default-src 'none'");
  next();
}, express.static(config.UPLOAD_DIR));

// Ensure directories exist
for (const dir of [config.PENDING_DIR, config.APPROVED_DIR, config.SEGMENTS_DIR]) {
  fs.mkdirSync(dir, { recursive: true });
}

// Global API rate limiting
app.use('/api/', security.globalApiLimiter.middleware());

// Request logging
app.use((req, res, next) => {
  if (req.path.startsWith('/api/')) {
    console.log(`[${new Date().toISOString()}] ${req.method} ${req.path} - IP: ${security.getClientIp(req)}`);
  }
  next();
});

// --- Multer config (100% Server-Controlled Random Filenames, Closes Finding H3) ---
const storage = multer.diskStorage({
  destination: config.PENDING_DIR,
  filename: (req, file, cb) => {
    // Purely server-generated 32-hex random token; ZERO user input in filename on disk
    const randomToken = crypto.randomBytes(16).toString('hex');
    const ext = file.mimetype === 'image/png' ? '.png' : file.mimetype === 'image/webp' ? '.webp' : '.jpg';
    cb(null, `img_${Date.now()}_${randomToken}${ext}`);
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

// Separate multer for CSV uploads (to temp directory with safe random filename)
const csvStorage = multer.diskStorage({
  destination: (req, file, cb) => cb(null, require('os').tmpdir()),
  filename: (req, file, cb) => {
    const token = crypto.randomBytes(6).toString('hex');
    cb(null, `csv_${Date.now()}_${token}.csv`);
  },
});
const csvUpload = multer({
  storage: csvStorage,
  limits: { fileSize: 5 * 1024 * 1024 },
  fileFilter: (req, file, cb) => {
    const allowed = ['text/csv', 'text/plain', 'application/vnd.ms-excel'];
    const ext = (file.originalname || '').toLowerCase();
    if (allowed.includes(file.mimetype) || ext.endsWith('.csv') || ext.endsWith('.txt')) {
      cb(null, true);
    } else {
      cb(new Error('فایل CSV یا TXT مجاز است.'));
    }
  },
});

// --- Admin session management (in-memory Map to avoid prototype pollution) ---
const sessions = new Map();

function createSession() {
  const token = crypto.randomBytes(32).toString('hex');
  sessions.set(token, { createdAt: Date.now() });
  return token;
}

function destroySession(token) {
  if (token) sessions.delete(token);
}

// Expired sessions are otherwise only dropped when that exact token is presented
// again, so abandoned ones accumulate for the life of the process.
setInterval(() => {
  const now = Date.now();
  for (const [token, session] of sessions.entries()) {
    if (now - session.createdAt > config.SESSION_EXPIRY_MS) sessions.delete(token);
  }
}, 60 * 60 * 1000).unref();

function isAdmin(req) {
  const token = req.cookies?.admin_session;
  if (!token || typeof token !== 'string' || !sessions.has(token)) return false;
  const session = sessions.get(token);
  if (!session || Date.now() - session.createdAt > config.SESSION_EXPIRY_MS) {
    sessions.delete(token);
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
  if (!stored || typeof stored !== 'string' || !stored.includes(':')) return false;
  if (!password || typeof password !== 'string') return false;
  try {
    const [salt, hash] = stored.split(':');
    if (!salt || !hash) return false;
    const hashToVerify = crypto.scryptSync(password, salt, 64).toString('hex');
    return crypto.timingSafeEqual(Buffer.from(hash, 'hex'), Buffer.from(hashToVerify, 'hex'));
  } catch {
    return false;
  }
}

// Auto-generate a random admin password if not configured
if (!config.ADMIN_PASSWORD_HASH) {
  const randomPassword = crypto.randomBytes(12).toString('base64url');
  const defaultHash = generatePasswordHash(randomPassword);
  console.log('[Admin] ⚠️  No ADMIN_PASSWORD_HASH configured.');
  console.log(`[Admin] Generated random admin password for this session: ${randomPassword}`);
  console.log('[Admin] To persist this password, add the following to your .env file:');
  console.log(`[Admin] ADMIN_PASSWORD_HASH=${defaultHash}`);
  config.ADMIN_PASSWORD_HASH = defaultHash;
}

// ======================
// USER-FACING ROUTES
// ======================

// Contributor creation rate limiter (10 / min per IP)
const contributorLimiter = new security.MemoryRateLimiter({
  windowMs: 60 * 1000,
  max: 10,
  message: 'تعداد درخواست‌های ایجاد شناسه بیش از حد مجاز است. لطفاً بعداً تلاش کنید.',
});

// Contributor Authentication Middleware (Closes Finding H1)
function requireContributor(req, res, next) {
  const token = req.headers['x-contributor-token'] || req.body?.contributor_token || req.query?.contributor_token;
  if (!token) {
    return res.status(401).json({ success: false, error: 'احراز هویت الزامی است (توکن یافت نشد).' });
  }

  const verifiedId = security.verifyContributorToken(token);
  if (!verifiedId) {
    return res.status(401).json({ success: false, error: 'توکن هویت نامعتبر یا جعلی است.' });
  }

  req.contributorId = verifiedId;
  next();
}

function formatContributorId(name) {
  if (!name || typeof name !== 'string') return '';
  let clean = name.trim().replace(/[\u200c\u200b\u200e\u200f\uFEFF]/g, ' ');
  clean = clean
    .replace(/[\u064A\u0649]/g, 'ی')
    .replace(/\u0643/g, 'ک')
    .replace(/\u0629/g, 'ه');
  clean = clean.replace(/\s+/g, '_');
  clean = clean.replace(/[^a-zA-Z0-9_\-\u0600-\u06FF]/g, '');
  // Lowercase at issuance: verifyContributorToken() returns a lowercased id, so an
  // id kept in mixed case would never match its own token (Ali_Rezaei vs ali_rezaei).
  return clean.substring(0, 60).toLowerCase();
}

// 1. Issue server-side HMAC identity (supports First & Last Name, closes Finding H1)
app.post('/api/contributors/register', contributorLimiter.middleware(), (req, res) => {
  try {
    const rawName = req.body?.name;
    let cleanName = null;
    let id = null;

    if (rawName && typeof rawName === 'string' && rawName.trim().length >= 2) {
      cleanName = rawName.trim().replace(/\s+/g, ' ');
      id = formatContributorId(cleanName);
    }

    if (!id || id.length < 2) {
      id = crypto.randomUUID();
    }

    const token = security.generateContributorToken(id);
    db.createContributor(id, cleanName, req.headers['user-agent']);
    res.json({ success: true, contributor_id: id, name: cleanName, token });
  } catch (err) {
    console.error('[API] POST /api/contributors/register:', err.message);
    res.status(500).json({ success: false, error: 'خطای سرور' });
  }
});

// Backward compatibility: GET /api/register
app.get('/api/register', contributorLimiter.middleware(), (req, res) => {
  try {
    const id = crypto.randomUUID();
    const token = security.generateContributorToken(id);
    db.createContributor(id, null, req.headers['user-agent']);
    res.json({ success: true, contributor_id: id, token });
  } catch (err) {
    console.error('[API] GET /api/register:', err.message);
    res.status(500).json({ success: false, error: 'خطای سرور' });
  }
});

// Backward compatibility: POST /api/contributors
app.post('/api/contributors', contributorLimiter.middleware(), (req, res) => {
  try {
    const { id, name } = req.body || {};
    let finalId = id;
    let cleanName = name && typeof name === 'string' ? name.trim().replace(/\s+/g, ' ') : null;

    if (cleanName && cleanName.length >= 2) {
      finalId = formatContributorId(cleanName);
    } else if (!finalId || typeof finalId !== 'string' || !security.CONTRIBUTOR_ID_REGEX.test(finalId.trim())) {
      finalId = crypto.randomUUID();
    }

    const cleanId = finalId.trim().toLowerCase();
    const token = security.generateContributorToken(cleanId);
    db.createContributor(cleanId, cleanName, req.headers['user-agent']);
    res.json({ success: true, id: cleanId, contributor_id: cleanId, name: cleanName, token });
  } catch (err) {
    console.error('[API] POST /api/contributors:', err.message);
    res.status(500).json({ success: false, error: 'خطای سرور' });
  }
});

// --- Sheets ---
//
// A volunteer no longer gets one prompt at a time. They get two sheets: one with
// SENTENCES_PER_SHEET sentence/word lines and one with NUMBERS_PER_SHEET number
// lines. Each sheet is written on a single page, line by line, and uploaded as ONE
// image. This endpoint returns both sheets and their submission state.
app.get('/api/sheets', requireContributor, (req, res) => {
  try {
    db.createContributor(req.contributorId, null, req.headers['user-agent']);
    const state = db.getContributorSheetState(req.contributorId);
    const contributor = db.getContributor(req.contributorId);
    res.json({
      success: true,
      ...state,
      name: contributor ? contributor.name : null,
    });
  } catch (err) {
    console.error('[API] GET /api/sheets:', err.message);
    res.status(500).json({ success: false, error: 'خطای سرور' });
  }
});

// Ask for a fresh set of ten and ten. Only allowed once both current sheets have
// been submitted, otherwise a volunteer could churn through the prompt bank by
// repeatedly abandoning sheets.
app.post('/api/sheets/new', requireContributor, (req, res) => {
  try {
    for (const category of db.SHEET_CATEGORIES) {
      if (db.getOpenAssignment(req.contributorId, category)) {
        return res.status(400).json({
          success: false,
          error: 'ابتدا هر دو برگه فعلی را تکمیل و ارسال کنید، سپس مجموعه جدید دریافت نمایید.',
        });
      }
    }

    const created = db.startNewSheetSet(req.contributorId);
    if (created.length === 0) {
      return res.status(404).json({
        success: false,
        error: 'متن جدیدی برای اختصاص وجود ندارد. لطفاً بعداً تلاش کنید.',
      });
    }

    res.json({ success: true, created, ...db.getContributorSheetState(req.contributorId) });
  } catch (err) {
    console.error('[API] POST /api/sheets/new:', err.message);
    res.status(500).json({ success: false, error: 'خطای سرور' });
  }
});

// Pre-upload security checks executed BEFORE Multer touches the disk
function preUploadSecurityCheck(req, res, next) {
  const clientIp = security.getClientIp(req);

  // Check IP hourly upload count directly from database
  const ipHourlyCount = db.countIpUploadsLastHour(clientIp);
  if (ipHourlyCount >= (config.MAX_UPLOADS_PER_IP_PER_HOUR || 100)) {
    return res.status(429).json({
      success: false,
      error: `سقف آپلود ساعتی برای آدرس شما (${config.MAX_UPLOADS_PER_IP_PER_HOUR || 100} تصویر در ساعت) به پایان رسیده است. لطفاً بعداً تلاش کنید.`,
    });
  }

  next();
}

// Upload image (Fully hardened against H1, H2, H3, H5, DoS, polyglot injection)
app.post(
  '/api/images',
  security.uploadMinuteLimiter.middleware(),
  security.storageQuotaGuard(db),
  preUploadSecurityCheck,
  upload.single('image'),
  async (req, res) => {
    try {
      if (!req.file) {
        return res.status(400).json({ success: false, error: 'تصویری ارسال نشد.' });
      }

      const clientIp = security.getClientIp(req);
      const { assignment_id, contributor_id, contributor_token, hp_website } = req.body || {};

      // 1. Anti-bot honeypot check
      if (hp_website) {
        fs.unlinkSync(req.file.path);
        return res.status(400).json({ success: false, error: 'درخواست نامعتبر' });
      }

      // 2. Authenticate Contributor via HMAC Token (Closes Finding H1)
      const token = req.headers['x-contributor-token'] || contributor_token;
      if (!token) {
        fs.unlinkSync(req.file.path);
        return res.status(401).json({ success: false, error: 'ارسال توکن احراز هویت الزامی است.' });
      }

      const verifiedContributorId = security.verifyContributorToken(token);
      if (!verifiedContributorId) {
        fs.unlinkSync(req.file.path);
        return res.status(401).json({ success: false, error: 'توکن هویت نامعتبر یا جعلی است.' });
      }

      // Ensure client-supplied contributor_id matches verified token identity
      if (contributor_id && contributor_id.trim().toLowerCase() !== verifiedContributorId) {
        fs.unlinkSync(req.file.path);
        return res.status(403).json({ success: false, error: 'عدم تطابق شناسه مشارکت‌کننده با توکن معتبر.' });
      }

      // 3. The upload must name the open sheet it belongs to. Ownership and the
      // open/submitted state are re-checked inside the insert mutex (createImage);
      // this is the early exit that avoids keeping a doomed file on disk.
      const assignmentId = parseInt(assignment_id, 10);
      if (!assignment_id || isNaN(assignmentId) || assignmentId <= 0) {
        fs.unlinkSync(req.file.path);
        return res.status(400).json({ success: false, error: 'شناسه برگه (assignment_id) الزامی است.' });
      }
      const assignment = db.getAssignment(assignmentId);
      if (!assignment) {
        fs.unlinkSync(req.file.path);
        return res.status(400).json({ success: false, error: 'برگه انتخابی در سامانه یافت نشد.' });
      }
      if (assignment.contributor_id !== verifiedContributorId) {
        fs.unlinkSync(req.file.path);
        return res.status(403).json({ success: false, error: 'این برگه متعلق به شما نیست.' });
      }
      if (assignment.status !== 'open') {
        fs.unlinkSync(req.file.path);
        return res.status(409).json({ success: false, error: 'برای این برگه قبلاً تصویری ارسال شده است.' });
      }

      // 4. Read file into buffer and validate Binary Magic Bytes (prevent fake files / garbage uploads)
      const fileBuffer = fs.readFileSync(req.file.path);
      const detectedMime = security.validateMagicBytes(fileBuffer);
      if (!detectedMime) {
        if (fs.existsSync(req.file.path)) {
          try { fs.unlinkSync(req.file.path); } catch (_) {}
        }
        return res.status(400).json({
          success: false,
          error: 'فایل ارسالی تصویر معتبر نیست یا فرمت آن پشتیبانی نمی‌شود.',
        });
      }

      // 5. Re-encode Image with Sharp: Strips tEXt/iTXt chunks, metadata, and polyglots (Closes Finding H5)
      // Note: Passing Buffer prevents Windows file-locking issues (EBUSY / UNKNOWN) with libvips.
      let finalMime = detectedMime;
      let cleanBuffer;
      try {
        const sharpInstance = sharp(fileBuffer).rotate();
        if (detectedMime === 'image/jpeg') {
          cleanBuffer = await sharpInstance.jpeg({ quality: 90 }).toBuffer();
          finalMime = 'image/jpeg';
        } else if (detectedMime === 'image/webp') {
          cleanBuffer = await sharpInstance.webp({ quality: 90 }).toBuffer();
          finalMime = 'image/webp';
        } else {
          cleanBuffer = await sharpInstance.png({ compressionLevel: 8 }).toBuffer();
          finalMime = 'image/png';
        }

        // Ensure file extension on disk matches the validated MIME type
        const targetExt = detectedMime === 'image/png' ? '.png' : detectedMime === 'image/webp' ? '.webp' : '.jpg';
        const currentExt = path.extname(req.file.filename).toLowerCase();
        if (currentExt !== targetExt) {
          const oldPath = req.file.path;
          req.file.filename = req.file.filename.replace(/\.[^/.]+$/, '') + targetExt;
          req.file.path = path.join(path.dirname(oldPath), req.file.filename);
          if (fs.existsSync(oldPath)) {
            try { fs.unlinkSync(oldPath); } catch (_) {}
          }
        }

        fs.writeFileSync(req.file.path, cleanBuffer);
      } catch (sharpErr) {
        console.error('[API] Sharp processing error:', sharpErr.message);
        if (fs.existsSync(req.file.path)) {
          try { fs.unlinkSync(req.file.path); } catch (_) {}
        }
        return res.status(400).json({
          success: false,
          error: 'تصویر ارسالی قابل پردازش نیست یا محتوای آن آسیب دیده است.',
        });
      }

      // 6. Compute File Hash and prevent duplicates (SHA-256 Deduplication)
      const fileHash = await security.computeFileHash(cleanBuffer);
      const duplicate = db.findByFileHash(fileHash);
      if (duplicate) {
        if (fs.existsSync(req.file.path)) {
          try { fs.unlinkSync(req.file.path); } catch (_) {}
        }
        return res.status(409).json({
          success: false,
          error: 'این تصویر قبلاً در سامانه ثبت شده است. لطفاً تصویر جدیدی ارسال کنید.',
        });
      }

      // 7. Rate limit check for contributor ID
      const uploadCount = db.countContributorUploadsLastHour(verifiedContributorId);
      if (uploadCount >= config.MAX_UPLOADS_PER_CONTRIBUTOR_PER_HOUR) {
        if (fs.existsSync(req.file.path)) {
          try { fs.unlinkSync(req.file.path); } catch (_) {}
        }
        return res.status(429).json({
          success: false,
          error: 'تعداد آپلودهای شما در ساعت گذشته بیش از حد مجاز است. لطفاً بعداً تلاش کنید.',
        });
      }

      // Ensure contributor exists in database
      const contributorName = req.body?.contributor_name ? String(req.body.contributor_name).trim() : null;
      db.createContributor(verifiedContributorId, contributorName, req.headers['user-agent']);

      // 8. Quota is now enforced by the assignment itself: one image per open sheet,
      // and a new set of sheets is only granted once both are submitted. The
      // open-status check above (and its re-check inside createImageSafe) IS the quota.

      const fileSize = cleanBuffer.length;
      // Use createImageSafe (mutex-protected) to prevent duplicate hash race (Bug 11)
      const result = await db.createImageSafe({
        filename: req.file.filename,
        originalName: req.file.originalname,
        assignmentId: assignmentId,
        contributorId: verifiedContributorId,
        mimeType: finalMime,
        fileSize: fileSize,
        ipAddress: clientIp,
        fileHash: fileHash,
      });

      res.json({
        success: true,
        image_id: result.lastInsertRowid,
        ...db.getContributorSheetState(verifiedContributorId),
      });
    } catch (err) {
      console.error('[API] POST /api/images:', err.message);
      if (req.file && fs.existsSync(req.file.path)) {
        try { fs.unlinkSync(req.file.path); } catch (_) {}
      }
      // Handle duplicate image error from createImageSafe gracefully
      if (err.message === 'DUPLICATE_IMAGE' || err.statusCode === 409) {
        return res.status(409).json({
          success: false,
          error: 'این تصویر قبلاً در سامانه ثبت شده است. لطفاً تصویر جدیدی ارسال کنید.',
        });
      }
      const statusCode = err.statusCode && err.statusCode >= 400 && err.statusCode < 500 ? err.statusCode : 500;
      res.status(statusCode).json({ success: false, error: statusCode < 500 ? err.message : 'خطای سرور' });
    }
  }
);

// Contributor upload count & progress (Protected: only authenticated contributor can see own count, closes L5)
app.get('/api/contributors/:id/count', requireContributor, (req, res) => {
  try {
    // Compare case-insensitively: tokens issued before ids were lowercased at the
    // source still carry a mixed-case id in the client's localStorage.
    if (String(req.params.id).toLowerCase() !== req.contributorId) {
      return res.status(403).json({ success: false, error: 'دسترسی غیرمجاز به اطلاعات سایر کاربران.' });
    }
    const progress = db.getContributorProgress(req.contributorId);
    const contributor = db.getContributor(req.contributorId);
    res.json({
      count: progress.total,
      sentencesCount: progress.sentences,
      numbersCount: progress.numbers,
      name: contributor ? contributor.name : null,
    });
  } catch (err) {
    console.error('[API] GET /api/contributors/:id/count:', err.message);
    res.status(500).json({ success: false, error: 'خطای سرور' });
  }
});

// ======================
// ADMIN ROUTES
// ======================

// Login (Protected by per-IP and global brute-force limiters)
app.post('/api/admin/login', async (req, res) => {
  try {
    const clientIp = security.getClientIp(req);

    // Global lockout if entire system has too many failed attempts
    if (security.globalLoginLimiter.isBlocked('global')) {
      return res.status(429).json({
        success: false,
        error: 'به دلیل تلاش‌های ناموفق مکرر در کل سامانه، ورود موقتاً مسدود شد. لطفاً ۵ دقیقه دیگر تلاش کنید.',
      });
    }

    // Per-IP lockout
    if (security.loginAttemptLimiter.isBlocked(clientIp)) {
      return res.status(429).json({
        success: false,
        error: 'به دلیل تلاش‌های ناموفق مکرر، ورود موقتاً مسدود شد. لطفاً ۱۵ دقیقه دیگر تلاش کنید.',
      });
    }

    const { username, password } = req.body || {};
    if (username === config.ADMIN_USERNAME && verifyPassword(password, config.ADMIN_PASSWORD_HASH)) {
      security.loginAttemptLimiter.reset(clientIp);
      const token = createSession();
      // Secure only when actually served over TLS, so localhost dev over http still works.
      const isHttps = req.secure || req.headers['x-forwarded-proto'] === 'https';
      const secureFlag = isHttps ? ' Secure;' : '';
      res.setHeader('Set-Cookie', `admin_session=${token}; HttpOnly;${secureFlag} SameSite=Strict; Path=/; Max-Age=${config.SESSION_EXPIRY_MS / 1000}`);
      return res.json({ success: true });
    }

    // Artificial delay (200ms) to throttle brute-forcing speed
    await new Promise(r => setTimeout(r, 200));

    security.loginAttemptLimiter.recordFailure(clientIp);
    security.globalLoginLimiter.recordFailure('global');
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

// Get unsynced approved images
app.get('/api/admin/images/unsynced', requireAdmin, (req, res) => {
  try {
    const images = db.getApprovedUnsynced();
    res.json(images);
  } catch (err) {
    console.error('[API] GET /api/admin/images/unsynced:', err.message);
    res.status(500).json({ success: false, error: 'Server error' });
  }
});

// Get single image details
app.get('/api/admin/images/:id', requireAdmin, (req, res) => {
  try {
    const image = db.getImage(req.params.id);
    if (!image) return res.status(404).json({ success: false, error: 'Image not found' });
    res.json(image);
  } catch (err) {
    console.error('[API] GET /api/admin/images/:id:', err.message);
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
    } else if (status === 'rejected') {
      // If was previously approved, move file back to pending directory
      const srcPath = path.join(config.APPROVED_DIR, image.filename);
      const dstPath = path.join(config.PENDING_DIR, image.filename);
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

// Bulk approve/reject images
app.post('/api/admin/images/batch-status', requireAdmin, (req, res) => {
  try {
    const { ids, status, rejection_reason } = req.body || {};
    if (!Array.isArray(ids) || ids.length === 0) {
      return res.status(400).json({ success: false, error: 'لیست شناسه‌های تصویر (ids) الزامی است.' });
    }
    if (!['approved', 'rejected'].includes(status)) {
      return res.status(400).json({ success: false, error: 'وضعیت نامعتبر است. فقط approved یا rejected مجاز است.' });
    }

    const validIds = ids.map(id => parseInt(id, 10)).filter(id => !isNaN(id) && id > 0);
    if (validIds.length === 0) {
      return res.status(400).json({ success: false, error: 'شناسه‌های ارسالی نامعتبر هستند.' });
    }

    const updatedImages = db.updateImagesStatusBatch(validIds, status, rejection_reason);

    for (const img of updatedImages) {
      if (status === 'approved') {
        const srcPath = path.join(config.PENDING_DIR, img.filename);
        const dstPath = path.join(config.APPROVED_DIR, img.filename);
        if (fs.existsSync(srcPath)) {
          try { fs.renameSync(srcPath, dstPath); } catch {}
        }
      } else if (status === 'rejected') {
        const srcPath = path.join(config.APPROVED_DIR, img.filename);
        const dstPath = path.join(config.PENDING_DIR, img.filename);
        if (fs.existsSync(srcPath)) {
          try { fs.renameSync(srcPath, dstPath); } catch {}
        }
      }
    }

    res.json({ success: true, updatedCount: updatedImages.length });
  } catch (err) {
    console.error('[API] POST /api/admin/images/batch-status:', err.message);
    res.status(500).json({ success: false, error: 'Server error' });
  }
});

// ======================
// MANUAL SEGMENTATION
// ======================
//
// A volunteer uploads ONE page holding ten handwritten lines. The dataset needs one
// tight image per line, labelled with the exact text that line was supposed to be.
// The admin gets the page plus its ordered line list and drags a rectangle around
// each line; the rectangle is stored in ORIGINAL image pixels and a crop is cut from
// the source file with sharp. Re-drawing a line replaces its crop.

// A sheet lives in pending/ before review and approved/ after, and moves between the
// two whenever its status changes. Resolve it fresh on every crop.
function resolveSheetPath(image) {
  for (const dir of [config.PENDING_DIR, config.APPROVED_DIR]) {
    const p = path.join(dir, image.filename);
    if (fs.existsSync(p)) return p;
  }
  return null;
}

function deleteSegmentFile(filename) {
  if (!filename) return;
  const p = path.join(config.SEGMENTS_DIR, filename);
  if (fs.existsSync(p)) {
    try { fs.unlinkSync(p); } catch (err) {
      console.warn('[Segments] Could not delete crop', filename, err.message);
    }
  }
}

// --- Manually recovered / admin-uploaded sheets ---
//
// Sheets that were still waiting for review when their rows were lost have no labels
// in any export, so they can only come back by hand. This lets an admin upload the
// image, file it under a writer id (so several sheets in the same handwriting stay
// grouped — writer identity is what keeps train/test splits honest), and either type
// the line labels straight away or park it in the waiting state and label it later.
//
// The image goes through EXACTLY the same processing as a volunteer upload. That is
// not incidental: a sheet that skipped the re-encode would carry a different encoding
// signature from every other sheet, which is precisely the kind of cue that makes a
// corpus trivially separable from itself.
async function reencodeUploadedImage(file) {
  const fileBuffer = fs.readFileSync(file.path);
  const detectedMime = security.validateMagicBytes(fileBuffer);
  if (!detectedMime) {
    throw Object.assign(new Error('فایل ارسالی تصویر معتبر نیست یا فرمت آن پشتیبانی نمی‌شود.'), { statusCode: 400 });
  }

  let finalMime = detectedMime;
  let cleanBuffer;
  try {
    const sharpInstance = sharp(fileBuffer).rotate();
    if (detectedMime === 'image/jpeg') {
      cleanBuffer = await sharpInstance.jpeg({ quality: 90 }).toBuffer();
      finalMime = 'image/jpeg';
    } else if (detectedMime === 'image/webp') {
      cleanBuffer = await sharpInstance.webp({ quality: 90 }).toBuffer();
      finalMime = 'image/webp';
    } else {
      cleanBuffer = await sharpInstance.png({ compressionLevel: 8 }).toBuffer();
      finalMime = 'image/png';
    }

    const targetExt = detectedMime === 'image/png' ? '.png' : detectedMime === 'image/webp' ? '.webp' : '.jpg';
    if (path.extname(file.filename).toLowerCase() !== targetExt) {
      const oldPath = file.path;
      file.filename = file.filename.replace(/\.[^/.]+$/, '') + targetExt;
      file.path = path.join(path.dirname(oldPath), file.filename);
      if (fs.existsSync(oldPath)) {
        try { fs.unlinkSync(oldPath); } catch (_) {}
      }
    }
    fs.writeFileSync(file.path, cleanBuffer);
  } catch (err) {
    if (err.statusCode) throw err;
    console.error('[API] Sharp processing error:', err.message);
    throw Object.assign(new Error('تصویر ارسالی قابل پردازش نیست یا محتوای آن آسیب دیده است.'), { statusCode: 400 });
  }

  const fileHash = await security.computeFileHash(cleanBuffer);
  return { filename: file.filename, mimeType: finalMime, fileSize: cleanBuffer.length, fileHash };
}

// Writers to choose from when filing a recovered sheet.
app.get('/api/admin/contributors', requireAdmin, (req, res) => {
  try {
    res.json(db.getAllContributors());
  } catch (err) {
    console.error('[API] GET /api/admin/contributors:', err.message);
    res.status(500).json({ success: false, error: 'Server error' });
  }
});

app.post('/api/admin/sheets/manual', requireAdmin, upload.single('image'), async (req, res) => {
  try {
    if (!req.file) return res.status(400).json({ success: false, error: 'تصویری ارسال نشد.' });

    const rawId = String(req.body?.contributor_id || '').trim().toLowerCase();
    const contributorName = req.body?.contributor_name ? String(req.body.contributor_name).trim() : null;
    const contributorId = rawId || formatContributorId(contributorName || '');
    if (!contributorId || contributorId.length < 2) {
      fs.unlinkSync(req.file.path);
      return res.status(400).json({ success: false, error: 'شناسه یا نام نویسنده الزامی است.' });
    }

    const category = req.body?.category === 'numbers' ? 'numbers' : 'sentences';

    // Labels are optional: without them the sheet is parked as "waiting" and can be
    // labelled later, which is the point of the waiting state.
    let texts = [];
    if (req.body?.labels) {
      texts = String(req.body.labels)
        .split(/\r?\n/)
        .map(t => t.trim())
        .filter(Boolean);
    }
    if (texts.length > 100) {
      fs.unlinkSync(req.file.path);
      return res.status(400).json({ success: false, error: 'حداکثر ۱۰۰ سطر برای یک برگه مجاز است.' });
    }

    const processed = await reencodeUploadedImage(req.file);

    const duplicate = db.findByFileHash(processed.fileHash);
    if (duplicate) {
      if (fs.existsSync(req.file.path)) { try { fs.unlinkSync(req.file.path); } catch (_) {} }
      return res.status(409).json({
        success: false,
        error: `این تصویر قبلاً در سامانه ثبت شده است (شناسه ${duplicate.id}).`,
      });
    }

    const result = db.createManualSheet({
      ...processed,
      originalName: req.file.originalname,
      contributorId,
      contributorName,
      category,
      texts,
      ipAddress: security.getClientIp(req),
    });
    db.flushIfDirty();

    res.json({
      success: true,
      image_id: result.imageId,
      lines: result.lines,
      waiting: result.lines === 0,
      contributor_id: contributorId,
    });
  } catch (err) {
    console.error('[API] POST /api/admin/sheets/manual:', err.message);
    if (req.file && fs.existsSync(req.file.path)) {
      try { fs.unlinkSync(req.file.path); } catch (_) {}
    }
    const code = err.statusCode && err.statusCode >= 400 && err.statusCode < 500 ? err.statusCode : 500;
    res.status(code).json({ success: false, error: code < 500 ? err.message : 'خطای سرور' });
  }
});

// Set or replace the expected line texts of a sheet, so one parked as waiting can be
// labelled afterwards. Segments whose line number no longer exists are removed along
// with their crops, otherwise the sheet would keep crops for lines it no longer has.
app.put('/api/admin/images/:id/lines', requireAdmin, (req, res) => {
  try {
    const image = db.getImage(req.params.id);
    if (!image) return res.status(404).json({ success: false, error: 'Image not found' });
    if (!image.assignment_id) {
      return res.status(400).json({ success: false, error: 'این ارسال قدیمی است و سطرهای قابل ویرایش ندارد.' });
    }

    const labels = Array.isArray(req.body?.labels)
      ? req.body.labels
      : String(req.body?.labels || '').split(/\r?\n/);
    const texts = labels.map(t => String(t || '').trim()).filter(Boolean);
    if (texts.length > 100) {
      return res.status(400).json({ success: false, error: 'حداکثر ۱۰۰ سطر برای یک برگه مجاز است.' });
    }

    const count = db.setAssignmentItems(image.assignment_id, texts, image.sheet_category);

    for (const seg of db.getSegments(image.id)) {
      if (seg.line_no > count) {
        const removed = db.deleteSegment(image.id, seg.line_no);
        if (removed) deleteSegmentFile(removed.filename);
      }
    }
    db.flushIfDirty();

    res.json({ success: true, lines: count, lineList: db.getImageLines(image.id) });
  } catch (err) {
    console.error('[API] PUT /api/admin/images/:id/lines:', err.message);
    const code = err.statusCode && err.statusCode >= 400 && err.statusCode < 500 ? err.statusCode : 500;
    res.status(code).json({ success: false, error: code < 500 ? err.message : 'Server error' });
  }
});

// --- Segment geometry ---
//
// Volunteers do not write in perfectly straight lines, so a line's shape is four
// draggable corners rather than an axis-aligned box, and the admin can paint over
// bits of the neighbouring lines that still leak in. Neither touches the uploaded
// sheet: the crop is re-cut from the original every time, and the shape mask plus
// the erase strokes are painted on top of that copy in the paper colour.

const HEX_COLOR = /^#[0-9a-fA-F]{6}$/;
const MAX_ERASE_STROKES = 400;
const MAX_ERASE_POINTS = 4000;

// Coerce to a finite, rounded number or throw — nothing unchecked may reach the SVG.
//
// Deliberately strict rather than leaning on Number(): Number(null) and Number('')
// are both 0, so a malformed corner would silently become a valid-looking (0, 0)
// instead of being rejected. JSON has no Infinity either — it serialises as null —
// so null has to be an error, not a zero.
function svgNum(value) {
  const n = typeof value === 'string' && value.trim() !== '' ? Number(value) : value;
  if (typeof n !== 'number' || !Number.isFinite(n)) {
    throw Object.assign(new Error('BAD_GEOMETRY'), { statusCode: 400 });
  }
  return Math.round(n);
}

function parseQuad(raw, fallback) {
  if (!Array.isArray(raw) || raw.length !== 4) return fallback;
  const quad = raw.map(p => {
    if (!Array.isArray(p) || p.length !== 2) throw Object.assign(new Error('BAD_GEOMETRY'), { statusCode: 400 });
    return [svgNum(p[0]), svgNum(p[1])];
  });
  return quad;
}

// Erase strokes are admin input; keep only shapes we know how to draw, with sane
// sizes, so a malformed payload can never produce unbounded SVG.
function parseErase(raw) {
  if (!Array.isArray(raw)) return [];
  const strokes = [];
  for (const item of raw.slice(0, MAX_ERASE_STROKES)) {
    if (!item || typeof item !== 'object') continue;
    if (item.type === 'box') {
      const w = Math.max(1, svgNum(item.w));
      const h = Math.max(1, svgNum(item.h));
      strokes.push({ type: 'box', x: svgNum(item.x), y: svgNum(item.y), w, h });
    } else if (item.type === 'brush' && Array.isArray(item.points) && item.points.length) {
      const points = item.points
        .slice(0, MAX_ERASE_POINTS)
        .filter(p => Array.isArray(p) && p.length === 2)
        .map(p => [svgNum(p[0]), svgNum(p[1])]);
      if (!points.length) continue;
      // svgNum is strict, so an absent size must default before it gets there.
      const size = Math.max(1, Math.min(500, item.size == null ? 20 : svgNum(item.size)));
      strokes.push({ type: 'brush', points, size });
    }
  }
  return strokes;
}

function quadBounds(quad, imgW, imgH) {
  const xs = quad.map(p => p[0]);
  const ys = quad.map(p => p[1]);
  let x = Math.max(0, Math.min(imgW - 1, Math.floor(Math.min(...xs))));
  let y = Math.max(0, Math.min(imgH - 1, Math.floor(Math.min(...ys))));
  let w = Math.ceil(Math.max(...xs)) - x;
  let h = Math.ceil(Math.max(...ys)) - y;
  w = Math.max(1, Math.min(w, imgW - x));
  h = Math.max(1, Math.min(h, imgH - y));
  return { x, y, w, h };
}

// An overlay the size of the crop, painting everything the admin excluded. Drawn as
// SVG because sharp can composite it directly — no extra dependency, no pixel loops.
function buildMaskSvg({ box, quad, erase, bgColor }) {
  const bg = HEX_COLOR.test(bgColor || '') ? bgColor : '#ffffff';
  const rx = p => p[0] - box.x;
  const ry = p => p[1] - box.y;

  const parts = [];

  // Outer rect + quad as one path with even-odd fill: the ring between them (the
  // corners the admin dragged away) is painted, the quad's interior is left alone.
  const quadPath = quad.map((p, i) => `${i ? 'L' : 'M'}${rx(p)} ${ry(p)}`).join(' ') + ' Z';
  parts.push(
    `<path d="M0 0 L${box.w} 0 L${box.w} ${box.h} L0 ${box.h} Z ${quadPath}" fill="${bg}" fill-rule="evenodd"/>`
  );

  for (const stroke of erase) {
    if (stroke.type === 'box') {
      parts.push(`<rect x="${stroke.x - box.x}" y="${stroke.y - box.y}" width="${stroke.w}" height="${stroke.h}" fill="${bg}"/>`);
    } else if (stroke.points.length === 1) {
      // A single tap still has to leave a dot; a 1-point polyline draws nothing.
      parts.push(`<circle cx="${rx(stroke.points[0])}" cy="${ry(stroke.points[0])}" r="${stroke.size / 2}" fill="${bg}"/>`);
    } else {
      const pts = stroke.points.map(p => `${rx(p)},${ry(p)}`).join(' ');
      parts.push(
        `<polyline points="${pts}" fill="none" stroke="${bg}" stroke-width="${stroke.size}" stroke-linecap="round" stroke-linejoin="round"/>`
      );
    }
  }

  return Buffer.from(
    `<svg xmlns="http://www.w3.org/2000/svg" width="${box.w}" height="${box.h}" viewBox="0 0 ${box.w} ${box.h}">${parts.join('')}</svg>`
  );
}

// The angle of the writing baseline, in degrees, from the quad's two horizontal
// edges. `dy` is negated to leave image coordinates (y down) for the ordinary y-up
// convention, so POSITIVE means the line rises to the right. To level a crop,
// rotate it by -baseline_angle_deg (PIL Image.rotate / cv2.getRotationMatrix2D).
function baselineAngleDeg(quad) {
  const [tl, tr, br, bl] = quad;
  const edge = (a, b) => Math.atan2(-(b[1] - a[1]), b[0] - a[0]);
  const top = edge(tl, tr);
  const bottom = edge(bl, br);
  return ((top + bottom) / 2) * (180 / Math.PI);
}

// The same angle, measured from the INK of the finished crop instead of the shape.
//
// There are two ways an admin can handle a crooked line: drag the corners to follow
// it, or draw a plain rectangle and erase what leaked in. The second leaves an
// axis-aligned quad, so baselineAngleDeg() reports 0° for handwriting that is
// visibly slanted. Measuring the ink recovers the angle either way, so the exported
// value never depends on which technique was used.
//
// Runs on the finished crop, so erased areas are already paper and contribute
// nothing. Returns null when there is not enough ink to be confident.
async function measureInkAngleDeg(cropPath) {
  try {
    const { data, info } = await sharp(cropPath).greyscale().raw().toBuffer({ resolveWithObject: true });
    const { width, height } = info;
    if (width < 20 || height < 8) return null;

    // Contrast-adaptive threshold from the crop's own histogram — a fixed cutoff
    // would fail on a dim photo or a light pencil.
    const hist = new Uint32Array(256);
    for (let i = 0; i < data.length; i++) hist[data[i]]++;
    const percentile = (p) => {
      let acc = 0;
      const want = data.length * p;
      for (let v = 0; v < 256; v++) {
        acc += hist[v];
        if (acc >= want) return v;
      }
      return 255;
    };
    const paper = percentile(0.90);
    const darkest = percentile(0.02);
    if (paper - darkest < 25) return null; // no real ink contrast to fit to
    const threshold = paper - 0.45 * (paper - darkest);

    // One centroid per column. Centroids beat "lowest ink pixel" for Persian, where
    // dots and descenders sit well below the body of the line.
    const xs = [];
    const ys = [];
    for (let x = 0; x < width; x++) {
      let n = 0;
      let sum = 0;
      for (let y = 0; y < height; y++) {
        if (data[y * width + x] < threshold) { n++; sum += y; }
      }
      if (n >= 2) { xs.push(x); ys.push(sum / n); }
    }
    if (xs.length < 20 || xs[xs.length - 1] - xs[0] < width * 0.3) return null;

    const fit = (idx) => {
      let sx = 0, sy = 0, sxx = 0, sxy = 0;
      for (const i of idx) { sx += xs[i]; sy += ys[i]; sxx += xs[i] * xs[i]; sxy += xs[i] * ys[i]; }
      const n = idx.length;
      const denom = n * sxx - sx * sx;
      if (Math.abs(denom) < 1e-9) return null;
      const a = (n * sxy - sx * sy) / denom;
      return { a, b: (sy - a * sx) / n };
    };

    let idx = xs.map((_, i) => i);
    let line = fit(idx);
    if (!line) return null;

    // One trimming pass: drop the worst residuals so a stray speck or a long
    // descender cannot tilt the fit.
    const residual = i => Math.abs(ys[i] - (line.a * xs[i] + line.b));
    const sorted = idx.map(residual).sort((p, q) => p - q);
    const cutoff = sorted[Math.floor(sorted.length * 0.85)];
    const kept = idx.filter(i => residual(i) <= cutoff);
    if (kept.length >= 10) {
      const refit = fit(kept);
      if (refit) line = refit;
    }

    // Negate the slope for the same y-up convention baselineAngleDeg uses.
    const deg = Math.atan(-line.a) * (180 / Math.PI);
    if (!Number.isFinite(deg) || Math.abs(deg) > 45) return null;
    return deg;
  } catch (err) {
    console.warn('[Segments] ink angle estimate failed:', err.message);
    return null;
  }
}

// Seeded PRNG, so re-saving a segment with identical geometry reproduces identical
// noise instead of quietly changing the dataset on every edit.
function mulberry32(seed) {
  let a = seed >>> 0;
  return function () {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function hashSeed(str) {
  let h = 2166136261;
  for (let i = 0; i < str.length; i++) {
    h ^= str.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return h >>> 0;
}

// The grain of THIS sheet's paper, so a filled patch sits in the same noise floor
// as the pixels around it. Sampled only from paper-ish pixels — anything far from
// the paper level is ink and would inflate the estimate wildly.
function estimatePaperSigma(rgb, pixelCount, bg) {
  const bgLum = 0.299 * bg[0] + 0.587 * bg[1] + 0.114 * bg[2];
  const step = Math.max(1, Math.floor(pixelCount / 20000));
  let n = 0;
  let sum = 0;
  let sumSq = 0;
  for (let i = 0; i < pixelCount; i += step) {
    const o = i * 3;
    const lum = 0.299 * rgb[o] + 0.587 * rgb[o + 1] + 0.114 * rgb[o + 2];
    if (Math.abs(lum - bgLum) > 25) continue;
    n++;
    sum += lum;
    sumSq += lum * lum;
  }
  if (n < 50) return 0;
  const mean = sum / n;
  return Math.min(12, Math.sqrt(Math.max(0, sumSq / n - mean * mean)));
}

function clamp255(v) {
  return v < 0 ? 0 : v > 255 ? 255 : v;
}

// Cut the crop and paint the excluded areas. Returns the fraction of the crop that
// ended up synthetic, so the dataset can report how much of each sample is fill.
async function renderSegmentCrop({ sheetPath, outPath, box, quad, erase, bgColor, seedKey }) {
  const extract = { left: box.x, top: box.y, width: box.w, height: box.h };

  // The common case — a plain rectangle with nothing erased — stays a straight
  // extract with no mask work at all.
  const isPlainRect =
    erase.length === 0 &&
    quad[0][0] === quad[3][0] && quad[1][0] === quad[2][0] &&
    quad[0][1] === quad[1][1] && quad[2][1] === quad[3][1];
  if (isPlainRect) {
    await sharp(sheetPath).extract(extract).jpeg({ quality: 92 }).toFile(outPath);
    return { maskedFraction: 0 };
  }

  const maskSvg = buildMaskSvg({ box, quad, erase, bgColor });

  // Render the mask to raw alpha. This is both what gets painted and how the
  // masked fraction is measured — antialiased edges count as their true coverage.
  const mask = await sharp(maskSvg).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
  const pixelCount = box.w * box.h;
  let coverage = 0;
  for (let i = 0; i < pixelCount; i++) {
    coverage += mask.data[i * mask.info.channels + 3] / 255;
  }
  const maskedFraction = pixelCount ? coverage / pixelCount : 0;

  const source = await sharp(sheetPath)
    .extract(extract)
    .removeAlpha()
    .toColourspace('srgb')
    .raw()
    .toBuffer({ resolveWithObject: true });

  // Anything other than plain 8-bit RGB (a greyscale or CMYK source that survived
  // upload) falls back to the flat composite rather than guessing at the layout.
  if (source.info.channels !== 3 || !config.SEGMENT_FILL_NOISE) {
    await sharp(sheetPath)
      .extract(extract)
      .composite([{ input: maskSvg, top: 0, left: 0 }])
      .jpeg({ quality: 92 })
      .toFile(outPath);
    return { maskedFraction };
  }

  const bg = [
    parseInt(bgColor.slice(1, 3), 16),
    parseInt(bgColor.slice(3, 5), 16),
    parseInt(bgColor.slice(5, 7), 16),
  ];
  const sigma = estimatePaperSigma(source.data, pixelCount, bg);
  const rand = mulberry32(hashSeed(seedKey || 'segment'));

  for (let i = 0; i < pixelCount; i++) {
    const alpha = mask.data[i * mask.info.channels + 3] / 255;
    if (alpha === 0) continue;

    // One grain value for all three channels: paper grain is luminance noise, and
    // per-channel noise would read as colour speckle that real paper does not have.
    let grain = 0;
    if (sigma > 0) {
      const u = Math.max(1e-9, rand());
      grain = Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * rand()) * sigma;
    }
    const o = i * 3;
    for (let c = 0; c < 3; c++) {
      const fill = clamp255(bg[c] + grain);
      // Blend rather than overwrite, so the mask's antialiased edge stays soft — a
      // hard synthetic edge is itself a cue.
      source.data[o + c] = clamp255(Math.round(source.data[o + c] * (1 - alpha) + fill * alpha));
    }
  }

  await sharp(source.data, { raw: { width: box.w, height: box.h, channels: 3 } })
    .jpeg({ quality: 92 })
    .toFile(outPath);

  return { maskedFraction };
}

// The sheet image with its expected lines and any rectangles already drawn.
app.get('/api/admin/images/:id/lines', requireAdmin, (req, res) => {
  try {
    const image = db.getImage(req.params.id);
    if (!image) return res.status(404).json({ success: false, error: 'Image not found' });

    const sheetPath = resolveSheetPath(image);
    res.json({
      success: true,
      image: {
        id: image.id,
        filename: image.filename,
        status: image.status,
        sheet_category: image.sheet_category,
        contributor_name: image.contributor_name,
        contributor_id: image.contributor_id,
        created_at: image.created_at,
        rejection_reason: image.rejection_reason,
        drive_file_id: image.drive_file_id,
        file_missing: !sheetPath,
      },
      lines: db.getImageLines(image.id),
    });
  } catch (err) {
    console.error('[API] GET /api/admin/images/:id/lines:', err.message);
    res.status(500).json({ success: false, error: 'Server error' });
  }
});

// Save (or replace) the rectangle for one line and cut its crop.
app.post('/api/admin/images/:id/segments', requireAdmin, async (req, res) => {
  try {
    const image = db.getImage(req.params.id);
    if (!image) return res.status(404).json({ success: false, error: 'Image not found' });

    const lineNo = parseInt(req.body?.line_no, 10);
    const lines = db.getImageLines(image.id);
    const line = lines.find(l => l.line_no === lineNo);
    if (!line) {
      return res.status(400).json({ success: false, error: 'شماره سطر نامعتبر است.' });
    }

    const sheetPath = resolveSheetPath(image);
    if (!sheetPath) {
      return res.status(404).json({ success: false, error: 'فایل تصویر روی دیسک یافت نشد.' });
    }

    const meta = await sharp(sheetPath).metadata();
    const imgW = meta.width || 0;
    const imgH = meta.height || 0;

    // Accept either the four corners or a plain x/y/w/h box (older clients and the
    // test suite post the box form); a box is just a quad with square corners.
    let quad;
    if (Array.isArray(req.body?.quad)) {
      quad = parseQuad(req.body.quad, null);
      if (!quad) return res.status(400).json({ success: false, error: 'شکل کادر نامعتبر است.' });
    } else {
      const bx = Number(req.body?.x);
      const by = Number(req.body?.y);
      const bw = Number(req.body?.w);
      const bh = Number(req.body?.h);
      if (![bx, by, bw, bh].every(Number.isFinite)) {
        return res.status(400).json({ success: false, error: 'مختصات کادر نامعتبر است.' });
      }
      quad = [[bx, by], [bx + bw, by], [bx + bw, by + bh], [bx, by + bh]].map(p => [Math.round(p[0]), Math.round(p[1])]);
    }

    // Clamp to the image: a drag that ran off the edge of the canvas must still
    // produce a crop sharp can actually extract.
    quad = quad.map(([px, py]) => [
      Math.max(0, Math.min(Math.round(px), imgW)),
      Math.max(0, Math.min(Math.round(py), imgH)),
    ]);

    const box = quadBounds(quad, imgW, imgH);
    if (box.w < 8 || box.h < 8) {
      return res.status(400).json({ success: false, error: 'کادر انتخابی بسیار کوچک است. لطفاً کادر بزرگ‌تری بکشید.' });
    }

    const erase = parseErase(req.body?.erase);
    const bgColor = HEX_COLOR.test(req.body?.bg_color || '') ? req.body.bg_color : '#ffffff';

    const filename = `seg_${image.id}_${String(lineNo).padStart(2, '0')}_${crypto.randomBytes(6).toString('hex')}.jpg`;
    const outPath = path.join(config.SEGMENTS_DIR, filename);
    // Seed the fill noise from the geometry, not the filename, so an unchanged
    // shape re-renders to the same pixels.
    const seedKey = `${image.id}|${lineNo}|${JSON.stringify(quad)}|${JSON.stringify(erase)}|${bgColor}`;
    const { maskedFraction } = await renderSegmentCrop({
      sheetPath, outPath, box, quad, erase, bgColor, seedKey,
    });

    // Measured on the crop we just wrote, so erased areas are already paper.
    const inkAngleDeg = await measureInkAngleDeg(outPath);

    const { previousFilename } = db.upsertSegment({
      imageId: image.id,
      promptId: line.prompt_id,
      lineNo,
      text: line.text,
      x: box.x, y: box.y, w: box.w, h: box.h,
      quad, erase, bgColor, maskedFraction, inkAngleDeg,
      filename,
    });

    // Only now that the new crop is on disk and the row points at it.
    if (previousFilename && previousFilename !== filename) deleteSegmentFile(previousFilename);

    res.json({
      success: true,
      segment: {
        line_no: lineNo, text: line.text,
        x: box.x, y: box.y, w: box.w, h: box.h,
        quad, erase, bg_color: bgColor, filename,
      },
      segmentCount: db.countSegments(image.id),
      totalLines: lines.length,
    });
  } catch (err) {
    console.error('[API] POST /api/admin/images/:id/segments:', err.message);
    // Geometry parsing rejects malformed corners/strokes with a 400; only genuine
    // failures should read as a server error.
    if (err.statusCode === 400) {
      return res.status(400).json({ success: false, error: 'شکل یا مختصات ارسالی نامعتبر است.' });
    }
    res.status(500).json({ success: false, error: 'خطا در برش تصویر.' });
  }
});

// Undo one line's rectangle.
app.delete('/api/admin/images/:id/segments/:lineNo', requireAdmin, (req, res) => {
  try {
    const image = db.getImage(req.params.id);
    if (!image) return res.status(404).json({ success: false, error: 'Image not found' });

    const lineNo = parseInt(req.params.lineNo, 10);
    if (isNaN(lineNo)) return res.status(400).json({ success: false, error: 'شماره سطر نامعتبر است.' });

    const removed = db.deleteSegment(image.id, lineNo);
    if (removed) deleteSegmentFile(removed.filename);

    res.json({ success: true, segmentCount: db.countSegments(image.id) });
  } catch (err) {
    console.error('[API] DELETE /api/admin/images/:id/segments/:lineNo:', err.message);
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

// --- Google Drive Config & Test ---

// Get current Drive configuration status
app.get('/api/admin/drive/config', requireAdmin, (req, res) => {
  try {
    res.json(drive.getConfigStatus());
  } catch (err) {
    console.error('[API] GET /api/admin/drive/config:', err.message);
    res.status(500).json({ success: false, error: 'Server error' });
  }
});

// Test connection with supplied credentials or active credentials
app.post('/api/admin/drive/test', requireAdmin, async (req, res) => {
  try {
    let { client_email, private_key, folder_id } = req.body || {};

    // If body fields not supplied, test currently configured credentials
    if (!client_email || !private_key || !folder_id) {
      client_email = client_email || db.getSetting('drive_client_email');
      private_key = private_key || db.getSetting('drive_private_key');
      folder_id = folder_id || db.getSetting('drive_folder_id');
    }

    const result = await drive.testConnection({ client_email, private_key, folder_id });
    res.json({ success: true, ...result });
  } catch (err) {
    res.status(400).json({ success: false, error: err.message });
  }
});

// Save Drive configuration and initialize
app.post('/api/admin/drive/config', requireAdmin, async (req, res) => {
  try {
    const { client_email, private_key, folder_id } = req.body || {};

    if (!client_email || !client_email.trim()) {
      return res.status(400).json({ success: false, error: 'ایمیل سرویس گوگل (Client Email) الزامی است.' });
    }
    if (!private_key || !private_key.trim()) {
      return res.status(400).json({ success: false, error: 'کلید اختصاصی (Private Key) الزامی است.' });
    }
    if (!folder_id || !folder_id.trim()) {
      return res.status(400).json({ success: false, error: 'شناسه پوشه Google Drive الزامی است.' });
    }

    // First test the credentials before saving
    const testResult = await drive.testConnection({ client_email, private_key, folder_id });

    // Save to database settings
    db.setSetting('drive_client_email', client_email.trim());
    db.setSetting('drive_private_key', private_key.trim());
    db.setSetting('drive_folder_id', folder_id.trim());

    // Re-initialize active drive client
    drive.initialize({
      client_email: client_email.trim(),
      private_key: private_key.trim(),
      folder_id: folder_id.trim(),
    });

    res.json({
      success: true,
      message: 'تنظیمات با موفقیت ذخیره و Google Drive فعال شد.',
      folderName: testResult.folderName,
      status: drive.getConfigStatus(),
    });
  } catch (err) {
    console.error('[API] POST /api/admin/drive/config:', err.message);
    res.status(400).json({ success: false, error: err.message });
  }
});

// --- GitHub Sync & Config ---

// Get GitHub config status
app.get('/api/admin/github/config', requireAdmin, (req, res) => {
  try {
    res.json(githubSync.getConfigStatus());
  } catch (err) {
    console.error('[API] GET /api/admin/github/config:', err.message);
    res.status(500).json({ success: false, error: 'Server error' });
  }
});

// Save GitHub configuration
app.post('/api/admin/github/config', requireAdmin, async (req, res) => {
  try {
    const { token, repo, branch, path: targetPath } = req.body || {};

    if (!repo || !repo.trim()) {
      return res.status(400).json({ success: false, error: 'نام ریپازیتوری الزامی است.' });
    }

    // Determine active token (keep existing if placeholder or empty)
    let activeToken = token ? token.trim() : '';
    const existingToken = db.getSetting('github_token') || '';
    if (!activeToken || activeToken.includes('****')) {
      activeToken = existingToken;
    }

    if (!activeToken) {
      return res.status(400).json({ success: false, error: 'توکن دسترسی گیت‌هاب (Personal Access Token) الزامی است.' });
    }

    const cleanBranch = (branch && branch.trim()) ? branch.trim() : 'main';
    const cleanPath = (targetPath && targetPath.trim()) ? targetPath.trim().replace(/^\/+|\/+$/g, '') : '';

    // Test connection with credentials before saving
    const testResult = await githubSync.testConnection({
      token: activeToken,
      repo: repo.trim(),
      branch: cleanBranch,
    });

    db.setSetting('github_token', activeToken);
    db.setSetting('github_repo', repo.trim());
    db.setSetting('github_branch', cleanBranch);
    db.setSetting('github_path', cleanPath);

    res.json({
      success: true,
      message: 'تنظیمات گیت‌هاب با موفقیت ذخیره شد.',
      details: testResult,
      status: githubSync.getConfigStatus(),
    });
  } catch (err) {
    console.error('[API] POST /api/admin/github/config:', err.message);
    res.status(400).json({ success: false, error: err.message });
  }
});

// Test GitHub connection
app.post('/api/admin/github/test', requireAdmin, async (req, res) => {
  try {
    let { token, repo, branch } = req.body || {};

    let activeToken = token ? token.trim() : '';
    const existingToken = db.getSetting('github_token') || '';
    if (!activeToken || activeToken.includes('****')) {
      activeToken = existingToken;
    }

    const activeRepo = (repo && repo.trim()) ? repo.trim() : (db.getSetting('github_repo') || '');
    const activeBranch = (branch && branch.trim()) ? branch.trim() : (db.getSetting('github_branch') || 'main');

    if (!activeToken) {
      return res.status(400).json({ success: false, error: 'توکن گیت‌هاب وارد نشده است.' });
    }
    if (!activeRepo) {
      return res.status(400).json({ success: false, error: 'نام ریپازیتوری وارد نشده است.' });
    }

    const result = await githubSync.testConnection({
      token: activeToken,
      repo: activeRepo,
      branch: activeBranch,
    });

    res.json({ success: true, ...result });
  } catch (err) {
    res.status(400).json({ success: false, error: err.message });
  }
});

// Commit approved dataset to GitHub
app.post('/api/admin/github/sync', requireAdmin, async (req, res) => {
  try {
    const token = db.getSetting('github_token');
    const repo = db.getSetting('github_repo');
    const branch = db.getSetting('github_branch') || 'main';
    const targetPath = (db.getSetting('github_path') || '').replace(/^\/+|\/+$/g, '');

    if (!token || !repo) {
      return res.status(400).json({ success: false, error: 'ابتدا اطلاعات ریپازیتوری و توکن گیت‌هاب را تنظیم و ذخیره کنید.' });
    }

    const images = db.getApprovedForExport();
    if (!images || images.length === 0) {
      return res.status(400).json({ success: false, error: 'هیچ تصویری با وضعیت تایید شده جهت ارسال وجود ندارد.' });
    }

    // Resolve images on disk
    const resolved = [];
    for (const img of images) {
      let filePath = path.join(config.APPROVED_DIR, img.filename);
      if (!fs.existsSync(filePath)) {
        filePath = path.join(config.PENDING_DIR, img.filename);
      }
      if (fs.existsSync(filePath)) {
        resolved.push({ img, filePath });
      }
    }

    if (resolved.length === 0) {
      return res.status(400).json({ success: false, error: 'هیچ فایل تصویری تایید شده‌ای روی دیسک یافت نشد.' });
    }

    const prefix = targetPath ? `${targetPath}/` : '';

    const resolvedSegments = [];
    for (const seg of db.getApprovedSegmentsForExport()) {
      const segPath = path.join(config.SEGMENTS_DIR, seg.filename);
      if (fs.existsSync(segPath)) resolvedSegments.push({ seg, segPath });
    }

    // 1. Manifests: labels.csv is line-level (the training set), sheets.csv is provenance.
    const csv = buildSegmentCsv(resolvedSegments.map(r => r.seg));
    const sheetsCsv = buildSheetCsv(resolved.map(r => r.img));

    // 2. Generate README.md
    const readme = `# Persian Handwritten OCR Dataset
مجموعه داده متن دست‌نویس فارسی جمع‌آوری‌شده توسط سامانه OCR Data Collector.

هر مشارکت‌کننده دو برگه می‌نویسد (یکی جملات/کلمات و یکی اعداد) و هر برگه چند سطر دارد.
مدیر سامانه هر سطر را به صورت دستی کادرکشی می‌کند و برش آن به همراه متن دقیقش ذخیره می‌شود.

## مشخصات مجموعه داده
- **تعداد برگه‌های تایید شده:** ${resolved.length}
- **تعداد نمونه‌های آموزشی (سطرهای برش‌خورده):** ${resolvedSegments.length}
- **تاریخ آخرین به‌روزرسانی:** ${new Date().toLocaleString('fa-IR', { timeZone: 'Asia/Tehran' })} (${new Date().toISOString().slice(0, 10)})
- **پوشه‌بندی:** ${targetPath ? `\`${targetPath}/\`` : 'شاخه اصلی ریپازیتوری (Root)'}

## ساختار فایل‌ها
- \`${prefix}labels.csv\`: جدول اصلی آموزش — هر ردیف یک سطر برش‌خورده و متن آن
- \`${prefix}segments/\`: تصاویر برش‌خورده سطرها
- \`${prefix}sheets.csv\`: فهرست برگه‌های کامل ارسالی
- \`${prefix}sheets/\`: تصویر کامل برگه‌ها (مرجع)

## ستون‌های labels.csv
| ستون | شرح |
| :--- | :--- |
| \`filename\` | نام فایل برش‌خورده در پوشه segments |
| \`text_label\` | متن دقیق آن سطر |
| \`sheet_filename\` | برگه‌ای که این سطر از آن برش خورده است |
| \`line_no\` | شماره سطر روی برگه |
| \`category\` | \`sentences\` یا \`numbers\` |
| \`contributor_name\` | نام و نام خانوادگی مشارکت‌کننده |
| \`contributor_id\` | شناسه نویسنده |
| \`created_at\` | تاریخ و زمان بارگذاری برگه |
| \`quad\` | چهار گوشه ناحیه متن: \`x1 y1 x2 y2 x3 y3 x4 y4\` (بالا-چپ، بالا-راست، پایین-راست، پایین-چپ) بر حسب پیکسل تصویر برش‌خورده |
| \`baseline_angle_deg\` | زاویه خط کرسی؛ مثبت یعنی سطر به راست بالا می‌رود. برای افقی‌سازی، تصویر را به اندازه منفی این عدد بچرخانید |
| \`angle_source\` | منبع زاویه: \`quad\` (از گوشه‌های کشیده‌شده)، \`ink\` (اندازه‌گیری‌شده از روی نوشته، وقتی مدیر کادر ساده کشیده و با پاک‌کن تمیز کرده)، یا \`none\` |
| \`masked_fraction\` | نسبت پیکسل‌های کاغذ مصنوعی (بیرون چهارضلعی + نواحی پاک‌شده) به کل برش، بین ۰ و ۱ |

## نکته مهم برای پیش‌پردازش
برش هر سطر، «کادر محیطی» چهارضلعی آن است. برای سطرهای کج، این کادر بسیار بلندتر از خودِ
متن است؛ بنابراین تغییر اندازه به ارتفاع ثابت، دست‌خط را به نسبت زاویه کوچک می‌کند.
با استفاده از \`quad\` و \`baseline_angle_deg\` می‌توانید ارتفاع بدنه متن را در راستای خط
کرسی اندازه بگیرید (و نه ارتفاع کادر)، یا برش را با زاویه معلوم افقی کنید.
`;

    // 3. Assemble files array
    const files = [
      {
        path: `${prefix}labels.csv`,
        content: '\uFEFF' + csv,
        isBinary: false,
      },
      {
        path: `${prefix}sheets.csv`,
        content: '\uFEFF' + sheetsCsv,
        isBinary: false,
      },
      {
        path: `${prefix}README.md`,
        content: readme,
        isBinary: false,
      },
    ];

    for (const { seg, segPath } of resolvedSegments) {
      files.push({
        path: `${prefix}segments/${seg.filename}`,
        diskPath: segPath,
        isBinary: true,
      });
    }

    for (const { img, filePath } of resolved) {
      files.push({
        path: `${prefix}sheets/${img.filename}`,
        diskPath: filePath,
        isBinary: true,
      });
    }

    const commitMessage = req.body?.message || `Update Persian OCR dataset: ${resolvedSegments.length} line crops from ${resolved.length} sheets`;

    const result = await githubSync.commitDataset({
      token,
      repo,
      branch,
      targetPath,
      files,
      message: commitMessage,
    });

    res.json({
      success: true,
      commitUrl: result.commitUrl,
      commitSha: result.commitSha,
      branch: result.branch,
      imageCount: resolved.length,
      segmentCount: resolvedSegments.length,
      fileCount: files.length,
    });
  } catch (err) {
    console.error('[API] POST /api/admin/github/sync:', err.message);
    res.status(500).json({ success: false, error: 'خطا در ارسال به گیت‌هاب: ' + err.message });
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

// Add single prompt manually
app.post('/api/admin/prompts', requireAdmin, (req, res) => {
  try {
    const { text, category } = req.body;
    if (!text || !text.trim()) {
      return res.status(400).json({ success: false, error: 'متن الزامی است.' });
    }
    const result = db.createPrompt(text.trim(), category || 'custom');
    res.json({ success: true, id: result.lastInsertRowid });
  } catch (err) {
    console.error('[API] POST /api/admin/prompts:', err.message);
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
      records = parse(content, {
        columns: false,
        skip_empty_lines: true,
        trim: true,
        bom: true,
        relax_quotes: true,
        relax_column_count: true,
      });
    } catch (e) {
      return res.status(400).json({ success: false, error: 'خطا در خواندن فایل CSV: ' + e.message });
    }

    const category = req.body.category || 'csv-batch';
    const texts = records.map(row => (Array.isArray(row) ? row[0] : row.text)).filter(t => t && String(t).trim());
    const { imported, skipped } = db.createPromptsBatch(texts, category);
    const batch = db.createPromptBatch(req.file.originalname, imported);

    res.json({
      success: true,
      imported,
      skipped,
      received: texts.length,
      batch_id: batch.lastInsertRowid,
      stats: db.getPromptStats(),
    });
  } catch (err) {
    console.error('[API] POST /api/admin/prompts/upload:', err.message);
    res.status(500).json({ success: false, error: 'Server error' });
  }
});

// Toggle prompt active/inactive
// Turn every prompt on (or off) in one request.
//
// The per-prompt PATCH below is fine for a handful, but the global API limiter is
// 150 requests/minute, so flipping a bank of a thousand one at a time takes minutes
// and locks the admin out of everything else meanwhile. This is also the supported
// alternative to running UPDATE against the database file by hand, which does not
// survive: the server keeps the database in memory and rewrites the file on its own
// schedule, so an external edit is silently discarded.
app.post('/api/admin/prompts/bulk-active', requireAdmin, (req, res) => {
  try {
    const { active, category } = req.body || {};
    if (active !== 0 && active !== 1 && active !== true && active !== false) {
      return res.status(400).json({ success: false, error: 'مقدار active باید ۰ یا ۱ باشد.' });
    }
    const scope = typeof category === 'string' && category.trim() ? category.trim() : null;
    const changed = db.setAllPromptsActive(active ? 1 : 0, scope);
    // Flush immediately: this is a recovery action and must not be lost to a crash
    // inside the debounce window.
    db.flushIfDirty();
    res.json({ success: true, changed, category: scope, stats: db.getPromptStats() });
  } catch (err) {
    console.error('[API] POST /api/admin/prompts/bulk-active:', err.message);
    res.status(500).json({ success: false, error: 'Server error' });
  }
});

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
    res.status(err.statusCode || 500).json({ success: false, error: err.message || 'Server error' });
  }
});

// Export approved images as CSV manifest
// --- Dataset manifests ---
//
// The training set is the SEGMENTS: one cropped line paired with its exact label.
// The full sheets are kept alongside as provenance, in their own manifest, because
// a sheet has ten labels and cannot be a row in a filename->label table.
// `quad`, `baseline_angle_deg` and `masked_fraction` exist so the training pipeline
// can make its own preprocessing decisions instead of inheriting ours. A slanted
// line's crop is the bounding box of its shape, which is much taller than the text —
// so resizing to a fixed height shrinks the handwriting in proportion to the slant.
// With the geometry exported, a loader can normalise on x-height measured along the
// baseline, or deskew by a known (human-drawn, not estimated) angle, and either
// choice stays a versioned decision in the pipeline rather than baked into the data.
const SEGMENT_CSV_HEADER =
  'filename,text_label,sheet_filename,line_no,category,contributor_name,contributor_id,created_at,'
  + 'quad,baseline_angle_deg,angle_source,masked_fraction\n';
const SHEET_CSV_HEADER = 'filename,category,line_count,segment_count,contributor_name,contributor_id,created_at,drive_file_id\n';

// A server-computed number, emitted bare rather than quoted and guarded.
//
// csvSafeCell prefixes anything starting with '-' to stop Excel treating it as a
// formula, which is right for user-supplied text but wrong here: it turns a
// baseline angle of -5.71 into the string '-5.71, which no loader can read as a
// number. These values come from toFixed() on our own arithmetic, so there is
// nothing to guard against.
function csvNum(value) {
  return { raw: String(value) };
}

// `v || ''` would blank out a legitimate 0 in the count columns, so only null and
// undefined become empty cells.
function csvRow(values) {
  return values
    .map(v => {
      if (v && typeof v === 'object' && 'raw' in v) return v.raw;
      return `"${csvSafeCell(v === null || v === undefined ? '' : v).replace(/"/g, '""')}"`;
    })
    .join(',') + '\n';
}

// The quad is stored against the full sheet; a consumer of the crop wants it in the
// crop's own pixels, so shift it by the bounding-box origin. Emitted as eight plain
// integers (TL TR BR BL) rather than JSON, so it survives CSV without nested quoting.
function quadForExport(seg) {
  let quad = null;
  try { quad = seg.quad ? JSON.parse(seg.quad) : null; } catch (_) {}
  if (!Array.isArray(quad) || quad.length !== 4) {
    quad = [[seg.x, seg.y], [seg.x + seg.w, seg.y], [seg.x + seg.w, seg.y + seg.h], [seg.x, seg.y + seg.h]];
  }
  const local = quad.map(([px, py]) => [Math.round(px - seg.x), Math.round(py - seg.y)]);
  return { text: local.flat().join(' '), quad };
}

// Best available angle, plus where it came from.
//
// A dragged quad is a deliberate human judgement, so it wins whenever it carries an
// angle at all. An axis-aligned quad carries none — that is the rectangle-plus-
// eraser workflow — so fall back to the angle measured from the ink. `angle_source`
// is exported alongside it so a consumer can filter or weight by provenance instead
// of having to guess which technique produced the sample.
function angleForExport(seg, quad) {
  const geometric = baselineAngleDeg(quad);
  if (Math.abs(geometric) >= 0.05) return { deg: geometric, source: 'quad' };
  if (typeof seg.ink_angle_deg === 'number') return { deg: seg.ink_angle_deg, source: 'ink' };
  return { deg: null, source: 'none' };
}

function buildSegmentCsv(segments) {
  let csv = SEGMENT_CSV_HEADER;
  for (const seg of segments) {
    const { text: quadText, quad } = quadForExport(seg);
    const angle = angleForExport(seg, quad);
    csv += csvRow([
      seg.filename, seg.text, seg.sheet_filename, seg.line_no,
      seg.sheet_category || 'sentences', seg.contributor_name, seg.contributor_id, seg.created_at,
      quadText,
      csvNum(angle.deg === null ? '' : angle.deg.toFixed(2)),
      angle.source,
      csvNum((typeof seg.masked_fraction === 'number' ? seg.masked_fraction : 0).toFixed(4)),
    ]);
  }
  return csv;
}

function buildSheetCsv(images) {
  let csv = SHEET_CSV_HEADER;
  for (const img of images) {
    csv += csvRow([
      img.filename, img.sheet_category || 'legacy', img.line_count, img.segment_count,
      img.contributor_name, img.contributor_id, img.created_at, img.drive_file_id,
    ]);
  }
  return csv;
}

app.get('/api/admin/export', requireAdmin, (req, res) => {
  try {
    const csv = buildSegmentCsv(db.getApprovedSegmentsForExport());
    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader('Content-Disposition', 'attachment; filename=ocr_labels.csv');
    res.send('﻿' + csv); // BOM for Excel compatibility
  } catch (err) {
    console.error('[API] GET /api/admin/export:', err.message);
    res.status(500).json({ success: false, error: 'Server error' });
  }
});

function createZipArchive(options) {
  if (typeof archiver === 'function') {
    return archiver('zip', options);
  }
  if (archiver && archiver.ZipArchive) {
    return new archiver.ZipArchive(options);
  }
  throw new Error('Unsupported archiver module');
}

// Export full dataset (images + labels.csv) as ZIP archive
app.get('/api/admin/export-zip', requireAdmin, async (req, res) => {
  try {
    const images = db.getApprovedForExport();
    const timestamp = new Date().toISOString().slice(0, 10);

    res.setHeader('Content-Type', 'application/zip');
    res.setHeader('Content-Disposition', `attachment; filename="persian_ocr_dataset_${timestamp}.zip"`);

    const archive = createZipArchive({
      zlib: { level: 6 },
    });

    archive.on('warning', (err) => {
      if (err.code === 'ENOENT') {
        console.warn('[API] ZIP warning:', err.message);
      } else {
        throw err;
      }
    });

    archive.on('error', (err) => {
      console.error('[API] ZIP archive error:', err.message);
      if (!res.headersSent) {
        res.status(500).json({ success: false, error: 'خطا در ایجاد فایل زیپ' });
      }
    });

    archive.pipe(res);

    // Resolve each record to a file on disk FIRST. A row whose file is missing must
    // not reach a manifest, otherwise the CSV points at images the ZIP does not
    // contain and any loader reading it fails on the missing path.
    const resolved = [];
    for (const img of images) {
      let filePath = path.join(config.APPROVED_DIR, img.filename);
      if (!fs.existsSync(filePath)) {
        filePath = path.join(config.PENDING_DIR, img.filename);
      }
      if (fs.existsSync(filePath)) {
        resolved.push({ img, filePath });
      } else {
        console.warn(`[API] export-zip: skipping ${img.filename} (file not found on disk)`);
      }
    }

    const resolvedSegments = [];
    for (const seg of db.getApprovedSegmentsForExport()) {
      const segPath = path.join(config.SEGMENTS_DIR, seg.filename);
      if (fs.existsSync(segPath)) {
        resolvedSegments.push({ seg, segPath });
      } else {
        console.warn(`[API] export-zip: skipping segment ${seg.filename} (file not found on disk)`);
      }
    }

    // 1. labels.csv — the training manifest: one cropped line per row.
    archive.append('\uFEFF' + buildSegmentCsv(resolvedSegments.map(r => r.seg)), { name: 'labels.csv' });

    // 2. sheets.csv — provenance for the full uploaded pages.
    archive.append('\uFEFF' + buildSheetCsv(resolved.map(r => r.img)), { name: 'sheets.csv' });

    // 3. README.txt
    const readme = `دیتاست OCR دست‌نویس فارسی
تعداد برگه‌های تایید شده: ${resolved.length}
تعداد برش‌های سطری (نمونه‌های آموزشی): ${resolvedSegments.length}
تاریخ دریافت خروجی: ${new Date().toLocaleString('fa-IR')}

محتوای فایل زیپ:
1. labels.csv  : جدول اصلی آموزش — هر ردیف یک تصویر برش‌خورده از یک سطر به همراه متن دقیق آن
2. پوشه segments/ : تصاویر برش‌خورده سطرها (ورودی آموزش مدل)
3. sheets.csv  : فهرست برگه‌های کامل ارسالی و تعداد سطرهای برش‌خورده هر برگه
4. پوشه sheets/   : تصویر کامل برگه‌های تایید شده (مرجع و بازبینی)

نکته: هر برگه شامل چند سطر دست‌نویس است. برچسب‌گذاری در سطح سطر انجام می‌شود،
بنابراین فایل labels.csv و پوشه segments/ منبع اصلی آموزش مدل هستند.

ستون‌های هندسی در labels.csv (برای مرحله پیش‌پردازش):
- quad               : هشت عدد صحیح «x1 y1 x2 y2 x3 y3 x4 y4» — چهار گوشه ناحیه متن،
                       به ترتیب بالا-چپ، بالا-راست، پایین-راست، پایین-چپ، بر حسب
                       پیکسل «تصویر برش‌خورده» (نه برگه کامل).
- baseline_angle_deg : زاویه خط کرسی نوشتار بر حسب درجه. مقدار مثبت یعنی سطر به سمت
                       راست بالا می‌رود. برای افقی کردن سطر، تصویر را به اندازه
                       منفیِ این عدد بچرخانید. اگر خالی باشد یعنی زاویه قابل
                       اندازه‌گیری نبوده است.
- angle_source       : منبع زاویه بالا. «quad» یعنی از گوشه‌های کشیده‌شده توسط مدیر
                       به دست آمده، «ink» یعنی از روی خودِ نوشته اندازه‌گیری شده
                       (حالتی که مدیر کادر ساده کشیده و با پاک‌کن تمیز کرده است)،
                       و «none» یعنی زاویه قابل تعیین نبوده است.
- masked_fraction    : نسبتی از پیکسل‌های برش که کاغذ مصنوعی است (بیرون چهارضلعی به
                       علاوه نواحی پاک‌شده) و نه تصویر واقعی برگه. عدد بین ۰ و ۱.
`;
    archive.append(readme, { name: 'README.txt' });

    // 4. Append the files behind exactly the rows written above.
    for (const { seg, segPath } of resolvedSegments) {
      archive.file(segPath, { name: `segments/${seg.filename}` });
    }
    for (const { img, filePath } of resolved) {
      archive.file(filePath, { name: `sheets/${img.filename}` });
    }

    await archive.finalize();
  } catch (err) {
    console.error('[API] GET /api/admin/export-zip:', err.message);
    if (!res.headersSent) {
      res.status(500).json({ success: false, error: 'Server error' });
    }
  }
});

// Storage usage stats
app.get('/api/admin/storage-stats', requireAdmin, (req, res) => {
  try {
    const usedBytes = security.getStorageUsageBytes();
    const maxBytes = (config.MAX_STORAGE_MB || 51200) * 1024 * 1024;
    const pendingCount = db.getPendingCount();
    res.json({
      usedBytes,
      usedMB: Math.round(usedBytes / (1024 * 1024) * 10) / 10,
      maxMB: config.MAX_STORAGE_MB || 51200,
      percent: Math.min(100, Math.round((usedBytes / maxBytes) * 1000) / 10),
      pendingCount,
      maxPending: config.MAX_PENDING_IMAGES || 2000,
    });
  } catch (err) {
    console.error('[API] GET /api/admin/storage-stats:', err.message);
    res.status(500).json({ success: false, error: 'Server error' });
  }
});

// Manual purge of rejected images (forceAll = true to immediately delete 100% of rejected images)
app.post('/api/admin/purge-rejected', requireAdmin, (req, res) => {
  try {
    const purgedCount = security.purgeRejectedImages(db, true);
    res.json({ success: true, purgedCount });
  } catch (err) {
    console.error('[API] POST /api/admin/purge-rejected:', err.message);
    res.status(500).json({ success: false, error: 'Server error' });
  }
});

// Health check
app.get('/api/health', (req, res) => {
  res.json({ status: 'ok' });
});

// --- Custom 404 Handler (Closes Finding L4) ---
app.use((req, res) => {
  res.status(404).json({ success: false, error: 'مسیر مورد نظر یافت نشد.' });
});

// --- Global Error Handling Middleware (Closes Finding H3 / H4 - Zero Info Leak) ---
app.use((err, req, res, next) => {
  console.error('[Global Error]:', err);
  if (err instanceof multer.MulterError) {
    if (err.code === 'LIMIT_FILE_SIZE') {
      return res.status(400).json({ success: false, error: `حجم فایل بیش از حد مجاز است (حداکثر ${config.MAX_FILE_SIZE_MB} مگابایت).` });
    }
    return res.status(400).json({ success: false, error: 'خطا در بارگذاری فایل.' });
  }
  if (err.status === 400 && 'body' in err) {
    return res.status(400).json({ success: false, error: 'فرمت داده‌های ارسالی (JSON) نامعتبر است.' });
  }
  const statusCode = (typeof err.statusCode === 'number' && err.statusCode >= 400 && err.statusCode < 500) ? err.statusCode : 500;
  // NEVER leak internal error message, paths, or stack to client
  res.status(statusCode).json({ success: false, error: 'خطای سرور' });
});

// --- Start server ---
async function start() {
  await db.initDatabase();
  const driveReady = drive.initialize();

  // Start 1-minute auto-purge worker for rejected images
  security.startAutoPurgeWorker(db);
  console.log(`[Security] Auto-purge worker started (rejected images deleted after ${Math.floor(config.REJECTED_RETENTION_MS / 1000)}s)`);

  app.listen(config.PORT, config.HOST, () => {
    console.log(`\n========================================`);
    console.log(`  OCR Data Collector is running!`);
    console.log(`  http://localhost:${config.PORT}`);
    console.log(`  Google Drive sync: ${driveReady ? 'ENABLED' : 'DISABLED'}`);
    console.log(`========================================\n`);
  });
}

start().catch(err => {
  console.error('Failed to start server:', err);
  process.exit(1);
});
