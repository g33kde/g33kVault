import fs from 'fs';
import path from 'path';
import { config } from '../config';
import {
  getGrafanaEnabled,
  getGrafanaCategories,
  getGrafanaPushIntervalMs,
  getGrafanaInstanceLabel,
  GrafanaCategory,
} from '../settings';

interface BufferedLine {
  tsNs: string; // Loki wants nanosecond-precision timestamps, as strings
  group: GrafanaCategory;
  line: string; // JSON-encoded event body
}

// Same directory as the JSON metadata store, so it's already covered by
// this project's existing volume/backup setup and .gitignore entry — see
// db.ts/settings.ts for the same pattern (whole-file read/mutate/write,
// reasonable at this app's actual event volume).
const bufferPath = path.join(path.dirname(config.dbPath), 'grafana-buffer.json');

// Bounds how much an extended offline stretch (see GRAFANA.md's
// buffer-and-retry note) can grow this file by on the Pi's SD card — once
// full, the OLDEST buffered events are dropped to make room for new ones,
// on the theory that "gap in old history" is a better failure mode than
// "stop accepting new events" for a live dashboard.
const MAX_BUFFERED_LINES = 2000;

let buffer: BufferedLine[] = loadBuffer();
let lastPushAt: number | null = null;
let lastError: string | null = null;

