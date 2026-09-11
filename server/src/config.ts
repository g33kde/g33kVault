import path from 'path';

export const config = {
  port: parseInt(process.env.PORT || '3000', 10),
  mediaDir: process.env.MEDIA_DIR || path.join(__dirname, '..', 'media'),
  dbPath: process.env.DB_PATH || path.join(__dirname, '..', 'data', 'g33kvault.json'),
  settingsPath: process.env.SETTINGS_PATH || path.join(__dirname, '..', 'data', 'settings.json'),
  importDir: process.env.IMPORT_DIR || path.join(__dirname, '..', 'import'),
  importScanIntervalMs: parseInt(process.env.IMPORT_SCAN_INTERVAL_MS || '60000', 10),
  // Applies to photos only now — see maxVideoSizeMb below for videos, which
  // need a much higher ceiling.
  maxFileSizeMb: parseInt(process.env.MAX_FILE_SIZE_MB || '100', 10),
  // A compressed multi-photo archive is reasonably much bigger than any
  // single photo — separate, higher ceiling than maxFileSizeMb.
  maxArchiveSizeMb: parseInt(process.env.MAX_ARCHIVE_SIZE_MB || '500', 10),
  // Videos get their own, much higher ceiling — even a couple of minutes of
  // phone footage routinely exceeds a 100MB photo limit. Matches
  // maxArchiveSizeMb's default since both are "the big one" compared to a
  // single photo, though the two are independently configurable.
  maxVideoSizeMb: parseInt(process.env.MAX_VIDEO_SIZE_MB || '500', 10),
  // Initial default only — the live value is adjustable from /admin and
  // persisted in settingsPath, which takes precedence once it exists.
  slideshowIntervalMs: parseInt(process.env.SLIDESHOW_INTERVAL_MS || '6000', 10),
  // Empty/unset disables the admin view entirely rather than defaulting open.
  adminPassword: process.env.ADMIN_PASSWORD || '',
  // Grafana Cloud Loki push credentials — env vars only, never written to
  // settingsPath, same reasoning as adminPassword above: a secret shouldn't
  // live in a file the admin UI's settings form round-trips through. All
  // three (URL + user/instance id + token) travel together since none of
  // them means anything without the other two, so they get the same
  // treatment. See GRAFANA.md for what these actually are and where to get
  // them. The /admin "Grafana Cloud" section only toggles/tests the
  // connection these define — it can't set or reveal them.
  grafanaLokiUrl: process.env.GRAFANA_CLOUD_LOKI_URL || '',
  grafanaLokiUser: process.env.GRAFANA_CLOUD_LOKI_USER || '',
  grafanaCloudToken: process.env.GRAFANA_CLOUD_TOKEN || '',
};
