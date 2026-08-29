import { Router } from 'express';
import fs from 'fs';
import path from 'path';
import { spawn } from 'child_process';
import { PassThrough } from 'stream';
import type { Server as SocketIOServer } from 'socket.io';
import { checkAdminPassword } from '../adminAuth';
import { config } from '../config';
import { getAllMedia, updateMedia, deleteManyMedia, MediaRow } from '../db';
import { computeContentHash, computePerceptualHash, findDuplicateGroups, planDuplicateDeletions } from '../duplicateDetect';
import { extractPhotoTakenAt } from '../photoDate';
import { getImageDimensions, isLowResolution } from '../lowResolution';
import {
  getSlideshowIntervalMs,
  setSlideshowIntervalMs,
  getShuffle,
  setShuffle,
  getTransitionStyle,
  setTransitionStyle,
  getPartyMode,
  setPartyMode,
  getLastBackup,
  setLastBackup,
  TRANSITION_STYLES,
  TransitionStyle,
} from '../settings';

const MIN_INTERVAL_MS = 1000;
const MAX_INTERVAL_MS = 10 * 60 * 1000;

function currentSettings() {
  return {
    slideshowIntervalMs: getSlideshowIntervalMs(),
    shuffle: getShuffle(),
    transitionStyle: getTransitionStyle(),
    partyMode: getPartyMode(),
    lastBackup: getLastBackup(),
  };
}

interface LowResResult {
  item: MediaRow;
  width: number;
  height: number;
}

// Shared by the scan route and the delete-all route below, so both agree on
// exactly which images count as low-resolution — recomputed fresh each call
// rather than cached on the row, since dimensions are cheap to read (just
// the image header, not a full decode) and a rotation swaps width/height,
// which could otherwise make a stale cached flag wrong.
async function scanLowResolutionImages(
  media: MediaRow[],
  mediaDir: string,
  io: SocketIOServer,
  progressEvent: string
): Promise<LowResResult[]> {
  const images = media.filter((m) => m.kind === 'image');
  const flagged: LowResResult[] = [];

  for (let i = 0; i < images.length; i++) {
    const item = images[i];
    const dims = await getImageDimensions(path.join(mediaDir, item.filename));
    if (dims && isLowResolution(dims)) {
      flagged.push({ item, width: dims.width, height: dims.height });
    }
    io.emit(progressEvent, { current: i + 1, total: images.length });
  }

  return flagged;
}

