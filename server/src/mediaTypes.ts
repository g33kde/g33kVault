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
};

const HEIC_EXTS = new Set(['.heic', '.heif']);

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
