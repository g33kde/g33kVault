import fs from 'fs';
import os from 'os';
import path from 'path';
import { randomUUID } from 'crypto';
import type { Server as SocketIOServer } from 'socket.io';
import { config } from './config';
import { insertMedia, MediaRow } from './db';
import { kindForExt, mimeForExt, isHeic } from './mediaTypes';
import { convertHeicToJpeg } from './heicConvert';
import { archiveKindFor, extractArchive, findArchiveVolumeParts, isJunkArchiveEntry } from './archiveExtract';
import { computeContentHash, computePerceptualHash } from './duplicateDetect';
import { extractPhotoTakenAt } from './photoDate';

// Skip files newer than this so a still-in-progress copy (e.g. from a USB
// stick or network share) isn't imported half-written.
const SETTLE_MS = 5000;

function collectFiles(dir: string): string[] {
  const results: string[] = [];
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return results;
  }
  for (const entry of entries) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      results.push(...collectFiles(full));
    } else if (entry.isFile()) {
      results.push(full);
    }
  }
  return results;
}

// Guards against a slow scan (e.g. converting several large HEIC files on a
// Pi) still running when the next periodic scan is due to start.
let scanning = false;

export async function scanImportFolder(io: SocketIOServer): Promise<number> {
  if (scanning) return 0;
  scanning = true;

  try {
    return await runScan(io);
  } finally {
    scanning = false;
  }
}

// Moves one already-settled media file into MEDIA_DIR, converting HEIC to
// JPEG along the way, and registers it. Returns false (without touching the
// file) if its extension isn't a recognized media type — used for both
// files dropped directly into the import folder and files pulled out of an
// extracted archive.
async function importSingleFile(srcPath: string, io: SocketIOServer): Promise<boolean> {
  const ext = path.extname(srcPath).toLowerCase();
  const kind = kindForExt(ext);
  if (!kind) return false;

  let destFilename = `${randomUUID()}${ext}`;
  let destPath = path.join(config.mediaDir, destFilename);

  try {
    fs.renameSync(srcPath, destPath);
  } catch {
    // Import and media dirs can be different mounts (bind mount vs.
    // named volume) — rename() fails cross-device, so fall back.
    fs.copyFileSync(srcPath, destPath);
    fs.unlinkSync(srcPath);
  }

  let mimeType = mimeForExt(ext) ?? 'application/octet-stream';

  // Read before any HEIC conversion below, which re-encodes the file and
  // carries no EXIF forward at all — see photoDate.ts.
  const photoTakenAt = kind === 'image' ? await extractPhotoTakenAt(destPath) : null;

  if (isHeic(ext)) {
    const jpegFilename = destFilename.replace(/\.[^.]+$/, '.jpg');
    const jpegPath = path.join(config.mediaDir, jpegFilename);
    await convertHeicToJpeg(destPath, jpegPath);
    destFilename = jpegFilename;
    destPath = jpegPath;
    mimeType = 'image/jpeg';
  }

  const media: MediaRow = {
    id: randomUUID(),
    filename: destFilename,
    original_name: path.basename(srcPath),
    mime_type: mimeType,
    kind,
    size: fs.statSync(destPath).size,
    // When this was added to the vault, not the original file's mtime (which
    // for an imported photo is usually its capture date, sometimes months
    // old) — otherwise imported photos would sort by that old date instead
    // of appearing alongside other recently-added photos in the admin grid,
    // same as an upload does.
    created_at: Date.now(),
    photo_taken_at: photoTakenAt,
    content_hash: computeContentHash(destPath),
    phash: kind === 'image' ? await computePerceptualHash(destPath) : null,
  };

  insertMedia(media);
  io.emit('media:new', media);
  return true;
}

// Extracts an archive (or, for a split 7z, every one of its sibling
// volumes) to a scratch directory, imports every recognized media file
// found inside (skipping junk like macOS AppleDouble sidecar files), then
// removes the scratch directory and, on success, the archive itself — every
// volume of it, for a split 7z — so re-scanning the import folder doesn't
// re-extract and duplicate everything on the next pass. If extraction
// itself fails (a corrupt archive, or a split one still missing a volume),
// all of it is left in place and retried on the next scan; a failure
// importing one file inside an otherwise-good archive is logged and
// skipped without blocking the rest.
async function importArchive(archivePath: string, io: SocketIOServer): Promise<number> {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'g33kvault-import-'));
  let imported = 0;

  try {
    await extractArchive(archivePath, tempDir);

    for (const extractedPath of collectFiles(tempDir)) {
      if (isJunkArchiveEntry(extractedPath)) continue;
      try {
        if (await importSingleFile(extractedPath, io)) imported++;
      } catch (err) {
        console.error(`Failed to import ${extractedPath} from archive ${archivePath}:`, err);
      }
    }

    for (const part of findArchiveVolumeParts(archivePath)) {
      fs.unlinkSync(part);
    }
  } catch (err) {
    console.error(`Failed to extract archive ${archivePath}:`, err);
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }

  return imported;
}

async function runScan(io: SocketIOServer): Promise<number> {
  fs.mkdirSync(config.importDir, { recursive: true });
  fs.mkdirSync(config.mediaDir, { recursive: true });

  let imported = 0;

  for (const srcPath of collectFiles(config.importDir)) {
    try {
      // A split archive's later volumes get deleted as a side effect of
      // processing its first volume (.001), earlier in this same loop —
      // collectFiles() already returned them by then, so skip silently
      // rather than logging a spurious "failed to import" for a file
      // that's already been handled.
      if (!fs.existsSync(srcPath)) continue;

      const archiveKind = archiveKindFor(srcPath);
      const ext = path.extname(srcPath).toLowerCase();
      if (!archiveKind && !kindForExt(ext)) continue;

      if (archiveKind) {
        // For a split 7z, every volume needs to exist and have individually
        // settled — not just the first one — before extraction starts.
        const volumeParts = findArchiveVolumeParts(srcPath);
        const allSettled = volumeParts.every((part) => {
          if (!fs.existsSync(part)) return false;
          return Date.now() - fs.statSync(part).mtimeMs >= SETTLE_MS;
        });
        if (!allSettled) continue;

        imported += await importArchive(srcPath, io);
        continue;
      }

      const stat = fs.statSync(srcPath);
      if (Date.now() - stat.mtimeMs < SETTLE_MS) continue;
      if (await importSingleFile(srcPath, io)) imported++;
    } catch (err) {
      console.error(`Failed to import ${srcPath}:`, err);
    }
  }

  if (imported > 0) {
    console.log(`Imported ${imported} file(s) from ${config.importDir}`);
  }

  return imported;
}
