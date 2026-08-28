import { Router } from 'express';
import QRCode from 'qrcode';

const DESTINATIONS: Record<string, string> = {
  upload: '/upload',
  booth: '/booth',
};

function destPath(req: import('express').Request): string {
  const dest = typeof req.query.dest === 'string' ? req.query.dest : 'upload';
  return DESTINATIONS[dest] ?? DESTINATIONS.upload;
}

function urlFor(req: import('express').Request): string {
  const baseUrl = `${req.protocol}://${req.get('host')}`;
  return `${baseUrl}${destPath(req)}`;
}

export const qrcodeRouter = Router();

qrcodeRouter.get('/', async (req, res) => {
  try {
    const png = await QRCode.toBuffer(urlFor(req), { width: 400, margin: 1 });
    res.set('Content-Type', 'image/png');
    res.send(png);
  } catch (err) {
    res.status(500).json({ error: 'Failed to generate QR code' });
  }
});

export const uploadUrlRouter = Router();

uploadUrlRouter.get('/', (req, res) => {
  res.json({ url: urlFor(req) });
});
