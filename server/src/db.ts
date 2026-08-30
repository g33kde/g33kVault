import fs from 'fs';
import path from 'path';
import { config } from './config';

export interface MediaRow {
  id: string;
  filename: string;
  original_name: string | null;
  mime_type: string;
  kind: 'image' | 'video';
  size: number;
  created_at: number;
  uploader?: string | null;
  // Both undefined = not yet computed (backfilled lazily by the duplicate
  // scan); phash is explicitly null once computed for something it doesn't
  // apply to (video, or an image sharp couldn't decode).
  content_hash?: string;
  phash?: string | null;
  // When the photo was actually taken, from EXIF (see photoDate.ts).
  // undefined = not yet scanned (backfilled lazily by the admin photo-date
  // scan); null = scanned but no usable EXIF date found (a screenshot, a
  // booth capture, or a photo that already lost its metadata before
  // reaching this app — most commonly a HEIC photo imported before this
  // field's ingestion-time extraction existed).
  photo_taken_at?: number | null;
  // undefined/'approved' = live, shown in the public gallery/slideshow like
  // always. 'pending' = extracted from a guest-uploaded archive
  // (routes/upload.ts, pendingUploads.ts) and awaiting admin review — never
  // returned by the public /api/media, never triggers a live-slideshow
  // highlight, until an admin approves the whole batch it belongs to.
  status?: 'pending' | 'approved';
  // Only set on rows created from one uploaded archive, so admin review can
  // group and act on them together. batchLabel is the archive's original
  // filename, for a human-readable review list.
  batchId?: string;
  batchLabel?: string;
}

fs.mkdirSync(path.dirname(config.dbPath), { recursive: true });

// Synchronous fs calls never yield the event loop mid-operation, so a
// read-modify-write here can't interleave with another request's write.
function readAll(): MediaRow[] {
  if (!fs.existsSync(config.dbPath)) return [];
  const raw = fs.readFileSync(config.dbPath, 'utf-8').trim();
  if (!raw) return [];
  return JSON.parse(raw) as MediaRow[];
}

function writeAll(rows: MediaRow[]) {
  fs.writeFileSync(config.dbPath, JSON.stringify(rows, null, 2));
}

export function insertMedia(row: MediaRow) {
  const rows = readAll();
  rows.push(row);
  writeAll(rows);
}

export function getAllMedia(): MediaRow[] {
  return readAll().sort((a, b) => a.created_at - b.created_at);
}

// Excludes anything still awaiting admin review (see the 'pending' status
// doc comment above) — used everywhere media is shown or scanned outside
// the dedicated pending-batches review flow itself, so an unreviewed photo
// can't leak into the public gallery, the slideshow, or any of the other
// admin tools (duplicates, photo dates, low-resolution) before it's
// approved.
export function getApprovedMedia(): MediaRow[] {
  return getAllMedia().filter((m) => m.status !== 'pending');
}

export function deleteMedia(id: string): MediaRow | null {
  const rows = readAll();
  const idx = rows.findIndex((r) => r.id === id);
  if (idx === -1) return null;
  const [removed] = rows.splice(idx, 1);
  writeAll(rows);
  return removed;
}

// One read + one write for the whole batch, rather than callers looping
// deleteMedia() — a bulk cleanup (e.g. duplicate removal) can touch hundreds
// or thousands of rows, and rewriting the entire JSON store per item made
// that both slow and fragile (any single failed request in a client-side
// loop would abort everything after it, silently leaving the rest
// undeleted).
export function deleteManyMedia(ids: Set<string>): MediaRow[] {
  const rows = readAll();
  const removed: MediaRow[] = [];
  const kept: MediaRow[] = [];
  for (const row of rows) {
    if (ids.has(row.id)) removed.push(row);
    else kept.push(row);
  }
  writeAll(kept);
  return removed;
}

// One read + one write for the whole batch, same reasoning as
// deleteManyMedia — approving a large pending batch shouldn't mean one
// rewrite of the entire JSON store per photo.
export function updateManyMedia(ids: Set<string>, patch: Partial<Omit<MediaRow, 'id'>>): MediaRow[] {
  const rows = readAll();
  const updated: MediaRow[] = [];
  for (let i = 0; i < rows.length; i++) {
    if (ids.has(rows[i].id)) {
      rows[i] = { ...rows[i], ...patch };
      updated.push(rows[i]);
    }
  }
  writeAll(rows);
  return updated;
}

export function getMediaById(id: string): MediaRow | null {
  return readAll().find((r) => r.id === id) ?? null;
}

export function updateMedia(id: string, patch: Partial<Omit<MediaRow, 'id'>>): MediaRow | null {
  const rows = readAll();
  const idx = rows.findIndex((r) => r.id === id);
  if (idx === -1) return null;
  rows[idx] = { ...rows[idx], ...patch };
  writeAll(rows);
  return rows[idx];
}
