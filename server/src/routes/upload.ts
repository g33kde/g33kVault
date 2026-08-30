import { Router } from 'express';
import multer, { FileFilterCallback } from 'multer';
import fs from 'fs';
import path from 'path';
import { randomUUID } from 'crypto';
import type { Request } from 'express';
import type { Server as SocketIOServer } from 'socket.io';
import { config } from '../config';
import { insertMedia } from '../db';
import { kindForExt, mimeForExt, isHeic } from '../mediaTypes';
import { convertHeicToJpeg } from '../heicConvert';
import { computeContentHash, computePerceptualHash } from '../duplicateDetect';
import { extractPhotoTakenAt } from '../photoDate';
import { archiveKindFor } from '../archiveExtract';
import { importArchive } from '../importFolder';

fs.mkdirSync(config.mediaDir, { recursive: true });

// path.extname() only ever returns the last dot-segment, so "foo.tar.gz"
// would otherwise get saved as "<uuid>.gz" — losing the part archiveKindFor
// needs to recognize it as a tar archive later during background
// processing. Matches the same compound-suffix handling archiveExtract.ts
// already does internally.
function realExtname(filename: string): string {
  return filename.toLowerCase().endsWith('.tar.gz') ? '.tar.gz' : path.extname(filename);
}

// Guests can upload a .zip/.tar.gz/.rar of multiple photos, extracted and
// held for admin review (routes/admin.ts pending-batches endpoints) rather
// than going straight to the live slideshow — see CHANGELOG. Not .7z here:
// that stays exclusive to the admin-only watched import folder, by choice.
function isAllowedArchiveUpload(originalname: string): boolean {
  const kind = archiveKindFor(originalname);
  return kind !== null && kind !== '7z';
}

const storage = multer.diskStorage({
  destination: (_req, _file, cb) => cb(null, config.mediaDir),
  filename: (_req, file, cb) => {
    cb(null, `${randomUUID()}${realExtname(file.originalname)}`);
  },
});

function fileFilter(_req: Request, file: Express.Multer.File, cb: FileFilterCallback) {
  const ext = realExtname(file.originalname);
  if (kindForExt(ext) || isAllowedArchiveUpload(file.originalname)) {
    cb(null, true);
  } else {
    cb(new Error('Unsupported file type'));
  }
}

// The multer-level limit has to cover the larger of the two — archives are
// allowed to be substantially bigger than a single photo/video. Whichever
// specific limit actually applies (maxFileSizeMb vs. maxArchiveSizeMb) is
// enforced per-upload once the file's real kind is known, below.
const upload = multer({
  storage,
  limits: { fileSize: Math.max(config.maxFileSizeMb, config.maxArchiveSizeMb) * 1024 * 1024 },
  fileFilter,
});

const MAX_UPLOADER_LENGTH = 40;

// Free-text, optional, guest-supplied — trim and cap it defensively rather
// than trusting it, same as any other public-facing input. Never required:
// an empty/missing value just means an anonymous upload, as before.
function sanitizeUploader(raw: unknown): string | null {
  if (typeof raw !== 'string') return null;
  const trimmed = raw.trim().slice(0, MAX_UPLOADER_LENGTH);
  return trimmed.length > 0 ? trimmed : null;
}

export function uploadRouter(io: SocketIOServer) {
  const router = Router();

  router.post('/', upload.single('file'), async (req, res) => {
    if (!req.file) {
      res.status(400).json({ error: 'No file uploaded' });
      return;
    }

    if (isAllowedArchiveUpload(req.file.originalname)) {
      if (req.file.size > config.maxArchiveSizeMb * 1024 * 1024) {
        fs.unlink(req.file.path, () => {});
        res.status(400).json({ error: `Archive must be smaller than ${config.maxArchiveSizeMb} MB` });
        return;
      }

      const batchId = randomUUID();
      const batchLabel = req.file.originalname;
      const uploader = sanitizeUploader(req.body?.uploader);
      const archivePath = req.file.path;

      // The guest gets an immediate response — extraction/hashing every
      // photo inside can take a while, and holding a mobile connection open
      // for that risks a timeout or a dropped upload. Processing continues
      // after the response is sent; any failure is logged, not surfaced to
      // the guest (they've already been told it's received).
      res.status(202).json({ pending: true, batchId });
      importArchive(archivePath, io, { status: 'pending', batchId, batchLabel, uploader }).catch((err) => {
        console.error(`Failed to process uploaded archive "${batchLabel}":`, err);
      });
      return;
    }

    const ext = path.extname(req.file.originalname).toLowerCase();
    const kind = kindForExt(ext);

    // fileFilter already rejects unrecognized extensions, but the file is
    // already on disk by the time we get here, so this is just cleanup for
    // the (currently unreachable) case where that check is ever loosened.
    if (!kind) {
      fs.unlink(req.file.path, () => {});
      res.status(400).json({ error: 'Unsupported file type' });
      return;
    }

    if (req.file.size > config.maxFileSizeMb * 1024 * 1024) {
      fs.unlink(req.file.path, () => {});
      res.status(400).json({ error: `File must be smaller than ${config.maxFileSizeMb} MB` });
      return;
    }

    let filename = req.file.filename;
    let mimeType = mimeForExt(ext) ?? req.file.mimetype;

    // Read before any HEIC conversion below, which re-encodes the file and
    // carries no EXIF forward at all — see photoDate.ts.
    const photoTakenAt = kind === 'image' ? await extractPhotoTakenAt(req.file.path) : null;

    if (isHeic(ext)) {
      const jpegFilename = filename.replace(/\.[^.]+$/, '.jpg');
      const jpegPath = path.join(config.mediaDir, jpegFilename);
      try {
        await convertHeicToJpeg(req.file.path, jpegPath);
      } catch (err) {
        console.error('HEIC conversion failed:', err);
        fs.unlink(req.file.path, () => {});
        res.status(400).json({ error: 'Could not process this photo (unsupported HEIC file)' });
        return;
      }
      filename = jpegFilename;
      mimeType = 'image/jpeg';
    }

    const finalPath = path.join(config.mediaDir, filename);
    const media = {
      id: randomUUID(),
      filename,
      original_name: req.file.originalname,
      mime_type: mimeType,
      kind,
      size: fs.statSync(finalPath).size,
      created_at: Date.now(),
      uploader: sanitizeUploader(req.body?.uploader),
      photo_taken_at: photoTakenAt,
      content_hash: await computeContentHash(finalPath),
      phash: kind === 'image' ? await computePerceptualHash(finalPath) : null,
    };

    insertMedia(media);
    io.emit('media:new', media);

    res.status(201).json(media);
  });

  return router;
}
