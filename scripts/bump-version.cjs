#!/usr/bin/env node
// Bumps the trailing counter in client/src/version.ts's APP_VERSION string
// (e.g. '107.001' -> '107.002') and commits just that file, so the bump
// rides along with whatever's about to be pushed. Run by the PreToolUse
// git-push hook in .claude/settings.json — see that file's "if" filter for
// exactly which commands trigger it.
//
// Deliberately never fails loudly: a push is far more important than this
// counter, so any problem here prints a warning and exits 0 rather than
// blocking or erroring out the push itself.

const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

const REPO_ROOT = path.resolve(__dirname, '..');
const VERSION_FILE = path.join(REPO_ROOT, 'client', 'src', 'version.ts');
const VERSION_PATTERN = /107\.(\d+)/;

function warnAndExit(message) {
  console.warn(`[bump-version] ${message} — skipping version bump.`);
  process.exit(0);
}

if (!fs.existsSync(VERSION_FILE)) {
  warnAndExit(`${VERSION_FILE} does not exist`);
}

const content = fs.readFileSync(VERSION_FILE, 'utf-8');
const match = content.match(VERSION_PATTERN);
if (!match) {
  warnAndExit(`no '107.NNN' version string found in ${VERSION_FILE}`);
}

// Base-10 explicitly: Number('008') is fine, but treating a leading-zero
// numeric string as octal has bitten past code in this exact shape before —
// parseInt's second argument keeps this safe regardless.
const nextNum = parseInt(match[1], 10) + 1;
const nextVersion = `107.${String(nextNum).padStart(3, '0')}`;
const updated = content.replace(VERSION_PATTERN, nextVersion);

try {
  fs.writeFileSync(VERSION_FILE, updated);
  // `git add` first so this still works the very first time version.ts is
  // bumped after being newly introduced (an untracked path isn't picked up
  // by a bare commit pathspec) — then commit with a pathspec limited to
  // just this file, not a bare `git commit`, so whatever else might
  // already be staged in the index at push time is left untouched rather
  // than getting swept into a "Bump version" commit.
  execFileSync('git', ['add', VERSION_FILE], { cwd: REPO_ROOT, stdio: 'ignore' });
  execFileSync('git', ['commit', '-m', `Bump version to v${nextVersion}`, '--', VERSION_FILE], {
    cwd: REPO_ROOT,
    stdio: 'ignore',
  });
  console.warn(`[bump-version] Bumped to v${nextVersion}.`);
} catch (err) {
  warnAndExit(`failed to write/commit (${err.message})`);
}
