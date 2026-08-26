import { Router } from 'express';
import type { Server as SocketIOServer } from 'socket.io';
import { checkAdminPassword } from '../adminAuth';
import { getSlideshowIntervalMs, setSlideshowIntervalMs } from '../settings';

const MIN_INTERVAL_MS = 1000;
const MAX_INTERVAL_MS = 10 * 60 * 1000;

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
    res.json({ slideshowIntervalMs: getSlideshowIntervalMs() });
  });

  router.put('/settings', (req, res) => {
    if (!checkAdminPassword(req.header('x-admin-password'))) {
      res.status(401).json({ error: 'Invalid password' });
      return;
    }

    const { slideshowIntervalMs } = req.body ?? {};
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

    const updated = setSlideshowIntervalMs(Math.round(slideshowIntervalMs));
    io.emit('config:updated', { slideshowIntervalMs: updated });
    res.json({ slideshowIntervalMs: updated });
  });

  return router;
}
