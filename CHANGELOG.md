# Changelog

## [Unreleased]

### Videos get their own, higher upload size limit

- Videos previously shared `MAX_FILE_SIZE_MB` (100 MB default) with photos — routinely
  too small for even a couple of minutes of phone footage. New `MAX_VIDEO_SIZE_MB` env
  var (default 500 MB, matching the existing archive limit) applies specifically to
  `kind === 'video'` uploads — `.mp4`/`.mov`/`.webm`/`.mpg`/`.mpeg` all count, photos
  still enforce the original 100 MB `MAX_FILE_SIZE_MB`.
- Verified for real: uploaded same-size test files as both a photo and a video against
  small overridden limits (1 MB photo cap, 2 MB video cap) — a 1.5 MB photo was
  correctly rejected while an identical-size video was correctly accepted and appeared
  in the pending queue, and a 2.5 MB video was correctly rejected against the 2 MB
  video cap with the right limit in the error message.

### Support .mpg/.mpeg uploads, transcoded to MP4

- `.mpg`/`.mpeg` are now recognized upload types, transcoded server-side to MP4
  (H.264/AAC) on the way in — same idea as the existing HEIC→JPEG conversion, since raw
  MPEG-1/2 has poor/inconsistent native support in HTML5 `<video>` across browsers.
- Unlike HEIC (a pure-JS/WASM library), there's no realistic pure-JS way to transcode
  video — this shells out to the system `ffmpeg` binary instead, the same category as
  `tar` in the backup feature (a real system binary, not an npm dependency needing a
  node-gyp compile step — CLAUDE.md's no-native-deps rule is about the latter). Added
  to the Docker image (`apk add ffmpeg`) and documented as an extra `apt install`
  step for the one bare-metal ("no Docker") deployment path in the README.
- The one genuine design decision here: transcoding takes meaningfully longer than a
  HEIC conversion (seconds to minutes, not sub-second), so unlike HEIC's synchronous
  handling, a guest uploading `.mpg` gets an immediate "received, being converted"
  response and the actual transcode runs in the background — the same
  respond-now-process-later pattern guest-uploaded archives already use, so a slow
  conversion on a Pi's modest CPU can't time out someone's mobile upload. The watched
  import folder and guest-uploaded archives convert synchronously instead, same as
  HEIC there — both already run off the request/response cycle, so there's no guest
  connection to protect from a timeout.
- Refactored `routes/upload.ts`'s single-file path: extracted the "insert the DB row,
  log it, broadcast it" logic (previously inline) into a shared
  `insertAndAnnounceMedia()` helper, used both by the normal synchronous path and the
  new MPEG background-completion callback — so the existing requireApproval/highlight
  behavior applies identically regardless of which path a file took to get there.
- Client: a third distinct "being converted" message in `/upload`'s post-upload
  summary, separate from "awaiting archive extraction" and "awaiting admin approval" —
  a video mid-transcode isn't either of those, and showing the wrong one would be
  misleading about what's actually happening.
- Verified for real, not just by building: built the actual Docker image and confirmed
  Alpine's `ffmpeg` package includes working `libx264`/`aac` encoders, generated a
  genuine MPEG-1 test video inside a real container, uploaded it through the real
  running app, and confirmed via `ffprobe` that the resulting served file is a
  correctly-encoded H.264/AAC MP4 at the right dimensions — then repeated the same
  real check with "Require approval for uploads" on (correctly landed in the Pending
  Uploads queue instead of going live) and with a corrupt/fake `.mpg` (failed
  gracefully: server stayed up, the broken raw file was cleaned up rather than left
  orphaned, and a clear error reached the container's own logs).
- Caught and fixed two stale README claims along the way ("no video transcoding" under
  both the Raspberry Pi and x86_64 hardware-guidance sections) that this feature made
  incorrect.

### Docs: how to wipe a Docker Compose instance clean before restoring

- New README section, "How to rebuild g33kVault" (under Backup & migration) —
  `restore.sh` only extracts a backup on top of what's already there (overwrites
  matching files, doesn't delete extras), so restoring onto a non-empty instance
  merges rather than replaces. Documents the actual clean-slate procedure
  (`docker compose down -v` to drop just this project's two named volumes, nothing
  else on the machine, then `restore.sh` into the now-empty volumes) for migrating an
  existing instance without reinstalling the OS, plus the safety caveats around a
  step that's genuinely irreversible.

### Rotate photos directly from Pending Uploads

- Pending thumbnails get the same ↺/↻ rotate buttons the approved Photo Gallery grid
  already has — no need to approve a sideways photo first just to fix its orientation,
  then find it again in the main gallery.
- No backend changes needed: `POST /api/media/:id/rotate` already worked on any image
  regardless of approval status (`getMediaById` looks across all media, not just
  approved) — this was purely a client-side gap, reusing the exact same endpoint,
  button styling, and `handleRotate` handler the Photo Gallery grid already uses.
- The one real fix: `handleRotate`'s success handler only ever patched the approved
  Photo Gallery's `items` state, a no-op for a pending item (it lives in a separate
  `pendingBatches` array). Without also patching that, a rotated pending photo would
  silently keep showing its old orientation until a manual page refresh, since its
  thumbnail's cache-busting `?v=size` query param wouldn't change. Now patches both.
- Verified for real: uploaded a real 300×150 test photo, rotated it clockwise through
  the actual browser UI, and confirmed via the live DOM (not just the API response)
  that the rendered `<img>` swapped to 150×300 and its URL's cache-busting query
  changed — a true live re-render, not a stale cached image.

### Select individual photos in Pending Uploads

- Each pending thumbnail now has a small checkbox badge in its corner (a dedicated
  button, not "click anywhere on the thumbnail" — pending items include videos with
  native `<video controls>`, which need their own clicks to work, so keeping
  selection to one consistent target avoids fighting that). A "Select all"/"Clear
  selection" link sits in each batch's header for picking most-but-not-all quickly.
- "Approve All (N)"/"Reject All (N)" switch to "Approve Selected (N)"/"Reject Selected
  (N)" the moment 1+ items are checked (asked the user which of two designs — this
  one, over adding separate dedicated buttons — to avoid button clutter), reverting to
  "All" wording at zero or fully-selected. Selection is scoped per batch — batches act
  independently, no cross-batch selection pool.
- New backend support: `POST /pending-batches/:batchId/approve` and `.../reject` now
  accept an optional `{ ids: [...] }` body to target a specific subset instead of
  every pending item in the batch — recomputed against the batch's own current
  pending items either way, never trusting a client-supplied id list wholesale (a
  requested id that isn't actually a pending member of that batch is silently
  dropped). Omitting `ids` (or the whole body) keeps the exact old "act on everything"
  behavior, so nothing about the existing "Approve All"/"Reject All"/top-level
  "Approve All Pending" buttons changed.
- A batch with some, but not all, of its items actioned stays visible with the
  remaining ones and an updated count — same "only disappears once empty" rule as
  before, just now reachable via a partial action too, not only a full one.
- Verified for real: uploaded a real 4-photo archive, selected 2 of 4 via the actual
  browser UI, confirmed the button labels and confirmation dialog updated correctly,
  approved just those 2 and confirmed via a fresh API fetch that exactly those 2 (not
  the other 2) ended up `approved` while the rest correctly stayed `pending` in the
  batch — then repeated the same real check for a partial reject.

### Running multiple g33kVault instances against one Grafana Cloud account

- Every Loki stream now carries an `instance` label, so two (or twenty) g33kVault
  deployments pushing to the same Grafana Cloud account no longer produce
  indistinguishable, silently-combined logs. Auto-generated from the host's own
  hostname plus a random number (e.g. `raspberrypi-482913`) and persisted on first
  use — a VM nobody's configured this on is still permanently distinguishable from
  every other one, never silently mixed, and at least somewhat recognizable at a
  glance rather than a pure random string. (Inside a plain `docker compose up` with no
  `hostname:` set, this ends up built from Docker's own opaque container id instead —
  set `hostname:` per deployment, or just use the override below, if that matters.)
  Overridable with a friendly name (`office-lobby`, `sarahs-wedding`) via a new
  **Instance name** field in `/admin`'s "📊 Grafana Cloud" section; clearing it falls
  back to a fresh auto-generated id rather than an empty label.
- `alloy/config.alloy.example` gained an `external_labels { instance = "..." }` block
  for the same reason on the host-metrics side — without it, multiple VMs' Alloy host
  metrics would collide in Prometheus the same way logs would have. Set to the same
  value as that VM's g33kVault instance name to correlate a host metric with an app log
  from the same machine.
- `grafana/dashboard.json` gained a new **"Uploads by instance"** panel (works
  standalone, no setup needed) for a side-by-side comparison across VMs/events. Making
  the *rest* of the dashboard's panels instance-filterable needs one manual step in
  Grafana Cloud's UI (adding an `instance` template variable + appending
  `instance=~"$instance"` to each panel's query) — documented step-by-step in
  GRAFANA.md's new "Running multiple instances" section, deliberately not hand-edited
  into the JSON here: the dashboard's newer schema (`dashboard.grafana.app/v2`) isn't
  something worth guessing at blindly and risking the already-tuned, working dashboard
  over.
