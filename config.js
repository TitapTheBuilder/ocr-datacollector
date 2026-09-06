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
  MAX_FILE_SIZE_MB: 10,
  ALLOWED_MIME_TYPES: ['image/jpeg', 'image/png', 'image/webp'],
  SESSION_EXPIRY_MS: 24 * 60 * 60 * 1000,
  MAX_UPLOADS_PER_CONTRIBUTOR_PER_HOUR: 30,
  GOOGLE_SERVICE_ACCOUNT_PATH: process.env.GOOGLE_SERVICE_ACCOUNT_PATH || path.join(__dirname, 'google-service-account.json'),
  GOOGLE_DRIVE_FOLDER_ID: process.env.GOOGLE_DRIVE_FOLDER_ID || '',
  ADMIN_USERNAME: process.env.ADMIN_USERNAME || 'admin',
  ADMIN_PASSWORD_HASH: process.env.ADMIN_PASSWORD_HASH || '',
};
