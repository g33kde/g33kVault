#!/usr/bin/env bash
# Bundles g33kVault's two Docker volumes (media-data: uploaded photos/videos,
# db-data: metadata + admin settings JSON) into a single timestamped tarball,
# with top-level archive folders "media" and "data" — deliberately matching
# what the /admin "Download Backup" button produces (server/src/routes/admin.ts
# derives those names from MEDIA_DIR's and DB_PATH's actual basenames, "media"
# and "data" under the default Docker Compose paths), so a backup taken either
# way restores the same. If you've customized MEDIA_DIR/DB_PATH to different
# basenames, the button's archive folder names will follow suit and this
# script's fixed "media"/"data" names (and restore.sh) will need adjusting.
#
# Usage: ./scripts/backup.sh [output-dir]
#   output-dir defaults to ./backups
#
# Must be run from the directory containing docker-compose.yml (or set
# COMPOSE_FILE), since it relies on `docker compose` to resolve the project's
# actual (name-prefixed) volumes rather than guessing them.
#
# Safe to run while the app is up — reads volumes read-only. For a
# perfectly consistent snapshot (no chance of catching an in-progress
# upload), stop the app first: `docker compose stop`.

set -euo pipefail

OUT_DIR="${1:-./backups}"
TIMESTAMP="$(date +%Y%m%d-%H%M%S)"
OUT_FILE="g33kvault-backup-${TIMESTAMP}.tar.gz"

if [ ! -f docker-compose.yml ]; then
  echo "Error: run this from the g33kVault repo root (docker-compose.yml not found here)." >&2
  exit 1
fi

mkdir -p "$OUT_DIR"
ABS_OUT_DIR="$(cd "$OUT_DIR" && pwd)"

echo "Backing up media-data and db-data volumes..."
docker compose run --rm --no-deps \
  -v media-data:/backup/media:ro \
  -v db-data:/backup/data:ro \
  -v "${ABS_OUT_DIR}:/out" \
  --entrypoint sh \
  g33kvault \
  -c "tar czf /out/${OUT_FILE} -C /backup media data"

echo "Backup written to ${ABS_OUT_DIR}/${OUT_FILE}"
