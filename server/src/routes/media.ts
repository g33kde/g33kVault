import { Router } from 'express';
import fs from 'fs';
import path from 'path';
import sharp from 'sharp';
import type { Server as SocketIOServer } from 'socket.io';
import { config } from '../config';
import { getApprovedMedia, getMediaById, deleteMedia, updateMedia } from '../db';
import { checkAdminPassword } from '../adminAuth';
import { computeContentHash, computePerceptualHash } from '../duplicateDetect';

// Formats sharp can re-encode losslessly-ish on this project's own terms.
// GIF is deliberately excluded — animated-GIF rotation needs per-frame
// handling this doesn't attempt, and HEIC/HEIF never persists past ingest
// (always converted to JPEG on upload/import, see heicConvert.ts).
const ROTATABLE_EXTENSIONS = new Set(['.jpg', '.jpeg', '.png', '.webp']);

export function mediaRouter(io: SocketIOServer) {
  const router = Router();

  // Excludes anything still awaiting review from an uploaded archive — this
  // feeds the public slideshow/host stats pages as well as the admin
  // gallery grid, none of which should show a pending photo before an
  // admin approves its batch (routes/admin.ts pending-batches endpoints).
  router.get('/', (_req, res) => {
    res.json(getApprovedMedia());
  });

  router.post('/:id/rotate', async (req, res) => {
    if (!checkAdminPassword(req.header('x-admin-password'))) {
      res.status(401).json({ error: 'Invalid password' });
      return;
    }

    const { direction } = req.body ?? {};
    if (direction !== 'cw' && direction !== 'ccw') {
      res.status(400).json({ error: "direction must be 'cw' or 'ccw'" });
      return;
    }

    const media = getMediaById(req.params.id);
    if (!media) {
      res.status(404).json({ error: 'Not found' });
      return;
    }

    if (media.kind !== 'image') {
      res.status(400).json({ error: 'Only images can be rotated' });
      return;
    }

    const ext = path.extname(media.filename).toLowerCase();
    if (!ROTATABLE_EXTENSIONS.has(ext)) {
      res.status(400).json({ error: `Rotating ${ext} files isn't supported` });
      return;
    }

    const filePath = path.join(config.mediaDir, media.filename);

    try {
      const input = fs.readFileSync(filePath);

      // Two explicit steps rather than a single chained call: first bake any
      // EXIF orientation into actual pixel data (and strip the tag), THEN
      // apply the requested 90° turn on top — otherwise a photo that already
      // carries EXIF orientation metadata could end up rotated twice.
      const normalized = await sharp(input).rotate().toBuffer();
      let pipeline = sharp(normalized).rotate(direction === 'cw' ? 90 : 270);
      if (ext === '.jpg' || ext === '.jpeg') pipeline = pipeline.jpeg({ quality: 92 });
      else if (ext === '.png') pipeline = pipeline.png();
      else pipeline = pipeline.webp();

      const output = await pipeline.toBuffer();
      fs.writeFileSync(filePath, output);

      // Rotation changes the file's bytes (new content hash) and its pixel
      // orientation (new perceptual hash) — both would otherwise go stale
      // and could cause an incorrect duplicate match against the old
      // orientation.
      const updated = updateMedia(media.id, {
        size: output.length,
        content_hash: await computeContentHash(filePath),
        phash: await computePerceptualHash(filePath),
      });
      io.emit('media:updated', updated);
      res.json(updated);
    } catch (err) {
      console.error('Rotate failed:', err);
      res.status(500).json({ error: 'Could not rotate this image' });
    }
  });

  router.delete('/:id', (req, res) => {
    if (!checkAdminPassword(req.header('x-admin-password'))) {
      res.status(401).json({ error: 'Invalid password' });
      return;
    }

    const removed = deleteMedia(req.params.id);
    if (!removed) {
      res.status(404).json({ error: 'Not found' });
      return;
    }

    fs.unlink(path.join(config.mediaDir, removed.filename), () => {});
    io.emit('media:deleted', { id: removed.id });
    res.status(204).end();
  });

  return router;
}
