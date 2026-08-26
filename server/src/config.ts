import path from 'path';

export const config = {
  port: parseInt(process.env.PORT || '3000', 10),
  mediaDir: process.env.MEDIA_DIR || path.join(__dirname, '..', 'media'),
  dbPath: process.env.DB_PATH || path.join(__dirname, '..', 'data', 'g33kvault.json'),
  importDir: process.env.IMPORT_DIR || path.join(__dirname, '..', 'import'),
  importScanIntervalMs: parseInt(process.env.IMPORT_SCAN_INTERVAL_MS || '60000', 10),
  maxFileSizeMb: parseInt(process.env.MAX_FILE_SIZE_MB || '100', 10),
  slideshowIntervalMs: parseInt(process.env.SLIDESHOW_INTERVAL_MS || '6000', 10),
  // Empty/unset disables the admin view entirely rather than defaulting open.
  adminPassword: process.env.ADMIN_PASSWORD || '',
};
