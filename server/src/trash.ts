import fs from 'fs';
import path from 'path';
import { config } from './config';

fs.mkdirSync(config.trashDir, { recursive: true });

// Best-effort, matching every other fs.unlink in this app (routes/media.ts,
// routes/eventImage.ts, ...) — a missing file shouldn't block the metadata
// update that's the actual source of truth for what's in Trash. Uses
// rename (not copy+delete) since both directories live on the same
// filesystem (trashDir is always nested inside mediaDir — see config.ts),
// so this is an instant, atomic move regardless of file size.
export function moveToTrash(filename: string) {
  try {
    fs.renameSync(path.join(config.mediaDir, filename), path.join(config.trashDir, filename));
  } catch (err) {
    console.error(`Could not move ${filename} to trash:`, err);
  }
}

export function restoreFromTrash(filename: string) {
  try {
    fs.renameSync(path.join(config.trashDir, filename), path.join(config.mediaDir, filename));
  } catch (err) {
    console.error(`Could not restore ${filename} from trash:`, err);
  }
}

export function purgeFromTrash(filename: string) {
  fs.unlink(path.join(config.trashDir, filename), () => {});
}
