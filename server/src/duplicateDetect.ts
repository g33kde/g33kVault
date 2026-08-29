import fs from 'fs';
import crypto from 'crypto';
import sharp from 'sharp';
import { MediaRow } from './db';

const DHASH_WIDTH = 9;
const DHASH_HEIGHT = 8;

// How close two perceptual hashes need to be (out of 64 bits) to count as
// "similar" — small enough that minor recompression/re-saving of the exact
// same photo lands well under it, large enough to tolerate a bit of noise,
// but nowhere near close enough for two genuinely different photos (even of
// the same subject) to collide. A conventional dHash threshold.
const SIMILAR_THRESHOLD = 5;

export function computeContentHash(filePath: string): string {
  const buffer = fs.readFileSync(filePath);
  return crypto.createHash('sha256').update(buffer).digest('hex');
}

// A difference hash (dHash): shrink to a tiny grayscale grid, then encode
// each pixel as one bit — "brighter than its right neighbor" or not.
// Resilient to re-encoding, minor resizing, and quality changes; a
// genuinely different photo produces a very different bit pattern. Returns
// null for anything sharp can't decode as a still image (unsupported
// format, corrupt file) — callers use that to mean "not applicable" rather
// than "not yet computed".
export async function computePerceptualHash(filePath: string): Promise<string | null> {
  try {
    const { data } = await sharp(filePath)
      .resize(DHASH_WIDTH, DHASH_HEIGHT, { fit: 'fill' })
      .greyscale()
      .raw()
      .toBuffer({ resolveWithObject: true });

    let bits = '';
    for (let row = 0; row < DHASH_HEIGHT; row++) {
      for (let col = 0; col < DHASH_WIDTH - 1; col++) {
        const left = data[row * DHASH_WIDTH + col];
        const right = data[row * DHASH_WIDTH + col + 1];
        bits += left < right ? '1' : '0';
      }
    }
    return BigInt(`0b${bits}`).toString(16).padStart(16, '0');
  } catch {
    return null;
  }
}

export function hammingDistance(hashA: string, hashB: string): number {
  let xor = BigInt(`0x${hashA}`) ^ BigInt(`0x${hashB}`);
  let distance = 0;
  while (xor > 0n) {
    distance += Number(xor & 1n);
    xor >>= 1n;
  }
  return distance;
}

export interface DuplicateGroups {
  exact: MediaRow[][];
  similar: MediaRow[][];
}

// Groups media into exact duplicates (identical file bytes) and similar
// photos (near-identical perceptual hash). Only items that already have a
// hash computed participate; the caller is responsible for backfilling
// first.
//
// The two passes run over the full set independently — an exact-duplicate
// pair's phash is necessarily identical too (same bytes decode to the same
// pixels), so it always reappears inside its similar-photos cluster. That's
// deliberate, not excluded: if a third photo (e.g. the same shot re-saved
// at a different quality) is *only* a phash match for one member of an
// exact pair, excluding exact-group members from the phash pool entirely
// would silently drop that third photo from the results (it would have no
// remaining match partner) — confirmed by testing against a real re-saved
// copy. A "similar" group is only suppressed when its membership doesn't
// add anything beyond an exact group already shown above it.
export function findDuplicateGroups(media: MediaRow[]): DuplicateGroups {
  const byContentHash = new Map<string, MediaRow[]>();
  for (const item of media) {
    if (!item.content_hash) continue;
    const group = byContentHash.get(item.content_hash) ?? [];
    group.push(item);
    byContentHash.set(item.content_hash, group);
  }
  const exact = [...byContentHash.values()].filter((group) => group.length > 1);
  const exactGroupKeys = new Set(exact.map((group) => groupKey(group)));

  const withPhash = media.filter((item) => item.phash);
  const used = new Set<string>();
  const similar: MediaRow[][] = [];

  for (let i = 0; i < withPhash.length; i++) {
    const a = withPhash[i];
    if (used.has(a.id)) continue;
    const group = [a];
    for (let j = i + 1; j < withPhash.length; j++) {
      const b = withPhash[j];
      if (used.has(b.id)) continue;
      if (hammingDistance(a.phash!, b.phash!) <= SIMILAR_THRESHOLD) {
        group.push(b);
        used.add(b.id);
      }
    }
    if (group.length > 1) {
      used.add(a.id);
      if (!exactGroupKeys.has(groupKey(group))) {
        similar.push(group);
      }
    }
  }

  return { exact, similar };
}

function groupKey(group: MediaRow[]): string {
  return group
    .map((item) => item.id)
    .sort()
    .join(',');
}
