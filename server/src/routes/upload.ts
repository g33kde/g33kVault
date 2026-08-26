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

fs.mkdirSync(config.mediaDir, { recursive: true });

const storage = multer.diskStorage({
  destination: (_req, _file, cb) => cb(null, config.mediaDir),
  filename: (_req, file, cb) => {
    const ext = path.extname(file.originalname).toLowerCase();
    cb(null, `${randomUUID()}${ext}`);
  },
});

function fileFilter(_req: Request, file: Express.Multer.File, cb: FileFilterCallback) {
  const ext = path.extname(file.originalname).toLowerCase();
  if (kindForExt(ext)) {
    cb(null, true);
  } else {
    cb(new Error('Unsupported file type'));
  }
}

const upload = multer({
  storage,
  limits: { fileSize: config.maxFileSizeMb * 1024 * 1024 },
  fileFilter,
});

export function uploadRouter(io: SocketIOServer) {
  const router = Router();

  router.post('/', upload.single('file'), async (req, res) => {
    if (!req.file) {
      res.status(400).json({ error: 'No file uploaded' });
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

    let filename = req.file.filename;
    let mimeType = mimeForExt(ext) ?? req.file.mimetype;

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

    const media = {
      id: randomUUID(),
      filename,
      original_name: req.file.originalname,
      mime_type: mimeType,
      kind,
      size: fs.statSync(path.join(config.mediaDir, filename)).size,
      created_at: Date.now(),
    };

    insertMedia(media);
    io.emit('media:new', media);

    res.status(201).json(media);
  });

  return router;
}
