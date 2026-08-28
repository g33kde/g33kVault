import { Router } from 'express';
import type { Server as SocketIOServer } from 'socket.io';
import { checkAdminPassword } from '../adminAuth';
import {
  getSlideshowIntervalMs,
  setSlideshowIntervalMs,
  getShuffle,
  setShuffle,
  getTransitionStyle,
  setTransitionStyle,
  getPartyMode,
  setPartyMode,
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

  return router;
}
