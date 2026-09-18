import { Router } from 'express';
import path from 'path';
import type { Server as SocketIOServer } from 'socket.io';
import { config } from '../config';
import { getTrashedMedia, getMediaById, updateMedia, deleteMedia, deleteManyMedia } from '../db';
import { checkTrashPassword } from '../adminAuth';
import { restoreFromTrash, purgeFromTrash } from '../trash';
import { logEvent } from '../grafana/eventLog';

// Every route here checks the *trash* password, never the regular admin
// one (checkAdminPassword) — deliberately a separate secret (see
// config.ts's trashPassword) so holding the everyday admin password alone
// never grants access to this file, matching or restoring what it holds.
export function trashRouter(io: SocketIOServer) {
  const router = Router();

  router.post('/verify', (req, res) => {
    if (checkTrashPassword(req.header('x-trash-password'))) {
      res.status(204).end();
    } else {
      res.status(401).json({ error: 'Invalid password' });
    }
  });

  router.get('/', (req, res) => {
    if (!checkTrashPassword(req.header('x-trash-password'))) {
      res.status(401).json({ error: 'Invalid password' });
      return;
    }
    res.json(getTrashedMedia());
  });

  // A plain <img src> can't attach the X-Trash-Password header a GET here
  // needs, so the client fetches this manually (with the header) and turns
  // the response into an object URL — same reason config.trashDir is
  // nested as a dotfile under mediaDir rather than served by the existing
  // unauthenticated /media static mount (express.static ignores dotfile
  // paths by default, so /media/.trash/... 404s regardless; this route is
  // the only way to actually read a trashed file's bytes back out).
  router.get('/:id/file', (req, res) => {
    if (!checkTrashPassword(req.header('x-trash-password'))) {
      res.status(401).json({ error: 'Invalid password' });
      return;
    }

    const item = getMediaById(req.params.id);
    if (!item || item.status !== 'trashed') {
      res.status(404).json({ error: 'Not found in Trash' });
      return;
    }

    res.sendFile(path.join(config.trashDir, item.filename));
  });

  // Moves a trashed item back to the live gallery — the exact reverse of
  // routes/media.ts's DELETE /:id. trashed_at is cleared (set to undefined,
  // which JSON.stringify drops) rather than left stale, so a later re-trash
  // of the same item always reflects *that* trip through Trash.
  router.post('/:id/restore', (req, res) => {
    if (!checkTrashPassword(req.header('x-trash-password'))) {
      res.status(401).json({ error: 'Invalid password' });
      return;
    }

    const item = getMediaById(req.params.id);
    if (!item || item.status !== 'trashed') {
      res.status(404).json({ error: 'Not found in Trash' });
      return;
    }

    restoreFromTrash(item.filename);
    const restored = updateMedia(item.id, { status: 'approved', trashed_at: undefined });
    logEvent('moderation', 'trash_item_restored', { kind: item.kind });
    io.emit('media:restored', restored);
    res.json(restored);
  });

  // Permanently deletes one trashed item — the point of no return for
  // whatever routes/media.ts's delete/delete-batch only *moved* into
  // Trash. Only reachable with the trash password, same as every route in
  // this file.
  router.delete('/:id', (req, res) => {
    if (!checkTrashPassword(req.header('x-trash-password'))) {
      res.status(401).json({ error: 'Invalid password' });
      return;
    }

    const item = getMediaById(req.params.id);
    if (!item || item.status !== 'trashed') {
      res.status(404).json({ error: 'Not found in Trash' });
      return;
    }

    purgeFromTrash(item.filename);
    deleteMedia(item.id);
    logEvent('moderation', 'trash_item_purged', { kind: item.kind });
    res.status(204).end();
  });

  // Permanently deletes everything currently in Trash in one batch —
  // recomputes the set itself (getTrashedMedia()) rather than trusting an
  // id list from the client, since "empty trash" always means "everything
  // in there right now," not a specific hand-picked subset (that's what
  // the single-item DELETE above is for).
  router.post('/empty', (req, res) => {
    if (!checkTrashPassword(req.header('x-trash-password'))) {
      res.status(401).json({ error: 'Invalid password' });
      return;
    }

    const items = getTrashedMedia();
    if (items.length === 0) {
      res.json({ deleted: 0 });
      return;
    }

    for (let i = 0; i < items.length; i++) {
      purgeFromTrash(items[i].filename);
      io.emit('trash:emptyProgress', { current: i + 1, total: items.length });
    }

    deleteManyMedia(new Set(items.map((i) => i.id)));
    logEvent('moderation', 'trash_emptied', { count: items.length });
    res.json({ deleted: items.length });
  });

  return router;
}
