import { Router } from 'express';
import { getAllMedia } from '../db';

export const mediaRouter = Router();

mediaRouter.get('/', (_req, res) => {
  res.json(getAllMedia());
});
