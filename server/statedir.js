// statedir.js — canonical state-dir names + one-shot rename migrations from the
// pre-rename product name (bridge-command → bridge-commander). Node built-ins
// only, zero deps; shared by the server and the bc-axi CLI.
//
// Every migration is idempotent and non-destructive: it renames ONLY when the
// new dir is absent and the legacy dir exists. Re-runs are no-ops, and a
// both-present install always prefers the new dir (no second, destructive
// rename). The `bc-` / `BC_*` abbreviations are a separate namespace and never
// appear here.
const fs = require('fs');
const path = require('path');
const os = require('os');

const STATE_DIR_NAME = '.bridge-commander';
const LEGACY_STATE_DIR_NAME = '.bridge-command';

// Rename <ws>/.bridge-command → <ws>/.bridge-commander when safe. Returns the
// new path if a rename happened, else null. Optional `isLive(legacyDir)` guards
// against renaming a state dir out from under a running legacy server — when it
// returns true the rename is skipped.
function migrateStateDir(ws, isLive) {
  const nu = path.join(ws, STATE_DIR_NAME);
  const old = path.join(ws, LEGACY_STATE_DIR_NAME);
  if (fs.existsSync(nu) || !fs.existsSync(old)) return null;
  if (typeof isLive === 'function' && isLive(old)) return null;
  fs.renameSync(old, nu);
  return nu;
}

// Resolve the workspace state dir: prefer the new name, accept the legacy one,
// default to the new name for a fresh install.
function resolveStateDir(ws) {
  const nu = path.join(ws, STATE_DIR_NAME);
  if (fs.existsSync(nu)) return nu;
  const old = path.join(ws, LEGACY_STATE_DIR_NAME);
  if (fs.existsSync(old)) return old;
  return nu;
}

// Home last-resort dir holds the captain.md seed and the harness fallback state.
// Same non-destructive rule. `home` defaults to os.homedir() (override for tests).
function migrateHomeStateDir(home) {
  const base = home || os.homedir();
  const nu = path.join(base, STATE_DIR_NAME);
  const old = path.join(base, LEGACY_STATE_DIR_NAME);
  if (fs.existsSync(nu) || !fs.existsSync(old)) return null;
  fs.renameSync(old, nu);
  return nu;
}

module.exports = {
  STATE_DIR_NAME, LEGACY_STATE_DIR_NAME,
  migrateStateDir, resolveStateDir, migrateHomeStateDir,
};
