require('dotenv').config();
const path = require('path');

// On Railway, set PERSISTENT_DATA_PATH to the volume mount path
// This keeps DB and uploads across deploys
const DATA_ROOT = process.env.PERSISTENT_DATA_PATH || __dirname;

module.exports = {
  PORT: parseInt(process.env.PORT) || 3000,
  HOST: '0.0.0.0',
  UPLOAD_DIR: path.join(DATA_ROOT, 'uploads'),
  PENDING_DIR: path.join(DATA_ROOT, 'uploads', 'pending'),
  APPROVED_DIR: path.join(DATA_ROOT, 'uploads', 'approved'),
  DB_PATH: path.join(DATA_ROOT, 'data', 'ocr-data.db'),
  MAX_FILE_SIZE_MB: parseInt(process.env.MAX_FILE_SIZE_MB) || 2,
  ALLOWED_MIME_TYPES: ['image/jpeg', 'image/jpg', 'image/pjpeg', 'image/png', 'image/webp'],
  SESSION_EXPIRY_MS: 24 * 60 * 60 * 1000,
  MAX_UPLOADS_PER_CONTRIBUTOR_PER_HOUR: parseInt(process.env.MAX_UPLOADS_PER_CONTRIBUTOR_PER_HOUR) || 100,
  MAX_UPLOADS_PER_IP_PER_HOUR: parseInt(process.env.MAX_UPLOADS_PER_IP_PER_HOUR) || 100,
  MAX_UPLOADS_PER_IP_PER_MINUTE: parseInt(process.env.MAX_UPLOADS_PER_IP_PER_MINUTE) || 20,
  MAX_STORAGE_MB: parseInt(process.env.MAX_STORAGE_MB) || 1000, // 1GB hard stop
  MAX_PENDING_IMAGES: parseInt(process.env.MAX_PENDING_IMAGES) || 2000,
  REJECTED_RETENTION_MS: 60 * 1000, // Auto-delete rejected images after 1 minute (60s)
  GOOGLE_SERVICE_ACCOUNT_PATH: path.resolve(process.env.GOOGLE_SERVICE_ACCOUNT_PATH || path.join(__dirname, 'google-service-account.json')),
  GOOGLE_DRIVE_FOLDER_ID: process.env.GOOGLE_DRIVE_FOLDER_ID || '',
  ADMIN_USERNAME: process.env.ADMIN_USERNAME || 'admin',
  ADMIN_PASSWORD_HASH: process.env.ADMIN_PASSWORD_HASH || '',
  CONTRIBUTOR_SECRET: process.env.CONTRIBUTOR_SECRET || 'ocr_contrib_sec_2026_8f92ab3c4e1d5a7b8c9d0e1f',
};
