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

export function getLastBackup(): BackupInfo | null {
  return readSettings().lastBackup ?? null;
}

export function setLastBackup(info: BackupInfo): BackupInfo {
  const settings = readSettings();
  settings.lastBackup = info;
  writeSettings(settings);
  return info;
}
