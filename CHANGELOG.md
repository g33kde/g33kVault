# Changelog

## [Unreleased]

### "Enable Slideshow" toggle

- New checkbox in /admin's Playback Settings. Turning it off does two things live,
  pushed over the existing WebSocket with no reload needed: `/slideshow` shows "Slideshow
  is currently disabled" instead of the normal rotation (matching the visual style of
  the existing "Waiting for the first upload…" empty state), and the "Launch Slideshow"
  button on the main page (`/`) turns into plain non-clickable text reading "Slideshow
  currently disabled" in the same spot. Defaults to enabled, so existing deployments are
  unaffected. Verified with three real browser tabs open at once (Host, Slideshow, and
  Admin) — toggling the checkbox in Admin updated both of the other already-open tabs
  immediately, and toggling back on correctly resumed the slideshow showing real content
  again, not just an empty non-error state.

### Guest-uploaded archives with admin review

- `/upload` now accepts `.zip`, `.tar.gz`, and `.rar` (not `.7z` — that stays exclusive
  to the admin-only watched import folder, by choice), for a guest with a whole folder
  of photos rather than picking them one at a time. Concept and every open design
  question (per-photo vs. whole-batch approval, what happens on rejection, where the
  review UI lives, synchronous vs. background extraction, archive size limit) were
  discussed and decided before any code was written.
- Unlike a normal upload, an archive doesn't go straight to the live slideshow: the
  guest gets an immediate "received, being processed" response (extraction happens in
  the background after, reusing the exact same code the watched import folder already
  uses — not while their connection is held open, which matters on a large archive over
  mobile data), and every photo/video extracted from it lands in a review queue instead
  of the gallery, grouped with the rest of that archive as one batch.
- New "📦 Pending Uploads" row in /admin's Gallery Tools — unlike the other rows, this
  one loads automatically (rather than waiting for a scan click) and stays live via a
  new `media:pending` broadcast, since an unreviewed batch is time-sensitive during a
  live event in a way "run a duplicate scan when convenient" isn't. Each batch shows its
  original archive filename, uploader name if given, and a thumbnail grid, with
  **Approve All** (goes live, quietly entering normal rotation — deliberately *not* the
  "New Upload" highlight badge, since approving dozens of photos at once would otherwise
  mean dozens of disruptive highlights back to back) and **Reject All** (permanently
  deleted immediately, same as every other delete in this app, with a confirmation
  dialog naming the count).
- New `MediaRow.status` (`'pending'` | `'approved'`, undefined treated as approved so
  every existing row is unaffected) and `batchId`/`batchLabel` fields. A new
  `getApprovedMedia()` is the single filter point every public/live-facing read goes
  through — `GET /api/media` (slideshow, host stats, admin's own gallery grid) and the
  other admin scan tools (duplicates, photo dates, low-resolution) all now operate on
  approved media only, so a pending photo can't leak into the public gallery or get
  flagged by another tool before it's reviewed.
- Archives get their own size limit, `MAX_ARCHIVE_SIZE_MB` (default 500 MB), separate
  from `MAX_FILE_SIZE_MB` for a single photo/video, since a compressed multi-photo dump
  is reasonably much bigger than any one file.
- A real bug found during testing: approving a batch initially only reached the public
  slideshow — the admin's own Photo Gallery grid kept showing the old count until a
  manual reload, because it only listened for `media:new`, not the new quieter
  `media:approved`. Fixed by adding the same live-insert handler there.
- Verified end-to-end with real archives built and uploaded through the actual public
  endpoint (not just unit-level calls): a real `.zip` and a real `.tar.gz`, each
  extracted, hashed, and correctly hidden from `/api/media` and the Event Statistics
  panel while pending; a byte-identical duplicate of an already-approved photo
  confirmed absent from the duplicate scan while pending and correctly detected the
  moment it's approved (proving the approved-only filtering is real, not just always
  finding nothing); approve and reject both exercised through the real admin UI in a
  browser, including the Photo Gallery grid updating live; oversized-archive rejection;
  and `.7z` correctly refused by this endpoint. `.rar` creation tooling wasn't available
  to build a genuine test fixture (same pre-existing gap as the watched import folder),
  but the accept path and graceful-failure-on-a-corrupt-file path were both confirmed.

### Photo viewer popup with prev/next in /admin

- Clicking a photo in the main Photo Gallery grid now opens a dedicated popup window
  (via `window.open()` with explicit size/chrome flags — the standard way to request a
  separate window rather than a tab, though browsers ultimately treat this as a
  preference, not a guarantee) instead of a plain new tab. Clicking the photo inside
  that window closes it. Left/right arrows step to the previous/next photo, in the same
  newest-first order the admin grid shows, without closing the window; they're hidden
  at the first/last photo rather than wrapping around, by choice. New standalone
  `/photo-viewer` route/page, reusing the already-public `/api/media` endpoint (no new
  auth surface — the same photo list is already exposed via the public slideshow page).
  Scoped to the main Photo Gallery only, by choice — Duplicate Photos stays as-is
  (no click-through), Low-Resolution Photos keeps its existing plain new-tab click.
- Verified end-to-end with a real running instance: the popup opens showing the
  clicked photo, has no left arrow on the newest (first) photo, steps correctly through
  all photos via the right arrow, correctly loses the right arrow on the oldest (last)
  photo rather than wrapping, and clicking the photo closes the popup while leaving the
  admin tab untouched.

### Fix: duplicate/photo-date scans could freeze the entire server on a large uncached file

