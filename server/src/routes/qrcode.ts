import { Router } from 'express';
import QRCode from 'qrcode';

function uploadUrlFor(req: import('express').Request): string {
  const baseUrl = `${req.protocol}://${req.get('host')}`;
  return `${baseUrl}/upload`;
}

export const qrcodeRouter = Router();

qrcodeRouter.get('/', async (req, res) => {
  try {
    const png = await QRCode.toBuffer(uploadUrlFor(req), { width: 400, margin: 1 });
    res.set('Content-Type', 'image/png');
    res.send(png);
  } catch (err) {
    res.status(500).json({ error: 'Failed to generate QR code' });
  }
});

export const uploadUrlRouter = Router();

uploadUrlRouter.get('/', (req, res) => {
  res.json({ url: uploadUrlFor(req) });
});
