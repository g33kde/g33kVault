import { Router } from 'express';
import multer, { FileFilterCallback } from 'multer';
import fs from 'fs';
import path from 'path';
import { randomUUID } from 'crypto';
import type { Request } from 'express';
import type { Server as SocketIOServer } from 'socket.io';
import { config } from '../config';
import { insertMedia, MediaRow } from '../db';
import { kindForExt, mimeForExt, isHeic, isMpeg, MediaKind } from '../mediaTypes';
import { convertHeicToJpeg } from '../heicConvert';
import { convertMpegToMp4 } from '../videoConvert';
import { computeContentHash, computePerceptualHash } from '../duplicateDetect';
import { extractPhotoTakenAt } from '../photoDate';
import { archiveKindFor } from '../archiveExtract';
import { importArchive } from '../importFolder';
import { getRequireApproval } from '../settings';
import { logEvent } from '../grafana/eventLog';
import { classifyUserAgent } from '../grafana/userAgent';

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

// Which page the upload came from — sent by the client (Upload.tsx/
// Booth.tsx both append a `source` field), just for the "photo booth vs.
// regular upload" breakdown in Grafana (see GRAFANA.md). Never trusted for
// anything functional, only for this label — falls back to 'upload' for
// any older/unrecognized client rather than rejecting the upload over it.
function sanitizeSource(raw: unknown): 'upload' | 'booth' {
  return raw === 'booth' ? 'booth' : 'upload';
}

// Shared by every path that ends with one finished file already sitting at
// its final location in MEDIA_DIR — computes hashes, inserts the DB row,
// logs it, and broadcasts it — regardless of whether that happened
// synchronously (a guest still waiting on the response) or after a
// background conversion finished (MPEG transcoding — see the isMpeg branch
// below, and importFolder.ts's importSingleFile for the watched-folder/
// archive equivalent). Doesn't touch the HTTP response itself, since the
// background-processing caller has usually already responded by the time
// this runs.
async function insertAndAnnounceMedia(params: {
  filename: string;
  originalName: string;
  mimeType: string;
  kind: MediaKind;
  photoTakenAt: number | null;
  uploaderRaw: unknown;
  source: 'upload' | 'booth';
  deviceType: string;
  os: string;
  io: SocketIOServer;
}): Promise<{ media: MediaRow; requireApproval: boolean }> {
  const finalPath = path.join(config.mediaDir, params.filename);
  const id = randomUUID();
  const requireApproval = getRequireApproval();
  const media: MediaRow = {
    id,
    filename: params.filename,
    original_name: params.originalName,
    mime_type: params.mimeType,
    kind: params.kind,
    size: fs.statSync(finalPath).size,
    created_at: Date.now(),
    uploader: sanitizeUploader(params.uploaderRaw),
    photo_taken_at: params.photoTakenAt,
    content_hash: await computeContentHash(finalPath),
    phash: params.kind === 'image' ? await computePerceptualHash(finalPath) : null,
    // requireApproval (an admin setting) holds every direct upload for
    // review exactly like a guest-uploaded archive's contents already
    // are — reusing the same pending-batches admin UI, one item per
    // "batch" (batchId set to its own id, so /pending-batches/:batchId's
    // filter on m.batchId matches it — see routes/admin.ts). Undefined
    // status/batchId/batchLabel when the setting is off, same as before
    // this feature existed.
    ...(requireApproval
      ? { status: 'pending' as const, batchId: id, batchLabel: params.originalName }
      : {}),
  };

  insertMedia(media);
  logEvent('uploads', 'upload_completed', {
    kind: params.kind,
    mime_type: params.mimeType,
    size_bytes: media.size,
    source: params.source,
    device_type: params.deviceType,
    os: params.os,
    pending: requireApproval,
  });
  params.io.emit(requireApproval ? 'media:pending' : 'media:new', media);

  return { media, requireApproval };
}

