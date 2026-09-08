import { Router } from 'express';
import fs from 'fs';
import path from 'path';
import { spawn } from 'child_process';
import { PassThrough } from 'stream';
import type { Server as SocketIOServer } from 'socket.io';
import { checkAdminPassword } from '../adminAuth';
import { config } from '../config';
import { getAllMedia, getApprovedMedia, updateMedia, updateManyMedia, deleteManyMedia, MediaRow } from '../db';
import { computeContentHash, computePerceptualHash, findDuplicateGroups, planDuplicateDeletions } from '../duplicateDetect';
import { extractPhotoTakenAt } from '../photoDate';
import { getImageDimensions, isLowResolution, makeThreshold, ResolutionThreshold } from '../lowResolution';
import {
  getSlideshowIntervalMs,
  setSlideshowIntervalMs,
  getShuffle,
  setShuffle,
  getTransitionStyle,
  setTransitionStyle,
  getPartyMode,
  setPartyMode,
  getSlideshowEnabled,
  setSlideshowEnabled,
  getRequireApproval,
  setRequireApproval,
  getCollageMode,
  setCollageMode,
  getCollageLayout,
  setCollageLayout,
  getLastBackup,
  setLastBackup,
  getGrafanaEnabled,
  setGrafanaEnabled,
  getGrafanaCategories,
  setGrafanaCategories,
  getGrafanaPushIntervalMs,
  setGrafanaPushIntervalMs,
  setGrafanaInstanceLabel,
  TRANSITION_STYLES,
  TransitionStyle,
  COLLAGE_MODES,
  CollageMode,
  COLLAGE_LAYOUTS,
  CollageLayout,
  GRAFANA_CATEGORIES,
  GrafanaCategory,
  GRAFANA_PUSH_INTERVALS_MS,
  GrafanaPushIntervalMs,
} from '../settings';
import { getGrafanaStatus, sendGrafanaTestEvent, ensureGrafanaPushLoop, logEvent } from '../grafana/eventLog';

const MIN_INTERVAL_MS = 1000;
const MAX_INTERVAL_MS = 10 * 60 * 1000;

function currentSettings() {
  return {
    slideshowIntervalMs: getSlideshowIntervalMs(),
    shuffle: getShuffle(),
    transitionStyle: getTransitionStyle(),
    partyMode: getPartyMode(),
    slideshowEnabled: getSlideshowEnabled(),
    collageMode: getCollageMode(),
    collageLayout: getCollageLayout(),
    requireApproval: getRequireApproval(),
    lastBackup: getLastBackup(),
  };
}

interface LowResResult {
  item: MediaRow;
  width: number;
  height: number;
}

// Query params come in as strings (or arrays, or missing) — this is the one
// place that turns req.query.maxWidth/maxHeight into a real threshold or
// null, so both routes below reject the same way rather than one silently
// falling back to a default the admin didn't ask for.
function parseThresholdQuery(query: Record<string, unknown>): ResolutionThreshold | null {
  const a = Number(query.maxWidth);
  const b = Number(query.maxHeight);
  if (!Number.isFinite(a) || !Number.isFinite(b) || a <= 0 || b <= 0) return null;
  return makeThreshold(a, b);
}

// Shared by the scan route and the delete-all route below, so both agree on
// exactly which images count as low-resolution — recomputed fresh each call
// rather than cached on the row, since dimensions are cheap to read (just
// the image header, not a full decode) and a rotation swaps width/height,
// which could otherwise make a stale cached flag wrong.
async function scanLowResolutionImages(
  media: MediaRow[],
  mediaDir: string,
  io: SocketIOServer,
  progressEvent: string,
  threshold: ResolutionThreshold
): Promise<LowResResult[]> {
  const images = media.filter((m) => m.kind === 'image');
  const flagged: LowResResult[] = [];

  for (let i = 0; i < images.length; i++) {
    const item = images[i];
    const dims = await getImageDimensions(path.join(mediaDir, item.filename));
    if (dims && isLowResolution(dims, threshold)) {
      flagged.push({ item, width: dims.width, height: dims.height });
    }
    io.emit(progressEvent, { current: i + 1, total: images.length });
  }

  return flagged;
}

