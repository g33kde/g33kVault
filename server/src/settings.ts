import fs from 'fs';
import os from 'os';
import path from 'path';
import { randomInt } from 'crypto';
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

// Three stops, not a free-form percentage — the admin's "Event Image" size
// control is a 3-position slider (100% = original size, then +50%/+100%),
// see CHANGELOG for why: enough range to matter without needing arbitrary
// precision for a single branding image.
export const EVENT_IMAGE_SCALES = [100, 150, 200] as const;
export type EventImageScale = (typeof EVENT_IMAGE_SCALES)[number];

// What gets shipped to Grafana Cloud when the integration is on — see
// GRAFANA.md. Each category is independently toggleable so an admin who
// only cares about, say, upload volume can leave device/access tracking
// off. "system" covers server-health snapshots (counts, disk space), not
// host-level telemetry (CPU/temp) — that's Alloy's job, configured
// separately outside the app (see GRAFANA.md).
export const GRAFANA_CATEGORIES = ['usage', 'uploads', 'system', 'moderation'] as const;
export type GrafanaCategory = (typeof GRAFANA_CATEGORIES)[number];

export const GRAFANA_PUSH_INTERVALS_MS = [30_000, 60_000, 300_000] as const;
export type GrafanaPushIntervalMs = (typeof GRAFANA_PUSH_INTERVALS_MS)[number];

