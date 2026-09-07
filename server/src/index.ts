import express, { NextFunction, Request, Response } from 'express';
import http from 'http';
import path from 'path';
import cors from 'cors';
import { Server as SocketIOServer } from 'socket.io';
import { config } from './config';
import { mediaRouter } from './routes/media';
import { uploadRouter } from './routes/upload';
import { qrcodeRouter, uploadUrlRouter } from './routes/qrcode';
import { configRouter } from './routes/config';
import { adminRouter } from './routes/admin';
import { statsRouter } from './routes/stats';
import { scanImportFolder } from './importFolder';
import { logEvent, ensureGrafanaPushLoop } from './grafana/eventLog';
import { emitSystemSnapshot } from './grafana/snapshot';
import { classifyUserAgent } from './grafana/userAgent';

const app = express();
const server = http.createServer(app);
const io = new SocketIOServer(server, { cors: { origin: '*' } });

app.use(cors());
app.use(express.json());

// Access/device tracking for the Grafana "usage" category (see
// GRAFANA.md) — an explicit allowlist of actual page routes, not a
// blanket request logger, so this never logs asset/API/media traffic
// (which would be both noisy and pointless for "which pages get visited").
const TRACKED_PAGE_ROUTES = new Set(['/', '/upload', '/booth', '/slideshow', '/admin']);
app.use((req, _res, next) => {
  if (req.method === 'GET' && TRACKED_PAGE_ROUTES.has(req.path)) {
    const { deviceType, os, browser } = classifyUserAgent(req.header('user-agent'));
    logEvent('usage', 'page_view', { route: req.path, device_type: deviceType, os, browser });
  }
  next();
});

app.use('/media', express.static(config.mediaDir));
app.use('/api/media', mediaRouter(io));
app.use('/api/upload', uploadRouter(io));
app.use('/api/qrcode', qrcodeRouter);
app.use('/api/upload-url', uploadUrlRouter);
app.use('/api/config', configRouter);
app.use('/api/admin', adminRouter(io));
app.use('/api/stats', statsRouter);

const clientDist = path.join(__dirname, '..', 'public');
app.use(express.static(clientDist));
app.get('*', (_req, res) => {
  res.sendFile(path.join(clientDist, 'index.html'));
});

app.use((err: Error, _req: Request, res: Response, _next: NextFunction) => {
  console.error(err);
  res.status(400).json({ error: err.message || 'Unexpected error' });
});

// Live connection count feeds the Grafana "system" snapshot below — mainly
// useful for catching a slideshow accidentally left open on two screens, or
// an admin panel open longer than expected (see GRAFANA.md).
let liveConnectionCount = 0;
io.on('connection', (socket) => {
  liveConnectionCount++;
  socket.on('disconnect', () => {
    liveConnectionCount--;
  });
});

function runImportScan() {
  scanImportFolder(io)
    .then((imported) => {
      // Most scans find nothing new — only log the ones that actually
      // imported something, so a healthy watched folder doesn't produce a
      // stream of "imported: 0" noise on the same push interval as
      // everything else.
      if (imported > 0) logEvent('uploads', 'import_folder_scan', { imported });
    })
    .catch((err) => console.error('Import folder scan failed:', err));
}

runImportScan();
if (config.importScanIntervalMs > 0) {
  setInterval(runImportScan, config.importScanIntervalMs);
}

// Starts the Grafana push loop (a no-op each tick unless the integration is
// actually enabled and configured — see eventLog.ts). On the same timer, it
// also emits one "system" snapshot log line so gauge-like counts
// (photo/pending totals, free disk space, live connections) show up as a
// time series in Grafana too, not just event counts. Re-armed with a fresh
// interval whenever the admin changes the push-interval setting (see
// PUT /api/admin/grafana/settings) — that later call omits the snapshot
// callback and eventLog.ts keeps using this one, so both stay on the same
// cadence rather than drifting apart.
ensureGrafanaPushLoop(() => {
  emitSystemSnapshot(() => liveConnectionCount).catch((err) => console.error('Grafana snapshot failed:', err));
});

server.listen(config.port, () => {
  console.log(`g33kVault listening on port ${config.port}`);
  console.log(`Watching import folder: ${config.importDir}`);
});