function loadBuffer(): BufferedLine[] {
  try {
    if (!fs.existsSync(bufferPath)) return [];
    const raw = fs.readFileSync(bufferPath, 'utf-8').trim();
    if (!raw) return [];
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

function persistBuffer() {
  try {
    fs.writeFileSync(bufferPath, JSON.stringify(buffer));
  } catch (err) {
    console.error('Could not persist Grafana event buffer:', err);
  }
}

export function isGrafanaConfigured(): boolean {
  return Boolean(config.grafanaLokiUrl && config.grafanaLokiUser && config.grafanaCloudToken);
}

// The one call site every instrumented event in the app goes through — see
// GRAFANA.md for the full list of what's logged and where. Always prints
// to the container's own console output regardless of whether Grafana is
// configured/enabled, so this doubles as this app's normal structured
// logging, not something purely Grafana-specific.
export function logEvent(group: GrafanaCategory, event: string, fields: Record<string, unknown> = {}): void {
  const payload = { event, ...fields };
  console.log(`[${group}] ${JSON.stringify(payload)}`);

  if (!isGrafanaConfigured() || !getGrafanaEnabled()) return;
  if (!getGrafanaCategories().includes(group)) return;

  buffer.push({ tsNs: `${Date.now()}000000`, group, line: JSON.stringify(payload) });
  if (buffer.length > MAX_BUFFERED_LINES) {
    buffer = buffer.slice(buffer.length - MAX_BUFFERED_LINES);
  }
  persistBuffer();
}

// One Loki "stream" per category (plus this install's instance label — see
// GRAFANA.md's "Running multiple instances") keeps label cardinality low
// (see GRAFANA.md's cardinality warning) — {app="g33kvault",
// event_group="uploads", instance="office-lobby"} etc. Everything else
// (event name, sizes, counts) lives inside the JSON line body, queried with
// LogQL's `| json` at dashboard time, never as a label.
function buildLokiPayload(lines: BufferedLine[]) {
  const instance = getGrafanaInstanceLabel();
  const byGroup = new Map<string, [string, string][]>();
  for (const l of lines) {
    const arr = byGroup.get(l.group) ?? [];
    arr.push([l.tsNs, l.line]);
    byGroup.set(l.group, arr);
  }
  return {
    streams: [...byGroup.entries()].map(([group, values]) => ({
      stream: { app: 'g33kvault', event_group: group, instance },
      values,
    })),
  };
}

// Accepts GRAFANA_CLOUD_LOKI_URL either as the base URL Grafana Cloud's
// "Details" page labels "URL" (e.g. https://logs-prod-006.grafana.net) or,
// forgivingly, as the full push URL some Grafana Cloud docs/examples show
// instead (already ending in /loki/api/v1/push) — easy to paste the wrong
// one of those two, see GRAFANA.md.
function lokiPushUrl(): string {
  const base = config.grafanaLokiUrl.replace(/\/$/, '').replace(/\/loki\/api\/v1\/push$/, '');
  return `${base}/loki/api/v1/push`;
}

async function pushLines(lines: BufferedLine[]): Promise<{ ok: boolean; error?: string }> {
  try {
    const res = await fetch(lokiPushUrl(), {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Basic ${Buffer.from(`${config.grafanaLokiUser}:${config.grafanaCloudToken}`).toString('base64')}`,
      },
      body: JSON.stringify(buildLokiPayload(lines)),
    });

    if (!res.ok) {
      const body = await res.text().catch(() => '');
      return { ok: false, error: `${res.status} ${res.statusText}${body ? `: ${body.slice(0, 200)}` : ''}` };
    }
    return { ok: true };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }
}

// Called on the push interval (see ensureGrafanaPushLoop below) — sends
// everything currently buffered in one request, grouped by category.
export async function flushGrafanaBuffer(): Promise<{ ok: boolean; error?: string }> {
  if (!isGrafanaConfigured()) return { ok: false, error: 'Not configured' };
  if (buffer.length === 0) return { ok: true };

  const toSend = buffer;
  const result = await pushLines(toSend);

  if (result.ok) {
    lastError = null;
    lastPushAt = Date.now();
    // Only drop what was actually sent — logEvent() may have appended more
    // to `buffer` while this request was in flight.
    buffer = buffer.slice(toSend.length);
    persistBuffer();
  } else {
    lastError = result.error ?? 'Unknown error';
  }

  return result;
}

// For the /admin "Send test event" button — a real push, independent of
// the persistent buffer and the enabled/category settings, so credentials
// can be verified before actually turning the integration on.
export async function sendGrafanaTestEvent(): Promise<{ ok: boolean; error?: string }> {
  if (!isGrafanaConfigured()) return { ok: false, error: 'Not configured — missing GRAFANA_CLOUD_* env vars' };

  const result = await pushLines([
    {
      tsNs: `${Date.now()}000000`,
      group: 'usage',
      line: JSON.stringify({ event: 'connection_test', source: 'admin_test_button' }),
    },
  ]);

  if (result.ok) {
    lastError = null;
    lastPushAt = Date.now();
  } else {
    lastError = result.error ?? 'Unknown error';
  }

  return result;
}

export function getGrafanaStatus() {
  return {
    configured: isGrafanaConfigured(),
    enabled: getGrafanaEnabled(),
    categories: getGrafanaCategories(),
    pushIntervalMs: getGrafanaPushIntervalMs(),
    instanceLabel: getGrafanaInstanceLabel(),
    lastPushAt,
    lastError,
    bufferedCount: buffer.length,
  };
}

let pushTimer: ReturnType<typeof setInterval> | null = null;
let pushTimerIntervalMs: number | null = null;
// Set once by index.ts's initial call (to emit the periodic "system"
// snapshot — see grafana/snapshot.ts) and preserved across later re-arms
// from PUT /api/admin/grafana/settings, which call this again with no
// argument — a single timer driving both the snapshot and the buffer flush
// keeps them on the same, always-correctly-re-armed cadence, rather than
// two independent intervals that could drift out of sync with the setting.
let onTick: (() => void) | null = null;

// Called once at startup, and again after any admin change to the push
// interval, so a live setting change takes effect without a server
// restart rather than only applying on the next deploy.
export function ensureGrafanaPushLoop(tick?: () => void): void {
  if (tick) onTick = tick;

  const intervalMs = getGrafanaPushIntervalMs();
  if (pushTimer && pushTimerIntervalMs === intervalMs) return;
  if (pushTimer) clearInterval(pushTimer);

  pushTimerIntervalMs = intervalMs;
  pushTimer = setInterval(() => {
    onTick?.();
    if (getGrafanaEnabled() && isGrafanaConfigured()) {
      flushGrafanaBuffer().catch((err) => console.error('Grafana push failed:', err));
    }
  }, intervalMs);
  // Doesn't hold the process open on its own — a clean shutdown (or a
  // future test run) shouldn't be blocked on this timer existing.
  pushTimer.unref();
}
