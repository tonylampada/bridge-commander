'use strict';
// Unit tests for the tmux-free parts of harness/claude-tmux.js.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const claude = require('../claude-tmux.js');
const { mockTmux } = require('./tmux-mock.js');

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

// The brief must never ride on the command line: `ps`/`pgrep -f` on the
// launched claude process would show it for the life of the session, and a
// worker's own broad pattern-kill (against its own argv, which literally
// contains its whole brief) could freeze or kill itself. Pin it by mocking
// tmux.js (harness/test/tmux-mock.js) and inspecting exactly what got typed:
// the FIRST literal (the launch line, at launch) must be brief-free, and the
// brief must show up ONLY in the later verified-submit (composer) call.
test('spawn never puts the brief on the launch line — it is typed into the composer after settle', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bc-claude-spawn-'));
  const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), 'bc-claude-state-'));
  const mock = mockTmux({ readyTail: 'bypass permissions\nsome status\n❯ ' });
  const brief = 'SECRET_BRIEF_MARKER: do the thing, then do the other thing.\nmulti-line too.';
  try {
    const ref = await claude.spawn(dir, brief, { session: 'bc-argvtest', stateDir });
    assert.strictEqual(ref.harness, 'claude');

    const launchCall = mock.calls.find((c) => c.fn === 'sendLiteral');
    assert.ok(launchCall, 'the launch line must have been typed');
    assert.doesNotMatch(launchCall.args[1], /SECRET_BRIEF_MARKER/, 'launch line must not carry the brief');
    assert.match(launchCall.args[1], /claude --dangerously-skip-permissions --session-id/);

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
    const promptFile = path.join(stateDir, 'bc-argvtest.prompt');
    assert.strictEqual(fs.readFileSync(promptFile, 'utf8'), brief);
  } finally {
    mock.restore();
    fs.rmSync(dir, { recursive: true, force: true });
    fs.rmSync(stateDir, { recursive: true, force: true });
  }
});
