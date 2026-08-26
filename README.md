# g33kVault

A live event photo wall. Guests scan a QR code, upload photos/videos from their phone,
and everything shows up instantly in a fullscreen slideshow.

- `/` — host screen: QR code for uploaders + button to launch the slideshow
- `/upload` — mobile-friendly upload page (what the QR code points to)
- `/slideshow` — fullscreen kiosk view, updates live via WebSocket as uploads arrive

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
| `IMPORT_DIR`               | `./import`               | Folder watched for bulk-import files           |
| `IMPORT_SCAN_INTERVAL_MS`  | `60000`                  | How often to rescan the import folder (`0` disables periodic rescans, keeping only the startup scan) |
| `MAX_FILE_SIZE_MB`         | `100`                    | Max upload size per file                       |
| `SLIDESHOW_INTERVAL_MS`    | `6000`                   | How long each image displays before advancing  |

Videos play to completion (or their natural length) before advancing; images use
`SLIDESHOW_INTERVAL_MS`. Newly uploaded items are inserted right after whatever is
currently showing, so they appear on the wall within one slide.

## Notes / ideas for later

- No moderation queue right now — uploads go live instantly. If needed later, add a
  `status` column to the `media` table and an admin approve/reject view.
- Uploads are anonymous (no name/caption field).
- Videos autoplay muted (browser autoplay policies block unmuted autoplay without a
  user gesture) — could add a "tap to unmute" overlay on the slideshow later.
- File type is validated by file extension on upload (browsers report inconsistent
  MIME types for HEIC in particular) — images: jpg/jpeg/png/gif/webp/heic/heif,
  videos: mp4/mov/webm.
