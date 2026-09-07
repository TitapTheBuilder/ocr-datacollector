const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const config = require('./config');

// --- Helper: Extract Client IP ---
function getClientIp(req) {
  const forwarded = req.headers['x-forwarded-for'];
  if (forwarded) {
    return forwarded.split(',')[0].trim();
  }
  return req.socket?.remoteAddress || req.ip || '127.0.0.1';
}

// --- Memory Rate Limiter ---
class MemoryRateLimiter {
  constructor(options = {}) {
    this.windowMs = options.windowMs || 60 * 1000;
    this.max = options.max || 10;
    this.message = options.message || 'تعداد درخواست‌های شما بیش از حد مجاز است. لطفاً بعداً تلاش کنید.';
    this.hits = new Map();

    // Auto cleanup expired keys every 2 minutes
    this.cleanupTimer = setInterval(() => {
      const now = Date.now();
      for (const [key, record] of this.hits.entries()) {
        if (now - record.startTime > this.windowMs) {
          this.hits.delete(key);
        }
      }
    }, 2 * 60 * 1000).unref();
  }

  middleware(keyFn = getClientIp) {
    return (req, res, next) => {
      const key = keyFn(req);
      const now = Date.now();
      let record = this.hits.get(key);

      if (!record || now - record.startTime > this.windowMs) {
        record = { count: 1, startTime: now };
        this.hits.set(key, record);
        return next();
      }

      record.count++;
      if (record.count > this.max) {
        const retryAfter = Math.ceil((this.windowMs - (now - record.startTime)) / 1000);
        res.setHeader('Retry-After', retryAfter);
        return res.status(429).json({
          success: false,
          error: this.message,
          retryAfterSeconds: retryAfter,
        });
      }

      next();
    };
  }

  recordFailure(key) {
    const now = Date.now();
    let record = this.hits.get(key);
    if (!record || now - record.startTime > this.windowMs) {
      this.hits.set(key, { count: 1, startTime: now });
    } else {
      record.count++;
    }
  }

  isBlocked(key) {
    const record = this.hits.get(key);
    if (!record) return false;
    if (Date.now() - record.startTime > this.windowMs) {
      this.hits.delete(key);
      return false;
    }
    return record.count >= this.max;
  }

  reset(key) {
    this.hits.delete(key);
  }
}

// Global API rate limiter (60 req / min per IP)
const globalApiLimiter = new MemoryRateLimiter({
  windowMs: 60 * 1000,
  max: 60,
  message: 'سرعت ارسال درخواست‌ها بیش از حد مجاز است. لطفاً چند لحظه صبر کنید.',
});

// Upload burst limiter (max 5 uploads per minute per IP)
const uploadMinuteLimiter = new MemoryRateLimiter({
  windowMs: 60 * 1000,
  max: config.MAX_UPLOADS_PER_IP_PER_MINUTE || 5,
  message: 'تعداد آپلودهای ارسالی در دقیقه بیش از حد مجاز است (حداکثر ۵ در دقیقه). لطفاً کمی صبر کنید.',
});

// Admin login rate limiter (max 5 failed attempts in 15 mins)
const loginAttemptLimiter = new MemoryRateLimiter({
  windowMs: 15 * 60 * 1000,
  max: 5,
  message: 'به دلیل تلاش‌های ناموفق مکرر، ورود موقتاً مسدود شد. لطفاً ۱۵ دقیقه دیگر تلاش کنید.',
});

// --- Storage Quota Calculation ---
function calculateDirSize(dirPath) {
  let totalBytes = 0;
  try {
    if (!fs.existsSync(dirPath)) return 0;
    const entries = fs.readdirSync(dirPath, { withFileTypes: true });
    for (const entry of entries) {
      const fullPath = path.join(dirPath, entry.name);
      if (entry.isDirectory()) {
        totalBytes += calculateDirSize(fullPath);
      } else if (entry.isFile()) {
        totalBytes += fs.statSync(fullPath).size;
      }
    }
  } catch (err) {
    console.warn('[Security] calculateDirSize warning:', err.message);
  }
  return totalBytes;
}

// Cached directory size (recomputed every 15s to avoid disk I/O on every request)
let cachedStorageBytes = 0;
let lastStorageCheck = 0;

function getStorageUsageBytes() {
  const now = Date.now();
  if (now - lastStorageCheck > 15000) {
    cachedStorageBytes = calculateDirSize(config.UPLOAD_DIR);
    lastStorageCheck = now;
  }
  return cachedStorageBytes;
}

