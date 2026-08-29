import fs from 'fs';
import path from 'path';
import AdmZip from 'adm-zip';
import * as tar from 'tar';
import { createExtractorFromFile } from 'node-unrar-js';
import SevenZip from '7z-wasm';

export type ArchiveKind = 'zip' | 'tar' | '7z' | 'rar';

// .tar.gz/.tgz checked before the bare .tar suffix so "foo.tar.gz" isn't
// mistaken for a (nonexistent) ".gz"-only file — path.extname() only ever
// returns the last dot-segment, so a plain suffix check is more reliable
// here than extname for the two-part extension.
const TAR_SUFFIXES = ['.tar.gz', '.tgz', '.tar'];

// 7-Zip's native split-archive naming for a size-limited archive: e.g.
// Qonf2019.7z.001, Qonf2019.7z.002, ... — a real archive that was too big
// for the compressor's volume-size limit and got split into sequential
// parts, as opposed to a single ordinary .7z file.
const SPLIT_7Z_RE = /^(.+\.7z)\.(\d{3,})$/i;

export function archiveKindFor(filename: string): ArchiveKind | null {
  const base = path.basename(filename);
  const lower = base.toLowerCase();
  if (lower.endsWith('.zip')) return 'zip';
  if (TAR_SUFFIXES.some((suffix) => lower.endsWith(suffix))) return 'tar';
  if (lower.endsWith('.7z')) return '7z';

  const splitMatch = base.match(SPLIT_7Z_RE);
  if (splitMatch) {
    // Only the first volume kicks off processing — later parts are found as
    // siblings once .001 is seen, not treated as their own archive (so the
    // scan doesn't try, and fail, to "extract" a lone .002 on its own).
    return parseInt(splitMatch[2], 10) === 1 ? '7z' : null;
  }

  if (lower.endsWith('.rar')) return 'rar';
  return null;
}

// For an ordinary archive this is just [archivePath]. For the first volume
// of a split 7z archive, finds every sibling part (.001, .002, ...) that
// actually exists alongside it, in order — the caller needs the full list
// both to wait for every part to settle before extracting, and to clean up
// every part afterward, not just the one path it happened to find first.
export function findArchiveVolumeParts(archivePath: string): string[] {
  const dir = path.dirname(archivePath);
  const match = path.basename(archivePath).match(SPLIT_7Z_RE);
  if (!match) return [archivePath];

  const [, prefix, digitsSample] = match;
  const digits = digitsSample.length;

  let entries: string[];
  try {
    entries = fs.readdirSync(dir);
  } catch {
    return [archivePath];
  }

  const parts = entries
    .map((name) => ({ name, m: name.match(SPLIT_7Z_RE) }))
    .filter(
      (e): e is { name: string; m: RegExpMatchArray } =>
        e.m !== null && e.m[1].toLowerCase() === prefix.toLowerCase() && e.m[2].length === digits
    )
    .sort((a, b) => parseInt(a.m[2], 10) - parseInt(b.m[2], 10))
    .map((e) => path.join(dir, e.name));

  return parts.length > 0 ? parts : [archivePath];
}

function extractZip(archivePath: string, destDir: string) {
  new AdmZip(archivePath).extractAllTo(destDir, true);
}

async function extractTar(archivePath: string, destDir: string) {
  // Auto-detects gzip vs. plain by sniffing the file's magic bytes, so this
  // one call covers .tar, .tar.gz, and .tgz.
  await tar.extract({ file: archivePath, cwd: destDir });
}

async function extractSevenZip(archivePath: string, destDir: string) {
  const sevenZip = await SevenZip({ print: () => {}, printErr: () => {} });
  // 7z-wasm extracts into its mounted working directory, so every volume
  // needs to be reachable from inside that same mount, under its real
  // filename — the 7-Zip CLI (which this wraps) auto-detects sibling
  // ".7z.NNN" parts by filename convention when pointed at the first one,
  // confirmed against a real multi-volume archive during development.
  // Removed afterward so the copies aren't picked up as "extracted content"
  // by the media scan that follows.
  const volumeParts = findArchiveVolumeParts(archivePath);
  const workNames = volumeParts.map((p) => path.basename(p));
  volumeParts.forEach((p, i) => fs.copyFileSync(p, path.join(destDir, workNames[i])));

  try {
    sevenZip.FS.mkdir('/work');
    sevenZip.FS.mount(sevenZip.NODEFS, { root: destDir }, '/work');
    sevenZip.FS.chdir('/work');
    sevenZip.callMain(['x', workNames[0], '-y']);
  } finally {
    for (const name of workNames) {
      const copyPath = path.join(destDir, name);
      if (fs.existsSync(copyPath)) fs.unlinkSync(copyPath);
    }
  }
}

async function extractRar(archivePath: string, destDir: string) {
  const extractor = await createExtractorFromFile({ filepath: archivePath, targetPath: destDir });
  const { files } = extractor.extract();
  // The returned generator is lazy — extraction to disk only happens as
  // each entry is pulled, so it must be fully drained.
  for (const _ of files) void _;
}

// Extracts every recognized archive format into destDir (created if it
// doesn't exist). Does not touch archivePath (or, for a split 7z, any of
// its sibling volumes) — the caller decides what happens to the originals.
export async function extractArchive(archivePath: string, destDir: string): Promise<void> {
  const kind = archiveKindFor(archivePath);
  if (!kind) {
    throw new Error(`Unrecognized archive type: ${archivePath}`);
  }

  fs.mkdirSync(destDir, { recursive: true });

  if (kind === 'zip') {
    extractZip(archivePath, destDir);
  } else if (kind === 'tar') {
    await extractTar(archivePath, destDir);
  } else if (kind === '7z') {
    await extractSevenZip(archivePath, destDir);
  } else {
    await extractRar(archivePath, destDir);
  }
}

// Junk that commonly ends up inside archives and would otherwise get
// misdetected as real media by extension alone — in particular, macOS's
// AppleDouble sidecar files (e.g. "._photo.jpg") share the real file's
// extension, confirmed by testing against a real macOS-created .tar.gz.
export function isJunkArchiveEntry(filePath: string): boolean {
  const base = path.basename(filePath);
  if (base.startsWith('._')) return true;
  if (base === '.DS_Store' || base === 'Thumbs.db') return true;
  if (filePath.split(path.sep).includes('__MACOSX')) return true;
  return false;
}
