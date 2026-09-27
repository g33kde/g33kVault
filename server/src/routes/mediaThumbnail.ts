import { Router } from 'express';
import path from 'path';
import { getThumbnailPath } from '../thumbnailCache';

// Serves a small cached copy of a photo for /webpage's grid — see
// thumbnailCache.ts for why. Never touches or replaces the original in
// mediaDir; this is purely an additional, regeneratable read path, same
// pattern as routes/mediaDisplay.ts.
export function mediaThumbnailRouter() {
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

    const filePath = await getThumbnailPath(filename);
    res.sendFile(filePath, (err) => {
      if (err && !res.headersSent) res.status(404).end();
    });
  });

  return router;
}
