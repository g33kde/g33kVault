import { Router } from 'express';
import multer, { FileFilterCallback } from 'multer';
import fs from 'fs';
import path from 'path';
import { randomUUID } from 'crypto';
import type { Request } from 'express';
import type { Server as SocketIOServer } from 'socket.io';
import { config } from '../config';
import { insertMedia } from '../db';

fs.mkdirSync(config.mediaDir, { recursive: true });

const ALLOWED_MIME: Record<string, 'image' | 'video'> = {
  'image/jpeg': 'image',
  'image/png': 'image',
  'image/gif': 'image',
  'image/webp': 'image',
  'video/mp4': 'video',
  'video/quicktime': 'video',
  'video/webm': 'video',
};

const storage = multer.diskStorage({
  destination: (_req, _file, cb) => cb(null, config.mediaDir),
  filename: (_req, file, cb) => {
    const ext = path.extname(file.originalname).toLowerCase();
    cb(null, `${randomUUID()}${ext}`);
  },
});

function fileFilter(_req: Request, file: Express.Multer.File, cb: FileFilterCallback) {
  if (ALLOWED_MIME[file.mimetype]) {
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

  router.post('/', upload.single('file'), (req, res) => {
    if (!req.file) {
      res.status(400).json({ error: 'No file uploaded' });
      return;
    }

    const kind = ALLOWED_MIME[req.file.mimetype];
    const media = {
      id: randomUUID(),
      filename: req.file.filename,
      original_name: req.file.originalname,
      mime_type: req.file.mimetype,
      kind,
      size: req.file.size,
      created_at: Date.now(),
    };

    insertMedia(media);
    io.emit('media:new', media);

    res.status(201).json(media);
  });

  return router;
}