export function adminRouter(io: SocketIOServer) {
  const router = Router();

  router.post('/verify', (req, res) => {
    if (checkAdminPassword(req.header('x-admin-password'))) {
      res.status(204).end();
    } else {
      res.status(401).json({ error: 'Invalid password' });
    }
  });

  router.get('/settings', (req, res) => {
    if (!checkAdminPassword(req.header('x-admin-password'))) {
      res.status(401).json({ error: 'Invalid password' });
      return;
    }
    res.json(currentSettings());
  });

  router.put('/settings', (req, res) => {
    if (!checkAdminPassword(req.header('x-admin-password'))) {
      res.status(401).json({ error: 'Invalid password' });
      return;
    }

    const { slideshowIntervalMs, shuffle, transitionStyle, partyMode } = req.body ?? {};

    if (
      typeof slideshowIntervalMs !== 'number' ||
      !Number.isFinite(slideshowIntervalMs) ||
      slideshowIntervalMs < MIN_INTERVAL_MS ||
      slideshowIntervalMs > MAX_INTERVAL_MS
    ) {
      res.status(400).json({
        error: `slideshowIntervalMs must be a number between ${MIN_INTERVAL_MS} and ${MAX_INTERVAL_MS}`,
      });
      return;
    }

    if (typeof shuffle !== 'boolean') {
      res.status(400).json({ error: 'shuffle must be a boolean' });
      return;
    }

    if (typeof transitionStyle !== 'string' || !TRANSITION_STYLES.includes(transitionStyle as TransitionStyle)) {
      res.status(400).json({ error: `transitionStyle must be one of: ${TRANSITION_STYLES.join(', ')}` });
      return;
    }

    if (typeof partyMode !== 'boolean') {
      res.status(400).json({ error: 'partyMode must be a boolean' });
      return;
    }

    setSlideshowIntervalMs(Math.round(slideshowIntervalMs));
    setShuffle(shuffle);
    setTransitionStyle(transitionStyle as TransitionStyle);
    setPartyMode(partyMode);

    const updated = currentSettings();
    io.emit('config:updated', updated);
    res.json(updated);
  });

  // Streams a tar.gz of MEDIA_DIR and the metadata directory straight to the
  // browser — no temp file, no Docker needed (unlike scripts/backup.sh),
  // since this runs with direct filesystem access to both already. Uses the
  // system `tar` binary (present on every platform this project targets)
  // rather than adding a new npm dependency just for this.
  router.get('/backup', (req, res) => {
    if (!checkAdminPassword(req.header('x-admin-password'))) {
      res.status(401).json({ error: 'Invalid password' });
      return;
    }

    const mediaParent = path.dirname(config.mediaDir);
    const mediaBase = path.basename(config.mediaDir);
    const dataDir = path.dirname(config.dbPath);
    const dataParent = path.dirname(dataDir);
    const dataBase = path.basename(dataDir);

    const timestamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
    const filename = `g33kvault-backup-${timestamp}.tar.gz`;

    const tar = spawn('tar', ['czf', '-', '-C', mediaParent, mediaBase, '-C', dataParent, dataBase]);

    tar.on('error', (err) => {
      console.error('Backup failed to start:', err);
      if (!res.headersSent) res.status(500).json({ error: 'Backup failed to start' });
    });

    let totalBytes = 0;
    const counter = new PassThrough();
    counter.on('data', (chunk: Buffer) => {
      totalBytes += chunk.length;
    });

    res.setHeader('Content-Type', 'application/gzip');
    res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);

    tar.stdout.pipe(counter).pipe(res);
    tar.stderr.on('data', (chunk: Buffer) => console.error('backup tar:', chunk.toString()));

    tar.on('close', (code) => {
      if (code === 0) {
        const info = setLastBackup({
          lastBackupAt: Date.now(),
          lastBackupSizeBytes: totalBytes,
          lastBackupItemCount: getAllMedia().length,
        });
        io.emit('config:updated', { ...currentSettings(), lastBackup: info });
      } else {
        console.error(`Backup tar exited with code ${code}`);
      }
    });
  });

  // Backfills content_hash/phash for any media that predates this feature
  // (or slipped through some other path without one), then groups by exact
  // file match and by near-identical perceptual hash. Backfilling here
  // rather than in a migration means a first scan on a large, long-running
  // gallery can take a while (one image decode per unhashed photo) — later
  // scans are fast, since everything's cached in the metadata store by then.
  router.get('/duplicates', async (req, res) => {
    if (!checkAdminPassword(req.header('x-admin-password'))) {
      res.status(401).json({ error: 'Invalid password' });
      return;
    }

    // Express 4 doesn't automatically turn an exception thrown inside an
    // async route handler into an HTTP response — without this try/catch,
    // anything unexpected here (a corrupted metadata entry, a file that's
    // gone missing from disk, whatever) would just hang the request instead
    // of failing cleanly.
    try {
      const media = getAllMedia();

      for (let i = 0; i < media.length; i++) {
        const item = media[i];
        const filePath = path.join(config.mediaDir, item.filename);
        const patch: { content_hash?: string; phash?: string | null } = {};

        if (item.content_hash === undefined) {
          try {
            patch.content_hash = computeContentHash(filePath);
          } catch (err) {
            console.error(`Could not hash ${item.filename}:`, err);
          }
        }

        if (item.phash === undefined) {
          try {
            patch.phash = item.kind === 'image' ? await computePerceptualHash(filePath) : null;
          } catch (err) {
            console.error(`Could not compute perceptual hash for ${item.filename}:`, err);
          }
        }

        if (Object.keys(patch).length > 0) {
          updateMedia(item.id, patch);
          Object.assign(item, patch);
        }

        // Broadcast over the same WebSocket the rest of the app already
        // uses for live updates, so /admin can show real progress on a
        // slow first scan instead of a blank "is this stuck?" wait. Cheap
        // enough to emit every item at the gallery sizes this app expects.
        io.emit('duplicates:progress', { current: i + 1, total: media.length });
      }

      res.json(findDuplicateGroups(media));
    } catch (err) {
      console.error('Duplicate scan failed:', err);
      res.status(500).json({ error: err instanceof Error ? err.message : 'Duplicate scan failed' });
    }
  });

  // Deletes every duplicate in one batch, keeping exactly one (the
  // earliest-uploaded) copy per duplicate cluster. Recomputes the grouping
  // and deletion plan itself rather than trusting ids the client sends —
  // the client's own copy of the groups can be stale by the time this runs,
  // and a client-supplied id list would let a stale request delete a photo
  // that's no longer actually a duplicate. One DB rewrite for the whole
  // batch (see deleteManyMedia) instead of one per item, which is what made
  // the previous client-side one-at-a-time approach slow enough to be
  // fragile at real gallery sizes.
  router.post('/duplicates/delete-all', (req, res) => {
    if (!checkAdminPassword(req.header('x-admin-password'))) {
      res.status(401).json({ error: 'Invalid password' });
      return;
    }

    try {
      const media = getAllMedia();
      const groups = findDuplicateGroups(media);
      const idsToDelete = planDuplicateDeletions(groups);

      if (idsToDelete.size === 0) {
        res.json({ deleted: 0 });
        return;
      }

      const removed = deleteManyMedia(idsToDelete);

      for (let i = 0; i < removed.length; i++) {
        const row = removed[i];
        fs.unlink(path.join(config.mediaDir, row.filename), () => {});
        io.emit('media:deleted', { id: row.id });
        io.emit('duplicates:deleteProgress', { current: i + 1, total: removed.length });
      }

      res.json({ deleted: removed.length });
    } catch (err) {
      console.error('Delete-all-duplicates failed:', err);
      res.status(500).json({ error: err instanceof Error ? err.message : 'Delete failed' });
    }
  });

  // Backfills photo_taken_at for any image that predates this feature (or
  // slipped through some other path without it) by reading EXIF from the
  // file as it exists right now. For a photo that arrived as HEIC, that file
  // was already converted to JPEG (and the original deleted) before this
  // feature existed, and JPEG re-encoded by heic-convert carries no EXIF at
  // all — so this will correctly find nothing for those, same as it would
  // for a screenshot or a booth capture. New uploads/imports no longer hit
  // this gap: they extract the date at ingestion time, before conversion.
  router.post('/photo-dates/scan', async (req, res) => {
    if (!checkAdminPassword(req.header('x-admin-password'))) {
      res.status(401).json({ error: 'Invalid password' });
      return;
    }

    try {
      const media = getAllMedia();
      let found = 0;

      for (let i = 0; i < media.length; i++) {
        const item = media[i];

        if (item.photo_taken_at === undefined) {
          let photoTakenAt: number | null = null;
          if (item.kind === 'image') {
            try {
              photoTakenAt = await extractPhotoTakenAt(path.join(config.mediaDir, item.filename));
            } catch (err) {
              console.error(`Could not extract photo date for ${item.filename}:`, err);
            }
          }

          const updated = updateMedia(item.id, { photo_taken_at: photoTakenAt });
          if (updated) {
            Object.assign(item, updated);
            io.emit('media:updated', updated);
          }
          if (photoTakenAt !== null) found++;
        }

        io.emit('photoDates:progress', { current: i + 1, total: media.length });
      }

      res.json({ scanned: media.length, found });
    } catch (err) {
      console.error('Photo-date scan failed:', err);
      res.status(500).json({ error: err instanceof Error ? err.message : 'Scan failed' });
    }
  });

  // Lists images below 640x480 (checked orientation-independently — see
  // lowResolution.ts) — usually a thumbnail, a resized re-upload, or a
  // screenshot rather than the original camera photo. Nothing is cached on
  // the row; every call re-reads dimensions fresh.
  router.get('/low-resolution', async (req, res) => {
    if (!checkAdminPassword(req.header('x-admin-password'))) {
      res.status(401).json({ error: 'Invalid password' });
      return;
    }

    try {
      const media = getAllMedia();
      const flagged = await scanLowResolutionImages(media, config.mediaDir, io, 'lowRes:progress');
      res.json({ items: flagged.map(({ item, width, height }) => ({ ...item, width, height })) });
    } catch (err) {
      console.error('Low-resolution scan failed:', err);
      res.status(500).json({ error: err instanceof Error ? err.message : 'Scan failed' });
    }
  });

  // Recomputes the low-resolution set itself rather than trusting ids the
  // client sends (same reasoning as duplicates/delete-all — a stale client
  // list could delete a photo that's no longer actually low-res, e.g. after
  // a rotation), then deletes all of them in one batch.
  router.post('/low-resolution/delete-all', async (req, res) => {
    if (!checkAdminPassword(req.header('x-admin-password'))) {
      res.status(401).json({ error: 'Invalid password' });
      return;
    }

    try {
      const media = getAllMedia();
      const flagged = await scanLowResolutionImages(media, config.mediaDir, io, 'lowRes:deleteProgress');
      const idsToDelete = new Set(flagged.map((f) => f.item.id));

      if (idsToDelete.size === 0) {
        res.json({ deleted: 0 });
        return;
      }

      const removed = deleteManyMedia(idsToDelete);
      for (const row of removed) {
        fs.unlink(path.join(config.mediaDir, row.filename), () => {});
        io.emit('media:deleted', { id: row.id });
      }

      res.json({ deleted: removed.length });
    } catch (err) {
      console.error('Delete-all-low-resolution failed:', err);
      res.status(500).json({ error: err instanceof Error ? err.message : 'Delete failed' });
    }
  });

  return router;
}
