'use strict';
// State-dir rename migrations (bridge-command → bridge-commander). Proves:
//   - fresh install uses the new dir;
//   - a legacy dir gets migrated once (non-destructively — content is moved);
//   - both-present prefers the new one (no destructive second rename);
//   - a live legacy server is left alone;
//   - the server migrates a legacy workspace at boot.
const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const {
  STATE_DIR_NAME, LEGACY_STATE_DIR_NAME,
  migrateStateDir, resolveStateDir, migrateHomeStateDir,
} = require('../server/statedir.js');
const { startServer } = require('./helper.js');

function tmp() { return fs.mkdtempSync(path.join(os.tmpdir(), 'bc-migrate-')); }
function write(dir, rel, content) {
  const p = path.join(dir, rel);
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, content);
}

test('fresh install: resolves to the new dir, nothing to migrate', () => {
  const ws = tmp();
  try {
    assert.equal(migrateStateDir(ws), null, 'no legacy dir → no rename');
    assert.equal(resolveStateDir(ws), path.join(ws, STATE_DIR_NAME));
  } finally { fs.rmSync(ws, { recursive: true, force: true }); }
});

test('legacy dir migrated once, content preserved, then a no-op', () => {
  const ws = tmp();
  try {
    write(ws, path.join(LEGACY_STATE_DIR_NAME, 'board.json'), '{"marker":1}');
    const moved = migrateStateDir(ws);
    assert.equal(moved, path.join(ws, STATE_DIR_NAME));
    assert.ok(!fs.existsSync(path.join(ws, LEGACY_STATE_DIR_NAME)), 'legacy dir gone');
    assert.equal(
      fs.readFileSync(path.join(ws, STATE_DIR_NAME, 'board.json'), 'utf8'),
      '{"marker":1}', 'content moved intact');
    // second run is a no-op
    assert.equal(migrateStateDir(ws), null);
    assert.equal(resolveStateDir(ws), path.join(ws, STATE_DIR_NAME));
  } finally { fs.rmSync(ws, { recursive: true, force: true }); }
});

test('both present: prefers the new dir, never touches the legacy one', () => {
  const ws = tmp();
  try {
    write(ws, path.join(STATE_DIR_NAME, 'board.json'), '{"new":1}');
    write(ws, path.join(LEGACY_STATE_DIR_NAME, 'board.json'), '{"legacy":1}');
    assert.equal(migrateStateDir(ws), null, 'new present → no destructive rename');
    assert.equal(
      fs.readFileSync(path.join(ws, LEGACY_STATE_DIR_NAME, 'board.json'), 'utf8'),
      '{"legacy":1}', 'legacy dir untouched');
    assert.equal(resolveStateDir(ws), path.join(ws, STATE_DIR_NAME));
  } finally { fs.rmSync(ws, { recursive: true, force: true }); }
});

test('live legacy server: rename is skipped by the isLive guard', () => {
  const ws = tmp();
  try {
    write(ws, path.join(LEGACY_STATE_DIR_NAME, 'board.json'), '{"legacy":1}');
    assert.equal(migrateStateDir(ws, () => true), null, 'live → skip');
    assert.ok(fs.existsSync(path.join(ws, LEGACY_STATE_DIR_NAME)), 'legacy left in place');
    // once it is no longer live, the same call migrates.
    assert.equal(migrateStateDir(ws, () => false), path.join(ws, STATE_DIR_NAME));
  } finally { fs.rmSync(ws, { recursive: true, force: true }); }
});

test('home state dir migrates the same way', () => {
  const home = tmp();
  try {
    write(home, path.join(LEGACY_STATE_DIR_NAME, 'captain.md'), 'seed');
    const moved = migrateHomeStateDir(home);
    assert.equal(moved, path.join(home, STATE_DIR_NAME));
    assert.equal(fs.readFileSync(path.join(home, STATE_DIR_NAME, 'captain.md'), 'utf8'), 'seed');
    assert.equal(migrateHomeStateDir(home), null, 'idempotent');
  } finally { fs.rmSync(home, { recursive: true, force: true }); }
});

test('server migrates a legacy workspace at boot', async () => {
  const ws = tmp();
  // Seed a legacy state dir with a marker; the booting server should move it.
  write(ws, path.join(LEGACY_STATE_DIR_NAME, 'legacy-marker.txt'), 'ok');
  const s = await startServer({ dir: ws });
  try {
    assert.ok(!fs.existsSync(path.join(ws, LEGACY_STATE_DIR_NAME)), 'legacy dir migrated away');
    assert.equal(
      fs.readFileSync(path.join(ws, STATE_DIR_NAME, 'legacy-marker.txt'), 'utf8'),
      'ok', 'legacy content now under the new dir');
    const r = await s.api('GET', '/api/status');
    assert.equal(r.status, 200, 'server healthy on the migrated dir');
  } finally {
    await s.stop();
    fs.rmSync(ws, { recursive: true, force: true });
  }
});
