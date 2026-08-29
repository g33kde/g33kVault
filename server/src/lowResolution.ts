import sharp from 'sharp';

// Checked against the shorter and longer edge independently, not raw width
// vs height, so orientation doesn't matter — a normal 1080x1920 portrait
// phone photo isn't mistaken for a "160x120" thumbnail just because its
// width is under 160, and a genuine landscape thumbnail saved sideways
// still gets caught.
const MAX_LONG_EDGE = 160;
const MAX_SHORT_EDGE = 120;

export interface ImageDimensions {
  width: number;
  height: number;
}

// Reads just the image header (not a full pixel decode) via sharp, already a
// project dependency for rotation/perceptual-hashing. Returns null for
// anything sharp can't read dimensions from (corrupt file, unsupported
// format) — callers treat that the same as "not flagged" rather than erroring.
export async function getImageDimensions(filePath: string): Promise<ImageDimensions | null> {
  try {
    const { width, height } = await sharp(filePath).metadata();
    if (!width || !height) return null;
    return { width, height };
  } catch {
    return null;
  }
}

export function isLowResolution({ width, height }: ImageDimensions): boolean {
  const shortEdge = Math.min(width, height);
  const longEdge = Math.max(width, height);
  return shortEdge <= MAX_SHORT_EDGE || longEdge <= MAX_LONG_EDGE;
}
