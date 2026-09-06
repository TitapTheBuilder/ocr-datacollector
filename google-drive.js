const { google } = require('googleapis');
const fs = require('fs');
const path = require('path');
const config = require('./config');

let driveClient = null;

function initialize() {
  const saPath = config.GOOGLE_SERVICE_ACCOUNT_PATH;
  const folderId = config.GOOGLE_DRIVE_FOLDER_ID;

  if (!saPath || !fs.existsSync(saPath) || !folderId) {
    console.log('[Drive] Service account or folder ID not configured. Drive sync disabled.');
    return false;
  }

  try {
    const key = JSON.parse(fs.readFileSync(saPath, 'utf-8'));
    const auth = new google.auth.GoogleAuth({
      credentials: key,
      scopes: ['https://www.googleapis.com/auth/drive.file'],
    });
    driveClient = google.drive({ version: 'v3', auth });
    console.log('[Drive] Initialized successfully.');
    return true;
  } catch (err) {
    console.error('[Drive] Failed to initialize:', err.message);
    return false;
  }
}

function isConfigured() {
  return driveClient !== null;
}

async function syncImageToDrive(localPath, filename, mimeType) {
  if (!driveClient) throw new Error('Google Drive not configured');

  const fileMetadata = {
    name: filename,
    parents: [config.GOOGLE_DRIVE_FOLDER_ID],
  };

  const media = {
    mimeType: mimeType || 'image/jpeg',
    body: fs.createReadStream(localPath),
  };

  const response = await driveClient.files.create({
    resource: fileMetadata,
    media: media,
    fields: 'id',
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

module.exports = { initialize, isConfigured, syncImageToDrive, syncAllApproved };