export function uploadRouter(io: SocketIOServer) {
  const router = Router();

  router.post('/', upload.single('file'), async (req, res) => {
    if (!req.file) {
      res.status(400).json({ error: 'No file uploaded' });
      return;
    }

    const source = sanitizeSource(req.body?.source);
    const { deviceType, os } = classifyUserAgent(req.header('user-agent'));

    if (isAllowedArchiveUpload(req.file.originalname)) {
      if (req.file.size > config.maxArchiveSizeMb * 1024 * 1024) {
        fs.unlink(req.file.path, () => {});
        logEvent('uploads', 'upload_rejected', { reason: 'archive_too_large', source });
        res.status(400).json({ error: `Archive must be smaller than ${config.maxArchiveSizeMb} MB` });
        return;
      }

      const batchId = randomUUID();
      const batchLabel = req.file.originalname;
      const uploader = sanitizeUploader(req.body?.uploader);
      const archivePath = req.file.path;
      const archiveSize = req.file.size;

      // The guest gets an immediate response — extraction/hashing every
      // photo inside can take a while, and holding a mobile connection open
      // for that risks a timeout or a dropped upload. Processing continues
      // after the response is sent; any failure is logged, not surfaced to
      // the guest (they've already been told it's received).
      res.status(202).json({ pending: true, batchId });
      logEvent('uploads', 'upload_completed', {
        kind: 'archive',
        size_bytes: archiveSize,
        source,
        device_type: deviceType,
        os,
      });
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
      logEvent('uploads', 'upload_rejected', { reason: 'unsupported_type', source });
      res.status(400).json({ error: 'Unsupported file type' });
      return;
    }

    if (req.file.size > config.maxFileSizeMb * 1024 * 1024) {
      fs.unlink(req.file.path, () => {});
      logEvent('uploads', 'upload_rejected', { reason: 'file_too_large', source });
      res.status(400).json({ error: `File must be smaller than ${config.maxFileSizeMb} MB` });
      return;
    }

    // MPEG needs real transcoding (see videoConvert.ts), which can take far
    // longer than anything else this route does — unlike HEIC (sub-second),
    // making a guest's mobile upload wait on it risks a timeout. Same fix
    // already used for archives just above: respond immediately, finish the
    // rest in the background. The guest never learns whether it succeeded
    // or failed beyond the initial "received" ack, same as an archive.
    if (isMpeg(ext)) {
      const mp4Filename = req.file.filename.replace(/\.[^.]+$/, '.mp4');
      const mp4Path = path.join(config.mediaDir, mp4Filename);
      const srcPath = req.file.path;
      const originalName = req.file.originalname;
      const uploaderRaw = req.body?.uploader;

      res.status(202).json({ pending: true, converting: true });
      logEvent('uploads', 'upload_completed', {
        kind: 'video',
        mime_type: 'video/mpeg',
        size_bytes: req.file.size,
        source,
        device_type: deviceType,
        os,
        converting: true,
      });

      convertMpegToMp4(srcPath, mp4Path)
        .then(() =>
          insertAndAnnounceMedia({
            filename: mp4Filename,
            originalName,
            mimeType: 'video/mp4',
            kind: 'video',
            photoTakenAt: null,
            uploaderRaw,
            source,
            deviceType,
            os,
            io,
          })
        )
        .catch((err) => {
          console.error(`MPEG conversion failed for "${originalName}":`, err);
          fs.unlink(srcPath, () => {});
          logEvent('uploads', 'upload_rejected', { reason: 'mpeg_conversion_failed', source });
        });
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
        logEvent('uploads', 'upload_rejected', { reason: 'heic_conversion_failed', source });
        res.status(400).json({ error: 'Could not process this photo (unsupported HEIC file)' });
        return;
      }
      filename = jpegFilename;
      mimeType = 'image/jpeg';
    }

    const { media, requireApproval } = await insertAndAnnounceMedia({
      filename,
      originalName: req.file.originalname,
      mimeType,
      kind,
      photoTakenAt,
      uploaderRaw: req.body?.uploader,
      source,
      deviceType,
      os,
      io,
    });

    res.status(requireApproval ? 202 : 201).json(requireApproval ? { pending: true, batchId: media.id } : media);
  });

  return router;
}
