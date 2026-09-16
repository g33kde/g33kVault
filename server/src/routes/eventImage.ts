import { Router } from 'express';
import multer, { FileFilterCallback } from 'multer';
import fs from 'fs';
import path from 'path';
import type { Request } from 'express';
import type { Server as SocketIOServer } from 'socket.io';
import { config } from '../config';
import { checkAdminPassword } from '../adminAuth';
import {
  getEventImageFilename,
  setEventImageFilename,
  setEventImageScale,
  EVENT_IMAGE_SCALES,
  EventImageScale,
} from '../settings';
import { logEvent } from '../grafana/eventLog';
import { currentSettings } from './admin';

fs.mkdirSync(config.eventImageDir, { recursive: true });

// Deliberately narrower than the guest-upload pipeline's image formats
// (which also takes HEIC/WebP) — this is an admin-chosen branding image,
// jpg for a plain photo, png for a logo that needs transparency, gif for
// something animated. Kept in memory rather than written to a temp path
// first: at most one small file, no need for multer's disk-storage
// machinery here.
const ALLOWED_EXTS = new Set(['.jpg', '.jpeg', '.png', '.gif']);

function fileFilter(_req: Request, file: Express.Multer.File, cb: FileFilterCallback) {
  const ext = path.extname(file.originalname).toLowerCase();
  if (ALLOWED_EXTS.has(ext)) {
    cb(null, true);
  } else {
    cb(new Error('Unsupported file type — use .jpg, .png, or .gif'));
  }
}

const upload = multer({
  storage: multer.memoryStorage(),
  // Reuses the plain-photo limit — a branding image is a single small
  // asset, not something that needs its own dedicated size knob.
  limits: { fileSize: config.maxFileSizeMb * 1024 * 1024 },
  fileFilter,
});

function removeExistingFile() {
  const previous = getEventImageFilename();
  if (previous) {
    fs.unlink(path.join(config.eventImageDir, previous), () => {});
  }
}

export function eventImageRouter(io: SocketIOServer) {
  const router = Router();

  // Replaces whatever was there before, regardless of its extension — e.g.
  // uploading a .gif over an existing .png removes the old .png rather
  // than leaving it orphaned in eventImageDir forever.
  router.post('/', upload.single('file'), (req, res) => {
    if (!checkAdminPassword(req.header('x-admin-password'))) {
      res.status(401).json({ error: 'Invalid password' });
      return;
    }

    if (!req.file) {
      res.status(400).json({ error: 'No file uploaded' });
      return;
    }

    const ext = path.extname(req.file.originalname).toLowerCase();
    removeExistingFile();

    const filename = `event-image${ext}`;
    fs.writeFileSync(path.join(config.eventImageDir, filename), req.file.buffer);
    setEventImageFilename(filename);
    logEvent('moderation', 'event_image_uploaded', { ext, size_bytes: req.file.size });

    const updated = currentSettings();
    io.emit('config:updated', updated);
    res.json(updated);
  });

  router.delete('/', (req, res) => {
    if (!checkAdminPassword(req.header('x-admin-password'))) {
      res.status(401).json({ error: 'Invalid password' });
      return;
    }

    removeExistingFile();
    setEventImageFilename(null);
    logEvent('moderation', 'event_image_removed', {});

    const updated = currentSettings();
    io.emit('config:updated', updated);
    res.json(updated);
  });

  // Separate from PUT /api/admin/settings on purpose — that endpoint's body
  // always reflects the Playback Settings form's full local state, and this
  // slider lives in the Event Image section instead, applied instantly on
  // drag rather than gated behind that form's own Save button. Routing it
  // through the general settings endpoint would risk overwriting another
  // field with a stale/invalid value the admin hasn't saved yet.
  router.put('/scale', (req, res) => {
    if (!checkAdminPassword(req.header('x-admin-password'))) {
      res.status(401).json({ error: 'Invalid password' });
      return;
    }

    const { scale } = req.body;
    if (!EVENT_IMAGE_SCALES.includes(scale)) {
      res.status(400).json({ error: `scale must be one of ${EVENT_IMAGE_SCALES.join(', ')}` });
      return;
    }

    setEventImageScale(scale as EventImageScale);

    const updated = currentSettings();
    io.emit('config:updated', updated);
    res.json(updated);
  });

  return router;
}
