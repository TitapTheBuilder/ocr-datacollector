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
const security = require('./security');

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
for (const dir of [config.PENDING_DIR, config.APPROVED_DIR]) {
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

function identifyContributor(req, res, next) {
  const token = req.headers['x-contributor-token'] || req.query?.contributor_token;
  if (token) {
    req.contributorId = security.verifyContributorToken(token) || null;
  }
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

// Get next prompt
app.get('/api/prompts/next', identifyContributor, (req, res) => {
  try {
    const contributorId = req.contributorId || req.query.contributor_id;
    const prompt = db.getRandomPrompt(contributorId);
    if (!prompt) {
      return res.status(404).json({ success: false, error: 'هیچ متنی برای نمایش وجود ندارد. لطفاً منتظر بمانید تا ادمین متن‌ها را اضافه کند.' });
    }
    res.json({ id: prompt.id, text: prompt.text, category: prompt.category });
  } catch (err) {
    console.error('[API] GET /api/prompts/next:', err.message);
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
      const { prompt_id, custom_text, contributor_id, contributor_token, hp_website } = req.body || {};

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

      // 3. Strict Input Validation for prompt_id vs custom_text (Closes Finding H2)
      let finalPromptId = null;
      let finalCustomText = null;

      if (prompt_id !== undefined && prompt_id !== null && String(prompt_id).trim() !== '') {
        const pid = parseInt(prompt_id, 10);
        if (isNaN(pid) || pid <= 0) {
          fs.unlinkSync(req.file.path);
          return res.status(400).json({ success: false, error: 'شناسه متن انتخابی نامعتبر است.' });
        }
        const promptRow = db.getPromptById(pid);
        if (!promptRow || !promptRow.active) {
          fs.unlinkSync(req.file.path);
          return res.status(400).json({ success: false, error: 'متن انتخاب شده در سامانه فعال نیست یا یافت نشد.' });
        }
        finalPromptId = pid;
      } else if (custom_text !== undefined && custom_text !== null && String(custom_text).trim() !== '') {
        if (typeof custom_text !== 'string' || custom_text.trim().length === 0 || custom_text.trim().length > 300) {
          fs.unlinkSync(req.file.path);
          return res.status(400).json({ success: false, error: 'طول متن دلخواه باید بین ۱ تا ۳۰۰ کاراکتر باشد.' });
        }
        if (!/[\u0600-\u06FF]/.test(custom_text)) {
          fs.unlinkSync(req.file.path);
          return res.status(400).json({ success: false, error: 'متن دلخواه باید شامل حروف فارسی باشد.' });
        }
        finalCustomText = custom_text.trim().replace(/[\x00-\x1f]/g, '');
      } else {
        fs.unlinkSync(req.file.path);
        return res.status(400).json({ success: false, error: 'تعیین یکی از فیلدهای prompt_id یا custom_text الزامی است.' });
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

      const fileSize = cleanBuffer.length;
      const result = db.createImage({
        filename: req.file.filename,
        originalName: req.file.originalname,
        promptId: finalPromptId,
        customText: finalCustomText,
        contributorId: verifiedContributorId,
        mimeType: finalMime,
        fileSize: fileSize,
        ipAddress: clientIp,
        fileHash: fileHash,
      });

      res.json({ success: true, image_id: result.lastInsertRowid });
    } catch (err) {
      console.error('[API] POST /api/images:', err.message);
      if (req.file && fs.existsSync(req.file.path)) {
        try { fs.unlinkSync(req.file.path); } catch (_) {}
      }
      res.status(500).json({ success: false, error: 'خطای سرور' });
    }
  }
);

// Contributor upload count (Protected: only authenticated contributor can see own count, closes L5)
app.get('/api/contributors/:id/count', requireContributor, (req, res) => {
  try {
    // Compare case-insensitively: tokens issued before ids were lowercased at the
    // source still carry a mixed-case id in the client's localStorage.
    if (String(req.params.id).toLowerCase() !== req.contributorId) {
      return res.status(403).json({ success: false, error: 'دسترسی غیرمجاز به اطلاعات سایر کاربران.' });
    }
    const count = db.getContributorUploadCount(req.contributorId);
    const contributor = db.getContributor(req.contributorId);
    res.json({ count, name: contributor ? contributor.name : null });
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
    const imported = db.createPromptsBatch(texts, category);
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
    res.status(err.statusCode || 500).json({ success: false, error: err.message || 'Server error' });
  }
});

// Export approved images as CSV manifest
app.get('/api/admin/export', requireAdmin, (req, res) => {
  try {
    const images = db.getApprovedForExport();
    let csv = 'filename,text_label,contributor_name,contributor_id,created_at,drive_file_id\n';
    for (const img of images) {
      const text = (img.prompt_text || img.custom_text || '').replace(/"/g, '""');
      const name = (img.contributor_name || '').replace(/"/g, '""');
      csv += `"${img.filename}","${text}","${name}","${img.contributor_id}","${img.created_at}","${img.drive_file_id || ''}"\n`;
    }
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
    // not reach labels.csv, otherwise the manifest points at images the ZIP does not
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

    // 1. Generate labels.csv manifest with BOM
    let csv = 'filename,text_label,contributor_name,contributor_id,created_at,drive_file_id\n';
    for (const { img } of resolved) {
      const text = (img.prompt_text || img.custom_text || '').replace(/"/g, '""');
      const name = (img.contributor_name || '').replace(/"/g, '""');
      csv += `"${img.filename}","${text}","${name}","${img.contributor_id}","${img.created_at}","${img.drive_file_id || ''}"\n`;
    }
    archive.append('\uFEFF' + csv, { name: 'labels.csv' });

    // 2. Generate README.txt
    const readme = `دیتاست OCR دستنویس فارسی
مجموع تصاویر تایید شده: ${resolved.length}
تاریخ دریافت خروجی: ${new Date().toLocaleString('fa-IR')}

محتوای فایل زیپ:
1. labels.csv : جدول برچسب‌ها، متن متناظر و مشخصات تصاویر (سازگار با Excel و Python Pandas)
2. پوشه images/ : شامل فایل‌های تصاویر تایید شده با کیفیت اصلی
`;
    archive.append(readme, { name: 'README.txt' });

    // 3. Append images (exactly the rows written to labels.csv)
    for (const { img, filePath } of resolved) {
      archive.file(filePath, { name: `images/${img.filename}` });
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
    const maxBytes = (config.MAX_STORAGE_MB || 1000) * 1024 * 1024;
    const pendingCount = db.getPendingCount();
    res.json({
      usedBytes,
      usedMB: Math.round(usedBytes / (1024 * 1024) * 10) / 10,
      maxMB: config.MAX_STORAGE_MB || 1000,
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
