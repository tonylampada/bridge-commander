'use strict';
// Workspace-scoped session naming: deterministic per workspace, distinct
// across workspaces, ASCII-only, tmux-safe (no dots/colons).
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { workspaceDisc, lieutenantSession, workerSession } = require('../server/names.js');

const TMUX_SAFE = /^bc-[A-Za-z0-9-]+$/; // no dots, no colons, ASCII only

test('names are deterministic per workspace and distinct across workspaces', () => {
  const a = fs.mkdtempSync(path.join(os.tmpdir(), 'bc-names-a-'));
  const b = fs.mkdtempSync(path.join(os.tmpdir(), 'bc-names-b-'));
  try {
    assert.strictEqual(workspaceDisc(a), workspaceDisc(a), 'stable across calls');
    assert.notStrictEqual(workspaceDisc(a), workspaceDisc(b), 'two boards never collide');
    assert.strictEqual(lieutenantSession(a, 'monica'), lieutenantSession(a, 'monica'));
    assert.notStrictEqual(lieutenantSession(a, 'monica'), lieutenantSession(b, 'monica'),
      'same-named lieutenant on two boards gets distinct sessions');
    assert.notStrictEqual(workerSession(a, 'fix-1'), workerSession(b, 'fix-1'));
    // shape: discriminator between the bc- prefix and the role marker
    assert.match(lieutenantSession(a, 'monica'), /^bc-.+-lt-monica$/);
    assert.match(workerSession(a, 'fix-1'), /^bc-.+-w-fix-1$/);
  } finally {
    fs.rmSync(a, { recursive: true, force: true });
    fs.rmSync(b, { recursive: true, force: true });
  }
});

test('names are tmux-safe ASCII even for hostile workspace basenames and ids', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'bc-names-h-'));
  try {
    const emojiWs = path.join(root, '👩‍🦰 café.board');
    fs.mkdirSync(emojiWs);
    for (const s of [
      lieutenantSession(emojiWs, 'marcela'),
      workerSession(emojiWs, 'fix.a:b'),
      lieutenantSession(root, 'a'.repeat(40)), // the server's derived-id cap
    ]) {
      assert.match(s, TMUX_SAFE, s);
      assert.ok(s.length < 80, 'reasonable length: ' + s);
    }
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('a symlinked workspace path resolves to the same discriminator', () => {
  const real = fs.mkdtempSync(path.join(os.tmpdir(), 'bc-names-real-'));
  const link = real + '-link';
  try {
    fs.symlinkSync(real, link);
    assert.strictEqual(workspaceDisc(link), workspaceDisc(real));
  } catch (e) {
    if (e.code === 'EPERM') return; // symlinks unavailable — nothing to prove here
    throw e;
  } finally {
    fs.rmSync(link, { force: true });
    fs.rmSync(real, { recursive: true, force: true });
  }
});
