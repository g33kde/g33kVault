import { Router } from 'express';
import { getApprovedMedia, getAllMedia } from '../db';

// Shared with the Grafana "system" snapshot (see grafana/eventLog.ts /
// index.ts's snapshot loop) so both compute counts the exact same way —
// factored out rather than duplicated.
export function computeStats() {
  const media = getApprovedMedia();
  const photos = media.filter((m) => m.kind === 'image').length;
  const videos = media.filter((m) => m.kind === 'video').length;
  const storageBytes = media.reduce((sum, m) => sum + m.size, 0);
  const pending = getAllMedia().filter((m) => m.status === 'pending').length;

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

  return {
    photos,
    videos,
    pending,
    contributors,
    storageBytes,
    uptimeMs: Math.round(process.uptime() * 1000),
  };
}

export const statsRouter = Router();

statsRouter.get('/', (_req, res) => {
  res.json(computeStats());
});
