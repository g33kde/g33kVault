import sharp from 'sharp';

export interface ImageDimensions {
  width: number;
  height: number;
}

// Two edges, not "width"/"height" — the admin picks two numbers (however
// they think of them) and this always compares the photo's actual shorter
// edge against the smaller of the two and its longer edge against the
// larger, so orientation never matters: a normal 1080x1920 portrait phone
// photo isn't mistaken for a small thumbnail just because one of its edges
// is short, and a landscape thumbnail saved sideways still gets caught.
export interface ResolutionThreshold {
  maxLongEdge: number;
  maxShortEdge: number;
}

export function makeThreshold(a: number, b: number): ResolutionThreshold {
  return { maxLongEdge: Math.max(a, b), maxShortEdge: Math.min(a, b) };
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

export function isLowResolution({ width, height }: ImageDimensions, threshold: ResolutionThreshold): boolean {
  const shortEdge = Math.min(width, height);
  const longEdge = Math.max(width, height);
  return shortEdge <= threshold.maxShortEdge || longEdge <= threshold.maxLongEdge;
}
