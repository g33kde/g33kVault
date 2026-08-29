#!/usr/bin/env bash
# Restores a backup created by scripts/backup.sh into this instance's
# media-data and db-data Docker volumes.
#
# Usage: ./scripts/restore.sh path/to/g33kvault-backup-<timestamp>.tar.gz
#
# Intended for populating a FRESH new instance (empty volumes), e.g. when
# migrating to a new machine — see README "Backup & migration". Restoring
# into an instance that already has real data merges on top of it (tar
# extraction overwrites files present in the backup, but won't delete
# anything the current instance has that the backup doesn't), which is
# rarely what you want, hence the confirmation prompt below.
#
# Must be run from the directory containing docker-compose.yml, same as
# backup.sh, so `docker compose` resolves the correct project volumes.

set -euo pipefail

BACKUP_FILE="${1:-}"

if [ -z "$BACKUP_FILE" ]; then
  echo "Usage: $0 path/to/g33kvault-backup-<timestamp>.tar.gz" >&2
  exit 1
fi

if [ ! -f "$BACKUP_FILE" ]; then
  echo "Error: backup file not found: $BACKUP_FILE" >&2
  exit 1
fi

if [ ! -f docker-compose.yml ]; then
  echo "Error: run this from the g33kVault repo root (docker-compose.yml not found here)." >&2
  exit 1
fi

ABS_BACKUP_FILE="$(cd "$(dirname "$BACKUP_FILE")" && pwd)/$(basename "$BACKUP_FILE")"
BACKUP_DIR="$(dirname "$ABS_BACKUP_FILE")"
BACKUP_NAME="$(basename "$ABS_BACKUP_FILE")"

echo "This will extract '${BACKUP_NAME}' into this instance's media-data and"
echo "db-data volumes, overwriting any files with the same name that already"
echo "exist there. Intended for a fresh, empty instance — not for merging"
echo "into one that already has real uploads."
read -r -p "Continue? [y/N] " CONFIRM
if [ "$CONFIRM" != "y" ] && [ "$CONFIRM" != "Y" ]; then
  echo "Aborted."
  exit 1
fi

echo "Make sure the app isn't running while you restore: docker compose stop"
echo "Restoring..."
docker compose run --rm --no-deps \
  -v media-data:/restore/media \
  -v db-data:/restore/db \
  -v "${BACKUP_DIR}:/in:ro" \
  --entrypoint sh \
  g33kvault \
  -c "tar xzf /in/${BACKUP_NAME} -C /restore/media --strip-components=1 media && \
      tar xzf /in/${BACKUP_NAME} -C /restore/db --strip-components=1 db"

echo "Restore complete. Start the app with: docker compose up -d"
