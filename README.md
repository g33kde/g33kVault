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

- **Server**: Node.js, TypeScript, Express, Socket.IO, Multer for uploads
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
lightweight way to clean up after the fact: `/admin` shows every photo/video as a grid
with a delete button on each, plus a control for the slideshow speed (see
[Configuration](#configuration-env-vars) below). Deleting removes the file from disk,
drops it from the metadata store, and broadcasts live over the same WebSocket as uploads
— so it disappears from an open slideshow immediately, mid-event, without a page refresh.

`/admin` is gated by a single shared password, set via the `ADMIN_PASSWORD` environment
variable (copy `.env.example` to `.env` and fill it in — `.env` is picked up automatically
by `docker compose` and is gitignored). **Leaving it unset disables `/admin` entirely**
rather than defaulting to open — deletion always returns "invalid password" until a
password is configured. The password is entered once and kept in the browser's session
storage (cleared when the tab closes), so it isn't re-entered on every visit.

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

## Running on a Raspberry Pi

Runs natively on a Pi — no native npm modules in this project need cross-compiling, and
`node:20-alpine` (the base image) is multi-arch, so Docker pulls the correct `arm64`/`armv7`
layers automatically.

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
slideshow interval. Newly uploaded items are inserted right after whatever is currently
showing, so they appear on the wall within one slide.

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

## Event statistics

The upload page (`/upload`) shows a small live "EVENT STATISTICS" panel below the
upload controls: photo count, video count, contributors, total storage used, and how
long the server's been running. It's served from `GET /api/stats` and updates live —
the same `media:new`/`media:deleted` WebSocket events that drive the slideshow also
trigger a stats refresh here, so the numbers move as guests upload without a page
reload.

**Contributors is a hardcoded placeholder (`107`)**, not a real count — uploads are
anonymous (see below), so there's currently no way to identify a unique uploader.
Wiring up a real count needs an actual contributor-identity mechanism first (e.g. the
name/caption field below, or something IP-based, which is unreliable behind shared
event Wi-Fi/NAT).

## Notes / ideas for later

- Still no pre-upload approval queue by design — uploads go live instantly, and
  moderation is after-the-fact via `/admin` (see [Moderation](#moderation)).
- Uploads are anonymous (no name/caption field) — this is also why the "Contributors"
  stat on `/upload` is a hardcoded placeholder rather than a real count (see
  [Event statistics](#event-statistics)).
- File type is validated by file extension on upload (browsers report inconsistent
  MIME types for HEIC in particular) — images: jpg/jpeg/png/gif/webp/heic/heif,
  videos: mp4/mov/webm.
- The photo booth's "Burst" mode uploads 4 separate stills rather than compositing an
  animated GIF — avoids pulling in a client-side GIF encoder. Could revisit if an actual
  animated-GIF export is wanted later.
