import { Router } from 'express';
import { config } from '../config';

export const configRouter = Router();

configRouter.get('/', (_req, res) => {
  res.json({ slideshowIntervalMs: config.slideshowIntervalMs });
});
