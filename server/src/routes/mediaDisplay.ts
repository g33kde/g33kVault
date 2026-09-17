import { Router } from 'express';
import path from 'path';
import { getDisplayPath } from '../displayCache';

// Serves a capped-resolution copy of a photo for the slideshow — see
// displayCache.ts for why. Never touches or replaces the original in
// mediaDir; this is purely an additional, regeneratable read path.
export function mediaDisplayRouter() {
  const router = Router();

  router.get('/:filename', async (req, res) => {
    const { filename } = req.params;
    // path.basename strips any directory components — the only defense this
    // route needs against path traversal, since (unlike /media) it isn't
    // backed by express.static's own built-in guard.
    if (filename !== path.basename(filename)) {
      res.status(400).end();
      return;
    }

    const filePath = await getDisplayPath(filename);
    res.sendFile(filePath, (err) => {
      if (err && !res.headersSent) res.status(404).end();
    });
  });

  return router;
}
