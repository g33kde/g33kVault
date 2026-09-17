import fs from 'fs';
import path from 'path';
import sharp from 'sharp';
import { config } from './config';

// Chrome's GPU compositor rasterizes an animated layer (any opacity/transform
// CSS animation, which every slideshow transition style applies to the photo
// element) in tiles — on a full-resolution phone photo (routinely 3000px+ on
// a side) this can leave faint seams at tile boundaries, visible as a few
// evenly-spaced horizontal lines baked right into the image. Not visible in
// Admin (nothing there animates a photo) and not visible in Safari (WebKit
// doesn't tile the same way) or with transitionStyle 'none' (nothing gets
// layer-promoted) — confirmed against the reported symptom before writing
// this. The fix is simply to never hand Chrome a multi-thousand-pixel image
// to animate: cap what the slideshow actually displays.
const MAX_DISPLAY_DIMENSION = 2560;

// GIF is excluded deliberately — animated GIFs would lose their animation if
// piped through sharp's resize, and HEIC never persists past ingest (always
// converted to JPEG first, see heicConvert.ts), so this only ever needs to
// handle the formats media can actually be stored as long-term.
const RESIZABLE_EXTENSIONS = new Set(['.jpg', '.jpeg', '.png', '.webp']);

// Returns the absolute path of a capped-resolution copy of `filename`
// suitable for the slideshow, generating and caching it on first request.
// Falls back to the original file's path — never modifies or deletes it —
// whenever resizing isn't applicable or fails for any reason, so a corrupt
// or unusual source file still displays instead of erroring out.
export async function getDisplayPath(filename: string): Promise<string> {
  const sourcePath = path.join(config.mediaDir, filename);
  const ext = path.extname(filename).toLowerCase();
  if (!RESIZABLE_EXTENSIONS.has(ext)) return sourcePath;

  let sourceStat: fs.Stats;
  try {
    sourceStat = fs.statSync(sourcePath);
  } catch {
    return sourcePath;
  }

  const cachePath = path.join(config.displayCacheDir, filename);
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
    if (!width || !height || (width <= MAX_DISPLAY_DIMENSION && height <= MAX_DISPLAY_DIMENSION)) {
      // Already small enough that resizing would just be a pointless
      // re-encode (and quality loss) — serve the original as-is.
      return sourcePath;
    }

    fs.mkdirSync(config.displayCacheDir, { recursive: true });
    // Write to a temp path and rename into place atomically, so a concurrent
    // request (e.g. this same photo preloading while another tab is also
    // mid-slideshow) can never see a half-written cache file.
    const tmpPath = `${cachePath}.tmp-${process.pid}-${Date.now()}`;
    await sharp(sourcePath)
      .rotate() // bake EXIF orientation into pixels, same normalization the rotate route already does
      .resize(MAX_DISPLAY_DIMENSION, MAX_DISPLAY_DIMENSION, { fit: 'inside', withoutEnlargement: true })
      .toFile(tmpPath);
    fs.renameSync(tmpPath, cachePath);
    return cachePath;
  } catch (err) {
    console.error(`Display cache generation failed for ${filename}:`, err);
    return sourcePath;
  }
}
