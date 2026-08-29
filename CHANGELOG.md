# Changelog

## [Unreleased]

### Admin page reorganization

- /admin had grown into a long, undifferentiated stack of controls as features
  accumulated over time. Reorganized into: a "Playback Settings" card (unchanged
  content, just newly grouped); a "Gallery Tools" section where the three occasional
  maintenance actions (Backup & Restore, Duplicate Photos, Photo Dates) are now
  collapsible rows — collapsed by default, each showing a one-line status summary
  ("Last backup 2h ago · 340 MB · 118 items", "3 exact · 1 similar", "Found dates for
  42/118 photos", or "Not scanned yet") and expanding independently to their full
  existing controls/results when clicked; and a "Photo Gallery" card for the item grid.
  No feature, button, or option was removed — purely a layout change. Proposed two
  mockup directions for review before building (sectioned cards vs. collapsible tools);
  the collapsible-tools direction was chosen. Verified end-to-end with a real running
  instance: starts fully collapsed, each row toggles independently of the others, and
  scanning for duplicates through the new collapsed/expanded row still works exactly as
  before with real live results.

### Photo-taken date overlay in the slideshow

- New "📅 Scan Photo Dates" button in /admin, reading each image's EXIF `DateTimeOriginal`
  and `CreateDate` (taking the earlier of the two when they disagree; falling back to
  `ModifyDate` only if neither exists) via `exifr` — a pure-JS library, not a system
  `exiftool` binary, to stay consistent with this project's no-native/no-system-binary
  dependency policy. Shows live progress the same way the duplicate scan does.
- Every photo where a date was found now shows it as a small overlay at the bottom
  center of the slideshow (e.g. "Jul 15, 2024"). Photos with no usable EXIF (screenshots,
  booth captures) simply show nothing.
- Found and worked around a real data-loss gap during development: this app converts
  every HEIC photo (the default iPhone camera format) to JPEG on ingest, and that
  conversion strips 100% of EXIF metadata — verified by round-tripping a real HEIC file
  with known EXIF dates through the app's actual conversion code. Fixed by extracting
  the date from the *original* file before HEIC conversion runs, in both ingestion paths
  (`/api/upload` and the watched import folder), so this works correctly for HEIC
  uploads going forward. It's an unrecoverable gap for anything imported *before* this
  fix, though: the original HEIC bytes are already gone by the time the scan button can
  look, so the backfill can only find a date for photos that happened to arrive as plain
  JPEG (EXIF untouched through this app's pipeline either way). Verified end-to-end: a
  real HEIC file with known EXIF dates uploaded via each path, a plain JPEG upload, an
  import-folder JPEG, a simulated legacy JPEG (backfilled correctly), and a simulated
  legacy HEIC-sourced photo with already-stripped EXIF (correctly finds nothing, doesn't
  error, and isn't re-scanned on a later run).
- `photo_taken_at` needed no changes to the backup/restore path to be covered by it —
  both the admin "Download Backup" button and `scripts/backup.sh` archive the entire
  metadata JSON file as-is (not a curated field list), so any field it holds, this one
  included, is backed up automatically. Verified for real: downloaded an actual backup
  of a gallery with a mix of dated and undated photos, confirmed every `photo_taken_at`
  value survived in the archived JSON untouched, then restored it into a fresh instance
  and confirmed the running server served the same values back out.

### Fix: photos imported via the watched folder appeared at the bottom of /admin instead of the top

- Uploads (web and booth) stamp `created_at` as the moment they're added to the vault,
  and the admin grid sorts newest-`created_at`-first — so a fresh upload always shows up
  at the top. Import-folder photos instead stamped `created_at` as the source file's own
  modification time, which for a real photo dump (SD card export, phone backup) is
  usually the original capture date, sometimes months old — so an imported photo sorted
  by that old date and could land anywhere in the grid, typically near the bottom, no
  matter when it was actually imported. Now uses the same "added to vault" timestamp as
  uploads. Verified with a real photo backdated to a 2025 file mtime dropped into the
  import folder: it now sorts to the top of /admin right alongside a same-session web
  upload, ahead of anything actually older.

### Duplicate-scan progress + one-click bulk cleanup

- The "Scan for Duplicates" button now shows a live percentage (e.g. "Scanning… 52%")
  while a scan is running, instead of just "Scanning…" with no sense of whether it's
  stuck. The server broadcasts progress over the same Socket.IO connection already used
  for live gallery updates as it backfills each photo's hash; verified end-to-end with
  Playwright against a real slow first scan (large, never-before-hashed images), and
  confirmed the percentage does *not* appear on a fast, already-hashed rescan since
  there's no meaningful backfill work left to report progress on.
- New "🗑 Delete All Duplicates (keep one of each)" button on the results, for when a
  scan turns up a lot of duplicates and clicking ✕ on each one individually isn't worth
  it. New `POST /api/admin/duplicates/delete-all` endpoint recomputes the duplicate
  groups server-side, merges every group into connected clusters (a photo can be a
  member of more than one group — an exact-duplicate trio is also a similar-photos
  cluster, and a photo can independently be "similar" to two unrelated others), keeps
  exactly one survivor per cluster (the earliest-uploaded copy), and deletes the rest —
  file and metadata record both — in a single batched DB write, broadcasting live
  progress the same way the scan does.
  - First version of this did the deletions one HTTP request at a time from the
    browser, deciding a survivor per *group* rather than per merged cluster. Both
    choices turned out to be real problems, not just style: every single-item delete on
    the server does a full read-modify-write of the entire JSON metadata file, so a
    gallery with hundreds of duplicates meant hundreds of full-file rewrites in a
    client-side loop with no per-item error handling — one failed request killed the
    whole batch silently, partway through, which is exactly what a real user hit
    ("some photos exist 3 times, there should be only one kept" after clicking the
    button). And deciding survivors per-group rather than per-cluster meant a photo
    picked as the "keeper" in one group could simultaneously be a "delete this" member
    of a different, overlapping group — a real correctness bug, not just a performance
    one. Rewritten as the single batched endpoint above; verified against a 120-item
    gallery (40 duplicated photos + overlapping near-duplicate/exact clusters, 88
    correct deletions) and a 500-item single giant cluster (499 deletions, exactly one
    correct survivor, live progress events confirmed 1-499/499), including the specific
    overlapping-group scenario that broke the old per-group logic.

### Fix: "Scan failed" with no detail on the duplicate-detection scan

- The `/api/admin/duplicates` handler had no top-level error handling — since this
  project runs Express 4 (not 5), an exception thrown inside an `async` route handler
  isn't automatically turned into an HTTP response, so anything unexpected there just
  hung the request instead of failing cleanly, surfacing to the browser as a generic
  "Scan failed" with no way to tell what actually went wrong. Now wrapped in try/catch,
  returning the real error message; verified by feeding it a corrupted metadata file and
  confirming it now responds immediately with a specific, actionable error instead of
  hanging.
- Also hardened the comparison itself: a single malformed perceptual-hash value (however
  it got there) is now logged and skipped rather than aborting the whole scan — verified
  by directly corrupting one entry's hash and confirming the scan still completes and
  correctly ignores just that one.

### Fix: multi-volume .7z archives in the import folder weren't recognized

- A split 7z archive (`name.7z.001`, `name.7z.002`, ...) was silently ignored entirely —
  the extension check only recognized a plain `.7z`. Now recognizes the first volume,
  locates every sibling part, waits for all of them to individually settle (not just
  the first) before extracting, and deletes every volume — not just the first — once
  its contents are imported. Verified against a real multi-volume archive, including
  that a still-copying later volume correctly holds off extraction of the whole set.

### Duplicate photo detection in /admin

- New "🔍 Scan for Duplicates" button, finding both exact duplicates (SHA-256 content
  hash) and visually similar photos (perceptual `dHash`, tolerant of re-encoding/resize
  but not rotation). Results shown as grouped thumbnails with the existing delete
  button on each — review and cleanup stays manual, nothing auto-deletes.
- Hashes are computed once per photo (on upload/import/booth-capture, and recomputed on
  rotation) and cached in the metadata store rather than recomputed on every scan;
  older photos are backfilled automatically the first time a scan runs.
- Found a real grouping bug while testing against actual re-saved copies: excluding
  exact-duplicate members from the similar-photos comparison pool caused a genuine
  near-duplicate to lose its only match partner and vanish from the results entirely.
  Fixed — both passes now run over the full set independently.

### Archive support in the watched import folder

- `.zip`, `.tar`, `.tar.gz`/`.tgz`, `.7z`, and `.rar` files dropped into the import
  folder are now extracted automatically (after the usual 5s settle wait), and every
  recognized photo/video inside — including in nested subfolders — is imported the same
  way a plain dropped file is. The archive is deleted once its contents are
  successfully imported (same "moved, not copied" semantics as before); a corrupt
  archive is left in place and retried on the next scan instead of being silently
  discarded.
- Filters out common archive junk automatically — macOS's `._`-prefixed AppleDouble
  sidecar files, `.DS_Store`, `__MACOSX/` — discovered because a real macOS-created
  `.tar.gz` test fixture actually contained it during development; without this filter
  those would have been misimported as bogus duplicate photos (they share the real
  file's extension).
- New dependencies, all pure JS/WASM (no native compilation, no system binaries):
  `adm-zip`, `tar`, `7z-wasm`, `node-unrar-js`. Each format was verified against a real
  archive built with a real archiver during development, except `.rar` — no RAR-creation
  tool was available to build a test fixture; the library was confirmed to load and run
  correctly, but a genuine end-to-end `.rar` import hasn't been (see README).

### Browser tab favicon

- Added a favicon — a bold green "V" monogram on the app's near-black background,
  matching the brand palette. SVG primary (`client/public/favicon.svg`) with a PNG
  fallback (`favicon-32x32.png`) for browsers that don't support SVG icons. Went
  through a "g" monogram first (matching a mockup direction picked earlier) but
  dropped it after confirming — via an actual rendered screenshot at real favicon
  size — that a single-story "g" reduced to a simple shape is very hard to
  distinguish from "9" at 16px; a plain letterform also risked depending on
  Courier New/Consolas being installed, which isn't guaranteed on every OS. "V"
  avoids both problems.

### Fix: backup/restore archive-folder mismatch

- `scripts/restore.sh` failed with `tar: db: not found in archive` on any
  backup downloaded from the `/admin` button — it expected a `db/` folder
  inside the tarball, but the button's backup (and, it turns out, the CLI's
  own `backup.sh`) actually produces `data/`. Standardized both CLI scripts
  and the README's manual procedure on `data/`, matching what the button
  already produced, so backups from either path now restore via either
  method. Verified end-to-end in both directions.

### One-click backup in /admin

- New "⬇ Download Backup" button on `/admin` — streams a `.tar.gz` of both the media
  files and metadata straight to the browser (server has direct filesystem access, so
  no Docker required, unlike the migration scripts). New status line next to it shows
  the last backup's time/size/item count, turning amber past 7 days old or reading "No
  backup taken yet" if none exists. Backed by two new settings getters/setters
  (`lastBackup`) and broadcast live over the existing WebSocket.

### Backup & migration scripts

- New `scripts/backup.sh` / `scripts/restore.sh`, bundling the `media-data` and
  `db-data` Docker volumes (photos/videos, metadata, admin settings) into a single
  tarball and restoring it on a fresh instance — for moving g33kVault to a new
  machine or just taking a backup. Documented in a new README section, both manual
  and scripted paths. Verified end-to-end: backed up a seeded instance, wiped its
  volumes, restored, confirmed everything (including file bytes) came back identical.

### New photo uploads interrupt the slideshow

- A freshly uploaded photo now cuts the slideshow away from whatever's currently
  showing and plays immediately, with a "🆕 New Upload" badge for the first 5 of its
  10 seconds on screen. Videos keep the previous (non-interrupting, queued) behavior.
- Back-to-back uploads no longer interrupt each other's highlight — a photo that
  arrives while another is already being highlighted queues instead, so each gets its
  own full, uninterrupted 10 seconds in upload order (no cap on queue depth).
- Fixed two bugs found while building the queue: the per-slide timer was keyed on
  `items.length`, so any upload landing in the background (even one just joining the
  queue, not being displayed) reset the currently-highlighted photo's remaining time —
  now keyed on the displayed item's id instead. Also removed a side effect
  (`Array.shift()`) from inside a `setState` updater, which React can invoke more than
  once (e.g. under StrictMode in dev) — was silently dropping a queued photo when it did.

### Docs: x86_64 Linux / VM deployment

- New README section alongside the Raspberry Pi one, with install steps for a fresh
  x86_64 Linux install (VM or bare metal) and a note about bridged vs. NAT networking
  on VMs (guests' phones can't reach a NAT'd VM's IP).

### Clickable "g33kVault" heading

- The brand heading is now a link back to `/` on every page (Host, Upload, Booth,
  Slideshow, Admin — both its logged-out and logged-in views).

### Optional uploader name

- `/upload` and `/booth` both have a new optional "Your name" field, remembered in the
  browser (`localStorage`, shared between the two pages) across visits. Attached to
  every file uploaded/captured as plain metadata (not burned into image pixels), shown
  as a small overlay tag: bottom-right on the slideshow, top-left on each `/admin`
  thumbnail.
- The "Contributors" stat on `/upload` is now wired up to this — count of distinct
  uploader names (normalized so casing doesn't inflate it), replacing the old hardcoded
  placeholder. Still an approximation, not a real headcount (see README).

### Admin: photo rotation, newest-first grid

- `/admin`'s grid now shows newest uploads first instead of chronological order.
- New ↺/↻ rotate buttons in the bottom corners of each photo (counter-clockwise /
  clockwise) — actually re-encode and overwrite the stored file, not a CSS-only flip,
  so the correct orientation holds everywhere, including direct file access. Click
  either repeatedly to keep turning; four clicks the same direction loops back to the
  original orientation. Images only (no videos, no GIFs); each rotation is a lossy
  JPEG re-encode. Pushed live over the existing WebSocket, with cache-busted
  thumbnail/slideshow URLs so already-open views pick up the new orientation
  immediately.
- New dependency: `sharp` — this project's one deliberate exception to its otherwise
  zero-native-dependency policy (chosen over the pure-JS alternative on request).
  Requires a 64-bit (`arm64`) Raspberry Pi OS; see [CLAUDE.md](CLAUDE.md).

### Slideshow: randomized playback, "Now Showing" transitions, Party Mode

- Slideshow can shuffle instead of playing chronologically (`/admin` → "Randomize
  playback order"), re-shuffling each time it loops back to the start.
- Videos start muted (required for autoplay) but now show a "🔇 Tap for sound" overlay;
  tapping it unmutes for the rest of the session.
- New transition when the slideshow moves to a new item: fade, zoom, Polaroid drop,
  glitch, arcade/game-style, VHS, random, or none (default) — chosen from `/admin`.
- 🎉 Party Mode toggle overrides the transition picker and randomly chooses a style per
  slide.

### Photo booth (`/booth`)

- New in-browser camera page: countdown, front/back camera switch, and four capture
  modes (Normal, Burst — 4 shots, Frame — funny caption + Polaroid border, Event overlay
  — branded lower-third bar).
- Captures upload automatically through the existing upload endpoint, so they land on
  the slideshow the same way a regular upload does.
- Host screen (`/`) got a QR toggle to switch the displayed QR/URL between `/upload` and
  `/booth`.

### Event statistics panel on `/upload`

- New live "EVENT STATISTICS" panel on the upload page: photo/video counts, total
  storage used, and server uptime, backed by a new `GET /api/stats` endpoint and
  refreshed live over the existing WebSocket as uploads come in.
- "Contributors" is a hardcoded placeholder (`107`) for now — uploads are anonymous, so
  there's no real way to count unique uploaders yet.

## [0.1.7] — 2026-08-27

First tagged version. Everything below shipped in the initial build-out; grouped by
area rather than by individual commit.

### Core

- Host screen (`/`) with a QR code for uploading, generated from whatever host/URL it
  was loaded with (so it works on any LAN IP without hardcoding one).
- Mobile-friendly upload page (`/upload`) — anonymous, no login, supports selecting and
  uploading multiple files at once (e.g. a whole folder from a desktop browser), with a
  per-file progress counter and success/failure summary.
- Fullscreen kiosk slideshow (`/slideshow`) — one item at a time, images advance on a
  timer, videos play to completion. Updates live over Socket.IO: new uploads, deletions,
  and slideshow-speed changes all apply to an already-open slideshow without a reload.
- Storage: uploaded files on local disk (`MEDIA_DIR`), metadata in a JSON file
  (`DB_PATH`) — no database server needed, deliberately picked for zero native
  dependencies (see Raspberry Pi note below).

### iPhone HEIC/HEIF support

- HEIC/HEIF photos are converted to JPEG server-side on the way in (both regular
  uploads and the watched import folder), since most non-Apple browsers can't render
  HEIC in an `<img>` tag.
- Conversion runs via `heic-convert`/`libheif-js`, which is WASM-based — no native
  compilation, so it works unmodified on the Pi's ARM CPU.
- File-type detection uses file extension, not MIME type, since browsers report HEIC's
  MIME type inconsistently.

### Watched import folder (bulk seeding)

- A folder (`IMPORT_DIR`, bind-mounted to `./import` in Docker Compose) is scanned on
  startup and periodically (`IMPORT_SCAN_INTERVAL_MS`, default 60s) while running.
- Matching files are **moved** into the vault's storage and registered like a normal
  upload, including a live socket broadcast. Subfolders are scanned recursively. A file
  must sit untouched 5s before import, so an in-progress copy isn't grabbed
  half-written. No content-based dedup — re-dropping a file re-imports it.

### Admin / moderation (`/admin`)

- No pre-upload approval queue, by design — uploads go live instantly. Instead,
  `/admin` is an after-the-fact cleanup view: every photo/video as a grid with a delete
  button. Deletion removes the file from disk, drops the metadata row, and broadcasts
  live so it disappears from an open slideshow immediately.
- Gated by a single shared password (`ADMIN_PASSWORD`). **Unset disables `/admin`
  entirely** rather than defaulting open. Password is kept in `sessionStorage` client
  side (cleared on tab close), not a real session/auth system — intentionally
  lightweight for a single-host, single-event use case.
- Slideshow speed is also adjustable from `/admin` (in seconds), persisted to
  `settings.json` (survives restarts) and pushed live over the socket to any open
  slideshow. `SLIDESHOW_INTERVAL_MS` now only seeds the *initial* value.

### Deployment

- Docker Compose, single container, multi-stage build (client build → server build →
  slim runtime image). Runs natively on a Raspberry Pi (`node:20-alpine` is multi-arch;
  the project has zero native/compiled npm dependencies on purpose, after specifically
  moving off `better-sqlite3` and `uuid` early on to avoid node-gyp/Python build issues).
- Update flow on the Pi: `git pull && docker compose up --build -d` — existing photos
  are untouched since they live in Docker volumes/bind mounts separate from the image.

### Notable fixes along the way

- Upload button silently doing nothing after picking a file — the file `<input>` was
  being unmounted once a preview appeared, nulling the ref `handleUpload` read from.
  Fixed by tracking the selected file(s) in React state instead.
- Dropped the `uuid` and `react-router-dom` dependencies (replaced with
  `crypto.randomUUID()` and a one-line path switch respectively) and upgraded `multer`
  to 2.x, closing several `npm audit` findings without pulling in unnecessary version
  churn. One moderate, dev-only `esbuild`/`vite` advisory remains open by choice (fix
  requires a Vite 8 major bump; doesn't affect the shipped production build).

### Known gaps (see README "Notes / ideas for later")

- No content-based dedup on the watched import folder.
- Uploads are anonymous — no name/caption field.
- Videos autoplay muted (browser autoplay policy), no "tap to unmute" affordance yet.
- `/admin`'s auth is a single shared password in session storage, not real accounts —
  fine for the intended single-host/single-event deployment, not for anything more.
