'use strict';
// Unit tests for the tmux-free parts of harness/codex-tmux.js.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const codex = require('../codex-tmux.js');
const { isHarnessRef } = require('../port.js');
const { mockTmux } = require('./tmux-mock.js');

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

// Same guarantee as claude-tmux.test.js: the brief must never ride on the
// command line — a worker's own broad pattern-kill (against its own argv)
// could freeze or kill itself. Mock tmux.js (tmux-mock.js) and check exactly
// what got typed: the launch line (typed at launch) must be brief-free; the
// brief must show up ONLY in the later verified-submit (composer) call.
test('spawn never puts the brief on the launch line — it is typed into the composer after settle', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bc-codex-spawn-'));
  const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), 'bc-codex-state2-'));
  const mock = mockTmux({ readyTail: 'OpenAI Codex (v1.0.0)\nYOLO mode\n› ' });
  const brief = 'SECRET_BRIEF_MARKER: do the thing, then do the other thing.\nmulti-line too.';
  try {
    const ref = await codex.spawn(dir, brief, { session: 'bc-argvtest2', stateDir });
    assert.strictEqual(ref.harness, 'codex');

    const launchCall = mock.calls.find((c) => c.fn === 'sendLiteral');
    assert.ok(launchCall, 'the launch line must have been typed');
    assert.doesNotMatch(launchCall.args[1], /SECRET_BRIEF_MARKER/, 'launch line must not carry the brief');
    assert.match(launchCall.args[1], /codex --dangerously-bypass-approvals-and-sandbox/);

    const submitCall = mock.calls.find((c) => c.fn === 'submit');
    assert.ok(submitCall, 'the brief must have been delivered via verified submit');
    assert.strictEqual(submitCall.args[1], brief, 'the exact brief text is what gets typed into the composer');
    assert.ok(mock.calls.indexOf(submitCall) > mock.calls.indexOf(launchCall), 'brief delivery happens AFTER launch');

    // no tmux/tryTmux/sendKey call anywhere carries the brief either
    for (const c of mock.calls) {
      if (c.fn === 'submit') continue;
      assert.ok(!JSON.stringify(c.args).includes('SECRET_BRIEF_MARKER'),
        `${c.fn}(${JSON.stringify(c.args)}) must not carry the brief`);
    }

    // the prompt file (source of truth) still gets the exact brief
    const promptFile = path.join(stateDir, 'bc-argvtest2.prompt');
    assert.strictEqual(fs.readFileSync(promptFile, 'utf8'), brief);
  } finally {
    mock.restore();
    fs.rmSync(dir, { recursive: true, force: true });
    fs.rmSync(stateDir, { recursive: true, force: true });
  }
});

test('slash commands: the shared trio only — codex has NO /autocompact (config scope, not a command)', async () => {
  const names = codex.commands().map((c) => c.name);
  assert.deepStrictEqual(names, ['/status', '/compact', '/help']);
  const ref = { harness: 'codex', session: 'bc-cmd', cwd: '/tmp' };
  await assert.rejects(() => codex.runCommand(ref, '/autocompact 80'), /unknown command \/autocompact/);
});
