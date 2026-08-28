import { Router } from 'express';
import { getAllMedia } from '../db';

// No tracking of unique uploaders exists yet (uploads are anonymous — see
// README "Notes / ideas for later"), so this is a fixed placeholder until a
// real contributor-identity mechanism (e.g. a caption/name field) lands.
const CONTRIBUTORS_PLACEHOLDER = 107;

export const statsRouter = Router();

statsRouter.get('/', (_req, res) => {
  const media = getAllMedia();
  const photos = media.filter((m) => m.kind === 'image').length;
  const videos = media.filter((m) => m.kind === 'video').length;
  const storageBytes = media.reduce((sum, m) => sum + m.size, 0);

  res.json({
    photos,
    videos,
    contributors: CONTRIBUTORS_PLACEHOLDER,
    storageBytes,
    uptimeMs: Math.round(process.uptime() * 1000),
  });
});