// Each id's required photo count is fixed by its geometry — the slideshow
// client owns the actual layout/CSS; this list is just what admin settings
// validate against. See CHANGELOG for the mockup these came from.
export const COLLAGE_LAYOUTS = [
  'big-plus-2',
  'grid-4',
  'feature-4',
  'grid-6',
  'scatter-6',
  'scatter-6-2',
  'scatter-6-3',
  'scatter-6-4',
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
  requireApproval?: boolean;
  lastBackup?: BackupInfo;
  grafanaEnabled?: boolean;
  grafanaCategories?: GrafanaCategory[];
  grafanaPushIntervalMs?: GrafanaPushIntervalMs;
  grafanaInstanceLabel?: string;
  // Superseded by showUploadQr/showBoothQr below — kept in the type (and
  // still read, never written) purely so an existing settings.json's
  // pre-upgrade value migrates instead of silently resetting.
  showQrCode?: boolean;
  showUploadQr?: boolean;
  showBoothQr?: boolean;
  // When on, a photo smaller than the available slideshow frame is scaled
  // up (never more than 1.5x its own native size, and never past what the
  // frame can actually hold) instead of displaying at its tiny native size
  // surrounded by black. Off by default — an upscaled low-res photo looks
  // softer than a genuinely full-resolution one, so this is a deliberate
  // trade-off the admin opts into rather than something applied by default.
  scaleSmallPhotos?: boolean;
  // The current event-image file's name within config.eventImageDir (e.g.
  // "event-image.png") — undefined/null means none uploaded. Set by
  // routes/eventImage.ts's upload/delete handlers, not by the admin
  // settings form directly, same treatment as lastBackup above.
  eventImageFilename?: string | null;
  // Display size of the event image in the slideshow, as a percentage of
  // its original/base size. Set via its own dedicated endpoint (routes/
  // eventImage.ts's PUT /scale) rather than the general admin settings
  // form, same reasoning as eventImageFilename above — it's specific to
  // the Event Image admin section, not a Playback Settings field.
  eventImageScale?: EventImageScale;
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

// When on, a guest's single-photo/video upload via /upload or /booth lands
// in the same 'pending' review queue as a guest-uploaded archive's contents
// (see routes/upload.ts, routes/admin.ts pending-batches) instead of going
// straight to the live slideshow. Off by default — matches the original
// zero-moderation behavior.
export function getRequireApproval(): boolean {
  return readSettings().requireApproval ?? false;
}

export function setRequireApproval(value: boolean): boolean {
  const settings = readSettings();
  settings.requireApproval = value;
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

// Off by default even when GRAFANA_CLOUD_* env vars are set — configuring
// the connection and turning it on are deliberately separate steps (see
// GRAFANA.md), so setting the env vars alone never starts shipping data.
export function getGrafanaEnabled(): boolean {
  return readSettings().grafanaEnabled ?? false;
}

export function setGrafanaEnabled(value: boolean): boolean {
  const settings = readSettings();
  settings.grafanaEnabled = value;
  writeSettings(settings);
  return value;
}

// All four categories on by default once enabled — matches this project's
// usual "opt out, not opt in" pattern for admin-controlled settings (e.g.
// shuffle, collage). The aggregate-only design (no per-guest data in any
// category, ever — see GRAFANA.md) is what makes defaulting to "on" a
// reasonable choice here rather than something to opt into.
export function getGrafanaCategories(): GrafanaCategory[] {
  return readSettings().grafanaCategories ?? [...GRAFANA_CATEGORIES];
}

export function setGrafanaCategories(value: GrafanaCategory[]): GrafanaCategory[] {
  const settings = readSettings();
  settings.grafanaCategories = value;
  writeSettings(settings);
  return value;
}

export function getGrafanaPushIntervalMs(): GrafanaPushIntervalMs {
  return readSettings().grafanaPushIntervalMs ?? 60_000;
}

export function setGrafanaPushIntervalMs(value: GrafanaPushIntervalMs): GrafanaPushIntervalMs {
  const settings = readSettings();
  settings.grafanaPushIntervalMs = value;
  writeSettings(settings);
  return value;
}

const MAX_INSTANCE_LABEL_LENGTH = 60;

// Loki labels tolerate arbitrary UTF-8, but a raw hostname can carry dots
// (an FQDN), underscores, or mixed case — lowercased/hyphenated here purely
// for readability in a Grafana dropdown, matching the style of an
// admin-chosen friendly name. Capped well under MAX_INSTANCE_LABEL_LENGTH
// so there's always room left for the "-123456" suffix below.
function slugifyHostname(hostname: string): string {
  const slug = hostname
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
  return slug.slice(0, 40) || 'host';
}

// Distinguishes this g33kVault install's logs from any other one pushing to
// the same Grafana Cloud account (see GRAFANA.md's "Running multiple
// instances") — every Loki stream carries this as its `instance` label.
// Auto-generated once and persisted (never regenerated on its own) so a VM
// nobody's configured this on still never silently mixes its data with
// another instance's; an admin can override it with something more
// readable any time via the /admin "Grafana Cloud" section.
//
// Built from the host's own hostname plus a random number rather than a
// pure random id, so it's at least somewhat recognizable at a glance —
// though note that inside a plain `docker compose up` (no explicit
// `hostname:` set), os.hostname() resolves to Docker's own opaque
// container id, not anything meaningful; set `hostname:` in
// docker-compose.yml per deployment, or just use the admin-settable
// friendly name below, if that matters to you.
export function getGrafanaInstanceLabel(): string {
  const settings = readSettings();
  if (settings.grafanaInstanceLabel) return settings.grafanaInstanceLabel;

  const generated = `${slugifyHostname(os.hostname())}-${randomInt(100_000, 999_999)}`;
  settings.grafanaInstanceLabel = generated;
  writeSettings(settings);
  return generated;
}

export function setGrafanaInstanceLabel(value: string): string {
  const trimmed = value.trim().slice(0, MAX_INSTANCE_LABEL_LENGTH);
  // An admin clearing the field falls back to the auto-generated one rather
  // than pushing an empty label — getGrafanaInstanceLabel() regenerates
  // (and persists) a fresh one the next time it's read.
  const settings = readSettings();
  if (trimmed.length > 0) {
    settings.grafanaInstanceLabel = trimmed;
    writeSettings(settings);
    return trimmed;
  }
  delete settings.grafanaInstanceLabel;
  writeSettings(settings);
  return getGrafanaInstanceLabel();
}

// On by default — matches this project's usual "opt out, not opt in"
// pattern for admin-controlled display settings (shuffle, collage, etc.).
// Falls back to the old showQrCode field when showUploadQr itself has never
// been set, so an existing install's choice carries over on upgrade instead
// of silently resetting to the new default.
export function getShowUploadQr(): boolean {
  const settings = readSettings();
  if (settings.showUploadQr !== undefined) return settings.showUploadQr;
  return settings.showQrCode ?? true;
}

export function setShowUploadQr(value: boolean): boolean {
  const settings = readSettings();
  settings.showUploadQr = value;
  writeSettings(settings);
  return value;
}

// Off by default — the Booth QR is new, and showing a "take a photo" QR
// during the slideshow wasn't previously offered at all, unlike the upload
// one above.
export function getShowBoothQr(): boolean {
  return readSettings().showBoothQr ?? false;
}

export function setShowBoothQr(value: boolean): boolean {
  const settings = readSettings();
  settings.showBoothQr = value;
  writeSettings(settings);
  return value;
}

// Off by default — see the doc comment on Settings.scaleSmallPhotos above.
export function getScaleSmallPhotos(): boolean {
  return readSettings().scaleSmallPhotos ?? false;
}

export function setScaleSmallPhotos(value: boolean): boolean {
  const settings = readSettings();
  settings.scaleSmallPhotos = value;
  writeSettings(settings);
  return value;
}

export function getEventImageFilename(): string | null {
  return readSettings().eventImageFilename ?? null;
}

export function setEventImageFilename(value: string | null): string | null {
  const settings = readSettings();
  settings.eventImageFilename = value;
  writeSettings(settings);
  return value;
}

export function getEventImageScale(): EventImageScale {
  return readSettings().eventImageScale ?? 100;
}

export function setEventImageScale(value: EventImageScale): EventImageScale {
  const settings = readSettings();
  settings.eventImageScale = value;
  writeSettings(settings);
  return value;
}

// The public URL Slideshow.tsx/Admin.tsx actually use — null whenever
// nothing's uploaded, or if the recorded filename's file has somehow gone
// missing (defensive: report "none" rather than let a stale reference
// crash anything downstream). `?v=<size>` cache-busts the same way every
// other media URL in this app already does, so uploading a replacement
// image immediately shows the new one instead of a cached copy of the old.
export function getEventImageUrl(): string | null {
  const filename = getEventImageFilename();
  if (!filename) return null;
  try {
    const stat = fs.statSync(path.join(config.eventImageDir, filename));
    return `/event-image/${filename}?v=${stat.size}`;
  } catch {
    return null;
  }
}
