import fs from 'fs';
import path from 'path';
import sharp from 'sharp';
import { config } from './config';

// Small enough that a page of 100 thumbnails (see routes/config.ts's
// webpageEnabled / client/src/pages/Webpage.tsx) is actually light on
// mobile data — the grid cells themselves never render much larger than
// this even at 2-3x DPI, unlike displayCache.ts's MAX_DISPLAY_DIMENSION
// (2560), which is sized for a fullscreen slideshow, not a grid thumbnail.
const MAX_THUMBNAIL_DIMENSION = 480;

// Same reasoning as displayCache.ts's RESIZABLE_EXTENSIONS: GIF is excluded
// so an animated GIF (Boomerang uploads) doesn't lose its animation, and
// HEIC never persists past ingest anyway.
const RESIZABLE_EXTENSIONS = new Set(['.jpg', '.jpeg', '.png', '.webp']);

// Returns the absolute path of a small cached copy of `filename` suitable
// for a grid thumbnail, generating and caching it on first request. Falls
// back to the original file's path — never modifies or deletes it —
// whenever resizing isn't applicable or fails for any reason, so a corrupt
// or unusual source file still displays instead of erroring out.
export async function getThumbnailPath(filename: string): Promise<string> {
  const sourcePath = path.join(config.mediaDir, filename);
  const ext = path.extname(filename).toLowerCase();
  if (!RESIZABLE_EXTENSIONS.has(ext)) return sourcePath;

  let sourceStat: fs.Stats;
  try {
    sourceStat = fs.statSync(sourcePath);
  } catch {
    return sourcePath;
  }

  const cachePath = path.join(config.thumbnailCacheDir, filename);
  try {
    const cacheStat = fs.statSync(cachePath);
    // Guards against a stale cache after an admin rotate() overwrites the
    // original in place (same filename, new bytes) — mtime comparison is
    // enough since that's the only thing that ever rewrites an existing
    // media file.
    if (cacheStat.mtimeMs >= sourceStat.mtimeMs) return cachePath;
  } catch {
    // No cached copy yet — fall through to generate one.
  }

  try {
    const metadata = await sharp(sourcePath).metadata();
    const { width, height } = metadata;
    if (!width || !height || (width <= MAX_THUMBNAIL_DIMENSION && height <= MAX_THUMBNAIL_DIMENSION)) {
      // Already small enough that resizing would just be a pointless
      // re-encode (and quality loss) — serve the original as-is.
      return sourcePath;
    }

    fs.mkdirSync(config.thumbnailCacheDir, { recursive: true });
    // Write to a temp path and rename into place atomically, so a concurrent
    // request for the same thumbnail can never see a half-written file.
    const tmpPath = `${cachePath}.tmp-${process.pid}-${Date.now()}`;
    await sharp(sourcePath)
      .rotate() // bake EXIF orientation into pixels, same normalization the rotate route already does
      .resize(MAX_THUMBNAIL_DIMENSION, MAX_THUMBNAIL_DIMENSION, { fit: 'inside', withoutEnlargement: true })
      .toFile(tmpPath);
    fs.renameSync(tmpPath, cachePath);
    return cachePath;
  } catch (err) {
    console.error(`Thumbnail cache generation failed for ${filename}:`, err);
    return sourcePath;
  }
}
