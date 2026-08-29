import { Router } from 'express';
import path from 'path';
import { spawn } from 'child_process';
import { PassThrough } from 'stream';
import type { Server as SocketIOServer } from 'socket.io';
import { checkAdminPassword } from '../adminAuth';
import { config } from '../config';
import { getAllMedia, updateMedia } from '../db';
import { computeContentHash, computePerceptualHash, findDuplicateGroups } from '../duplicateDetect';
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

    const media = getAllMedia();

    for (const item of media) {
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
        patch.phash = item.kind === 'image' ? await computePerceptualHash(filePath) : null;
      }

      if (Object.keys(patch).length > 0) {
        updateMedia(item.id, patch);
        Object.assign(item, patch);
      }
    }

    res.json(findDuplicateGroups(media));
  });

  return router;
}
