# Grafana Cloud integration

Ships g33kVault's own usage stats — uploads, page access, device/browser breakdown,
system health, moderation activity — to a [Grafana Cloud](https://grafana.com/products/cloud/)
account, so you can build dashboards without SSH-ing into the Pi and grepping logs.

This is entirely optional. g33kVault works exactly as before with none of this
configured — see [Configuration (env vars)](README.md#configuration-env-vars) for what
every other env var does.

## How it works, briefly

g33kVault runs on a Pi or a home server, usually with no public IP — Grafana Cloud is
SaaS and can't reach in to pull data from it. So instead, **g33kVault pushes its own
logs out** to Grafana Cloud's hosted Loki, on a timer, over plain HTTPS. There's a
second, separate, fully optional piece for **host-level metrics** (Pi CPU/temperature/
disk/memory) using [Grafana Alloy](#optional-host-level-metrics-via-grafana-alloy) —
covered near the end of this file, since it needs its own separate setup outside the
app.

Every stat in this document reaches Grafana Cloud as a structured JSON log line via
Loki, not as a traditional Prometheus metric — see
[Why logs instead of metrics](#why-logs-instead-of-metrics-for-app-level-stats) below
if you're wondering why, and [Querying it in Grafana](#querying-it-in-grafana) for how
to turn these into normal-looking dashboard panels anyway.

## What you need from Grafana Cloud

Three pieces of information, all from the **same Grafana Cloud stack** (a stack bundles
a Grafana instance with hosted Loki, Prometheus, etc. — created automatically when you
sign up, or from the Grafana Cloud portal if you want a separate one):

1. **Loki URL** — from [grafana.com](https://grafana.com), go to your account's
   **Stacks** page, click into the stack you want to use, and find **Loki** in its list
   of connected data sources. Its "Details" panel shows a field literally labeled
   **URL** — something like `https://logs-prod-006.grafana.net`. That's it, no path
   after the domain (the app appends `/loki/api/v1/push` itself — see the note below if
   you paste the wrong form by mistake, it's handled either way).
2. **Loki User / Instance ID** — same Loki "Details" panel, a short number like
   `123456`. This is *not* your Grafana Cloud account username.
3. **An API token with logs-write access** — Grafana Cloud calls these
   **Access Policies** (older accounts/docs may still say "API Keys"). From the
   account's **Security > Access Policies** page, create one scoped to `logs:write`
   for the stack above, then generate a token under it. The Loki "Details" panel
   usually has a **"Generate now"** shortcut that creates a correctly-scoped token for
   you without needing to find the Access Policies page yourself — use that if it's
   there.

> If you accidentally copy the full push URL (ending in `/loki/api/v1/push`, which some
> Grafana Cloud code examples show instead of the plain "Details" page URL) instead of
> the base one, g33kVault handles either form — no need to double back and re-copy it.

## Setting it up

**1. Set the three environment variables** wherever g33kVault's other env vars live
(`docker-compose.yml`, an `.env` file, or your process manager's config —
see [Configuration (env vars)](README.md#configuration-env-vars)):

```bash
GRAFANA_CLOUD_LOKI_URL=https://logs-prod-006.grafana.net
GRAFANA_CLOUD_LOKI_USER=123456
GRAFANA_CLOUD_TOKEN=glc_eyJ...              # the Access Policy token from above
```

These are **env vars only, deliberately** — same treatment as `ADMIN_PASSWORD`: a
secret shouldn't live in a file the admin UI's settings form round-trips through
(`server/data/settings.json`). The `/admin` "Grafana Cloud" section can toggle and test
the connection these define, but can't set or reveal them.

**2. Restart g33kVault** so it picks up the new env vars.

**3. In `/admin`, open the "📊 Grafana Cloud" section** (under Gallery Tools). If the
three env vars are set, you'll see:

- An **Enable Grafana Cloud reporting** toggle — off by default even with everything
  configured, so setting the env vars alone never starts shipping data. You decide when.
- An **Instance name** field — only matters if you're running more than one g33kVault
  pointed at the same Grafana Cloud account; see
  [Running multiple instances](#running-multiple-instances) below. Safe to ignore for
  a single deployment.
- Checkboxes for **what to send** — Usage & devices, Uploads, System health, Moderation
  — independently toggleable. All four are on by default once you enable it.
- A **push interval** (30s / 1 min / 5 min) — how often buffered events actually go
  out.
- **Save**, and a **"Send test event"** button that fires one real push immediately,
  independent of the enabled toggle and the interval — use it to confirm your
  credentials actually work before turning the integration on for real.
- A status line showing the last successful push time, or the last error verbatim (an
  HTTP 401 here almost always means the token's scope doesn't include `logs:write`, or
  it was pasted with a stray space/newline).

If the section instead says the integration isn't configured, double-check the env vars
landed in the running container (`docker compose config` will show resolved values) and
that you restarted after setting them.

## What gets sent

Every category is aggregate-only — see [Privacy](#privacy) below for what that means
and why it's a hard rule, not a per-category choice.

| Category | Events |
|---|---|
| **Usage & devices** | `page_view` — one per load of `/`, `/upload`, `/booth`, `/slideshow`, `/admin`, tagged with a coarse device type (mobile/tablet/desktop), OS (iOS/Android/other), and browser family (Safari/Chrome/Firefox/other). No IP addresses, no per-visitor identifiers, ever. |
| **Uploads** | `upload_completed` (kind, size, format, which page it came from, device/OS, whether it landed pending review) and `upload_rejected` (why — too large, unsupported type, failed HEIC conversion) for every guest upload, plus a summary line when the watched import folder picks up new files. |
| **System health** | A `snapshot` line on every push interval: current photo/video/pending counts, contributor count, total storage used, free disk space on the media volume, and how many browser tabs currently have a live connection open (catches a slideshow accidentally left open on two screens). |
| **Moderation** | Every admin action that changes something: settings changed, a photo rotated or deleted, a duplicate/low-resolution cleanup, a pending batch approved or rejected, a backup completed. |

Every event is also printed to the container's normal console output regardless of
whether Grafana is configured or enabled at all — this doubles as g33kVault's ordinary
structured logging now, not something purely Grafana-specific. `docker compose logs`
shows the same lines Grafana would receive.

## Privacy

**Aggregate-only, always — not a per-category choice.** No IP addresses, no per-guest
or per-session identifiers, ever, in any category, even as an opt-in. Device/browser
tracking is a coarse bucket (e.g. "mobile / iOS / Safari"), not a fingerprint. The
`uploader` name a guest optionally types in is never sent — only counts and sizes.

**Cardinality is deliberately kept low** for anyone building dashboards on top of this:
Loki "stream labels" are just `{app="g33kvault", event_group="uploads"}` etc. — never
per-event details like a filename, an upload id, or a device type as a *label* (only as
a field inside the JSON line body, queried with LogQL's `| json` at dashboard time).
Labeling by anything with many unique values is the classic way to blow through Grafana
Cloud's free-tier active-series limit; this design avoids that structurally rather than
relying on remembering not to do it later.

## Offline handling

Events that fail to send (no internet at the venue, Grafana Cloud briefly unreachable,
wrong credentials) are queued in a bounded, disk-persisted buffer (survives a Pi
reboot) and retried on the next push interval — not silently dropped. The buffer caps
at 2,000 events; if it fills during an extended offline stretch, the *oldest* buffered
events are dropped to make room for new ones. The "Grafana Cloud" admin section shows
how many events are currently buffered whenever it's non-zero.

## Why logs instead of metrics for app-level stats

Grafana Cloud's hosted Prometheus (Mimir) only accepts the `remote_write` protocol,
which is protobuf+snappy-encoded — real added complexity and a couple of new
dependencies for what this app actually needs. Loki's push API, by contrast, is plain
JSON over HTTPS. Since every stat here (including gauge-like counts — see the `system`
category's periodic snapshot line above) is fully expressible as a LogQL query over
structured JSON logs, sending logs only, and querying them as if they were metrics,
covers everything without the extra dependency weight.

## Querying it in Grafana

A few LogQL starting points, once you've added your Grafana Cloud Loki instance as a
data source in a dashboard (Grafana Cloud stacks have this pre-wired already):

```logql
# Uploads per 5 minutes, over time
sum(count_over_time({app="g33kvault", event_group="uploads"} | json | event="upload_completed" [5m]))

# Total bytes uploaded per hour
sum(sum_over_time({app="g33kvault", event_group="uploads"} | json | event="upload_completed" | unwrap size_bytes [1h]))

# Device type breakdown of page views
sum by (device_type) (count_over_time({app="g33kvault", event_group="usage"} | json | event="page_view" [1h]))

# Free disk space over time (a gauge, reconstructed from periodic snapshots)
max_over_time({app="g33kvault", event_group="system"} | json | event="snapshot" | unwrap free_disk_bytes [5m])

# Every moderation action, as a raw log stream
{app="g33kvault", event_group="moderation"} | json
```

### Building a dashboard by hand

The general shape, for any panel: **Dashboards → New → New dashboard → Add visualization**,
pick your Grafana Cloud **Loki** data source, paste a LogQL query like the ones above
into the query editor, and pick a visualization type that fits what the query returns:

- A `count_over_time`/`sum_over_time` query returns a time series → **Time series** panel.
- The same query with **Instant** ticked (query editor's "Instant" toggle) collapses it
  to one value per label combination for *right now* → **Pie chart** or **Bar chart**,
  good for breakdowns like device type or browser.
- A `snapshot` field via `| unwrap` (photos, pending, free_disk_bytes, etc.) is really a
  gauge in log form → **Stat** panel, "Calculation: Last \*" in its options, since you
  want the latest snapshot value, not a sum over the time range.
- A raw `{event_group="..."} | json` with no aggregation → **Logs** panel, to just read
  the actual events (e.g. a moderation audit trail) rather than chart them.

Repeat per stat you care about, arrange panels on the grid, **Save dashboard**. This is
exactly how the ready-made one below was put together — a reasonable way to learn the
pattern is opening it in Grafana afterward and looking at how each panel is configured.

### Ready-made dashboard

[`grafana/dashboard.json`](grafana/dashboard.json) in this repo is a complete
dashboard covering every category above: uploads over time, rejection reasons, bytes
uploaded, page views by route, device/browser/OS breakdowns, live stat tiles for
current photo/video/pending counts and free disk space, and a raw moderation activity
log — refined and confirmed working directly in Grafana Cloud (thresholds on the stat
tiles, `| __error__=""` filtering on the LogQL queries, panel descriptions), then
re-exported into this file in Grafana Cloud's own dashboard schema.

**Dashboards → New → Import**, paste the contents of that file (or upload it directly).
Unlike a hand-built exportable dashboard, this one doesn't prompt you to pick a data
source on import — it's wired to whichever Loki data source is named
**`grafanacloud-logs`** in your stack, which is the name Grafana Cloud auto-provisions
by default, so this works as-is for most stacks. If yours is named something else (a
renamed or additional Loki data source), either rename it to match, or find/replace
`"grafanacloud-logs"` with your data source's actual name in the JSON before
importing.

## Optional: host-level metrics via Grafana Alloy

Everything above is g33kVault reporting on itself. It has no way to see the actual
Pi's CPU temperature, host disk usage, or memory pressure — only its own process. For
that, [Grafana Alloy](https://grafana.com/docs/alloy/latest/) can run as a second,
optional container that reports on the host directly. This is **separate** from
everything above: its own setup, its own Grafana Cloud credentials (a Prometheus/Mimir
remote_write endpoint, not the Loki one), and it's off unless you explicitly start it.

**1. Get your Grafana Cloud Prometheus remote_write details** — same stack as before,
but this time find **Prometheus** (Mimir) in its connected data sources instead of
Loki. Its "Details" page shows a remote_write URL ending in `.../api/prom/push`, a
User/Instance ID, and (again) a "Generate now" shortcut for a correctly-scoped
(`metrics:write`) Access Policy token. Grafana Cloud's **Connections > Add new
connection > Linux Server** wizard can also generate a complete, ready-to-use Alloy
config file for you covering more than the starter below — prefer that if it's
available to you.

**2. Create your config file:**

```bash
cp alloy/config.alloy.example alloy/config.alloy
```

Edit `alloy/config.alloy` and fill in the placeholders (`url`, `username`, `password`)
with what you got in step 1. This file is gitignored — it holds real credentials, same
reasoning as never committing a `.env` file. Leave the `external_labels` block's
`instance` value as its default unless you're running more than one g33kVault VM — see
[Running multiple instances](#running-multiple-instances) below if you are.

**3. Start it:**

```bash
docker compose --profile monitoring up -d alloy
```

It won't start with a plain `docker compose up` — the `monitoring` profile keeps it
opt-in. Once running, host metrics show up in your Grafana Cloud Prometheus data
source (standard `node_exporter`-style metric names — a normal Grafana Cloud "Linux
Node" dashboard, importable from the Grafana dashboard library, will plot most of it
out of the box).

## Running multiple instances

Point more than one g33kVault VM at the same Grafana Cloud account — different events,
different venues, whatever — and by default their logs are indistinguishable: every
instance reports identical `{app="g33kvault", event_group="..."}` labels, so every
dashboard panel silently sums all of them together.

**The fix is one more label: `instance`.** Every Loki stream g33kVault pushes now
carries it automatically. Where the value comes from:

- The first time anything reads it, g33kVault generates a short random id (e.g.
  `a3f9c1`) and **persists it** in `settings.json` — so even a VM nobody's touched this
  setting on is still permanently distinguishable from every other one. It's never
  silently regenerated after that.
- `/admin` → "📊 Grafana Cloud" has an **Instance name** field to override it with
  something readable (`office-lobby`, `sarahs-wedding-oct-2026`) — much more useful
  than a random id once you're looking at a list of instances in Grafana. Clearing the
  field goes back to the auto-generated one rather than an empty label.
- Still low-cardinality and safe under the [cardinality](#privacy) rule above — one
  label value per *deployment* (a handful, realistically), not per-event.

**If you're also running Alloy** (see above) on more than one VM, it has the identical
problem independently for host metrics — fix it by setting `config.alloy`'s
`external_labels { instance = "..." }` to the *same* value as that VM's g33kVault
instance name, so a host metric and an app log from the same machine correlate.

**Making the dashboard instance-aware** needs one manual step in Grafana Cloud's UI —
deliberately not hand-edited into `grafana/dashboard.json` here, since its newer
schema (`dashboard.grafana.app/v2`) isn't something worth guessing at blindly and
risking a working, already-tuned dashboard over:

1. Open the dashboard → **Settings → Variables → New variable**.
2. Type: **Query**, data source: your Grafana Cloud **Loki** instance, query:
   `label_values({app="g33kvault"}, instance)`. Enable **Multi-value** and
   **Include All option**.
3. Name it `instance`, save.
4. For each panel you want filterable (all of them, realistically), edit its query and
   add `, instance=~"$instance"` right after the `event_group="..."` part — e.g.
   `{app="g33kvault", event_group="uploads", instance=~"$instance"} | json | ...`.
5. Save the dashboard, then re-export it (**Export → Export as JSON**) over
   `grafana/dashboard.json` in the repo, same as the last round of panel refinements —
   worth committing so the next `git pull` (or a fresh VM's setup) starts from the
   instance-aware version instead of redoing this by hand.

Already included, no setup needed: a new **"Uploads by instance"** panel in the
"Uploads" row — `sum by (instance) (...)`, a side-by-side comparison across
VMs/events, useful once you're running more than one regardless of whether you've
added the filter variable above.
