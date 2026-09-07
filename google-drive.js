const { google } = require('googleapis');
const fs = require('fs');
const path = require('path');
const config = require('./config');

let driveClient = null;
let activeFolderId = null;
let activeClientEmail = null;
let activePrivateKey = null;

function cleanPrivateKey(key) {
  if (!key) return '';
  let cleaned = key.trim();
  // Handle escaped newlines from text inputs or json
  if (cleaned.includes('\\n')) {
    cleaned = cleaned.replace(/\\n/g, '\n');
  }
  return cleaned;
}

function createDriveClient(clientEmail, privateKey) {
  const formattedKey = cleanPrivateKey(privateKey);
  const auth = new google.auth.GoogleAuth({
    credentials: {
      client_email: clientEmail.trim(),
      private_key: formattedKey,
    },
    scopes: [
      'https://www.googleapis.com/auth/drive.file',
      'https://www.googleapis.com/auth/drive.readonly',
    ],
  });
  return google.drive({ version: 'v3', auth });
}

function initialize(customConfig = null) {
  let folderId = null;
  let clientEmail = null;
  let privateKey = null;

  if (customConfig && customConfig.client_email && customConfig.private_key && customConfig.folder_id) {
    folderId = customConfig.folder_id.trim();
    clientEmail = customConfig.client_email.trim();
    privateKey = customConfig.private_key.trim();
  } else {
    // Check database settings
    try {
      const db = require('./database');
      const dbFolderId = db.getSetting('drive_folder_id');
      const dbEmail = db.getSetting('drive_client_email');
      const dbKey = db.getSetting('drive_private_key');
      if (dbFolderId && dbEmail && dbKey) {
        folderId = dbFolderId.trim();
        clientEmail = dbEmail.trim();
        privateKey = dbKey.trim();
      }
    } catch {
      // database might not be initialized yet
    }

    // Fall back to environment file if not found in database
    if (!clientEmail || !privateKey || !folderId) {
      const saPath = config.GOOGLE_SERVICE_ACCOUNT_PATH;
      const envFolderId = config.GOOGLE_DRIVE_FOLDER_ID;

      if (saPath && fs.existsSync(saPath) && envFolderId) {
        try {
          const keyData = JSON.parse(fs.readFileSync(saPath, 'utf-8'));
          clientEmail = keyData.client_email;
          privateKey = keyData.private_key;
          folderId = envFolderId;
        } catch (err) {
          console.error('[Drive] Error reading service account file:', err.message);
        }
      }
    }
  }

  if (!folderId || !clientEmail || !privateKey) {
    console.log('[Drive] Google Drive is not configured. Sync is disabled.');
    driveClient = null;
    activeFolderId = null;
    activeClientEmail = null;
    activePrivateKey = null;
    return false;
  }

  try {
    driveClient = createDriveClient(clientEmail, privateKey);
    activeFolderId = folderId;
    activeClientEmail = clientEmail;
    activePrivateKey = privateKey;
    console.log(`[Drive] Initialized successfully for email: ${clientEmail}`);
    return true;
  } catch (err) {
    console.error('[Drive] Failed to initialize:', err.message);
    driveClient = null;
    activeFolderId = null;
    activeClientEmail = null;
    activePrivateKey = null;
    return false;
  }
}

function isConfigured() {
  return driveClient !== null && !!activeFolderId;
}

function getConfigStatus() {
  return {
    configured: isConfigured(),
    folder_id: activeFolderId || '',
    client_email: activeClientEmail || '',
    has_private_key: !!activePrivateKey,
  };
}

async function testConnection({ client_email, private_key, folder_id }) {
  if (!client_email || !client_email.trim()) {
    throw new Error('ایمیل سرویس گوگل (Client Email) را وارد کنید.');
  }
  if (!private_key || !private_key.trim()) {
    throw new Error('کلید اختصاصی (Private Key) را وارد کنید.');
  }
  if (!folder_id || !folder_id.trim()) {
    throw new Error('شناسه پوشه Google Drive را وارد کنید.');
  }

  const testEmail = client_email.trim();
  const testFolderId = folder_id.trim();
  const testClient = createDriveClient(testEmail, private_key);

  try {
    const res = await testClient.files.get({
      fileId: testFolderId,
      fields: 'id, name, mimeType',
      supportsAllDrives: true,
    });

    if (res.data.mimeType !== 'application/vnd.google-apps.folder') {
      throw new Error('شناسه وارد شده مربوط به یک پوشه نیست.');
    }

    return {
      success: true,
      folderName: res.data.name,
      folderId: res.data.id,
      clientEmail: testEmail,
    };
  } catch (err) {
    if (err.code === 404) {
      throw new Error(`پوشه با شناسه "${testFolderId}" در گوگل درایو یافت نشد یا دسترسی داده نشده است. لطفاً مطمئن شوید پوشه را با ایمیل ${testEmail} به عنوان Editor به اشتراک گذاشته‌اید.`);
    }
    if (err.code === 403) {
      throw new Error(`دسترسی غیرمجاز. لطفاً در گوگل درایو دسترسی ویرایشگر (Editor) را به ایمیل ${testEmail} اعطا کنید.`);
    }
    if (err.message && err.message.includes('DEK-Info')) {
      throw new Error('فرمت کلید اختصاصی نامعتبر است.');
    }
    throw new Error('خطا در اتصال به Google Drive: ' + (err.message || 'خطای نامشخص'));
  }
}

async function syncImageToDrive(localPath, filename, mimeType) {
  if (!driveClient || !activeFolderId) {
    throw new Error('Google Drive پیکربندی نشده است.');
  }

  const fileMetadata = {
    name: filename,
    parents: [activeFolderId],
  };

  const media = {
    mimeType: mimeType || 'image/jpeg',
    body: fs.createReadStream(localPath),
  };

  const response = await driveClient.files.create({
    requestBody: fileMetadata,
    media: media,
    fields: 'id',
    supportsAllDrives: true,
  });

  return response.data.id;
}

async function syncAllApproved(getApprovedUnsynced, setDriveFileId) {
  const unsynced = getApprovedUnsynced();
  let synced = 0;
  let failed = 0;

  for (const image of unsynced) {
    const localPath = path.join(config.APPROVED_DIR, image.filename);
    if (!fs.existsSync(localPath)) {
      console.warn(`[Drive] File not found: ${localPath}`);
      failed++;
      continue;
    }

    try {
      const driveFileId = await syncImageToDrive(localPath, image.filename, image.mime_type);
      setDriveFileId(image.id, driveFileId);
      synced++;
      // Small delay to avoid rate limiting
      await new Promise(r => setTimeout(r, 300));
    } catch (err) {
      console.error(`[Drive] Failed to sync ${image.filename}:`, err.message);
      failed++;
    }
  }

  return { synced, failed };
}

module.exports = {
  initialize,
  isConfigured,
  getConfigStatus,
  testConnection,
  syncImageToDrive,
  syncAllApproved,
};
