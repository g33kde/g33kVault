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
