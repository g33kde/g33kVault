import { Router } from 'express';
import { getAllMedia } from '../db';

export const statsRouter = Router();

statsRouter.get('/', (_req, res) => {
  const media = getAllMedia();
  const photos = media.filter((m) => m.kind === 'image').length;
  const videos = media.filter((m) => m.kind === 'video').length;
  const storageBytes = media.reduce((sum, m) => sum + m.size, 0);

  // Approximate, not a real headcount: the uploader name is optional free
  // text with no identity behind it, normalized (trimmed, lowercased) so
  // casing differences on the same name don't inflate the count. Anonymous
  // uploads (no name given) aren't counted at all, so this undercounts
  // actual contributors whenever names are skipped.
  const contributors = new Set(
    media
      .map((m) => m.uploader?.trim().toLowerCase())
      .filter((name): name is string => !!name)
  ).size;

  res.json({
    photos,
    videos,
    contributors,
    storageBytes,
    uptimeMs: Math.round(process.uptime() * 1000),
  });
});
