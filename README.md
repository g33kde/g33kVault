# g33kVault

A live event photo wall. Guests scan a QR code, upload photos/videos from their phone,
and everything shows up instantly in a fullscreen slideshow.

Current version: **0.1.7** — see [CHANGELOG.md](CHANGELOG.md) for version history. If
you're picking this project up fresh (human or agent), also read
[CLAUDE.md](CLAUDE.md) — it has one standing constraint that isn't obvious from the
code alone.

- `/` — host screen: QR code for uploaders + button to launch the slideshow
- `/upload` — mobile-friendly upload page (what the QR code points to)
- `/booth` — in-browser photo booth: countdown, camera capture, auto-upload (see
  [Photo booth](#photo-booth) below)
- `/slideshow` — fullscreen kiosk view, updates live via WebSocket as uploads arrive
- `/admin` — password-protected view to delete photos/videos and adjust slideshow
  speed, shuffle, and transitions

## Stack

- **Server**: Node.js, TypeScript, Express, Socket.IO, Multer for uploads, sharp for
  photo rotation (the project's one deliberate native dependency — see [CLAUDE.md](CLAUDE.md))
- **Client**: React, TypeScript, Vite
- **Storage**: uploaded files on local disk, metadata in a JSON file (no database server needed)

## Local development

Requires Node.js 20+.

```bash
npm install

# terminal 1
npm run dev:server

# terminal 2
npm run dev:client
```

The client dev server (Vite) runs on `http://localhost:5173` and proxies `/api`, `/media`,
and `/socket.io` to the backend on `http://localhost:3000`.

## Production (Docker Compose)

```bash
docker compose up --build
```

The app is served on `http://localhost:3000`. Media files and the metadata JSON file persist
in Docker volumes (`media-data`, `db-data`).

On a phone to scan the QR code, the host machine's IP/hostname needs to be reachable from
the guest's phone (same Wi-Fi network) — the QR code is generated from whatever host/URL
the host screen was loaded with, so open the host page using the machine's LAN IP
(e.g. `http://192.168.1.42:3000`), not `localhost`.

## Moderation

There's no upload approval queue — photos go live on the slideshow instantly, by design
(see [Notes / ideas for later](#notes--ideas-for-later)). What there is instead is a
lightweight way to clean up after the fact: `/admin` shows every photo/video as a grid,
newest upload first, with rotate buttons and a delete button on each photo (delete-only
for videos — see below), plus a control for the slideshow speed (see
[Configuration](#configuration-env-vars) below). Deleting removes the file from disk,
drops it from the metadata store, and broadcasts live over the same WebSocket as uploads
— so it disappears from an open slideshow immediately, mid-event, without a page refresh.

**Rotating a photo** — ↺ (bottom-left, counter-clockwise) and ↻ (bottom-right,
clockwise) — actually re-encodes and overwrites the stored file, not just a CSS flip, so
it's correctly oriented everywhere, including if someone copies the raw files off the Pi
later. Click either repeatedly to keep turning; four clicks in the same direction loops
back to the original orientation. It's image-only (videos don't get the buttons), and
doesn't support GIFs (rotating an animated GIF frame-by-frame isn't implemented). Each
rotation is a lossy JPEG re-encode, so many repeated rotations of the
same photo will slowly degrade its quality — a deliberate trade-off, not a bug. The
change is pushed live over the same WebSocket as everything else, so an already-open
slideshow or admin view picks up the new orientation immediately.

`/admin` is gated by a single shared password, set via the `ADMIN_PASSWORD` environment
variable (copy `.env.example` to `.env` and fill it in — `.env` is picked up automatically
by `docker compose` and is gitignored). **Leaving it unset disables `/admin` entirely**
rather than defaulting to open — deletion always returns "invalid password" until a
password is configured. The password is entered once and kept in the browser's session
storage (cleared when the tab closes), so it isn't re-entered on every visit.

## Duplicate detection

`/admin` has a **🔍 Scan for Duplicates** button that finds two different kinds of
duplicate, shown as separate groups of thumbnails (with the usual delete button on each,
so cleanup is still a manual, deliberate choice — nothing gets auto-deleted):

- **Exact duplicates** — byte-identical files (a SHA-256 content hash), e.g. the same
  photo uploaded twice, or imported twice via the watched folder (which has no
  content-based dedup of its own).
- **Similar photos** — visually near-identical but not byte-identical, via a perceptual
  hash (`dHash`) that's tolerant of re-encoding, quality changes, and resizing but not of
  rotation — a photo and its 90°-rotated copy come out looking like two different
  photos, since orientation is exactly what this hash is sensitive to. Won't catch
  photo-booth burst shots (deliberately different moments of the same scene, not
  encoding variants of one shot) — that's a much harder computer-vision problem this
  doesn't attempt.

Both hashes are computed once, when a photo is created (upload, import, booth capture)
or rotated (rotation changes both the file's bytes and, since it changes orientation,
the perceptual hash) — not recomputed on every scan. Photos that predate this feature
get backfilled automatically the first time you scan, which can take a little while on a
large, long-untouched gallery (one image decode per photo); every scan after that is
fast, since it's just comparing already-known values. Verified end-to-end during
development: an exact copy, a re-saved-at-different-quality copy, and a genuinely
different photo were all sorted into the right (or no) group correctly.

## iPhone photos (HEIC/HEIF)

iPhones often store photos as HEIC, which most non-Apple browsers can't render in an
`<img>` tag — so the slideshow would silently fail to display them on anything but
Safari. g33kVault converts HEIC/HEIF to JPEG server-side on the way in (both on upload
and in the watched import folder), so this isn't a concern regardless of which browser
guests use to upload or which browser/TV renders the slideshow.

The conversion runs via `heic-convert`/`libheif-js`, which is WASM-based — no native
compilation, so it works unmodified on the Pi's ARM CPU the same as on any other
platform.

## Bulk import via a watched folder

Besides uploading through `/upload`, g33kVault also watches a local folder and imports
whatever it finds there — handy for seeding the gallery from an existing folder of photos
without going through the browser at all.

With Docker Compose, that folder is `./import` next to `docker-compose.yml` (a bind mount,
so it's a real folder on the host you can drop files into directly, over Samba/SFTP, from a
USB stick, etc. — created automatically on first `docker compose up`).

- Scanned once on startup, then again every `IMPORT_SCAN_INTERVAL_MS` (default 60s) while
  running — you don't need to restart the container for newly dropped files to show up.
- Imported files are **moved** into the vault's storage (not copied) and removed from the
  import folder, so a scan never re-imports the same file twice. Dropping a duplicate copy
  back in later will import it again as a new item, since there's no content-based dedup.
- A file has to sit untouched for 5 seconds before it's picked up, so a still-in-progress
  copy from a USB stick doesn't get imported half-written.
- Subfolders are scanned too (useful if you want to organize source photos by date/event
  before dropping them in) — the folder structure itself isn't preserved, everything lands
  in the same flat gallery.
- Supported types match uploads: images (jpg/png/gif/webp/heic/heif), videos
  (mp4/mov/webm). HEIC/HEIF (iPhone's default photo format) is converted to JPEG on
  import — see below.

**Archives** — `.zip`, `.tar`, `.tar.gz`/`.tgz`, `.7z`, and `.rar` — dropped into the
import folder are extracted automatically (after the same 5-second settle wait as any
other file), and every recognized photo/video found inside is imported exactly like the
files above, including nested subfolders inside the archive. Non-media files inside an
archive are ignored, as is common junk like macOS's `._`-prefixed AppleDouble sidecar
files, `.DS_Store`, and `__MACOSX/` — confirmed by testing against a real macOS-created
archive, which includes exactly this junk by default. The archive itself is deleted once
its contents are successfully imported, same "moved, not copied" behavior as a plain
file — if extraction fails (a corrupt archive), it's left in place and logged, retried
on the next scan, rather than silently discarded. Extraction uses `adm-zip`, `tar`,
`7z-wasm`, and `node-unrar-js` — all pure JavaScript/WebAssembly, no native compilation
or system binaries needed, keeping this project's zero-native-dependency policy intact
for everything except `sharp` (see [CLAUDE.md](CLAUDE.md)).

## Running on a Raspberry Pi

Runs natively on a Pi — `node:20-alpine` (the base image) is multi-arch, so Docker pulls
the correct `arm64`/`armv7` layers automatically, and the one native dependency this
project has (`sharp`, used for admin photo rotation) ships prebuilt binaries fetched at
install time rather than needing a compiler on the Pi. **It requires a 64-bit
(`arm64`) Raspberry Pi OS**, though — sharp doesn't publish 32-bit ARM (`armv7`)
binaries. Raspberry Pi OS has defaulted to 64-bit on Pi 4/5 for a while now, so this is
usually a non-issue, but worth checking (`uname -m` should print `aarch64`, not `armv7l`)
if you're on an older install.

1. Install Docker on Raspberry Pi OS:

   ```bash
   curl -fsSL https://get.docker.com | sh
   sudo usermod -aG docker $USER
   # log out/in (or reboot) for the group change to take effect
   ```

2. Get the code onto the Pi and build/run it there (building on-device avoids needing a
   multi-arch buildx setup):

   ```bash
   git clone https://github.com/g33kde/g33kVault.git
   cd g33kVault
   docker compose up --build -d
   ```

3. Find the Pi's LAN IP (`hostname -I`) and open `http://<pi-ip>:3000` on the host screen —
   that's what the QR code will encode, so guests' phones need to be on the same Wi-Fi.

**Updating to the latest version**, once it's already set up:

```bash
cd g33kVault
git pull
docker compose up --build -d
```

This rebuilds the image with the new code and recreates the container. Already-imported
photos and metadata are untouched — they live in the `media-data`/`db-data` Docker volumes
and the bind-mounted `import` folder, separate from the app image being rebuilt. Check
`docker compose logs -f` afterwards to confirm it came back up cleanly. If you update often,
`docker image prune -f` afterwards clears out old superseded images so they don't quietly
eat into the SD card's space over time.

To preload photos onto the Pi without going through the upload page, copy them into the
`import` folder created next to `docker-compose.yml` on the Pi (e.g. `scp` from a laptop, a
mounted USB stick, or a Samba share pointed at that folder) — see
[Bulk import via a watched folder](#bulk-import-via-a-watched-folder) above. They're picked
up automatically within a minute; no restart needed.

Hardware guidance:

- A Pi 4 or 5 (2GB+ RAM) is comfortable. The server itself is lightweight — just static
  file serving and a JSON metadata store, no video transcoding — so even a Pi 3 can run
  the backend alone.
- If the Pi also drives the display (e.g. Chromium in kiosk mode showing `/slideshow` on
  an attached screen/TV), prefer a Pi 4/5 for smoother video playback.
- Uploads land on whatever the Docker volume sits on — the SD card is fine for occasional
  event use; use a USB drive instead if you're running this often and want to reduce SD
  card wear.

## Running on x86_64 Linux (VM or bare metal)

Runs the same way as the Pi deployment above, just on more common hardware — a VM (any
hypervisor) or a physical x86_64 machine. If anything, it's a safer target than the Pi:
`sharp` (the one native dependency this project has, used for admin photo rotation) has
mature prebuilt binaries for `linux-x64` on both glibc and musl (Alpine) distros, so
there's none of the 32-bit-vs-64-bit ambiguity that applies on ARM.

1. Install Docker on a fresh install (the script auto-detects and works across most
   Debian/Ubuntu/Fedora-family distros):

   ```bash
   curl -fsSL https://get.docker.com | sh
   sudo usermod -aG docker $USER
   # log out/in (or reboot) for the group change to take effect
   ```

2. Get the code and build/run it:

   ```bash
   git clone https://github.com/g33kde/g33kVault.git
   cd g33kVault
   docker compose up --build -d
   ```

3. Find the machine's LAN IP (`ip addr` or `hostname -I`) and open
   `http://<machine-ip>:3000` on the host screen — that's what the QR code will encode,
   so guests' phones need to be able to reach that IP.

**If this is a VM**, make sure its network adapter is set to **bridged mode**, not the
default NAT mode most hypervisors ship with. A NAT'd VM gets its own private IP that's
typically only reachable from the host machine itself — guests' phones on the same
Wi-Fi won't be able to reach it, even though `docker compose` and everything else works
fine. Bridged mode puts the VM directly on the LAN with its own real IP, same as any
physical machine.

Updating to the latest version and bulk-importing photos work exactly as described in
the [Raspberry Pi section](#running-on-a-raspberry-pi) above — same commands, same
Docker volumes, nothing platform-specific about either of those.

Resource guidance: any modern x86_64 machine is comfortable, even a modest VM (1-2
vCPUs, 1GB+ RAM) — the server itself is lightweight (static file serving + a JSON
metadata store, no video transcoding), and x86_64 hardware is generally faster than the
Pi hardware this project is otherwise documented against.

## Backup & migration

Everything that matters — uploaded photos/videos, their metadata, and admin settings
(slideshow speed, shuffle, transitions) — lives in two Docker volumes: `media-data`
(the files) and `db-data` (`g33kvault.json` + `settings.json`). Migrating to a new
machine, or just taking a backup, means moving those two volumes.

### One-click backup from `/admin`

The simplest option for a quick backup (not a migration — see below for that): `/admin`
has a **⬇ Download Backup** button that streams a `.tar.gz` of both the media files and
the metadata straight to your browser, same format the CLI scripts use (`media/` and
`data/` at the top level). No Docker knowledge needed — the running server already has
direct filesystem access to both, so it just shells out to `tar` locally rather than
going through Docker volumes. Next to the button, a status line shows when the last
backup was taken, its size, and how many items it covered — turning amber if it's more
than 7 days old, or reading "⚠ No backup taken yet" if you've never used it.

### Automated, for migrating to a new machine (`scripts/backup.sh` / `scripts/restore.sh`)

```bash
# On the OLD instance — bundles both volumes into one timestamped tarball:
./scripts/backup.sh                       # writes to ./backups/ by default
./scripts/backup.sh /path/to/somewhere    # or a custom output directory

# Copy the resulting .tar.gz to the new machine however you like
# (scp, USB stick, etc.), then on the NEW instance:
git clone https://github.com/g33kde/g33kVault.git
cd g33kVault
cp .env.example .env   # and fill in ADMIN_PASSWORD — see Moderation above;
                        # this is NOT part of the backup, set it up fresh
./scripts/restore.sh /path/to/g33kvault-backup-<timestamp>.tar.gz
docker compose up -d
```

Both scripts must be run from the repo root (where `docker-compose.yml` lives) — they
use `docker compose run` to reach the project's actual volumes, rather than guessing
Docker's name-prefixing scheme. `backup.sh` reads the volumes read-only and is safe to
run while the app is up, though stopping it first (`docker compose stop`) guarantees a
perfectly consistent snapshot with zero chance of catching an in-progress upload
mid-write. `restore.sh` is for populating a **fresh, empty** instance (a new machine, or
one you've just `docker compose down -v`'d) — it asks for confirmation before writing,
since extracting on top of an instance that already has real data would overwrite files
in the backup without removing anything newer that isn't in it.

Verified end-to-end while writing this: seeded a test instance with photos and custom
settings, ran a backup, wiped the volumes entirely, restored into the empty instance,
and confirmed the photos, metadata, and settings all came back byte-for-byte identical.

### Manual procedure (what the scripts automate)

If you'd rather not use the scripts, or want to back up just one volume, this is the
standard Docker named-volume backup pattern — a throwaway container mounts the volume
and a fresh output location, and tars one into the other:

```bash
# Back up (run from the repo root, app can be running or stopped):
docker compose run --rm --no-deps \
  -v media-data:/backup/media:ro -v db-data:/backup/data:ro -v "$(pwd):/out" \
  --entrypoint sh g33kvault -c "tar czf /out/backup.tar.gz -C /backup media data"

# On the new instance, after `git clone` (do NOT `docker compose up` yet —
# stop after volumes are created if you already have, since restoring
# overwrites, not merges):
docker compose run --rm --no-deps \
  -v media-data:/restore/media -v db-data:/restore/data -v "$(pwd):/in:ro" \
  --entrypoint sh g33kvault -c \
  "tar xzf /in/backup.tar.gz -C /restore/media --strip-components=1 media && \
   tar xzf /in/backup.tar.gz -C /restore/data --strip-components=1 data"

docker compose up -d
```

The two top-level archive folders are named `media` and `data` — deliberately matching
what the `/admin` "Download Backup" button produces (it derives those names from
`MEDIA_DIR`'s and `DB_PATH`'s actual basenames, which default to exactly `media` and
`data`), so a backup taken either way restores the same. If you've customized
`MEDIA_DIR`/`DB_PATH` to different directory names, the button's archive will follow
suit and these commands need adjusting to match.

## Configuration (env vars)

| Variable                  | Default                 | Description                                    |
|---------------------------|--------------------------|-------------------------------------------------|
| `PORT`                    | `3000`                   | Server port                                    |
| `MEDIA_DIR`                | `./media`                | Where uploaded files are stored                |
| `DB_PATH`                  | `./data/g33kvault.json`  | JSON file storing upload metadata              |
| `SETTINGS_PATH`            | `./data/settings.json`   | JSON file storing admin-adjustable settings (e.g. slideshow speed) |
| `IMPORT_DIR`               | `./import`               | Folder watched for bulk-import files           |
| `IMPORT_SCAN_INTERVAL_MS`  | `60000`                  | How often to rescan the import folder (`0` disables periodic rescans, keeping only the startup scan) |
| `MAX_FILE_SIZE_MB`         | `100`                    | Max upload size per file                       |
| `SLIDESHOW_INTERVAL_MS`    | `6000`                   | Initial slideshow image duration — see below   |
| `ADMIN_PASSWORD`           | *(unset)*                | Password for `/admin`; unset disables it entirely |

Videos play to completion (or their natural length) before advancing; images use the
slideshow interval — except a freshly uploaded image, which interrupts immediately (see
[New uploads jump the queue](#new-uploads-jump-the-queue) below). A newly uploaded
*video* is inserted right after whatever is currently showing instead, so it appears on
the wall within one slide without interrupting anything already playing.

`SLIDESHOW_INTERVAL_MS` is only the *initial* value. It's also adjustable live from
`/admin` ("Slideshow speed", in seconds) — that change is persisted (survives restarts,
stored alongside the other app data) and pushed instantly over the same WebSocket to any
slideshow that's already open, no page reload needed. The env var only matters the very
first time the app runs, before any admin change has been saved.

`/admin` also has a **Randomize playback order** toggle — when on, the slideshow shuffles
on load and re-shuffles each time it loops back to the start, instead of always playing
chronologically.

## "Now Showing" transitions

Instead of a plain cut, a short animated transition plays whenever the slideshow moves to
a new photo or video. Pick a style from `/admin`:

- Smooth fade
- Zoom
- Polaroid drop
- Glitch
- Arcade / game-style
- VHS
- Random (a different style picked each slide)
- None (instant cut — the original behavior, and the default)

**🎉 Party Mode** is a separate toggle in `/admin` that overrides the style picker and
randomly chooses a transition for every slide, so the wall keeps surprising people
throughout the event. Like the other slideshow settings, the choice is persisted and
pushed live over the existing WebSocket — it applies to an already-open slideshow
immediately, no reload needed.

## New uploads jump the queue

A freshly uploaded **photo** interrupts the slideshow immediately — whatever's currently
showing gets cut away from right then, not queued to wait its turn. The new photo:

- Plays a normal "Now Showing" transition in, like any other slide.
- Shows a glowing "🆕 New Upload" badge at the top of the screen for the first 5 seconds.
- Stays on screen for 10 seconds total (overriding the configured slideshow speed for
  just this one slide), then the badge fades and the slideshow resumes normally from
  there — whatever it interrupted isn't lost, it just comes back around on its regular
  turn like anything else in the gallery.

**Back-to-back uploads don't interrupt each other.** If a second photo arrives while one
is already being highlighted, it waits in line instead of cutting the first one short —
each queued photo gets its own full, uninterrupted 10-second turn with the badge, in the
order they were uploaded, before the slideshow returns to normal. There's no cap on how
many can queue up this way (e.g. bulk-importing a large batch via the
[watched import folder](#bulk-import-via-a-watched-folder) while the slideshow is running
would play through all of them, one at a time, before resuming normal rotation).

This only applies to photos. A newly uploaded **video** keeps the older, non-interrupting
behavior — inserted to play in its normal turn soon, without cutting away from whatever's
currently on screen — since a video's own length doesn't fit a fixed "shown for 10
seconds" rule the way a photo does.

## Photo booth

`/booth` is an in-browser camera so guests can take a photo directly instead of picking
one from their camera roll — nothing to install, nothing to leave the page for. Point a
QR code at it from the host screen (toggle "📸 Booth QR" on `/`, next to the regular
upload QR).

- **Countdown** — 3…2…1 before each capture.
- **Front/back camera** — a flip button switches between them (falls back gracefully on
  devices/browsers that only expose one).
- **Burst** — captures 4 shots in quick succession instead of one, each uploaded as its
  own gallery item.
- **Frame** — adds a Polaroid-style white border with a randomly picked funny caption.
- **Event overlay** — adds a branded lower-third bar (the g33kVault wordmark + accent
  underline) instead of a full frame.
- **Normal** — just the photo, no decoration.

Captured photos upload automatically through the same `/api/upload` endpoint the regular
upload page uses, so they show up on the slideshow the same way. All of the image
processing (countdown, capture, frame/overlay compositing) happens client-side via
`<canvas>` — no new server dependencies.

## Uploader name

Both `/upload` and `/booth` have an optional "Your name" field — not required, and it's
not a real identity system, just a free-text label. If filled in, it's attached to every
file uploaded in that batch/capture and shown as a small tag in the corner: bottom-right
on the slideshow, top-left on each thumbnail in `/admin` (handy for moderation context —
knowing who to ask about a photo). It's stored as plain metadata alongside the photo, not
burned into the image pixels, so it can be shown, hidden, or changed without touching the
file itself, and it works for videos too (just an overlay, not limited to what can be
drawn onto an image).

The name typed in is remembered in the browser (`localStorage`, shared between `/upload`
and `/booth` — type it once on either page and it carries over to the other) so a guest
doesn't have to retype it if they come back to upload more later in the event. It's local
to that phone/browser, not synced anywhere.

## Event statistics

The upload page (`/upload`) shows a small live "EVENT STATISTICS" panel below the
upload controls: photo count, video count, contributors, total storage used, and how
long the server's been running. It's served from `GET /api/stats` and updates live —
the same `media:new`/`media:deleted` WebSocket events that drive the slideshow also
trigger a stats refresh here, so the numbers move as guests upload without a page
reload.

**Contributors is the count of distinct uploader names** (see
[Uploader name](#uploader-name) above), normalized (trimmed, lowercased) so casing
differences on the same name don't inflate it — not a real headcount, since it's free
text with no identity behind it and anonymous uploads (no name given) aren't counted at
all. Good enough as an approximation; not meant to be exact.

## Notes / ideas for later

- Still no pre-upload approval queue by design — uploads go live instantly, and
  moderation is after-the-fact via `/admin` (see [Moderation](#moderation)).
- Uploads can optionally carry a name (see [Uploader name](#uploader-name)) but it's
  still not a real identity system — no login, nothing to stop someone typing any name
  they like, including someone else's.
- File type is validated by file extension on upload (browsers report inconsistent
  MIME types for HEIC in particular) — images: jpg/jpeg/png/gif/webp/heic/heif,
  videos: mp4/mov/webm.
- The photo booth's "Burst" mode uploads 4 separate stills rather than compositing an
  animated GIF — avoids pulling in a client-side GIF encoder. Could revisit if an actual
  animated-GIF export is wanted later.
- Photo rotation (see [Moderation](#moderation)) doesn't support GIFs — only
  jpg/jpeg/png/webp. Rotating a GIF returns an error rather than corrupting it.
- Only images can be rotated, not videos — rotating a video would need re-encoding it
  (e.g. via ffmpeg), a much heavier dependency than this project otherwise carries.
- `.rar` archive import was implemented and reviewed against `node-unrar-js`'s
  documented API, but — unlike `.zip`/`.tar`/`.tar.gz`/`.7z`, each verified against a
  real archive during development — it couldn't be tested against a genuine `.rar` file
  (no RAR-creation tool was available in that environment). The extraction library
  itself was confirmed to load and run correctly; only a real end-to-end `.rar` drop
  hasn't been. Worth an explicit test with a real `.rar` file before relying on it.
