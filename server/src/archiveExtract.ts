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

export function archiveKindFor(filename: string): ArchiveKind | null {
  const lower = filename.toLowerCase();
  if (lower.endsWith('.zip')) return 'zip';
  if (TAR_SUFFIXES.some((suffix) => lower.endsWith(suffix))) return 'tar';
  if (lower.endsWith('.7z')) return '7z';
  if (lower.endsWith('.rar')) return 'rar';
  return null;
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
  // 7z-wasm extracts into its mounted working directory, so the archive
  // itself needs to be reachable from inside that same mount — copy it in,
  // then remove the copy afterward so it isn't picked up as "extracted
  // content" by the media scan that follows.
  const workName = `_archive${path.extname(archivePath) || '.7z'}`;
  const workPath = path.join(destDir, workName);
  fs.copyFileSync(archivePath, workPath);
  try {
    sevenZip.FS.mkdir('/work');
    sevenZip.FS.mount(sevenZip.NODEFS, { root: destDir }, '/work');
    sevenZip.FS.chdir('/work');
    sevenZip.callMain(['x', workName, '-y']);
  } finally {
    fs.unlinkSync(workPath);
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
// doesn't exist). Does not touch archivePath itself — the caller decides
// what happens to the original file.
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
