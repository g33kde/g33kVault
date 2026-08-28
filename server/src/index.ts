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

const app = express();
const server = http.createServer(app);
const io = new SocketIOServer(server, { cors: { origin: '*' } });

app.use(cors());
app.use(express.json());

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

io.on('connection', (socket) => {
  socket.on('disconnect', () => {});
});

function runImportScan() {
  scanImportFolder(io).catch((err) => console.error('Import folder scan failed:', err));
}

runImportScan();
if (config.importScanIntervalMs > 0) {
  setInterval(runImportScan, config.importScanIntervalMs);
}

server.listen(config.port, () => {
  console.log(`g33kVault listening on port ${config.port}`);
  console.log(`Watching import folder: ${config.importDir}`);
});
