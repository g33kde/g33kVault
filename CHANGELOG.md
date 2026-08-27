# Changelog

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
