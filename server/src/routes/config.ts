import { Router } from 'express';
import {
  getSlideshowIntervalMs,
  getShuffle,
  getTransitionStyle,
  getPartyMode,
  getSlideshowEnabled,
  getCollageMode,
  getCollageLayout,
} from '../settings';

export const configRouter = Router();

configRouter.get('/', (_req, res) => {
  res.json({
    slideshowIntervalMs: getSlideshowIntervalMs(),
    shuffle: getShuffle(),
    transitionStyle: getTransitionStyle(),
    partyMode: getPartyMode(),
    slideshowEnabled: getSlideshowEnabled(),
    collageMode: getCollageMode(),
    collageLayout: getCollageLayout(),
  });
});
