'use strict';
// Workspace discovery must VALIDATE, not just find, a state dir. A bare
// `.bridge-commander/` does not make a directory a workspace — only one holding
// config.json or board.json does. This pins the live bug where the harness state
// home (`~/.bridge-commander/` with only `harness/`) hijacked upward discovery,
// so a NEW workspace created anywhere under $HOME resolved to $HOME itself.
const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawn } = require('node:child_process');
const { CLI } = require('./helper');
const {
  STATE_DIR_NAME, LEGACY_STATE_DIR_NAME, isWorkspace,
} = require('../server/statedir.js');

function tmp() { return fs.mkdtempSync(path.join(os.tmpdir(), 'bc-discovery-')); }
function write(dir, rel, content) {
  const p = path.join(dir, rel);
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, content);
}
// Run bc-axi from an explicit cwd + HOME (no --workspace), so upward discovery
// is exercised exactly as it is in the field.
function runFrom(cwd, home, args) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [CLI, ...args], {
      cwd,
      env: Object.assign({}, process.env, { HOME: home }),
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stdout = '', stderr = '';
    child.stdout.on('data', (c) => (stdout += c));
    child.stderr.on('data', (c) => (stderr += c));
    child.on('close', (code) => resolve({ code, stdout, stderr }));
  });
}

// ---------- unit: isWorkspace ----------

test('isWorkspace: config.json qualifies', () => {
  const ws = tmp();
  try {
    write(ws, path.join(STATE_DIR_NAME, 'config.json'), '{"port":4780}');
    assert.equal(isWorkspace(ws), true);
  } finally { fs.rmSync(ws, { recursive: true, force: true }); }
});

test('isWorkspace: board.json qualifies', () => {
  const ws = tmp();
  try {
    write(ws, path.join(STATE_DIR_NAME, 'board.json'), '{"cards":[]}');
    assert.equal(isWorkspace(ws), true);
  } finally { fs.rmSync(ws, { recursive: true, force: true }); }
});

test('isWorkspace: legacy state dir with board.json qualifies', () => {
  const ws = tmp();
  try {
    write(ws, path.join(LEGACY_STATE_DIR_NAME, 'board.json'), '{"cards":[]}');
    assert.equal(isWorkspace(ws), true);
  } finally { fs.rmSync(ws, { recursive: true, force: true }); }
});

test('isWorkspace: a bare .bridge-commander/ does NOT qualify', () => {
  const ws = tmp();
  try {
    fs.mkdirSync(path.join(ws, STATE_DIR_NAME), { recursive: true });
    assert.equal(isWorkspace(ws), false);
  } finally { fs.rmSync(ws, { recursive: true, force: true }); }
});

test('isWorkspace: the harness state home (only harness/) does NOT qualify', () => {
  const home = tmp();
  try {
    fs.mkdirSync(path.join(home, STATE_DIR_NAME, 'harness'), { recursive: true });
    assert.equal(isWorkspace(home), false, '~/.bridge-commander/harness is not a workspace');
  } finally { fs.rmSync(home, { recursive: true, force: true }); }
});

// ---------- integration: upward discovery via the CLI ----------

test('discovery finds a real ancestor workspace (config.json) from a nested cwd', async () => {
  const root = tmp();
  const home = tmp();
  try {
    // A genuine workspace two levels up, carrying a distinctive config.
    write(root, path.join(STATE_DIR_NAME, 'config.json'), '{"voices":["marker-v"]}');
    const nested = path.join(root, 'projects', 'demo');
    fs.mkdirSync(nested, { recursive: true });
    const r = await runFrom(nested, home, ['config', 'show']);
    assert.equal(r.code, 0, r.stderr);
    assert.deepEqual(JSON.parse(r.stdout).voices, ['marker-v'], 'walked up to the real workspace');
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
    fs.rmSync(home, { recursive: true, force: true });
  }
});

test('the harness state home never hijacks init: a NEW workspace is created under $HOME, not $HOME itself', async () => {
  const home = tmp();
  try {
    // Every install has this once a lieutenant/worker has spawned. It must NOT
    // count as a workspace — before the fix, discovery adopted $HOME here.
    fs.mkdirSync(path.join(home, STATE_DIR_NAME, 'harness'), { recursive: true });
    const fleet = path.join(home, 'fleet2', 'sub');
    fs.mkdirSync(fleet, { recursive: true });
    // A non-init command resolves the workspace and must find NONE — proving
    // $HOME was not adopted. (init would then bootstrap the cwd itself.)
    const r = await runFrom(fleet, home, ['config', 'show']);
    assert.equal(r.code, 1, 'no workspace found — $HOME was not hijacked');
    assert.match(r.stderr, /no workspace found/);
  } finally { fs.rmSync(home, { recursive: true, force: true }); }
});

test('fresh machine: ancestors with only non-qualifying state dirs resolve to no workspace (init would use cwd)', async () => {
  const home = tmp();
  try {
    // Bare state dir on an ancestor, no config/board anywhere.
    fs.mkdirSync(path.join(home, STATE_DIR_NAME), { recursive: true });
    const cwd = path.join(home, 'work', 'proj');
    fs.mkdirSync(cwd, { recursive: true });
    const r = await runFrom(cwd, home, ['config', 'show']);
    assert.equal(r.code, 1, 'nothing qualifies → no workspace, so init bootstraps the cwd');
    assert.match(r.stderr, /no workspace found/);
  } finally { fs.rmSync(home, { recursive: true, force: true }); }
});
