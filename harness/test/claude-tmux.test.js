'use strict';
// Unit tests for the tmux-free parts of harness/claude-tmux.js.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const claude = require('../claude-tmux.js');

test('resumable: ref.resumeId, else the hook-recorded session-id file, else false', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bc-claude-state-'));
  try {
    const ref = { harness: 'claude', session: 'bc-x1', cwd: '/tmp' };
    assert.strictEqual(await claude.resumable(ref, { stateDir: dir }), false, 'no id anywhere');
    assert.strictEqual(await claude.resumable({ ...ref, resumeId: 'uuid-1' }, { stateDir: dir }), true, 'ref carries the id');
    fs.writeFileSync(path.join(dir, 'bc-x1.session-id'), 'uuid-recorded\n');
    assert.strictEqual(await claude.resumable(ref, { stateDir: dir }), true, 'recorded id counts');
    fs.writeFileSync(path.join(dir, 'bc-x1.session-id'), '\n');
    assert.strictEqual(await claude.resumable(ref, { stateDir: dir }), false, 'blank record is no id');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('resumable for a window-granular ref reads the session:window keyed record', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bc-claude-state-'));
  try {
    const ref = { harness: 'claude', session: 'bc-lt-a', window: 'w-card-7', cwd: '/tmp' };
    // a record under the bare session name belongs to the LIEUTENANT, not this worker
    fs.writeFileSync(path.join(dir, 'bc-lt-a.session-id'), 'uuid-lieutenant\n');
    assert.strictEqual(await claude.resumable(ref, { stateDir: dir }), false, 'never reads the cohabited session record');
    fs.writeFileSync(path.join(dir, 'bc-lt-a:w-card-7.session-id'), 'uuid-worker\n');
    assert.strictEqual(await claude.resumable(ref, { stateDir: dir }), true);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('spawn validates the window name before touching tmux: numeric or hostile names refused', async () => {
  // tmux parses a numeric window "name" in a target as a window INDEX — the
  // harness refuses such names outright (papercut #8's core trap).
  for (const window of ['123', '7', '-w', 'w:x', 'w.x', '']) {
    await assert.rejects(
      claude.spawn('/tmp', 'hi', { session: 'bc-t', window }),
      /invalid window name/,
      `window "${window}" must be refused`);
  }
});