- Verified for real: ran a local mock Loki server, confirmed the auto-generated label
  appears correctly in pushed payloads, confirmed an admin-set custom label persists
  and takes effect on the next push, confirmed clearing it falls back to a fresh
  generated id, and confirmed the `/admin` field itself saves and survives a page
  reload in a real browser.

### Grafana Cloud integration

- Optional, off by default: ships upload/access/moderation stats to a Grafana Cloud
  account via a new "📊 Grafana Cloud" section in `/admin`. Full write-up — what a
  Grafana account needs to provide (Loki URL, instance ID, API token), the complete
  event catalog, privacy/cardinality design, and the optional host-metrics-via-Alloy
  add-on — is in the new **[GRAFANA.md](GRAFANA.md)**.
- Designed and scoped through an extended back-and-forth before any code: landed on
  shipping structured JSON logs to Grafana Cloud's Loki push API directly from the app
  (plain HTTPS, no new dependency — Loki's JSON push API doesn't need the
  protobuf+snappy encoding Prometheus remote_write requires), queried back as
  metric-shaped dashboards via LogQL, rather than building a full Prometheus
  `/metrics` + remote_write pipeline. Optional host-level telemetry (Pi CPU/disk/
  memory — things the app's own process fundamentally can't see about itself) is a
  separate, one-time Grafana Alloy sidecar setup (`docker compose --profile
  monitoring up`), not admin-UI-driven — see GRAFANA.md for why that split.
- `GRAFANA_CLOUD_LOKI_URL`/`GRAFANA_CLOUD_LOKI_USER`/`GRAFANA_CLOUD_TOKEN` are env-var
  only, same treatment as `ADMIN_PASSWORD` — never written to `settings.json`. The
  admin section can toggle the integration, pick which categories to send (Usage &
  devices / Uploads / System health / Moderation — all independently switchable), set
  the push interval, and fire a real test push to verify credentials, but can't set or
  reveal the credentials themselves.
- Aggregate-only by design, not an opt-in choice: no IP addresses or per-guest/
  per-session identifiers in any category, ever. Device/browser info is a coarse
  bucket (mobile/tablet/desktop × iOS/Android/other × Safari/Chrome/Firefox/other),
  hand-rolled from the User-Agent header rather than adding a parser dependency — only
  a few buckets were ever needed. Loki stream labels stay to `{app, event_group}`;
  everything else lives inside each JSON log line's body, queried with LogQL's
  `| json` — deliberate, to avoid the classic way self-hosted Grafana integrations
  blow through Grafana Cloud's free-tier active-series limit.
- Buffer-and-retry for events that fail to send (an event's Wi-Fi may have no internet
  uplink even though the app itself needs none): a bounded, disk-persisted queue
  (survives a Pi reboot mid-event), retried on the next push interval, oldest events
  dropped first if an extended offline stretch fills it.
- Instrumented: page views on the five real page routes (not a blanket request
  logger — asset/API/media traffic was never logged), every upload outcome (success
  with kind/size/format/device, and each rejection reason), a periodic system
  snapshot (photo/video/pending counts, free disk space on the media volume, live
  Socket.IO connection count — reusing `/api/stats`'s counting logic rather than
  duplicating it), and every moderation action (settings changes, rotations,
  deletions, batch approvals/rejections, duplicate/low-res cleanups, backups). Upload
  events also now know whether they came from `/upload` or `/booth` — a small
  `source` field the client now sends, purely for this breakdown.
- Verified for real, not just by building: ran an actual local mock Loki HTTP server,
  pointed a real running g33kVault at it, and confirmed end-to-end — the Basic-auth
  header decoded to the right credentials, a real photo upload and page view produced
  correctly-shaped JSON log lines (right device/OS classification from a real iPhone
  User-Agent), the disk-persisted buffer filled and then correctly flushed on the next
  push-interval tick, and the `/admin` card's checkboxes, save, and "Send test event"
  button all worked against the real server in a real browser.
- Added a ready-made, importable dashboard (`grafana/dashboard.json`) covering every
  category — uploads over time, rejection reasons, bytes uploaded, page views by
  route, device/browser/OS breakdowns, stat tiles for current photo/pending counts and
  free disk space, and a raw moderation activity log — plus a "building one by hand"
  walkthrough in GRAFANA.md for going beyond it. The original version was written
  without a live Grafana instance to test against; the project owner then imported it
  for real, refined the panels directly in Grafana Cloud (thresholds, LogQL error
  filtering, descriptions), and re-exported it into the repo in Grafana Cloud's own
  dashboard schema — now confirmed working, not just structurally valid. It's wired to
  a data source literally named `grafanacloud-logs` (Grafana Cloud's auto-provisioned
  default) rather than prompting on import; see GRAFANA.md if yours is named
  differently.

### "Preview slideshow" link in /admin, works even while disabled

- A new **"🔍 Preview slideshow"** link sits right under the **Enable Slideshow**
  toggle in `/admin` — opens `/slideshow?preview=1` in a new tab, which shows the real
  photo/video rotation even when "Enable Slideshow" is off for everyone else. Lets an
  admin check the show looks right (new transitions, collage layout, a just-approved
  batch) before flipping it on for guests, instead of having to enable it first.
- No new auth check needed for the `?preview=1` bypass: "Enable Slideshow" has always
  been a pause/display toggle, not an access control (see the existing "Enable
  Slideshow" README entry) — the same media is already reachable unauthenticated via
  `/api/media` and `/media/<filename>` regardless of this flag, so nothing new is
  actually being exposed.
- When preview mode is genuinely showing something guests currently can't see (i.e.
  the toggle actually is off), a small amber "🔍 Admin preview — disabled for guests"
  badge sits in the bottom-left corner — bottom-left specifically so it never collides
  with the top-center "New Upload" badge. No badge appears once Enable Slideshow is
  back on, since at that point the preview matches what guests see anyway.
- Verified for real: installed Playwright locally, ran the actual dev server, turned
  Enable Slideshow off via the admin API, confirmed plain `/slideshow` still shows
  "Slideshow is currently disabled" while `/slideshow?preview=1` shows the real photo
  plus the preview badge, and confirmed the admin page's link points at the right URL.

### Fix: polaroid transition showed a doubled white background behind the photo

- Reported: in single-photo mode, the "polaroid" transition still showed white
  background space behind the image. Root cause: the polaroid CSS (`.t-polaroid
  .slide`) was written before every single photo got its own permanent white-bordered
  frame (`.slide-photo-frame`) and gave the `<img>` itself a second background +
  padding + rotation — nesting one polaroid-style white border inside another. Because
  only the inner image was animated/rotated, the outer frame stayed static and
  axis-aligned behind it, showing as a mismatched white box around the rotated photo.
- Fixed by moving the polaroid animation to `.slide-photo-frame` itself (rotating the
  whole white-bordered card as one rigid unit, like an actual polaroid) and removing
  the redundant background/padding/shadow it was redeclaring on the image. Video slides
  (which have no separate frame wrapper) keep the original self-contained polaroid
  styling on the `<video>` element, unaffected.
- Verified for real: installed Playwright locally (found its browser binaries already
  cached on this machine from earlier work, but the `playwright` npm package itself
  wasn't a project dependency), ran a real Vite dev server + backend, set
  `transitionStyle` to `polaroid` via the admin API, uploaded a real test photo, and
  screenshotted the settled slideshow — one clean rotated white border, and confirmed
  via `getComputedStyle` that the rotation transform lives on `.slide-photo-frame`
  while the `<img>` itself has no transform of its own (previously reversed).

### Preload the next slide's photo during the current one

- Reported: single photos sometimes took a few seconds to appear in the slideshow —
  a big photo's `<img>` only started downloading once it actually became the current
  slide, so a slow-to-decode/large file showed as a blank stall instead of a clean
  transition.
- Fixed by warming the browser's cache one slide early: while the current slide is
  showing, a throwaway `new Image()` is pointed at the *next* slide's URL, so it has
  the current slide's whole duration to finish downloading in the background before
  it's actually displayed — by the time `advance()` swaps in the real `<img>`, the
  browser typically already has it cached.
- Scoped deliberately narrow for this first pass (asked the user, who confirmed):
  only the plain single-photo case is preloaded — the exact case that was reported
  slow. Videos aren't preloaded (they stream progressively, so prefetching the whole
  file isn't the same win a decoded image gets), and a collage's tiles beyond the
  first aren't specifically covered (predicting a collage's full photo set ahead of
  time would mean duplicating the layout-picking/mixed-mode-counter logic without
  actually running it — real added complexity for a case that wasn't reported as
  slow). A collage's first tile still benefits, since it shares the same array
  position as an ordinary next-slide preload.
