import { Router } from 'express';
import fs from 'fs';
import path from 'path';
import type { Server as SocketIOServer } from 'socket.io';
import { config } from '../config';
import { getAllMedia, deleteMedia } from '../db';
import { checkAdminPassword } from '../adminAuth';

export function mediaRouter(io: SocketIOServer) {
  const router = Router();

  router.get('/', (_req, res) => {
    res.json(getAllMedia());
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
