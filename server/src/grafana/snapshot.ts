import fs from 'fs';
import { config } from '../config';
import { computeStats } from '../routes/stats';
import { logEvent } from './eventLog';

// Point-in-time counts (photo/video/pending totals, live connections) don't
// have a natural "event" to log when they change — a snapshot log line,
// emitted on the same cadence as the push loop, is how Grafana gets
// gauge-like time series out of a pure event log (a LogQL `| unwrap` on
// each numeric field turns this back into a normal-looking metric). See
// GRAFANA.md.
export async function emitSystemSnapshot(getConnectionCount: () => number): Promise<void> {
  const stats = computeStats();
  const freeDiskBytes = await mediaDirFreeBytes();

  logEvent('system', 'snapshot', {
    photos: stats.photos,
    videos: stats.videos,
    pending: stats.pending,
    contributors: stats.contributors,
    storage_bytes: stats.storageBytes,
    free_disk_bytes: freeDiskBytes,
    live_connections: getConnectionCount(),
    uptime_ms: stats.uptimeMs,
  });
}

// null when unavailable rather than throwing — fs.statfs isn't guaranteed
// on every platform/filesystem this could run on (e.g. some container
// overlay filesystems), and "no disk-space reading this cycle" is a much
// better failure mode than crashing the snapshot loop over it.
async function mediaDirFreeBytes(): Promise<number | null> {
  try {
    const stat = await fs.promises.statfs(config.mediaDir);
    return stat.bavail * stat.bsize;
  } catch {
    return null;
  }
}