- No test framework or browser automation is set up in this project yet (see
  CLAUDE.md), so this was verified by build/typecheck passing and a careful trace of
  the effect's dependency/ref-sync ordering (confirmed `indexRef`/`itemsRef` are
  synced before this effect runs each commit) rather than a live network-tab
  capture — worth a quick manual check in DevTools' Network tab after deploying
  (filter by `/media/`, watch for the next photo's request starting before the
  current slide's timer fires).

### Native Apple TV app (`tvos/g33kVaultTV/`)

- Asked to scope out an iOS/Apple TV app; started with Apple TV. The original plan was
  a thin WKWebView wrapper around the existing `/slideshow` page — but a real build
  attempt revealed tvOS has no WebKit at all (`WebKit.framework` isn't part of
  `AppleTVOS.sdk`, confirmed by listing every framework in it, not assumed from
  memory). Apple TV has no general-purpose browser engine, unlike iOS/macOS, so a
  web-view wrapper genuinely can't work on this platform. Flagged this to the user and
  pivoted to a native SwiftUI app instead, once they confirmed that direction.
- The native app talks directly to the same REST endpoints the web slideshow uses
  (`GET /api/media`, `GET /api/config`, `/media/<filename>`) and reimplements the core
  single photo/video rotation experience, including the "🆕 New Upload" highlight
  behavior for a lone fresh photo vs. a quietly-queued batch. Collage layouts,
  transition styles and Party Mode are deliberately not reimplemented in this first
  pass. See [Apple TV app](README.md#apple-tv-app) in the README for the full rundown,
  including the polling-instead-of-Socket.IO trade-off and build instructions.
- Verified against a real running server in the tvOS Simulator, not just a successful
  build: booted an "Apple TV 4K" simulator, pointed the app at a live local server,
  and screenshotted the actual result at each step. This caught two real bugs a build
  alone wouldn't have — `.textFieldStyle(.roundedBorder)` is unavailable on tvOS (fixed
  by dropping the explicit style, which tvOS doesn't need for its remote-driven focus
  chrome anyway), and the uploader-name tag was pinned to the screen edge instead of
  the photo frame's edge because it was a ZStack sibling of the framed image rather than
  an overlay on it — a greedy `Spacer()` in the tag row expanded the whole ZStack to
  full screen width, the same underlying category of bug the web slideshow's frame hit
  and fixed earlier (tags need to be nested/attached to the frame's own box, not a
  separate layer positioned against the full screen). Fixed by attaching the tags as an
  `.overlay(alignment: .bottom)` on the exact view chain that has the frame's
  padding/background, which guarantees the same bounding box.
- Also needed a fresh tvOS platform/simulator download mid-session — `xcrun simctl list
  runtimes` intermittently came back completely empty despite the SDK being present on
  disk, and `xcodebuild -downloadPlatform tvOS` had to be re-run (twice) before the
  simulator devices actually registered. Not something this project's code caused; a
  quirk of this particular machine's Xcode/platform installation state.

### "Approve All Pending" button in /admin

- A new **"✅ Approve All Pending"** button sits above the individual batch rows in the
  "📦 Pending Uploads" tool — approves every pending batch in one click (with the usual
  confirmation dialog), for clearing a backlog without reviewing each batch one at a
  time. New `POST /api/admin/pending-batches/approve-all` endpoint; the existing
  single-batch Approve All/Reject All buttons on each batch are unchanged.
- The existing rule for a single approved item getting the normal "🆕 New Upload"
  highlight instead of a quiet insert — previously judged per batch — is judged across
  *everything* this button approves in one action: a backlog of, say, 15 individual
  pending uploads (each its own one-item "batch") approved all at once stays quiet for
  all 15, rather than firing 15 highlights back to back, which would have defeated the
  entire point of the quiet path. Only the case where there's truly just one photo
  pending, period, gets the highlight.
- Verified against a real running server: a mix of three single-upload batches plus one
  two-photo archive batch (5 items total) all correctly used the quiet `media:approved`
  event; with exactly one photo pending, the same button correctly fired `media:new`
  instead; the pending list and public gallery count updated correctly in both cases;
  and the button, its confirmation dialog text, and the resulting empty state were all
  checked in a real browser.

### Fix: single-photo frame's letterbox "matting" was too much white

- Reported as "the slideshow background is white" — for a photo whose aspect ratio
  didn't match the screen (a portrait photo being the clearest case), the cream-white
  fill added a few rounds ago to avoid black letterbox bars could end up covering most
  of the screen, dominating the composition far more than a thin border was ever meant
  to. Checked with the user which of three fixes they wanted (revert to plain black,
  keep a thin border with black filling the rest, or crop photos to fill the frame) —
  they picked the middle one: a white border that hugs the photo's own actual size,
  with black filling whatever's left over.
- Done in pure CSS, no JavaScript measurement needed: the `<img>` gets `width/height:
  auto` plus `max-width`/`max-height` in viewport units (not percentages, which would
  create a circular dependency on the border wrapper's own size) — a plain image with
  only max-width/max-height set naturally scales to fit both while preserving its
  intrinsic aspect ratio, the same mechanism behind an ordinary responsive
  `max-width: 100%` image, just applied to both axes at once. The white-bordered wrapper
  then has no explicit size of its own, so as a centered flex child it shrink-wraps to
  exactly the image's real rendered size plus its own padding — the border ends up
  exactly where the photo's edge actually is, not the edge of the available screen area.
- The uploader/date tags move with it, still anchored to this now-tighter box rather
  than the wider empty area — otherwise they'd end up floating away from the actual
  photo for a narrow portrait one, the same misalignment problem fixed for the previous
  (differently-shaped) frame a few rounds ago.
- Verified with the same portrait/landscape test photos used throughout this feature's
  development: black now fills the letterbox space instead of cream, the border still
  hugs a landscape photo just as tightly as before, both tags measured to stay inside
  the tighter frame boundary, and video (unframed, unaffected either way) confirmed
  still full-bleed.

### Optional approval for regular photo/video uploads

- New **"👀 Require approval for uploads"** toggle in `/admin`'s Playback Settings. Off
  by default (unchanged behavior). When on, every photo/video from `/upload` or `/booth`
  — not just a guest-uploaded archive's contents, which already worked this way — is
  held for review instead of going straight to the live slideshow. Concept discussed
  before building: three real design forks (how a single upload should fit into a UI
  built around archive batches, whether Photo Booth should be covered, and what
  approving one photo should look like), each resolved before writing code.
- Reuses the exact same `pending`/`batchId`/`batchLabel` machinery a guest-uploaded
  archive's contents already use — a single upload just becomes a "batch" of one, with
  its own `batchId` (its own row id) and `batchLabel` (its original filename), showing
  up as its own entry in the existing "📦 Pending Uploads" list with the same Approve/
  Reject actions. No new review UI, no new data model.
- Approving a batch of exactly one item now emits the normal `media:new` event — the
  full-screen "🆕 New Upload" highlight, exactly as if the upload hadn't waited for
  approval — rather than the quieter `media:approved` a real multi-photo archive batch
  still gets (unchanged): dozens of back-to-back highlights for one approved archive
  would be worse than none, but a single approved photo doesn't have that problem.
- `/upload` shows an accurate note before and after uploading — before, if the setting
  is on, a note that covers everything (not just archives, which is what the pre-existing
  archive-specific note was scoped to); after, a message distinguishing "received,
  pending approval" (a plain photo/video held by this setting) from "received, being
  processed" (an archive still being extracted) — previously any `202` response was
  unconditionally labeled "archive," which would have been wrong for the new case.
- Verified end-to-end against a real running server: upload with the setting off
  (unaffected, still 201/`media:new`, confirmed no regression); upload with it on
  (202/`pending`, correctly excluded from `/api/media` and the Event Statistics count);
  approve (fires `media:new`, moves into `/api/media`) and reject (fully deletes,
  confirmed via the pending-batches list going empty) via the real admin endpoints; a
  genuine multi-photo archive still uses the quiet `media:approved` per item, unaffected
  by the new single-item logic; the Admin.tsx checkbox loads, saves, and persists
  correctly; the Upload.tsx pre- and post-upload messaging, screenshotted in a real
  browser, matches exactly.

### Fix: uploader/date tags cutting into the single-photo frame's border

- Reported with a real screenshot: the bottom of the white photo frame looked
  interrupted/broken. Root cause confirmed by measuring the actual DOM — the uploader
  name and photo-date tags were still positioned `bottom: 1.25rem` from the *screen*
  edge, a leftover from before the frame existed (when the photo filled the full
  screen, so that offset happened to land near the photo's edge too). With the frame
  now inset, that put the tags straddling the frame's bottom border — mostly inside it,
  a few pixels poking out into the black gutter — rather than cleanly on one side of it.
  The gutter itself (24px) also isn't tall enough to fit a tag outside the frame without
  enlarging it, so — confirmed with the user first — the tags now nest inside the framed
  photo instead, anchored to the frame's own box rather than the screen edge, floating
  over the bottom of the photo like a caption. Verified the tags now sit fully inside
  the frame boundary at every position (uploader bottom-right, date bottom-center,
  together, with a portrait photo matching the original bug report), and that videos —
  which don't get a frame — keep their uploader tag exactly where it was, unaffected.

### Fix: single-photo frame gutter was uneven

- Sized the black gutter around the frame with `94vw`/`94vh`, which looked wrong: `vw`
  and `vh` are percentages of two *different* base dimensions (viewport width vs.
  height), so carving off the same percentage from each produces a different number of
  pixels per axis on any non-square screen — 1600×900 gave a 48px gutter on the sides
  but only 27px top/bottom. Confirmed uneven with a real measurement, then fixed with
  `calc(100vw - 48px)` / `calc(100vh - 48px)` — subtracting the same fixed pixel amount
  from both axes guarantees an equal gutter regardless of aspect ratio, verified at
  16:9, 4:3, and a phone's portrait ratio (24px on all 4 sides in every case). Also
  shrank both the gutter and the white border themselves (was a chunkier 2vw padding,
  now a fixed 12px, closer to the collage tiles' own 10px) — smaller and unmistakably
  even beats bigger and slightly lopsided.

### Fix: single-photo frame wasn't visible against a white background

- The white photo-matting frame added just above filled the entire viewport edge to
  edge, so there was nothing behind it to actually read as a "frame" — no visible
  border effect, since the white just blended into the actual screen edge. A collage
  tile, by contrast, sits inset within `.collage-frame`'s black background, which is
  exactly what makes its white border visible. Fixed by giving the single-photo frame
  the same treatment: `.slide-frame` is now black (matching `.collage-frame`), and the
  framed photo is slightly smaller than the viewport (94vw × 94vh, centered) rather than
  filling it, so the black shows as a gutter all around — plus the same drop shadow a
  collage tile gets, now that there's a dark backdrop for it to actually fall on.

### White frame around single photos in the slideshow

- Single-photo slides now get the same cream-white "photo matting" a collage's grid
  layouts use — a clean, even border on all sides, no rotation. Three decisions
  clarified before building: even border (not the tilted, thick-bottom Polaroid style
  the Scattered Wall collage layouts use) — a full-screen rotated photo felt like too
  big a change for every single slide; the whole photo stays visible, uncropped
  (`object-fit: contain`, same as before) rather than switching to the collage tiles'
  crop-to-fill behavior — a photo whose aspect ratio doesn't match the screen now shows
  the matting color filling that space instead of the previous black letterbox bars,
  rather than losing part of the photo to a crop; and videos keep their existing
  full-bleed look — a white-bordered playing video read oddly in a preview mockup.
  Applies to the "New Upload" highlight too, since that's the same image element with a
  badge overlaid, not a separate one — no special-casing needed there.

### Scattered Wall — Zigzag Band: capped overlap at 5%

- The previous version's same-row neighbors overlapped by 28-45% of a tile's width —
  enough to hide a meaningful chunk of the photo behind it. Repositioned all 6 tiles so
  neighbors overlap by only ~2-2.4% of tile area, comfortably under a 5% cap. Tiles also
  shrank somewhat (40vh vs the previous 46vh) — fitting 3 per row at this tight an
  overlap needs narrower tiles, which leaves a bit more black margin top/bottom than the
  max-fill version from two rounds ago. A deliberate trade-off: minimizing how much of
  each photo gets hidden now wins over squeezing out every last bit of black space.
- Caught and fixed a measurement mistake before shipping this: an initial pass
  calibrated the new positions against each tile's *axis-aligned bounding box*, which
  for a rotated element is inflated well beyond its actual visible footprint (empty
  space in the rotated corners counts toward the bounding box but isn't really there) —
  that first attempt measured 6-8% "overlap" that wasn't actually real. Recomputed using
  true rotated-rectangle polygon intersection (the tiles' real rotated footprints, not
  their bounding boxes) to get an accurate number before finalizing the positions.

### Photo Gallery collapsed by default in /admin

- Follow-up to the two fixes above: with the re-render cost and per-image lazy-loading
  both fixed, the Photo Gallery card still requested every visible thumbnail the
  instant `/admin` loaded, since the grid was always rendered. It's now a collapsed
  accordion, matching the Gallery Tools row below it (chevron, item count, "tap to
  show") — the grid, and the `loading="lazy"` `<img>` tags inside it, aren't rendered
  into the DOM at all until an admin actually expands it, so a large gallery costs
  nothing on page load instead of "less than before." Verified against a synthetic
  2,000-item gallery: zero `/media/` requests and zero rendered thumbnails while
  collapsed, expanding renders all 2,000 correctly with lazy-loading still limiting
  actual network requests to what's near the viewport, and the item count keeps
  updating live over the existing socket while collapsed (only what's *rendered* is
  gated by the new toggle — the underlying data/socket layer is unchanged).

### Admin layout fixes for iPhone

- Follow-up to the iOS input-lag fix below: with that solved, the actual layout on a
  narrow screen turned out to have several real overflow bugs, not just tight spacing.
  Confirmed with a real WebKit-engine screenshot at iPhone width (390px) before and
  after each fix, not just reasoning about the CSS. A `@media (max-width: 480px)`
  breakpoint (desktop layout is completely unaffected):
  - **Gallery Tools accordion headers** (Duplicate Photos, Photo Dates, Low-Resolution
    Photos, Pending Uploads, Backup & Restore) could overflow their row — "Backup &
    Restore" with a real backup summary needed 431px in a 324px-wide row, and since
    nothing there scrolled independently, that dragged the *entire page* into
    horizontal scroll. The label now always stays on one line; the summary next to it
    truncates with an ellipsis, and — since the longest labels left so little room that
    truncation degenerated to something like "N…" — the summary wraps to its own full
    row below the label instead of being squeezed into a sliver.
  - **The Playback Settings form** used a free-flowing `flex-wrap`, which could let a
    label land on its own line separated from the input/select it describes, and let a
    long checkbox label (e.g. "Party Mode (random transition every slide)") wrap
    word-by-word. Each label now stacks directly above its own control, full-width.
  - **Every `<select>`** (Transition, Photo Collage mode/layout) sizes itself to fit its
    widest option by default — "Mix (collage every 4th slide)" was making some
    dropdowns wider than the card itself. Now full-width and capped to the card.
  - **The Photo Gallery grid** dropped to a single, nearly-full-width column at iPhone
    widths (the existing 160px-minimum column size was already too wide for 2 columns
    at this breakpoint, even before any of these changes) — fine for looking at one
    photo, but a lot of scrolling to spot-check a large gallery, which is the primary
    way this gets used from a phone (a quick glance/delete/rotate during a live event,
    not full scan/backup work). Narrowed the minimum column to keep 2 columns.
  - Rotate/delete buttons bumped from 28px to 38px (mobile only) — closer to Apple's
    44pt touch-target guidance without changing the desktop-mouse-sized default.
  - One bug caught during this work and fixed before it shipped: an early version of
    the settings-stacking fix used a bare `input` descendant selector that also matched
    the checkbox `<input>` nested inside its own `<label>` (not just the top-level
    number input it was meant for), stretching a 12px checkbox to ~188px wide and
    squeezing its label text into a wrapped sliver. Caught by inspecting real computed
    styles, not just eyeballing a screenshot.

### Fix: Admin unresponsive on iOS with a large gallery

- Reported as "can't click any checkboxes or change any settings" on an iPhone; turned
  out to be severe input lag (up to ~30 seconds for a checkbox to register), not a
  touch/CSS bug — confirmed by reproducing with Playwright's WebKit engine (Safari's
  actual rendering engine) plus real touch taps, which worked instantly on a small
  gallery. Two compounding causes, both scoped to large galleries (thousands of items):
  1. The Photo Gallery grid and the Playback Settings form (checkboxes, selects) lived
     in one large component, so toggling any setting forced React to re-render and
     re-diff every thumbnail in the grid, not just the control that changed. Fixed by
     extracting the grid into its own `React.memo`-wrapped component, with the handler
     functions it needs (`onOpenViewer`/`onRotate`/`onDelete`) wrapped in `useCallback`
     so their identity stays stable across renders — otherwise a memoized component still
     re-renders on every new function reference passed in as a prop.
  2. Every thumbnail — in the main gallery, duplicate groups, pending-batch review, and
     low-resolution results — requested the full original photo with no lazy-loading
     and no server-side thumbnail generation, so loading the admin page requested and
     decoded every photo in the library at once. Fixed with `loading="lazy"` on every
     gallery `<img>`; confirmed via a real browser network trace on a synthetic
     4,300-item gallery that this cuts initial image requests from 4,300 to ~10 (just
     what's visible in the viewport). This is very likely the dominant factor on a real
     phone with real multi-megabyte photos — thumbnails still aren't generated
     server-side, so a very large gallery will still be heavier than ideal; worth a
     proper thumbnailing pipeline if galleries keep growing (see "Notes / ideas for
     later" in the README).
- Verified end-to-end: a synthetic 4,300-item gallery (seeded directly into the JSON
  store, matching a real user's reported library size) measured under 6x CPU throttling
  in Chromium — checkbox-toggle latency dropped from 475ms to 144-224ms with both fixes
  applied, and this doesn't yet account for the far larger real-world effect of
  lazy-loading on actual multi-megabyte phone photos over a real network, which the
  synthetic small test images can't fully demonstrate.

### Photo Collage mode

- New "🖼 Photo Collage" control in /admin's Playback Settings, next to Transition and
  Party Mode: a mode dropdown (Off / Always / Mix — collage every 4th slide) and a
  layout dropdown (8 named layouts plus "Random layout each time"), the layout select
  disabled while mode is Off. Roadmap and the first 10 layouts were designed and
  approved as a visual mockup before any code was written, including a follow-up round
  adding a white border around every tile (even on all sides, except the two layouts —
  Diagonal Stack and Scattered Polaroid Wall — that were already polaroid-style with a
  thick bottom border, which kept their existing look unchanged).
- A second revision round after first building it: four of the original 10 layouts (2-
  Split Vertical, 2-Split Horizontal, 3 Even Columns, 1 Big + 4 Small) were dropped for
  being visually flat/uninteresting compared to the rest; Diagonal Stack was tightened
  from its original heavy overlap to just a minor corner overlap; and the single
  Scattered Polaroid Wall layout was likewise tightened to minor overlap and expanded
  into 6 distinct arrangements of the same "polaroid wall" style (Even Grid, Big Top
  Pair, Two Columns, Diagonal Cascade, Center Cluster, Zigzag Band), each a different
  loose composition of the same 6 photos rather than one fixed layout.
- A third revision round, after reviewing a live mockup catalog of every layout: every
  Scattered Wall tile was resized to a photo-realistic ratio between 4:3 and 16:9
  (varied tile-to-tile, never square — the Diagonal Cascade variant's tiles had drifted
  close to square) with margins/overlaps trimmed to minimize black space; Diagonal
  Stack, Two Columns, and Diagonal Cascade were then dropped outright (the remaining
  overlap Diagonal Stack needed to hit both the ratio range and a tight frame fill, with
  only 2 photos to work with, read as too much; the other two didn't earn their slot);
  and Zigzag Band — the worst offender for empty space — was rebuilt from small
  scattered tiles into two full-height overlapping rows, filling nearly the entire
  frame. Final list is 8 concrete layouts: 1 Big + 2 Stacked, 4-Grid Even, Feature + 3
  Thumbs, 6-Grid Even, and 4 Scattered Wall variants (Even Grid, Big Top Pair, Center
  Cluster, Zigzag Band) — built with CSS Grid explicit placement for the 4 rectangular
  ones (a flat list of sibling tiles, letting Grid auto-placement fill the rest in
  reading order around one explicitly-placed "feature" tile) and `vw`/`vh` absolute
  positioning for the 4 overlapping/rotated ones, so every layout scales correctly to
  any real screen resolution. The smallest layout now needs 3 photos (was 2, back when
  Diagonal Stack existed) — the collage-eligibility floor and its no-collage fallback
  were updated to match, so a 2-photo gallery correctly never shows a collage instead of
  rendering one short a tile.
- A handful of scoped calls made to keep this a buildable first version, each easy to
  revisit later: collage tiles reuse the existing slideshow-speed setting rather than
  getting a separate duration control; "Mix" mode fires a collage on exactly every 4th
  slide (a simple turn counter, not tied to how many photos a previous collage
  consumed); videos never appear inside a collage tile and always keep their normal solo
  turn instead (a collage set is filled by skipping past any video in the upcoming
  items); and a fresh upload's existing full-screen "New Upload" highlight still takes
  priority over collage mode exactly as before, with collage rotation resuming right
  after the highlight (and any highlights queued behind it) finishes.
- New `collageMode`/`collageLayout` settings (server `settings.ts`, validated in
  `PUT /api/admin/settings`, exposed on the public `GET /api/config`), pushed live to
  `/slideshow` over the existing `config:updated` socket event with no reload needed.
- Verified against a real running server across all three rounds: every layout render
  the correct tile count and CSS class each time, checked against the approved mockup
  or catalog for that round (pixel-correct match, including drop shadows, rotation, and
  — in the third round — that no tile reads as square); one bug caught and fixed along
  the way (Center Cluster initially clipped at the frame's bottom edge from the
  polaroid style's extra bottom padding); server-side settings validation confirmed to
  reject every removed layout id (including `diagonal-2` after the third round) and
  accept the current ones; the collage-eligibility floor bump (2 → 3 photos) confirmed
  by exercising the smallest remaining layout, 1 Big + 2 Stacked; Mix mode's cadence
  confirmed exactly every 4th turn by reading the counter logic
  (wall-clock polling alone wasn't precise enough to rule out sampling drift); a
  real (dummy-content) video upload confirmed to never appear inside a collage tile
  across multiple collage turns; Off mode confirmed to show zero collages (pure
  regression check); a real fresh upload while collage mode was active confirmed the
  New Upload highlight still takes over first, with collage rotation resuming
  afterward; and the new Admin.tsx dropdowns exercised through the real browser UI,
  including the layout select correctly disabling under Off and the Save round-trip
  persisting both fields.

### "Enable Slideshow" toggle

- New checkbox in /admin's Playback Settings. Turning it off does two things live,
  pushed over the existing WebSocket with no reload needed: `/slideshow` shows "Slideshow
  is currently disabled" instead of the normal rotation (matching the visual style of
  the existing "Waiting for the first upload…" empty state), and the "Launch Slideshow"
  button on the main page (`/`) turns into plain non-clickable text reading "Slideshow
  currently disabled" in the same spot. Defaults to enabled, so existing deployments are
  unaffected. Verified with three real browser tabs open at once (Host, Slideshow, and
  Admin) — toggling the checkbox in Admin updated both of the other already-open tabs
  immediately, and toggling back on correctly resumed the slideshow showing real content
  again, not just an empty non-error state.

### Guest-uploaded archives with admin review

- `/upload` now accepts `.zip`, `.tar.gz`, and `.rar` (not `.7z` — that stays exclusive
  to the admin-only watched import folder, by choice), for a guest with a whole folder
  of photos rather than picking them one at a time. Concept and every open design
  question (per-photo vs. whole-batch approval, what happens on rejection, where the
  review UI lives, synchronous vs. background extraction, archive size limit) were
  discussed and decided before any code was written.
- Unlike a normal upload, an archive doesn't go straight to the live slideshow: the
  guest gets an immediate "received, being processed" response (extraction happens in
  the background after, reusing the exact same code the watched import folder already
  uses — not while their connection is held open, which matters on a large archive over
  mobile data), and every photo/video extracted from it lands in a review queue instead
  of the gallery, grouped with the rest of that archive as one batch.
- New "📦 Pending Uploads" row in /admin's Gallery Tools — unlike the other rows, this
  one loads automatically (rather than waiting for a scan click) and stays live via a
  new `media:pending` broadcast, since an unreviewed batch is time-sensitive during a
  live event in a way "run a duplicate scan when convenient" isn't. Each batch shows its
  original archive filename, uploader name if given, and a thumbnail grid, with
  **Approve All** (goes live, quietly entering normal rotation — deliberately *not* the
  "New Upload" highlight badge, since approving dozens of photos at once would otherwise
  mean dozens of disruptive highlights back to back) and **Reject All** (permanently
  deleted immediately, same as every other delete in this app, with a confirmation
  dialog naming the count).
- New `MediaRow.status` (`'pending'` | `'approved'`, undefined treated as approved so
  every existing row is unaffected) and `batchId`/`batchLabel` fields. A new
  `getApprovedMedia()` is the single filter point every public/live-facing read goes
  through — `GET /api/media` (slideshow, host stats, admin's own gallery grid) and the
  other admin scan tools (duplicates, photo dates, low-resolution) all now operate on
  approved media only, so a pending photo can't leak into the public gallery or get
  flagged by another tool before it's reviewed.
- Archives get their own size limit, `MAX_ARCHIVE_SIZE_MB` (default 500 MB), separate
  from `MAX_FILE_SIZE_MB` for a single photo/video, since a compressed multi-photo dump
  is reasonably much bigger than any one file.
- A real bug found during testing: approving a batch initially only reached the public
  slideshow — the admin's own Photo Gallery grid kept showing the old count until a
  manual reload, because it only listened for `media:new`, not the new quieter
  `media:approved`. Fixed by adding the same live-insert handler there.
- Verified end-to-end with real archives built and uploaded through the actual public
  endpoint (not just unit-level calls): a real `.zip` and a real `.tar.gz`, each
  extracted, hashed, and correctly hidden from `/api/media` and the Event Statistics
  panel while pending; a byte-identical duplicate of an already-approved photo
  confirmed absent from the duplicate scan while pending and correctly detected the
  moment it's approved (proving the approved-only filtering is real, not just always
  finding nothing); approve and reject both exercised through the real admin UI in a
  browser, including the Photo Gallery grid updating live; oversized-archive rejection;
  and `.7z` correctly refused by this endpoint. `.rar` creation tooling wasn't available
  to build a genuine test fixture (same pre-existing gap as the watched import folder),
  but the accept path and graceful-failure-on-a-corrupt-file path were both confirmed.

### Photo viewer popup with prev/next in /admin

- Clicking a photo in the main Photo Gallery grid now opens a dedicated popup window
  (via `window.open()` with explicit size/chrome flags — the standard way to request a
  separate window rather than a tab, though browsers ultimately treat this as a
  preference, not a guarantee) instead of a plain new tab. Clicking the photo inside
  that window closes it. Left/right arrows step to the previous/next photo, in the same
  newest-first order the admin grid shows, without closing the window; they're hidden
  at the first/last photo rather than wrapping around, by choice. New standalone
  `/photo-viewer` route/page, reusing the already-public `/api/media` endpoint (no new
  auth surface — the same photo list is already exposed via the public slideshow page).
  Scoped to the main Photo Gallery only, by choice — Duplicate Photos stays as-is
  (no click-through), Low-Resolution Photos keeps its existing plain new-tab click.
- Verified end-to-end with a real running instance: the popup opens showing the
  clicked photo, has no left arrow on the newest (first) photo, steps correctly through
  all photos via the right arrow, correctly loses the right arrow on the oldest (last)
  photo rather than wrapping, and clicking the photo closes the popup while leaving the
  admin tab untouched.

### Fix: duplicate/photo-date scans could freeze the entire server on a large uncached file

- Root cause of a real report ("shows 1%, never changes until it's finished" on a
  repeat scan that should have been mostly cached): `computeContentHash` read the
  whole file into memory and hashed it with `fs.readFileSync` — fully synchronous, zero
  `await`. For one large uncached video or photo (e.g. an older file that predates
  content-hash backfilling), this blocks Node's entire event loop for however long that
  single read+hash takes — not just this feature's own progress display, but *every*
  other request and socket the server is handling, for the same duration.
- Now streams the file through a `crypto.createHash` update loop instead, so the
  read+hash no longer monopolizes the event loop. Verified two ways: correctness (the
  streamed hash matches real `shasum -a 256` byte-for-byte, and duplicate detection
  still correctly groups identical files) and the actual fix (hashing a ~2GB file while
  firing 8 separate concurrent requests throughout — previously all 8 would have queued
  behind the ~3-second synchronous block and landed together at the end; now every one
  responded promptly, 6-351ms, throughout the whole operation).
- Worth being upfront about the remaining limitation: this stops one huge file from
  freezing the whole app, but the duplicate scan's own percentage will still hold at
  that file's position while it's specifically being hashed — an accurate reflection of
  "working on this one item," not a bug, just not more granular than per-item. If a scan
  is still dominated by one or two big files after this fix, sub-item progress (e.g.
  bytes hashed so far) would be the next thing to add, but wasn't built here since it's
  a separate, larger change.

### Fix: scan progress bars showing a literal "0%" for a long stretch on large galleries

- All five progress percentages in /admin (Duplicate Photos scan and delete-all, Photo
  Dates scan, Low-Resolution Photos scan and delete-all) used plain `Math.round`, which
  rounds down to a literal "0%" until enough items have been processed to cross the
  0.5% mark — on a 1000-photo gallery, that's the first 4 items. Technically accurate,
  but reads as "stuck" rather than "just started", which is exactly what got reported.
  Now floors the display at 1% as soon as any real progress exists (item 1 of 1000
  shows "1%", not "0%"). Verified on a real 300-item scan with no cached hashes yet
  (forcing genuine per-item work): the first percentage shown is now 1%, climbing
  through 11%, 37%, 61%, 85% before completing — previously the first several items
  would have all displayed "0%".

### Configurable resolution threshold for Low-Resolution Photos

- The scan threshold was previously fixed at 160×120. Now a "Resolution threshold"
  dropdown in the Low-Resolution Photos row offers named presets — Tiny thumbnails
  (160×120), Old VGA (640×480), SD (854×480), HD-ready (1280×720) — plus a Custom
  option with two width/height number inputs for any exact value, defaulting to
  Custom at 320×280. Changing the threshold clears any results already on screen
  (they were computed under the old threshold) rather than leaving a stale count
  displayed next to a newly-selected value.
- Worth calling out: 160×120 only catches literal thumbnail-sized accidents. A photo
  that's merely SD-quality (e.g. 640×480 or 854×480) will still look visibly soft
  blown up fullscreen on a modern TV or projector — which is presumably how this
  slideshow actually gets displayed — but wouldn't trip a 160×120 check at all. The
  HD-ready (1280×720) preset is a closer match to "looks bad on the big screen"
  specifically, if that's the goal rather than just clearing out true thumbnails.
- The delete-all endpoint takes the same threshold query params as the scan (rather
  than a hardcoded default), so it always deletes against whatever was actually just
  scanned. Verified against 10 real test images spanning every preset boundary (100×75
  up to 1600×900): each preset flags exactly the expected set, including the
  orientation-independent "either edge" rule correctly catching a wide-but-short image
  (854×480) under the VGA preset even though its long edge exceeds 640 — its short
  edge (480) still qualifies.

### Click a photo in /admin to open it full-size in a new tab

- Originally just the main Photo Gallery grid, now also the Low-Resolution Photos
  results (by request) — Duplicate Photos results are still unaffected. Videos are
  unchanged everywhere — they keep their native click-to-play/pause controls rather
  than being wrapped in a link, which would have broken them. The existing
  rotate/delete overlay buttons still work exactly as before in both places; verified
  they don't trigger the new link (they're siblings of it, not inside it) and that
  clicking a photo opens a real new tab at the image's actual URL without navigating
  the admin page away.

### Low-resolution photo detection in /admin

- New "Low-Resolution Photos" row in Gallery Tools, alongside Duplicate Photos and
  Photo Dates: scans every image's actual pixel dimensions (via `sharp`, already a
  project dependency) and lists anything at or below 160×120 — usually a thumbnail, a
  resized re-upload, or a screenshot rather than the original camera photo. Each
  flagged photo shows its real resolution; a "Delete All Low-Resolution Photos (N)"
  button removes all of them in one batch after a confirmation naming the count,
  mirroring the Duplicate Photos delete-all (same reasoning: the server recomputes the
  flagged set itself rather than trusting a client-supplied list, so a stale request
  can't delete a photo that's no longer actually low-res).
- The threshold check is orientation-independent by design: a photo's shorter edge is
  checked against 120px and its longer edge against 160px, regardless of portrait vs.
  landscape — a naive width<=160/height<=120 check on raw stored dimensions would
  incorrectly flag a perfectly good 120×160 portrait photo (same pixel count as an
  ordinary 160×120 landscape one, just rotated). Confirmed with deliberately
  constructed test images: a 160×120 image (and its 120×160 portrait equivalent) sits
  exactly on the line and is correctly flagged ("at or below"), 161×121 is not, and a
  normal 1080×1920 portrait phone photo is correctly left alone.
- Dimensions aren't cached — re-read fresh on every scan (cheap, header-only, no full
  decode) rather than stored on the row, so a later rotation (which swaps width/height)
  can't leave a stale flag behind.

### Admin page reorganization

- /admin had grown into a long, undifferentiated stack of controls as features
  accumulated over time. Reorganized into: a "Playback Settings" card (unchanged
  content, just newly grouped); a "Gallery Tools" section where the three occasional
  maintenance actions (Backup & Restore, Duplicate Photos, Photo Dates) are now
  collapsible rows — collapsed by default, each showing a one-line status summary
  ("Last backup 2h ago · 340 MB · 118 items", "3 exact · 1 similar", "Found dates for
  42/118 photos", or "Not scanned yet") and expanding independently to their full
  existing controls/results when clicked; and a "Photo Gallery" card for the item grid.
  No feature, button, or option was removed — purely a layout change. Proposed two
  mockup directions for review before building (sectioned cards vs. collapsible tools);
  the collapsible-tools direction was chosen. Verified end-to-end with a real running
  instance: starts fully collapsed, each row toggles independently of the others, and
  scanning for duplicates through the new collapsed/expanded row still works exactly as
  before with real live results.

### Photo-taken date overlay in the slideshow

- New "📅 Scan Photo Dates" button in /admin, reading each image's EXIF `DateTimeOriginal`
  and `CreateDate` (taking the earlier of the two when they disagree; falling back to
  `ModifyDate` only if neither exists) via `exifr` — a pure-JS library, not a system
  `exiftool` binary, to stay consistent with this project's no-native/no-system-binary
  dependency policy. Shows live progress the same way the duplicate scan does.
- Every photo where a date was found now shows it as a small overlay at the bottom
  center of the slideshow (e.g. "Jul 15, 2024"). Photos with no usable EXIF (screenshots,
  booth captures) simply show nothing.
- Found and worked around a real data-loss gap during development: this app converts
  every HEIC photo (the default iPhone camera format) to JPEG on ingest, and that
  conversion strips 100% of EXIF metadata — verified by round-tripping a real HEIC file
  with known EXIF dates through the app's actual conversion code. Fixed by extracting
  the date from the *original* file before HEIC conversion runs, in both ingestion paths
  (`/api/upload` and the watched import folder), so this works correctly for HEIC
  uploads going forward. It's an unrecoverable gap for anything imported *before* this
  fix, though: the original HEIC bytes are already gone by the time the scan button can
  look, so the backfill can only find a date for photos that happened to arrive as plain
  JPEG (EXIF untouched through this app's pipeline either way). Verified end-to-end: a
  real HEIC file with known EXIF dates uploaded via each path, a plain JPEG upload, an
  import-folder JPEG, a simulated legacy JPEG (backfilled correctly), and a simulated
  legacy HEIC-sourced photo with already-stripped EXIF (correctly finds nothing, doesn't
  error, and isn't re-scanned on a later run).
- `photo_taken_at` needed no changes to the backup/restore path to be covered by it —
  both the admin "Download Backup" button and `scripts/backup.sh` archive the entire
  metadata JSON file as-is (not a curated field list), so any field it holds, this one
  included, is backed up automatically. Verified for real: downloaded an actual backup
  of a gallery with a mix of dated and undated photos, confirmed every `photo_taken_at`
  value survived in the archived JSON untouched, then restored it into a fresh instance
  and confirmed the running server served the same values back out.

### Fix: photos imported via the watched folder appeared at the bottom of /admin instead of the top

- Uploads (web and booth) stamp `created_at` as the moment they're added to the vault,
  and the admin grid sorts newest-`created_at`-first — so a fresh upload always shows up
  at the top. Import-folder photos instead stamped `created_at` as the source file's own
  modification time, which for a real photo dump (SD card export, phone backup) is
  usually the original capture date, sometimes months old — so an imported photo sorted
  by that old date and could land anywhere in the grid, typically near the bottom, no
  matter when it was actually imported. Now uses the same "added to vault" timestamp as
  uploads. Verified with a real photo backdated to a 2025 file mtime dropped into the
  import folder: it now sorts to the top of /admin right alongside a same-session web
  upload, ahead of anything actually older.

### Duplicate-scan progress + one-click bulk cleanup

- The "Scan for Duplicates" button now shows a live percentage (e.g. "Scanning… 52%")
  while a scan is running, instead of just "Scanning…" with no sense of whether it's
  stuck. The server broadcasts progress over the same Socket.IO connection already used
  for live gallery updates as it backfills each photo's hash; verified end-to-end with
  Playwright against a real slow first scan (large, never-before-hashed images), and
  confirmed the percentage does *not* appear on a fast, already-hashed rescan since
  there's no meaningful backfill work left to report progress on.
- New "🗑 Delete All Duplicates (keep one of each)" button on the results, for when a
  scan turns up a lot of duplicates and clicking ✕ on each one individually isn't worth
  it. New `POST /api/admin/duplicates/delete-all` endpoint recomputes the duplicate
  groups server-side, merges every group into connected clusters (a photo can be a
  member of more than one group — an exact-duplicate trio is also a similar-photos
  cluster, and a photo can independently be "similar" to two unrelated others), keeps
  exactly one survivor per cluster (the earliest-uploaded copy), and deletes the rest —
  file and metadata record both — in a single batched DB write, broadcasting live
  progress the same way the scan does.
  - First version of this did the deletions one HTTP request at a time from the
    browser, deciding a survivor per *group* rather than per merged cluster. Both
    choices turned out to be real problems, not just style: every single-item delete on
    the server does a full read-modify-write of the entire JSON metadata file, so a
    gallery with hundreds of duplicates meant hundreds of full-file rewrites in a
    client-side loop with no per-item error handling — one failed request killed the
    whole batch silently, partway through, which is exactly what a real user hit
    ("some photos exist 3 times, there should be only one kept" after clicking the
    button). And deciding survivors per-group rather than per-cluster meant a photo
    picked as the "keeper" in one group could simultaneously be a "delete this" member
    of a different, overlapping group — a real correctness bug, not just a performance
    one. Rewritten as the single batched endpoint above; verified against a 120-item
    gallery (40 duplicated photos + overlapping near-duplicate/exact clusters, 88
    correct deletions) and a 500-item single giant cluster (499 deletions, exactly one
    correct survivor, live progress events confirmed 1-499/499), including the specific
    overlapping-group scenario that broke the old per-group logic.

### Fix: "Scan failed" with no detail on the duplicate-detection scan

- The `/api/admin/duplicates` handler had no top-level error handling — since this
  project runs Express 4 (not 5), an exception thrown inside an `async` route handler
  isn't automatically turned into an HTTP response, so anything unexpected there just
  hung the request instead of failing cleanly, surfacing to the browser as a generic
  "Scan failed" with no way to tell what actually went wrong. Now wrapped in try/catch,
  returning the real error message; verified by feeding it a corrupted metadata file and
  confirming it now responds immediately with a specific, actionable error instead of
  hanging.
- Also hardened the comparison itself: a single malformed perceptual-hash value (however
  it got there) is now logged and skipped rather than aborting the whole scan — verified
  by directly corrupting one entry's hash and confirming the scan still completes and
  correctly ignores just that one.

### Fix: multi-volume .7z archives in the import folder weren't recognized

- A split 7z archive (`name.7z.001`, `name.7z.002`, ...) was silently ignored entirely —
  the extension check only recognized a plain `.7z`. Now recognizes the first volume,
  locates every sibling part, waits for all of them to individually settle (not just
  the first) before extracting, and deletes every volume — not just the first — once
  its contents are imported. Verified against a real multi-volume archive, including
  that a still-copying later volume correctly holds off extraction of the whole set.

### Duplicate photo detection in /admin

- New "🔍 Scan for Duplicates" button, finding both exact duplicates (SHA-256 content
  hash) and visually similar photos (perceptual `dHash`, tolerant of re-encoding/resize
  but not rotation). Results shown as grouped thumbnails with the existing delete
  button on each — review and cleanup stays manual, nothing auto-deletes.
- Hashes are computed once per photo (on upload/import/booth-capture, and recomputed on
  rotation) and cached in the metadata store rather than recomputed on every scan;
  older photos are backfilled automatically the first time a scan runs.
- Found a real grouping bug while testing against actual re-saved copies: excluding
  exact-duplicate members from the similar-photos comparison pool caused a genuine
  near-duplicate to lose its only match partner and vanish from the results entirely.
  Fixed — both passes now run over the full set independently.

### Archive support in the watched import folder

- `.zip`, `.tar`, `.tar.gz`/`.tgz`, `.7z`, and `.rar` files dropped into the import
  folder are now extracted automatically (after the usual 5s settle wait), and every
  recognized photo/video inside — including in nested subfolders — is imported the same
  way a plain dropped file is. The archive is deleted once its contents are
  successfully imported (same "moved, not copied" semantics as before); a corrupt
  archive is left in place and retried on the next scan instead of being silently
  discarded.
- Filters out common archive junk automatically — macOS's `._`-prefixed AppleDouble
  sidecar files, `.DS_Store`, `__MACOSX/` — discovered because a real macOS-created
  `.tar.gz` test fixture actually contained it during development; without this filter
  those would have been misimported as bogus duplicate photos (they share the real
  file's extension).
- New dependencies, all pure JS/WASM (no native compilation, no system binaries):
  `adm-zip`, `tar`, `7z-wasm`, `node-unrar-js`. Each format was verified against a real
  archive built with a real archiver during development, except `.rar` — no RAR-creation
  tool was available to build a test fixture; the library was confirmed to load and run
  correctly, but a genuine end-to-end `.rar` import hasn't been (see README).

### Browser tab favicon

- Added a favicon — a bold green "V" monogram on the app's near-black background,
  matching the brand palette. SVG primary (`client/public/favicon.svg`) with a PNG
  fallback (`favicon-32x32.png`) for browsers that don't support SVG icons. Went
  through a "g" monogram first (matching a mockup direction picked earlier) but
  dropped it after confirming — via an actual rendered screenshot at real favicon
  size — that a single-story "g" reduced to a simple shape is very hard to
  distinguish from "9" at 16px; a plain letterform also risked depending on
  Courier New/Consolas being installed, which isn't guaranteed on every OS. "V"
  avoids both problems.

### Fix: backup/restore archive-folder mismatch

- `scripts/restore.sh` failed with `tar: db: not found in archive` on any
  backup downloaded from the `/admin` button — it expected a `db/` folder
  inside the tarball, but the button's backup (and, it turns out, the CLI's
  own `backup.sh`) actually produces `data/`. Standardized both CLI scripts
  and the README's manual procedure on `data/`, matching what the button
  already produced, so backups from either path now restore via either
  method. Verified end-to-end in both directions.

### One-click backup in /admin

- New "⬇ Download Backup" button on `/admin` — streams a `.tar.gz` of both the media
  files and metadata straight to the browser (server has direct filesystem access, so
  no Docker required, unlike the migration scripts). New status line next to it shows
  the last backup's time/size/item count, turning amber past 7 days old or reading "No
  backup taken yet" if none exists. Backed by two new settings getters/setters
  (`lastBackup`) and broadcast live over the existing WebSocket.

### Backup & migration scripts

- New `scripts/backup.sh` / `scripts/restore.sh`, bundling the `media-data` and
  `db-data` Docker volumes (photos/videos, metadata, admin settings) into a single
  tarball and restoring it on a fresh instance — for moving g33kVault to a new
  machine or just taking a backup. Documented in a new README section, both manual
  and scripted paths. Verified end-to-end: backed up a seeded instance, wiped its
  volumes, restored, confirmed everything (including file bytes) came back identical.

### New photo uploads interrupt the slideshow

- A freshly uploaded photo now cuts the slideshow away from whatever's currently
  showing and plays immediately, with a "🆕 New Upload" badge for the first 5 of its
  10 seconds on screen. Videos keep the previous (non-interrupting, queued) behavior.
- Back-to-back uploads no longer interrupt each other's highlight — a photo that
  arrives while another is already being highlighted queues instead, so each gets its
  own full, uninterrupted 10 seconds in upload order (no cap on queue depth).
- Fixed two bugs found while building the queue: the per-slide timer was keyed on
  `items.length`, so any upload landing in the background (even one just joining the
  queue, not being displayed) reset the currently-highlighted photo's remaining time —
  now keyed on the displayed item's id instead. Also removed a side effect
  (`Array.shift()`) from inside a `setState` updater, which React can invoke more than
  once (e.g. under StrictMode in dev) — was silently dropping a queued photo when it did.

### Docs: x86_64 Linux / VM deployment

- New README section alongside the Raspberry Pi one, with install steps for a fresh
  x86_64 Linux install (VM or bare metal) and a note about bridged vs. NAT networking
  on VMs (guests' phones can't reach a NAT'd VM's IP).

### Clickable "g33kVault" heading

- The brand heading is now a link back to `/` on every page (Host, Upload, Booth,
  Slideshow, Admin — both its logged-out and logged-in views).

### Optional uploader name

- `/upload` and `/booth` both have a new optional "Your name" field, remembered in the
  browser (`localStorage`, shared between the two pages) across visits. Attached to
  every file uploaded/captured as plain metadata (not burned into image pixels), shown
  as a small overlay tag: bottom-right on the slideshow, top-left on each `/admin`
  thumbnail.
- The "Contributors" stat on `/upload` is now wired up to this — count of distinct
  uploader names (normalized so casing doesn't inflate it), replacing the old hardcoded
  placeholder. Still an approximation, not a real headcount (see README).

### Admin: photo rotation, newest-first grid

- `/admin`'s grid now shows newest uploads first instead of chronological order.
- New ↺/↻ rotate buttons in the bottom corners of each photo (counter-clockwise /
  clockwise) — actually re-encode and overwrite the stored file, not a CSS-only flip,
  so the correct orientation holds everywhere, including direct file access. Click
  either repeatedly to keep turning; four clicks the same direction loops back to the
  original orientation. Images only (no videos, no GIFs); each rotation is a lossy
  JPEG re-encode. Pushed live over the existing WebSocket, with cache-busted
  thumbnail/slideshow URLs so already-open views pick up the new orientation
  immediately.
- New dependency: `sharp` — this project's one deliberate exception to its otherwise
  zero-native-dependency policy (chosen over the pure-JS alternative on request).
  Requires a 64-bit (`arm64`) Raspberry Pi OS; see [CLAUDE.md](CLAUDE.md).

### Slideshow: randomized playback, "Now Showing" transitions, Party Mode

- Slideshow can shuffle instead of playing chronologically (`/admin` → "Randomize
  playback order"), re-shuffling each time it loops back to the start.
- Videos start muted (required for autoplay) but now show a "🔇 Tap for sound" overlay;
  tapping it unmutes for the rest of the session.
- New transition when the slideshow moves to a new item: fade, zoom, Polaroid drop,
  glitch, arcade/game-style, VHS, random, or none (default) — chosen from `/admin`.
- 🎉 Party Mode toggle overrides the transition picker and randomly chooses a style per
  slide.

### Photo booth (`/booth`)

- New in-browser camera page: countdown, front/back camera switch, and four capture
  modes (Normal, Burst — 4 shots, Frame — funny caption + Polaroid border, Event overlay
  — branded lower-third bar).
- Captures upload automatically through the existing upload endpoint, so they land on
  the slideshow the same way a regular upload does.
- Host screen (`/`) got a QR toggle to switch the displayed QR/URL between `/upload` and
  `/booth`.

### Event statistics panel on `/upload`

- New live "EVENT STATISTICS" panel on the upload page: photo/video counts, total
  storage used, and server uptime, backed by a new `GET /api/stats` endpoint and
  refreshed live over the existing WebSocket as uploads come in.
- "Contributors" is a hardcoded placeholder (`107`) for now — uploads are anonymous, so
  there's no real way to count unique uploaders yet.

## [0.1.7] — 2026-08-27

First tagged version. Everything below shipped in the initial build-out; grouped by
area rather than by individual commit.

### Core

- Host screen (`/`) with a QR code for uploading, generated from whatever host/URL it
  was loaded with (so it works on any LAN IP without hardcoding one).
- Mobile-friendly upload page (`/upload`) — anonymous, no login, supports selecting and
  uploading multiple files at once (e.g. a whole folder from a desktop browser), with a
  per-file progress counter and success/failure summary.
- Fullscreen kiosk slideshow (`/slideshow`) — one item at a time, images advance on a
  timer, videos play to completion. Updates live over Socket.IO: new uploads, deletions,
  and slideshow-speed changes all apply to an already-open slideshow without a reload.
- Storage: uploaded files on local disk (`MEDIA_DIR`), metadata in a JSON file
  (`DB_PATH`) — no database server needed, deliberately picked for zero native
  dependencies (see Raspberry Pi note below).

### iPhone HEIC/HEIF support

- HEIC/HEIF photos are converted to JPEG server-side on the way in (both regular
  uploads and the watched import folder), since most non-Apple browsers can't render
  HEIC in an `<img>` tag.
- Conversion runs via `heic-convert`/`libheif-js`, which is WASM-based — no native
  compilation, so it works unmodified on the Pi's ARM CPU.
- File-type detection uses file extension, not MIME type, since browsers report HEIC's
  MIME type inconsistently.

### Watched import folder (bulk seeding)

- A folder (`IMPORT_DIR`, bind-mounted to `./import` in Docker Compose) is scanned on
  startup and periodically (`IMPORT_SCAN_INTERVAL_MS`, default 60s) while running.
- Matching files are **moved** into the vault's storage and registered like a normal
  upload, including a live socket broadcast. Subfolders are scanned recursively. A file
  must sit untouched 5s before import, so an in-progress copy isn't grabbed
  half-written. No content-based dedup — re-dropping a file re-imports it.

### Admin / moderation (`/admin`)

- No pre-upload approval queue, by design — uploads go live instantly. Instead,
  `/admin` is an after-the-fact cleanup view: every photo/video as a grid with a delete
  button. Deletion removes the file from disk, drops the metadata row, and broadcasts
  live so it disappears from an open slideshow immediately.
- Gated by a single shared password (`ADMIN_PASSWORD`). **Unset disables `/admin`
  entirely** rather than defaulting open. Password is kept in `sessionStorage` client
  side (cleared on tab close), not a real session/auth system — intentionally
  lightweight for a single-host, single-event use case.
- Slideshow speed is also adjustable from `/admin` (in seconds), persisted to
  `settings.json` (survives restarts) and pushed live over the socket to any open
  slideshow. `SLIDESHOW_INTERVAL_MS` now only seeds the *initial* value.

### Deployment

- Docker Compose, single container, multi-stage build (client build → server build →
  slim runtime image). Runs natively on a Raspberry Pi (`node:20-alpine` is multi-arch;
  the project has zero native/compiled npm dependencies on purpose, after specifically
  moving off `better-sqlite3` and `uuid` early on to avoid node-gyp/Python build issues).
- Update flow on the Pi: `git pull && docker compose up --build -d` — existing photos
  are untouched since they live in Docker volumes/bind mounts separate from the image.

### Notable fixes along the way

- Upload button silently doing nothing after picking a file — the file `<input>` was
  being unmounted once a preview appeared, nulling the ref `handleUpload` read from.
  Fixed by tracking the selected file(s) in React state instead.
- Dropped the `uuid` and `react-router-dom` dependencies (replaced with
  `crypto.randomUUID()` and a one-line path switch respectively) and upgraded `multer`
  to 2.x, closing several `npm audit` findings without pulling in unnecessary version
  churn. One moderate, dev-only `esbuild`/`vite` advisory remains open by choice (fix
  requires a Vite 8 major bump; doesn't affect the shipped production build).

### Known gaps (see README "Notes / ideas for later")

- No content-based dedup on the watched import folder.
- Uploads are anonymous — no name/caption field.
- Videos autoplay muted (browser autoplay policy), no "tap to unmute" affordance yet.
- `/admin`'s auth is a single shared password in session storage, not real accounts —
  fine for the intended single-host/single-event deployment, not for anything more.