// Storage Quota Guard Middleware
function storageQuotaGuard(db) {
  return (req, res, next) => {
    const maxBytes = (config.MAX_STORAGE_MB || 1000) * 1024 * 1024;
    const currentBytes = getStorageUsageBytes();

    if (currentBytes >= maxBytes) {
      return res.status(507).json({
        success: false,
        error: 'ظرفیت دیسک سرور تکمیل شده است. لطفاً منتظر بررسی و آزادسازی فضا توسط ادمین باشید.',
      });
    }

    const pendingCount = db.getPendingCount();
    if (pendingCount >= (config.MAX_PENDING_IMAGES || 2000)) {
      return res.status(429).json({
        success: false,
        error: 'تعداد تصاویر در انتظار بررسی به سقف مجاز رسیده است. لطفاً بعداً تلاش کنید.',
      });
    }

    next();
  };
}

// --- Image Magic Bytes Validation ---
function validateMagicBytes(filePath) {
  try {
    const buffer = Buffer.alloc(12);
    const fd = fs.openSync(filePath, 'r');
    fs.readSync(fd, buffer, 0, 12, 0);
    fs.closeSync(fd);

    // JPEG: FF D8 FF
    if (buffer[0] === 0xFF && buffer[1] === 0xD8 && buffer[2] === 0xFF) {
      return 'image/jpeg';
    }

    // PNG: 89 50 4E 47 0D 0A 1A 0A
    if (
      buffer[0] === 0x89 && buffer[1] === 0x50 && buffer[2] === 0x4E && buffer[3] === 0x47 &&
      buffer[4] === 0x0D && buffer[5] === 0x0A && buffer[6] === 0x1A && buffer[7] === 0x0A
    ) {
      return 'image/png';
    }

    // WebP: RIFF ... WEBP
    if (
      buffer[0] === 0x52 && buffer[1] === 0x49 && buffer[2] === 0x46 && buffer[3] === 0x46 &&
      buffer[8] === 0x57 && buffer[9] === 0x45 && buffer[10] === 0x42 && buffer[11] === 0x50
    ) {
      return 'image/webp';
    }

    return null;
  } catch {
    return null;
  }
}

// --- Compute File SHA-256 Hash ---
function computeFileHash(filePath) {
  return new Promise((resolve, reject) => {
    const hash = crypto.createHash('sha256');
    const stream = fs.createReadStream(filePath);
    stream.on('data', chunk => hash.update(chunk));
    stream.on('end', () => resolve(hash.digest('hex')));
    stream.on('error', err => reject(err));
  });
}

// --- Auto-Purge Worker: Delete Rejected Images After 1 Minute ---
function purgeRejectedImages(db) {
  try {
    const retentionSeconds = Math.floor((config.REJECTED_RETENTION_MS || 60000) / 1000);
    const rejectedImages = db.getOldRejectedImages(retentionSeconds);

    if (!rejectedImages || rejectedImages.length === 0) return 0;

    let purgedCount = 0;
    for (const img of rejectedImages) {
      // 1. Delete physical file from disk
      const pathsToCheck = [
        path.join(config.PENDING_DIR, img.filename),
        path.join(config.APPROVED_DIR, img.filename),
      ];

      for (const p of pathsToCheck) {
        if (fs.existsSync(p)) {
          try {
            fs.unlinkSync(p);
          } catch (err) {
            console.warn(`[Security Cleanup] Could not delete file ${p}:`, err.message);
          }
        }
      }

      // 2. Delete row from database
      db.deleteImage(img.id);
      purgedCount++;
    }

    if (purgedCount > 0) {
      // Invalidate storage cache
      lastStorageCheck = 0;
      console.log(`[Security Cleanup] Purged ${purgedCount} rejected images older than ${retentionSeconds}s (storage reclaimed).`);
    }

    return purgedCount;
  } catch (err) {
    console.error('[Security Cleanup] Error purging rejected images:', err.message);
    return 0;
  }
}

// Start periodic rejected image cleanup (runs every 30 seconds)
function startAutoPurgeWorker(db) {
  const timer = setInterval(() => {
    purgeRejectedImages(db);
  }, 30 * 1000);
  timer.unref();
  return timer;
}

module.exports = {
  getClientIp,
  globalApiLimiter,
  uploadMinuteLimiter,
  loginAttemptLimiter,
  storageQuotaGuard,
  getStorageUsageBytes,
  validateMagicBytes,
  computeFileHash,
  purgeRejectedImages,
  startAutoPurgeWorker,
};
