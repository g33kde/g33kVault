import path from 'path';

const defaultDbPath = path.join(__dirname, '..', 'data', 'g33kvault.json');
const dbPath = process.env.DB_PATH || defaultDbPath;
const mediaDir = process.env.MEDIA_DIR || path.join(__dirname, '..', 'media');

export const config = {
  port: parseInt(process.env.PORT || '3000', 10),
  mediaDir,
  dbPath,
  // Nested *inside* mediaDir (not a sibling directory) so a trashed file is
  // automatically covered by the exact same Docker volume and backup/
  // restore tooling as every other file in mediaDir — no separate volume
  // or backup-script change needed, same reasoning as eventImageDir below
  // but the other direction (this one wants to inherit mediaDir's coverage,
  // eventImageDir deliberately doesn't belong in mediaDir at all).
  trashDir: path.join(mediaDir, '.trash'),
  settingsPath: process.env.SETTINGS_PATH || path.join(__dirname, '..', 'data', 'settings.json'),
  importDir: process.env.IMPORT_DIR || path.join(__dirname, '..', 'import'),
  importScanIntervalMs: parseInt(process.env.IMPORT_SCAN_INTERVAL_MS || '60000', 10),
  // Holds exactly one file at a time — the admin-uploaded event logo/graphic
  // shown in the slideshow's corner (see routes/eventImage.ts). Deliberately
  // not part of MEDIA_DIR/db.json: it's an admin-only branding asset, not a
  // guest photo, so it doesn't belong in the gallery or the duplicate/
  // photo-date/low-res scans. Nested under the *same* directory as
  // dbPath/settingsPath rather than a sibling top-level folder, though —
  // that directory is exactly what Docker Compose's db-data volume mounts,
  // and what the backup/restore scripts and the admin "Download Backup"
  // button already tar up wholesale; a sibling folder outside both
  // media-data and db-data wouldn't persist across a container recreate at
  // all without its own new volume, and wouldn't be covered by either
  // backup path either.
  eventImageDir: process.env.EVENT_IMAGE_DIR || path.join(path.dirname(dbPath), 'event-image'),
  // Capped-resolution copies of photos, generated on demand for the
  // slideshow (see displayCache.ts) — never the source of truth, always
  // regeneratable from the untouched original in mediaDir, so it's fine for
  // this to be plain ephemeral container storage rather than a backed-up
  // volume like mediaDir/dbPath are.
  displayCacheDir: process.env.DISPLAY_CACHE_DIR || path.join(__dirname, '..', 'cache', 'display'),
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
  // A second, separate secret gating the Trash section specifically (see
  // routes/trash.ts) — deliberately independent of adminPassword, so
  // whoever holds the everyday admin password (e.g. a helper running the
  // event) can delete/restore photos but can't view what's in Trash or
  // permanently empty it. Empty/unset disables the Trash section entirely,
  // same "no default-open" reasoning as adminPassword above.
  trashPassword: process.env.TRASH_PASSWORD || '',
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