- Root cause of a real report ("shows 1%, never changes until it's finished" on a
  repeat scan that should have been mostly cached): `computeContentHash` read the
  whole file into memory and hashed it with `fs.readFileSync` — fully synchronous, zero
  `await`. For one large uncached video or photo (e.g. an older file that predates
  content-hash backfilling), this blocks Node's entire event loop for however long that
  single read+hash takes — not just this feature's own progress display, but *every*
  other request and socket the server is handling, for the same duration.
- Now streams the file through a `crypto.createHash` update loop instead, so the
  read+hash no longer monopolizes the event loop. Verified two ways: correctness (the
  streamed hash matches real `shasum -a 256` byte-for-byte, and duplicate detection
  still correctly groups identical files) and the actual fix (hashing a ~2GB file while
  firing 8 separate concurrent requests throughout — previously all 8 would have queued
  behind the ~3-second synchronous block and landed together at the end; now every one
  responded promptly, 6-351ms, throughout the whole operation).
- Worth being upfront about the remaining limitation: this stops one huge file from
  freezing the whole app, but the duplicate scan's own percentage will still hold at
  that file's position while it's specifically being hashed — an accurate reflection of
  "working on this one item," not a bug, just not more granular than per-item. If a scan
  is still dominated by one or two big files after this fix, sub-item progress (e.g.
  bytes hashed so far) would be the next thing to add, but wasn't built here since it's
  a separate, larger change.

### Fix: scan progress bars showing a literal "0%" for a long stretch on large galleries

- All five progress percentages in /admin (Duplicate Photos scan and delete-all, Photo
  Dates scan, Low-Resolution Photos scan and delete-all) used plain `Math.round`, which
  rounds down to a literal "0%" until enough items have been processed to cross the
  0.5% mark — on a 1000-photo gallery, that's the first 4 items. Technically accurate,
  but reads as "stuck" rather than "just started", which is exactly what got reported.
  Now floors the display at 1% as soon as any real progress exists (item 1 of 1000
  shows "1%", not "0%"). Verified on a real 300-item scan with no cached hashes yet
  (forcing genuine per-item work): the first percentage shown is now 1%, climbing
  through 11%, 37%, 61%, 85% before completing — previously the first several items
  would have all displayed "0%".

### Configurable resolution threshold for Low-Resolution Photos

- The scan threshold was previously fixed at 160×120. Now a "Resolution threshold"
  dropdown in the Low-Resolution Photos row offers named presets — Tiny thumbnails
  (160×120), Old VGA (640×480), SD (854×480), HD-ready (1280×720) — plus a Custom
  option with two width/height number inputs for any exact value, defaulting to
  Custom at 320×280. Changing the threshold clears any results already on screen
  (they were computed under the old threshold) rather than leaving a stale count
  displayed next to a newly-selected value.
- Worth calling out: 160×120 only catches literal thumbnail-sized accidents. A photo
  that's merely SD-quality (e.g. 640×480 or 854×480) will still look visibly soft
  blown up fullscreen on a modern TV or projector — which is presumably how this
  slideshow actually gets displayed — but wouldn't trip a 160×120 check at all. The
  HD-ready (1280×720) preset is a closer match to "looks bad on the big screen"
  specifically, if that's the goal rather than just clearing out true thumbnails.
- The delete-all endpoint takes the same threshold query params as the scan (rather
  than a hardcoded default), so it always deletes against whatever was actually just
  scanned. Verified against 10 real test images spanning every preset boundary (100×75
  up to 1600×900): each preset flags exactly the expected set, including the
  orientation-independent "either edge" rule correctly catching a wide-but-short image
  (854×480) under the VGA preset even though its long edge exceeds 640 — its short
  edge (480) still qualifies.

### Click a photo in /admin to open it full-size in a new tab

- Originally just the main Photo Gallery grid, now also the Low-Resolution Photos
  results (by request) — Duplicate Photos results are still unaffected. Videos are
  unchanged everywhere — they keep their native click-to-play/pause controls rather
  than being wrapped in a link, which would have broken them. The existing
  rotate/delete overlay buttons still work exactly as before in both places; verified
  they don't trigger the new link (they're siblings of it, not inside it) and that
  clicking a photo opens a real new tab at the image's actual URL without navigating
  the admin page away.

### Low-resolution photo detection in /admin

- New "Low-Resolution Photos" row in Gallery Tools, alongside Duplicate Photos and
  Photo Dates: scans every image's actual pixel dimensions (via `sharp`, already a
  project dependency) and lists anything at or below 160×120 — usually a thumbnail, a
  resized re-upload, or a screenshot rather than the original camera photo. Each
  flagged photo shows its real resolution; a "Delete All Low-Resolution Photos (N)"
  button removes all of them in one batch after a confirmation naming the count,
  mirroring the Duplicate Photos delete-all (same reasoning: the server recomputes the
  flagged set itself rather than trusting a client-supplied list, so a stale request
  can't delete a photo that's no longer actually low-res).
- The threshold check is orientation-independent by design: a photo's shorter edge is
  checked against 120px and its longer edge against 160px, regardless of portrait vs.
  landscape — a naive width<=160/height<=120 check on raw stored dimensions would
  incorrectly flag a perfectly good 120×160 portrait photo (same pixel count as an
  ordinary 160×120 landscape one, just rotated). Confirmed with deliberately
  constructed test images: a 160×120 image (and its 120×160 portrait equivalent) sits
  exactly on the line and is correctly flagged ("at or below"), 161×121 is not, and a
  normal 1080×1920 portrait phone photo is correctly left alone.
- Dimensions aren't cached — re-read fresh on every scan (cheap, header-only, no full
  decode) rather than stored on the row, so a later rotation (which swaps width/height)
  can't leave a stale flag behind.

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
