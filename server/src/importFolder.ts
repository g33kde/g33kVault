import fs from 'fs';
import path from 'path';
import { randomUUID } from 'crypto';
import type { Server as SocketIOServer } from 'socket.io';
import { config } from './config';
import { insertMedia, MediaRow } from './db';

const EXT_MIME: Record<string, string> = {
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.png': 'image/png',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.mp4': 'video/mp4',
  '.mov': 'video/quicktime',
  '.webm': 'video/webm',
};

const KIND: Record<string, 'image' | 'video'> = {
  'image/jpeg': 'image',
  'image/png': 'image',
  'image/gif': 'image',
  'image/webp': 'image',
  'video/mp4': 'video',
  'video/quicktime': 'video',
  'video/webm': 'video',
};

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

export function scanImportFolder(io: SocketIOServer): number {
  fs.mkdirSync(config.importDir, { recursive: true });
  fs.mkdirSync(config.mediaDir, { recursive: true });

  let imported = 0;

  for (const srcPath of collectFiles(config.importDir)) {
    try {
      const ext = path.extname(srcPath).toLowerCase();
      const mimeType = EXT_MIME[ext];
      if (!mimeType) continue;

      const stat = fs.statSync(srcPath);
      if (Date.now() - stat.mtimeMs < SETTLE_MS) continue;

      const destFilename = `${randomUUID()}${ext}`;
      const destPath = path.join(config.mediaDir, destFilename);

      try {
        fs.renameSync(srcPath, destPath);
      } catch {
        // Import and media dirs can be different mounts (bind mount vs.
        // named volume) — rename() fails cross-device, so fall back.
        fs.copyFileSync(srcPath, destPath);
        fs.unlinkSync(srcPath);
      }

      const media: MediaRow = {
        id: randomUUID(),
        filename: destFilename,
        original_name: path.basename(srcPath),
        mime_type: mimeType,
        kind: KIND[mimeType],
        size: stat.size,
        created_at: stat.mtimeMs,
      };

      insertMedia(media);
      io.emit('media:new', media);
      imported++;
    } catch (err) {
      console.error(`Failed to import ${srcPath}:`, err);
    }
  }

  if (imported > 0) {
    console.log(`Imported ${imported} file(s) from ${config.importDir}`);
  }

  return imported;
}