export function adminRouter(io: SocketIOServer) {
  const router = Router();

  router.post('/verify', (req, res) => {
    if (checkAdminPassword(req.header('x-admin-password'))) {
      res.status(204).end();
    } else {
      res.status(401).json({ error: 'Invalid password' });
    }
  });

  router.get('/settings', (req, res) => {
    if (!checkAdminPassword(req.header('x-admin-password'))) {
      res.status(401).json({ error: 'Invalid password' });
      return;
    }
    res.json(currentSettings());
  });

  router.put('/settings', (req, res) => {
    if (!checkAdminPassword(req.header('x-admin-password'))) {
      res.status(401).json({ error: 'Invalid password' });
      return;
    }

    const {
      slideshowIntervalMs,
      shuffle,
      transitionStyle,
      partyMode,
      slideshowEnabled,
      collageMode,
      collageLayout,
      requireApproval,
    } = req.body ?? {};

    if (
      typeof slideshowIntervalMs !== 'number' ||
      !Number.isFinite(slideshowIntervalMs) ||
      slideshowIntervalMs < MIN_INTERVAL_MS ||
      slideshowIntervalMs > MAX_INTERVAL_MS
    ) {
      res.status(400).json({
        error: `slideshowIntervalMs must be a number between ${MIN_INTERVAL_MS} and ${MAX_INTERVAL_MS}`,
      });
      return;
    }

    if (typeof shuffle !== 'boolean') {
      res.status(400).json({ error: 'shuffle must be a boolean' });
      return;
    }

    if (typeof transitionStyle !== 'string' || !TRANSITION_STYLES.includes(transitionStyle as TransitionStyle)) {
      res.status(400).json({ error: `transitionStyle must be one of: ${TRANSITION_STYLES.join(', ')}` });
      return;
    }

    if (typeof partyMode !== 'boolean') {
      res.status(400).json({ error: 'partyMode must be a boolean' });
      return;
    }

    if (typeof slideshowEnabled !== 'boolean') {
      res.status(400).json({ error: 'slideshowEnabled must be a boolean' });
      return;
    }

    if (typeof collageMode !== 'string' || !COLLAGE_MODES.includes(collageMode as CollageMode)) {
      res.status(400).json({ error: `collageMode must be one of: ${COLLAGE_MODES.join(', ')}` });
      return;
    }

    if (typeof collageLayout !== 'string' || !COLLAGE_LAYOUTS.includes(collageLayout as CollageLayout)) {
      res.status(400).json({ error: `collageLayout must be one of: ${COLLAGE_LAYOUTS.join(', ')}` });
      return;
    }

    if (typeof requireApproval !== 'boolean') {
      res.status(400).json({ error: 'requireApproval must be a boolean' });
      return;
    }

    setSlideshowIntervalMs(Math.round(slideshowIntervalMs));
    setShuffle(shuffle);
    setTransitionStyle(transitionStyle as TransitionStyle);
    setPartyMode(partyMode);
    setSlideshowEnabled(slideshowEnabled);
    setCollageMode(collageMode as CollageMode);
    setCollageLayout(collageLayout as CollageLayout);
    setRequireApproval(requireApproval);

    const updated = currentSettings();
    logEvent('moderation', 'settings_changed', updated);
    io.emit('config:updated', updated);
    res.json(updated);
  });

  // See GRAFANA.md. `configured` reflects whether the GRAFANA_CLOUD_* env
  // vars are set — this route never echoes their actual values back, only
  // whether they're present, and the live connection status (last
  // push/error) from eventLog.ts's in-memory state.
  router.get('/grafana/status', (req, res) => {
    if (!checkAdminPassword(req.header('x-admin-password'))) {
      res.status(401).json({ error: 'Invalid password' });
      return;
    }
    res.json(getGrafanaStatus());
  });

  router.put('/grafana/settings', (req, res) => {
    if (!checkAdminPassword(req.header('x-admin-password'))) {
      res.status(401).json({ error: 'Invalid password' });
      return;
    }

    const { enabled, categories, pushIntervalMs, instanceLabel } = req.body ?? {};

    if (typeof enabled !== 'boolean') {
      res.status(400).json({ error: 'enabled must be a boolean' });
      return;
    }

    if (
      !Array.isArray(categories) ||
      categories.length === 0 ||
      !categories.every((c) => GRAFANA_CATEGORIES.includes(c))
    ) {
      res.status(400).json({ error: `categories must be a non-empty array of: ${GRAFANA_CATEGORIES.join(', ')}` });
      return;
    }

    if (!GRAFANA_PUSH_INTERVALS_MS.includes(pushIntervalMs)) {
      res.status(400).json({ error: `pushIntervalMs must be one of: ${GRAFANA_PUSH_INTERVALS_MS.join(', ')}` });
      return;
    }

    if (typeof instanceLabel !== 'string') {
      res.status(400).json({ error: 'instanceLabel must be a string' });
      return;
    }

    setGrafanaEnabled(enabled);
    setGrafanaCategories(categories as GrafanaCategory[]);
    setGrafanaPushIntervalMs(pushIntervalMs as GrafanaPushIntervalMs);
    // Blank clears back to the auto-generated id (see settings.ts) rather
    // than rejecting an empty string — an admin clearing the field is a
    // reasonable way to say "stop calling it that."
    setGrafanaInstanceLabel(instanceLabel);
    ensureGrafanaPushLoop();

    res.json(getGrafanaStatus());
  });

  // A real push, independent of the enabled toggle and the persistent
  // buffer — lets an admin verify GRAFANA_CLOUD_* credentials actually work
  // before flipping the integration on for real.
  router.post('/grafana/test', async (req, res) => {
    if (!checkAdminPassword(req.header('x-admin-password'))) {
      res.status(401).json({ error: 'Invalid password' });
      return;
    }

    const result = await sendGrafanaTestEvent();
    if (result.ok) {
      res.json({ ok: true });
    } else {
      res.status(502).json({ ok: false, error: result.error });
    }
  });

  // Streams a tar.gz of MEDIA_DIR and the metadata directory straight to the
  // browser — no temp file, no Docker needed (unlike scripts/backup.sh),
  // since this runs with direct filesystem access to both already. Uses the
  // system `tar` binary (present on every platform this project targets)
  // rather than adding a new npm dependency just for this.
  router.get('/backup', (req, res) => {
    if (!checkAdminPassword(req.header('x-admin-password'))) {
      res.status(401).json({ error: 'Invalid password' });
      return;
    }

    const mediaParent = path.dirname(config.mediaDir);
    const mediaBase = path.basename(config.mediaDir);
    const dataDir = path.dirname(config.dbPath);
    const dataParent = path.dirname(dataDir);
    const dataBase = path.basename(dataDir);

    const timestamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
    const filename = `g33kvault-backup-${timestamp}.tar.gz`;

    const tar = spawn('tar', ['czf', '-', '-C', mediaParent, mediaBase, '-C', dataParent, dataBase]);

    tar.on('error', (err) => {
      console.error('Backup failed to start:', err);
      if (!res.headersSent) res.status(500).json({ error: 'Backup failed to start' });
    });

    let totalBytes = 0;
    const counter = new PassThrough();
    counter.on('data', (chunk: Buffer) => {
      totalBytes += chunk.length;
    });

    res.setHeader('Content-Type', 'application/gzip');
    res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);

    tar.stdout.pipe(counter).pipe(res);
    tar.stderr.on('data', (chunk: Buffer) => console.error('backup tar:', chunk.toString()));

    tar.on('close', (code) => {
      if (code === 0) {
        const info = setLastBackup({
          lastBackupAt: Date.now(),
          lastBackupSizeBytes: totalBytes,
          lastBackupItemCount: getAllMedia().length,
        });
        logEvent('moderation', 'backup_completed', {
          size_bytes: info.lastBackupSizeBytes,
          item_count: info.lastBackupItemCount,
        });
        io.emit('config:updated', { ...currentSettings(), lastBackup: info });
      } else {
        console.error(`Backup tar exited with code ${code}`);
      }
    });
  });

  // Backfills content_hash/phash for any media that predates this feature
  // (or slipped through some other path without one), then groups by exact
  // file match and by near-identical perceptual hash. Backfilling here
  // rather than in a migration means a first scan on a large, long-running
  // gallery can take a while (one image decode per unhashed photo) — later
  // scans are fast, since everything's cached in the metadata store by then.
  router.get('/duplicates', async (req, res) => {
    if (!checkAdminPassword(req.header('x-admin-password'))) {
      res.status(401).json({ error: 'Invalid password' });
      return;
    }

    // Express 4 doesn't automatically turn an exception thrown inside an
    // async route handler into an HTTP response — without this try/catch,
    // anything unexpected here (a corrupted metadata entry, a file that's
    // gone missing from disk, whatever) would just hang the request instead
    // of failing cleanly.
    try {
      const media = getApprovedMedia();

      for (let i = 0; i < media.length; i++) {
        const item = media[i];
        const filePath = path.join(config.mediaDir, item.filename);
        const patch: { content_hash?: string; phash?: string | null } = {};

        if (item.content_hash === undefined) {
          try {
            patch.content_hash = await computeContentHash(filePath);
          } catch (err) {
            console.error(`Could not hash ${item.filename}:`, err);
          }
        }

        if (item.phash === undefined) {
          try {
            patch.phash = item.kind === 'image' ? await computePerceptualHash(filePath) : null;
          } catch (err) {
            console.error(`Could not compute perceptual hash for ${item.filename}:`, err);
          }
        }

        if (Object.keys(patch).length > 0) {
          updateMedia(item.id, patch);
          Object.assign(item, patch);
        }

        // Broadcast over the same WebSocket the rest of the app already
        // uses for live updates, so /admin can show real progress on a
        // slow first scan instead of a blank "is this stuck?" wait. Cheap
        // enough to emit every item at the gallery sizes this app expects.
        io.emit('duplicates:progress', { current: i + 1, total: media.length });
      }

      res.json(findDuplicateGroups(media));
    } catch (err) {
      console.error('Duplicate scan failed:', err);
      res.status(500).json({ error: err instanceof Error ? err.message : 'Duplicate scan failed' });
    }
  });

  // Deletes every duplicate in one batch, keeping exactly one (the
  // earliest-uploaded) copy per duplicate cluster. Recomputes the grouping
  // and deletion plan itself rather than trusting ids the client sends —
  // the client's own copy of the groups can be stale by the time this runs,
  // and a client-supplied id list would let a stale request delete a photo
  // that's no longer actually a duplicate. One DB rewrite for the whole
  // batch (see deleteManyMedia) instead of one per item, which is what made
  // the previous client-side one-at-a-time approach slow enough to be
  // fragile at real gallery sizes.
  router.post('/duplicates/delete-all', (req, res) => {
    if (!checkAdminPassword(req.header('x-admin-password'))) {
      res.status(401).json({ error: 'Invalid password' });
      return;
    }

    try {
      const media = getApprovedMedia();
      const groups = findDuplicateGroups(media);
      const idsToDelete = planDuplicateDeletions(groups);

      if (idsToDelete.size === 0) {
        res.json({ deleted: 0 });
        return;
      }

      const removed = deleteManyMedia(idsToDelete);

      for (let i = 0; i < removed.length; i++) {
        const row = removed[i];
        fs.unlink(path.join(config.mediaDir, row.filename), () => {});
        io.emit('media:deleted', { id: row.id });
        io.emit('duplicates:deleteProgress', { current: i + 1, total: removed.length });
      }

      logEvent('moderation', 'duplicates_deleted', { count: removed.length });
      res.json({ deleted: removed.length });
    } catch (err) {
      console.error('Delete-all-duplicates failed:', err);
      res.status(500).json({ error: err instanceof Error ? err.message : 'Delete failed' });
    }
  });

  // Backfills photo_taken_at for any image that predates this feature (or
  // slipped through some other path without it) by reading EXIF from the
  // file as it exists right now. For a photo that arrived as HEIC, that file
  // was already converted to JPEG (and the original deleted) before this
  // feature existed, and JPEG re-encoded by heic-convert carries no EXIF at
  // all — so this will correctly find nothing for those, same as it would
  // for a screenshot or a booth capture. New uploads/imports no longer hit
  // this gap: they extract the date at ingestion time, before conversion.
  router.post('/photo-dates/scan', async (req, res) => {
    if (!checkAdminPassword(req.header('x-admin-password'))) {
      res.status(401).json({ error: 'Invalid password' });
      return;
    }

    try {
      const media = getApprovedMedia();
      let found = 0;

      for (let i = 0; i < media.length; i++) {
        const item = media[i];

        if (item.photo_taken_at === undefined) {
          let photoTakenAt: number | null = null;
          if (item.kind === 'image') {
            try {
              photoTakenAt = await extractPhotoTakenAt(path.join(config.mediaDir, item.filename));
            } catch (err) {
              console.error(`Could not extract photo date for ${item.filename}:`, err);
            }
          }

          const updated = updateMedia(item.id, { photo_taken_at: photoTakenAt });
          if (updated) {
            Object.assign(item, updated);
            io.emit('media:updated', updated);
          }
          if (photoTakenAt !== null) found++;
        }

        io.emit('photoDates:progress', { current: i + 1, total: media.length });
      }

      res.json({ scanned: media.length, found });
    } catch (err) {
      console.error('Photo-date scan failed:', err);
      res.status(500).json({ error: err instanceof Error ? err.message : 'Scan failed' });
    }
  });

  // Lists images at or below an admin-chosen threshold (?maxWidth=&maxHeight=,
  // checked orientation-independently — see lowResolution.ts) — usually a
  // thumbnail, a resized re-upload, or a screenshot rather than the original
  // camera photo. Nothing is cached on the row; every call re-reads
  // dimensions fresh.
  router.get('/low-resolution', async (req, res) => {
    if (!checkAdminPassword(req.header('x-admin-password'))) {
      res.status(401).json({ error: 'Invalid password' });
      return;
    }

    const threshold = parseThresholdQuery(req.query);
    if (!threshold) {
      res.status(400).json({ error: 'maxWidth and maxHeight must be positive numbers' });
      return;
    }

    try {
      const media = getApprovedMedia();
      const flagged = await scanLowResolutionImages(media, config.mediaDir, io, 'lowRes:progress', threshold);
      res.json({ items: flagged.map(({ item, width, height }) => ({ ...item, width, height })) });
    } catch (err) {
      console.error('Low-resolution scan failed:', err);
      res.status(500).json({ error: err instanceof Error ? err.message : 'Scan failed' });
    }
  });

  // Recomputes the low-resolution set itself rather than trusting ids the
  // client sends (same reasoning as duplicates/delete-all — a stale client
  // list could delete a photo that's no longer actually low-res, e.g. after
  // a rotation), then deletes all of them in one batch. Takes the same
  // ?maxWidth=&maxHeight= as the scan — the client always sends whatever
  // threshold it just scanned with, so this can't delete against a
  // different, stale threshold.
  router.post('/low-resolution/delete-all', async (req, res) => {
    if (!checkAdminPassword(req.header('x-admin-password'))) {
      res.status(401).json({ error: 'Invalid password' });
      return;
    }

    const threshold = parseThresholdQuery(req.query);
    if (!threshold) {
      res.status(400).json({ error: 'maxWidth and maxHeight must be positive numbers' });
      return;
    }

    try {
      const media = getApprovedMedia();
      const flagged = await scanLowResolutionImages(media, config.mediaDir, io, 'lowRes:deleteProgress', threshold);
      const idsToDelete = new Set(flagged.map((f) => f.item.id));

      if (idsToDelete.size === 0) {
        res.json({ deleted: 0 });
        return;
      }

      const removed = deleteManyMedia(idsToDelete);
      for (const row of removed) {
        fs.unlink(path.join(config.mediaDir, row.filename), () => {});
        io.emit('media:deleted', { id: row.id });
      }

      logEvent('moderation', 'low_resolution_deleted', { count: removed.length });
      res.json({ deleted: removed.length });
    } catch (err) {
      console.error('Delete-all-low-resolution failed:', err);
      res.status(500).json({ error: err instanceof Error ? err.message : 'Delete failed' });
    }
  });

  // Lists every batch of photos extracted from a guest-uploaded archive
  // that's still awaiting review, grouped by batchId — one entry per
  // archive upload, not per photo.
  router.get('/pending-batches', (req, res) => {
    if (!checkAdminPassword(req.header('x-admin-password'))) {
      res.status(401).json({ error: 'Invalid password' });
      return;
    }

    try {
      const pending = getAllMedia().filter((m) => m.status === 'pending');
      const batches = new Map<string, { batchId: string; batchLabel: string; uploader: string | null; createdAt: number; items: MediaRow[] }>();

      for (const item of pending) {
        const batchId = item.batchId ?? item.id;
        const existing = batches.get(batchId);
        if (existing) {
          existing.items.push(item);
          existing.createdAt = Math.min(existing.createdAt, item.created_at);
        } else {
          batches.set(batchId, {
            batchId,
            batchLabel: item.batchLabel ?? 'Uploaded archive',
            uploader: item.uploader ?? null,
            createdAt: item.created_at,
            items: [item],
          });
        }
      }

      res.json([...batches.values()].sort((a, b) => a.createdAt - b.createdAt));
    } catch (err) {
      console.error('Listing pending batches failed:', err);
      res.status(500).json({ error: err instanceof Error ? err.message : 'Could not list pending uploads' });
    }
  });

  // Approves every pending batch in one click, for clearing out a backlog
  // (e.g. after leaving "Require approval for uploads" on for a while)
  // without reviewing each one individually. Same highlight-vs-quiet rule
  // as approving a single batch below, but judged across everything being
  // approved by this one action rather than per batch — otherwise a
  // backlog of, say, 15 single-photo pending uploads (15 separate
  // "batches" of one) would fire 15 disruptive highlights back to back,
  // exactly what the quiet 'media:approved' path exists to avoid. Only
  // the genuinely common case — approving all of it when there's just one
  // photo pending, period — gets the highlight.
  router.post('/pending-batches/approve-all', (req, res) => {
    if (!checkAdminPassword(req.header('x-admin-password'))) {
      res.status(401).json({ error: 'Invalid password' });
      return;
    }

    try {
      const ids = new Set(getAllMedia().filter((m) => m.status === 'pending').map((m) => m.id));

      if (ids.size === 0) {
        res.json({ approved: 0 });
        return;
      }

      const updated = updateManyMedia(ids, { status: 'approved' });
      const event = updated.length === 1 ? 'media:new' : 'media:approved';
      for (const row of updated) {
        io.emit(event, row);
      }

      logEvent('moderation', 'batch_approved', { count: updated.length, via: 'approve_all' });
      res.json({ approved: updated.length });
    } catch (err) {
      console.error('Approving all pending batches failed:', err);
      res.status(500).json({ error: err instanceof Error ? err.message : 'Approve failed' });
    }
  });

  // Which pending items in a batch a request actually targets — every item
  // (the plain "Approve All"/"Reject All" case, req.body empty/omitted), or
  // just an admin-picked subset (the "Approve Selected"/"Reject Selected"
  // case, req.body.ids). Recomputed against the batch's own current pending
  // items either way rather than trusting the client's list wholesale — a
  // requested id that isn't actually a pending member of this batch (stale
  // client state, or someone poking the API directly) is silently dropped,
  // never lets a request reach outside the batch it named.
  function resolveBatchTargetIds(batchId: string, requestedIds: unknown): Set<string> {
    const batchItems = getAllMedia().filter((m) => m.status === 'pending' && m.batchId === batchId);
    if (!Array.isArray(requestedIds) || requestedIds.length === 0) {
      return new Set(batchItems.map((m) => m.id));
    }
    const batchItemIds = new Set(batchItems.map((m) => m.id));
    return new Set(requestedIds.filter((id): id is string => typeof id === 'string' && batchItemIds.has(id)));
  }

  // Flips the targeted photo(s) to approved in one write, so they start
  // showing up in the public gallery/slideshow and the admin gallery grid.
  // Exactly one item approved — a single web-upload held for approval
  // (requireApproval setting), the rare one-photo archive, or an admin
  // selecting just one photo out of a bigger batch — gets the normal
  // 'media:new' treatment, the same "New Upload" highlight it would have
  // gotten if approval had been off; more than one instead gets the
  // quieter 'media:approved' per item, since dozens of disruptive
  // highlights back to back for one approved archive would be worse than
  // no highlight at all.
  router.post('/pending-batches/:batchId/approve', (req, res) => {
    if (!checkAdminPassword(req.header('x-admin-password'))) {
      res.status(401).json({ error: 'Invalid password' });
      return;
    }

    try {
      const { batchId } = req.params;
      const ids = resolveBatchTargetIds(batchId, req.body?.ids);

      if (ids.size === 0) {
        res.status(404).json({ error: 'Batch not found (already reviewed?)' });
        return;
      }

      const updated = updateManyMedia(ids, { status: 'approved' });
      const event = updated.length === 1 ? 'media:new' : 'media:approved';
      for (const row of updated) {
        io.emit(event, row);
      }

      logEvent('moderation', 'batch_approved', {
        count: updated.length,
        via: Array.isArray(req.body?.ids) && req.body.ids.length > 0 ? 'selected' : 'single_batch',
      });
      res.json({ approved: updated.length });
    } catch (err) {
      console.error('Approving pending batch failed:', err);
      res.status(500).json({ error: err instanceof Error ? err.message : 'Approve failed' });
    }
  });

  // Permanently deletes the targeted photo(s) — files and metadata rows
  // both — same as any other delete in this app: immediate, no separate
  // trash/quarantine step.
  router.post('/pending-batches/:batchId/reject', (req, res) => {
    if (!checkAdminPassword(req.header('x-admin-password'))) {
      res.status(401).json({ error: 'Invalid password' });
      return;
    }

    try {
      const { batchId } = req.params;
      const ids = resolveBatchTargetIds(batchId, req.body?.ids);

      if (ids.size === 0) {
        res.status(404).json({ error: 'Batch not found (already reviewed?)' });
        return;
      }

      const removed = deleteManyMedia(ids);
      for (const row of removed) {
        fs.unlink(path.join(config.mediaDir, row.filename), () => {});
      }

      logEvent('moderation', 'batch_rejected', {
        count: removed.length,
        via: Array.isArray(req.body?.ids) && req.body.ids.length > 0 ? 'selected' : 'single_batch',
      });
      res.json({ rejected: removed.length });
    } catch (err) {
      console.error('Rejecting pending batch failed:', err);
      res.status(500).json({ error: err instanceof Error ? err.message : 'Reject failed' });
    }
  });

  return router;
}
