# g33kVault

A live event photo wall: guests scan a QR code, upload photos/videos from their phone,
and everything shows up instantly in a fullscreen slideshow. Node/TypeScript/Express
backend, React/Vite frontend, deployed via Docker Compose (built and tested to run on a
Raspberry Pi). Current version: **0.1.7** — see [CHANGELOG.md](CHANGELOG.md) for what's
shipped and [README.md](README.md) for full setup/architecture docs. Read the README
before making changes; this file only covers what the README can't: standing
constraints and orientation for picking the work back up.

## Hard constraint: never lose already-imported photos

Do not make a change that could delete or lose photos/videos a user has already
uploaded or imported. This was set as an explicit standing rule by the project owner.

- Media lives in `MEDIA_DIR` (files) and `DB_PATH` (a JSON metadata file), configured
  in `server/src/config.ts` and used by `server/src/db.ts`. In Docker Compose these are
  named volumes (`media-data`, `db-data`) — normal deploys (`docker compose up
  --build`) never touch them; only `docker compose down -v` or a manual `docker volume
  rm` would. Don't suggest either of those, and don't change the default paths in a way
  that orphans existing data.
- If a change needs to restructure the JSON metadata schema (e.g. a new required
  field), write it defensively so existing entries without that field still load —
  treat a missing field as a sensible default rather than failing to parse. Never
  require a destructive rewrite/migration of the JSON store.
- The watched-import folder (`server/src/importFolder.ts`) moves files out of
  `import/` into `MEDIA_DIR` by design — that's expected, not a violation of this rule.
  The rule is about not losing data *after* it's in the vault's storage.
- Admin-triggered photo rotation (`POST /api/media/:id/rotate`, see below) overwrites
  the stored file in place with a re-encoded, rotated version — an intentional content
  edit the admin explicitly requests, not the kind of accidental data loss this rule
  guards against. It's a lossy JPEG re-encode each time, though, so many repeated
  rotations of the same photo will slowly degrade its quality — accepted trade-off,
  not a bug.
- Before any change touching storage/schema/volumes: would this make already-imported
  photos disappear from the gallery or fail to load? If yes, find a non-destructive
  path, or flag it to the user before proceeding rather than deciding alone.

## Orientation

- `server/src/index.ts` wires everything together — start there to see how routes,
  Socket.IO, and the import-folder scanner fit together.
- `server/src/config.ts` is the single source of truth for env vars and their
  defaults — check it before assuming a default value.
- Each client page (`client/src/pages/{Host,Upload,Booth,Slideshow,Admin}.tsx`) is a
  self-contained route, switched on `window.location.pathname` in `client/src/main.tsx`
  (no router library — deliberately dropped `react-router-dom`, see CHANGELOG).
- No native/compiled npm dependencies anywhere in this project, on purpose (with one
  deliberate exception — see below) — it was actively kept that way (moved off
  `better-sqlite3` and `uuid` early on) specifically so it builds and runs on the Pi's
  ARM CPU without node-gyp/Python toolchain issues. Think twice before adding a
  dependency that needs native compilation; prefer a WASM-based or pure-JS alternative
  (see how HEIC support was done via `heic-convert`).
  - **Exception: `sharp`** (used for admin photo rotation, `server/src/routes/media.ts`).
    This *is* a native dependency (libvips), chosen deliberately over the pure-JS
    alternative after the project owner explicitly preferred it over the zero-native-deps
    default. Its install script fetches prebuilt binaries per-platform rather than
    compiling, and this project's Dockerfile runs `npm install` fresh inside each actual
    target image/stage (no cross-stage copying of `node_modules`), so the right binary
    for wherever the image is actually built should resolve automatically. **Caveat:**
    sharp does not ship prebuilt binaries for 32-bit Linux ARM (`armv7`) — this requires
    a 64-bit Raspberry Pi OS (`arm64`) if deploying to a Pi. If you ever need to drop
    back to zero native deps, `jimp` (pure JS) was the alternative considered.

## Working in this repo

```bash
npm install                 # installs all workspaces (root, server, client)
npm run dev:server           # backend on :3000
npm run dev:client           # frontend on :5173, proxies /api,/media,/socket.io
npm run build                 # typecheck + build both workspaces
docker compose up --build    # production-style single-container run on :3000
```

Verify changes for real before calling them done: build, then actually hit the
running server (curl for API changes; the dev servers plus manual browser checks for
UI changes) rather than relying on the build succeeding alone. This project has no
automated test suite yet.
