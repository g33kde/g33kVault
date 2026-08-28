import { Router } from 'express';
import { getSlideshowIntervalMs, getShuffle, getTransitionStyle, getPartyMode } from '../settings';

export const configRouter = Router();

configRouter.get('/', (_req, res) => {
  res.json({
    slideshowIntervalMs: getSlideshowIntervalMs(),
    shuffle: getShuffle(),
    transitionStyle: getTransitionStyle(),
    partyMode: getPartyMode(),
  });
});
