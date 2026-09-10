export type MediaKind = 'image' | 'video';

export const EXT_MIME: Record<string, string> = {
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.png': 'image/png',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.heic': 'image/heic',
  '.heif': 'image/heif',
  '.mp4': 'video/mp4',
  '.mov': 'video/quicktime',
  '.webm': 'video/webm',
  '.mpg': 'video/mpeg',
  '.mpeg': 'video/mpeg',
};

const MIME_KIND: Record<string, MediaKind> = {
  'image/jpeg': 'image',
  'image/png': 'image',
  'image/gif': 'image',
  'image/webp': 'image',
  'image/heic': 'image',
  'image/heif': 'image',
  'video/mp4': 'video',
  'video/quicktime': 'video',
  'video/webm': 'video',
  'video/mpeg': 'video',
};

const HEIC_EXTS = new Set(['.heic', '.heif']);
// MPEG-1/2 has poor/inconsistent native support in HTML5 <video> across
// browsers, unlike mp4/mov/webm — transcoded to MP4 on ingest (see
// videoConvert.ts) rather than served as-is, same reasoning HEIC gets
// converted to JPEG instead of served directly.
const MPEG_EXTS = new Set(['.mpg', '.mpeg']);

export function kindForExt(ext: string): MediaKind | null {
  const mime = EXT_MIME[ext.toLowerCase()];
  return mime ? MIME_KIND[mime] : null;
}

export function mimeForExt(ext: string): string | null {
  return EXT_MIME[ext.toLowerCase()] ?? null;
}

export function isHeic(ext: string): boolean {
  return HEIC_EXTS.has(ext.toLowerCase());
}

export function isMpeg(ext: string): boolean {
  return MPEG_EXTS.has(ext.toLowerCase());
}
