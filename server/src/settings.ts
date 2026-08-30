import fs from 'fs';
import path from 'path';
import { config } from './config';

export const TRANSITION_STYLES = [
  'none',
  'fade',
  'zoom',
  'polaroid',
  'glitch',
  'arcade',
  'vhs',
  'random',
] as const;
export type TransitionStyle = (typeof TRANSITION_STYLES)[number];

export const COLLAGE_MODES = ['off', 'always', 'mixed'] as const;
export type CollageMode = (typeof COLLAGE_MODES)[number];

// Each id's required photo count is fixed by its geometry — the slideshow
// client owns the actual layout/CSS; this list is just what admin settings
// validate against. See CHANGELOG for the mockup these came from.
export const COLLAGE_LAYOUTS = [
  'split-2v',
  'split-2h',
  'diagonal-2',
  'big-plus-2',
  'columns-3',
  'grid-4',
  'feature-4',
  'big-plus-4',
  'grid-6',
  'scatter-6',
  'random',
] as const;
export type CollageLayout = (typeof COLLAGE_LAYOUTS)[number];

interface BackupInfo {
  lastBackupAt: number;
  lastBackupSizeBytes: number;
  lastBackupItemCount: number;
}

interface Settings {
  slideshowIntervalMs?: number;
  shuffle?: boolean;
  transitionStyle?: TransitionStyle;
  partyMode?: boolean;
  slideshowEnabled?: boolean;
  collageMode?: CollageMode;
  collageLayout?: CollageLayout;
  lastBackup?: BackupInfo;
}

fs.mkdirSync(path.dirname(config.settingsPath), { recursive: true });

function readSettings(): Settings {
  if (!fs.existsSync(config.settingsPath)) return {};
  const raw = fs.readFileSync(config.settingsPath, 'utf-8').trim();
  if (!raw) return {};
  try {
    return JSON.parse(raw) as Settings;
  } catch {
    return {};
  }
}

function writeSettings(settings: Settings) {
  fs.writeFileSync(config.settingsPath, JSON.stringify(settings, null, 2));
}

export function getSlideshowIntervalMs(): number {
  return readSettings().slideshowIntervalMs ?? config.slideshowIntervalMs;
}

export function setSlideshowIntervalMs(value: number): number {
  const settings = readSettings();
  settings.slideshowIntervalMs = value;
  writeSettings(settings);
  return value;
}

export function getShuffle(): boolean {
  return readSettings().shuffle ?? false;
}

export function setShuffle(value: boolean): boolean {
  const settings = readSettings();
  settings.shuffle = value;
  writeSettings(settings);
  return value;
}

export function getTransitionStyle(): TransitionStyle {
  return readSettings().transitionStyle ?? 'none';
}

export function setTransitionStyle(value: TransitionStyle): TransitionStyle {
  const settings = readSettings();
  settings.transitionStyle = value;
  writeSettings(settings);
  return value;
}

export function getPartyMode(): boolean {
  return readSettings().partyMode ?? false;
}

export function setPartyMode(value: boolean): boolean {
  const settings = readSettings();
  settings.partyMode = value;
  writeSettings(settings);
  return value;
}

export function getSlideshowEnabled(): boolean {
  return readSettings().slideshowEnabled ?? true;
}

export function setSlideshowEnabled(value: boolean): boolean {
  const settings = readSettings();
  settings.slideshowEnabled = value;
  writeSettings(settings);
  return value;
}

export function getCollageMode(): CollageMode {
  return readSettings().collageMode ?? 'off';
}

export function setCollageMode(value: CollageMode): CollageMode {
  const settings = readSettings();
  settings.collageMode = value;
  writeSettings(settings);
  return value;
}

export function getCollageLayout(): CollageLayout {
  return readSettings().collageLayout ?? 'random';
}

export function setCollageLayout(value: CollageLayout): CollageLayout {
  const settings = readSettings();
  settings.collageLayout = value;
  writeSettings(settings);
  return value;
}

export function getLastBackup(): BackupInfo | null {
  return readSettings().lastBackup ?? null;
}

export function setLastBackup(info: BackupInfo): BackupInfo {
  const settings = readSettings();
  settings.lastBackup = info;
  writeSettings(settings);
  return info;
}
