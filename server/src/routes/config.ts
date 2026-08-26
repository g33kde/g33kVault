import { Router } from 'express';
import { getSlideshowIntervalMs } from '../settings';

export const configRouter = Router();

configRouter.get('/', (_req, res) => {
  res.json({ slideshowIntervalMs: getSlideshowIntervalMs() });
});
