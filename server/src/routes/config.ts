import { Router } from 'express';
import {
  getSlideshowIntervalMs,
  getShuffle,
  getTransitionStyle,
  getPartyMode,
  getSlideshowEnabled,
  getCollageMode,
  getCollageLayout,
  getRequireApproval,
  getShowUploadQr,
  getShowBoothQr,
  getScaleSmallPhotos,
  getWebpageEnabled,
  getShowSlideshowButton,
  getEventImageUrl,
  getEventImageScale,
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
    requireApproval: getRequireApproval(),
    showUploadQr: getShowUploadQr(),
    showBoothQr: getShowBoothQr(),
    scaleSmallPhotos: getScaleSmallPhotos(),
    webpageEnabled: getWebpageEnabled(),
    showSlideshowButton: getShowSlideshowButton(),
    eventImageUrl: getEventImageUrl(),
    eventImageScale: getEventImageScale(),
  });
});
