'use strict';
// Unit tests for the tmux-free parts of harness/codex-tmux.js.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const codex = require('../codex-tmux.js');
const { isHarnessRef } = require('../port.js');

test('a codex ref is a valid HarnessRef with and without the (late-adopted) resumeId', () => {
  // Born WITHOUT resumeId — codex assigns the thread-id and the first notify
  // delivers it — so the bare shape must already round-trip the board state.
  const born = { harness: 'codex', session: 'bc-ab12cd', cwd: '/tmp/x' };
  assert.ok(isHarnessRef(born));
  assert.deepStrictEqual(JSON.parse(JSON.stringify(born)), born);
  const adopted = { ...born, resumeId: '019f49a7-81f4-7ad3-822d-3acf8cf81ed6', window: 'w-card-7' };
  assert.ok(isHarnessRef(adopted));
});

test('resumable: ref.resumeId, else the relay-recorded session-id file, else false', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bc-codex-state-'));
  try {
    const ref = { harness: 'codex', session: 'bc-x1', cwd: '/tmp' };
    assert.strictEqual(await codex.resumable(ref, { stateDir: dir }), false, 'no id anywhere');
    assert.strictEqual(await codex.resumable({ ...ref, resumeId: 'thread-1' }, { stateDir: dir }), true, 'ref carries the id');
    fs.writeFileSync(path.join(dir, 'bc-x1.session-id'), 'thread-recorded\n');
    assert.strictEqual(await codex.resumable(ref, { stateDir: dir }), true, 'recorded thread-id counts');
    fs.writeFileSync(path.join(dir, 'bc-x1.session-id'), '\n');
    assert.strictEqual(await codex.resumable(ref, { stateDir: dir }), false, 'blank record is no id');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('resumable for a window-granular ref reads the session:window keyed record', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bc-codex-state-'));
  try {
    const ref = { harness: 'codex', session: 'bc-lt-a', window: 'w-card-7', cwd: '/tmp' };
    // a record under the bare session name belongs to the LIEUTENANT, not this worker
    fs.writeFileSync(path.join(dir, 'bc-lt-a.session-id'), 'thread-lieutenant\n');
    assert.strictEqual(await codex.resumable(ref, { stateDir: dir }), false, 'never reads the cohabited session record');
    fs.writeFileSync(path.join(dir, 'bc-lt-a:w-card-7.session-id'), 'thread-worker\n');
    assert.strictEqual(await codex.resumable(ref, { stateDir: dir }), true);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('spawn validates the window name before touching tmux: numeric or hostile names refused', async () => {
  // Same rule as claude (shared tmux-session.js plumbing): tmux parses a
  // numeric window "name" in a target as a window INDEX.
  for (const window of ['123', '7', '-w', 'w:x', 'w.x', '']) {
    await assert.rejects(
      codex.spawn('/tmp', 'hi', { session: 'bc-t', window }),
      /invalid window name/,
      `window "${window}" must be refused`);
  }
});
