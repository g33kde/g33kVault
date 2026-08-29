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

export function deleteMedia(id: string): MediaRow | null {
  const rows = readAll();
  const idx = rows.findIndex((r) => r.id === id);
  if (idx === -1) return null;
  const [removed] = rows.splice(idx, 1);
  writeAll(rows);
  return removed;
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
