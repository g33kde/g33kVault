import { Router } from 'express';
import fs from 'fs';
import path from 'path';
import sharp from 'sharp';
import type { Server as SocketIOServer } from 'socket.io';
import { config } from '../config';
import { getApprovedMedia, getMediaById, updateMedia, updateManyMedia } from '../db';
import { checkAdminPassword } from '../adminAuth';
import { computeContentHash, computePerceptualHash } from '../duplicateDetect';
import { logEvent } from '../grafana/eventLog';
import { moveToTrash } from '../trash';

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
      logEvent('moderation', 'photo_rotated', { direction });
      io.emit('media:updated', updated);
      res.json(updated);
    } catch (err) {
      console.error('Rotate failed:', err);
      res.status(500).json({ error: 'Could not rotate this image' });
    }
  });

  // Moves the file into Trash (config.trashDir) rather than deleting it —
  // see trash.ts and routes/trash.ts. Still broadcasts the same
  // 'media:deleted' event as a real delete: every existing listener
  // (Slideshow.tsx, Admin.tsx's own gallery/duplicates/low-res lists) just
  // needs "this id is gone from the live view," which is exactly as true
  // for a trashed item as a permanently deleted one.
  router.delete('/:id', (req, res) => {
    if (!checkAdminPassword(req.header('x-admin-password'))) {
      res.status(401).json({ error: 'Invalid password' });
      return;
    }

    const trashed = updateMedia(req.params.id, { status: 'trashed', trashed_at: Date.now() });
    if (!trashed) {
      res.status(404).json({ error: 'Not found' });
      return;
    }

    moveToTrash(trashed.filename);
    logEvent('moderation', 'photo_trashed', { kind: trashed.kind });
    io.emit('media:deleted', { id: trashed.id });
    res.status(204).end();
  });

  // Bulk trash for the admin gallery's "Select photos" mode — unlike
  // duplicates/low-resolution delete-all (which recompute their own id list
  // server-side, since those criteria are well-defined and re-derivable),
  // there's no server-side "correct" set to recompute here: the admin
  // explicitly hand-picked these specific items, so the client-supplied id
  // list IS the authoritative one. One read + one write for the whole
  // batch (updateManyMedia) rather than looping updateMedia() per id, same
  // reasoning as the other bulk-action routes.
  router.post('/delete-batch', (req, res) => {
    if (!checkAdminPassword(req.header('x-admin-password'))) {
      res.status(401).json({ error: 'Invalid password' });
      return;
    }

    const { ids } = req.body ?? {};
    if (!Array.isArray(ids) || ids.length === 0 || !ids.every((id) => typeof id === 'string')) {
      res.status(400).json({ error: 'ids must be a non-empty array of strings' });
      return;
    }

    const trashedAt = Date.now();
    const trashed = updateManyMedia(new Set(ids), { status: 'trashed', trashed_at: trashedAt });

    for (let i = 0; i < trashed.length; i++) {
      const row = trashed[i];
      moveToTrash(row.filename);
      io.emit('media:deleted', { id: row.id });
      io.emit('media:deleteBatchProgress', { current: i + 1, total: trashed.length });
    }

    logEvent('moderation', 'photos_trashed_batch', { count: trashed.length });
    res.json({ deleted: trashed.length });
  });

  return router;
}
