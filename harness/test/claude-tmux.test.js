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

test('slash commands: the shared trio plus claude-only /autocompact and /output-style; /help lists them all', async () => {
  const names = claude.commands().map((c) => c.name);
  assert.deepStrictEqual(names, ['/status', '/compact', '/help', '/autocompact', '/output-style']);
  const ref = { harness: 'claude', session: 'bc-cmd', cwd: '/tmp' };
  const help = await claude.runCommand(ref, '/help');
  assert.match(help, /\/autocompact — set how full/);
  assert.match(help, /\/output-style — set this session's output style/);
  // unknown commands throw without ever touching tmux
  await assert.rejects(() => claude.runCommand(ref, '/nope'), /unknown command \/nope/);
});

// adoptWindow — the migration that pins an already-running, session-granular
// agent (a lieutenant registered before its ref carried a window) to its own
// window. Pure tmux plumbing, so tryTmux is stubbed and every call inspected;
// the whole point is that the agent is RENAMED, never killed or relaunched.
function stubTryTmux(answer) {
  const tmuxMod = require('../tmux.js');
  const original = tmuxMod.tryTmux;
  const calls = [];
  tmuxMod.tryTmux = async (...args) => { calls.push(args); return answer(args); };
  return { calls, restore() { tmuxMod.tryTmux = original; } };
}
// A session whose windows are `windows` ([[index, name], …]); null session = gone.
function tmuxWith(windows) {
  return (args) => {
    if (args[0] === 'has-session') return windows ? '' : null;
    if (args[0] === 'list-windows') {
      if (!windows) return null;
      const idx = args.indexOf('-F');
      return windows.map(([i, n]) => (args[idx + 1].includes('window_index') ? i + '\t' + n : n)).join('\n');
    }
    if (args[0] === 'rename-window') return '';
    return null;
  };
}

test('adoptWindow renames the session FIRST window and returns a window-granular ref', async () => {
  const stub = stubTryTmux(tmuxWith([['0', 'node'], ['1', 'w-card-7']]));
  try {
    const ref = { harness: 'claude', session: 'bc-lt-ada', cwd: '/tmp', resumeId: 'u1' };
    assert.deepStrictEqual(await claude.adoptWindow(ref, 'lt', ['w-card-7']), { ...ref, window: 'lt' });
    const rename = stub.calls.find((c) => c[0] === 'rename-window');
    assert.deepStrictEqual(rename, ['rename-window', '-t', '=bc-lt-ada:0', 'lt']);
    assert.ok(!stub.calls.some((c) => c[0] === 'kill-window' || c[0] === 'kill-session'),
      'the running lieutenant is renamed, never killed');
  } finally { stub.restore(); }
});

test('adoptWindow refuses when the first window belongs to a worker', async () => {
  // the lieutenant's own window is gone; window 1 is a live worker — renaming
  // THAT would hand a worker's pane to the lieutenant's ref
  const stub = stubTryTmux(tmuxWith([['1', 'w-card-7']]));
  try {
    const ref = { harness: 'claude', session: 'bc-lt-ada', cwd: '/tmp' };
    assert.strictEqual(await claude.adoptWindow(ref, 'lt', ['w-card-7']), null);
    assert.ok(!stub.calls.some((c) => c[0] === 'rename-window'), 'nothing renamed');
  } finally { stub.restore(); }
});

test('adoptWindow with no live session hands back the window-granular ref (nothing to rename)', async () => {
  const stub = stubTryTmux(tmuxWith(null));
  try {
    const ref = { harness: 'claude', session: 'bc-lt-ada', cwd: '/tmp' };
    assert.deepStrictEqual(await claude.adoptWindow(ref, 'lt', []), { ...ref, window: 'lt' });
    assert.ok(!stub.calls.some((c) => c[0] === 'rename-window'));
    // already window-granular: no tmux call at all
    const done = { ...ref, window: 'lt' };
    assert.strictEqual(await claude.adoptWindow(done, 'lt', []), done);
  } finally { stub.restore(); }
});

// Round 1 of the onboarding install test, in a container, twice: the launch
// line claude refuses outright still cost the caller the FULL 45s wait, and the
// caller then explained the timeout with a guess ("not installed, or not logged
// in") that the pane flatly contradicted. A screen that can never become a
// running agent has to end the wait immediately and hand back what it said.
test('a launch claude refuses ends the wait at once, with the pane attached', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bc-claude-spawn-'));
  const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), 'bc-claude-state-'));
  const mock = mockTmux({ readyTail:
    '$ CLAUDE_CODE_ENABLE_PROMPT_SUGGESTION=false claude --dangerously-skip-permissions --session-id x\n'
    + '--dangerously-skip-permissions cannot be used with root/sudo privileges for security reasons\n$ ' });
  try {
    await assert.rejects(
      () => claude.spawn(dir, 'a brief', { session: 'bc-rootfail', stateDir }),
      (e) => {
        assert.match(e.message, /could not start/);
        assert.match(e.message, /cannot be used with root\/sudo privileges/, 'the pane rides on the error');
        return true;
      });
    const looks = mock.calls.filter((c) => c.fn === 'capture').length;
    assert.strictEqual(looks, 1, 'it gave up on the first look, not after 90 of them');
  } finally {
    mock.restore();
    fs.rmSync(dir, { recursive: true, force: true });
    fs.rmSync(stateDir, { recursive: true, force: true });
  }
});

// --allow-root is the ONLY thing that puts IS_SANDBOX=1 on a launch line: it is
// the guard claude itself checks, and it is never switched off on our own say-so.
test('IS_SANDBOX rides the launch line only when the caller asked for it', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bc-claude-spawn-'));
  const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), 'bc-claude-state-'));
  const launchLine = async (opts) => {
    const mock = mockTmux({ readyTail: 'bypass permissions\n❯ ' });
    try {
      await claude.spawn(dir, 'a brief', Object.assign({ session: 'bc-sbx', stateDir }, opts));
      return mock.calls.find((c) => c.fn === 'sendLiteral').args[1];
    } finally { mock.restore(); }
  };
  try {
    assert.doesNotMatch(await launchLine({}), /IS_SANDBOX/);
    const asked = await launchLine({ allowRoot: true });
    // Off root the flag is inert — the guard it lifts only exists for uid 0.
    if (typeof process.getuid === 'function' && process.getuid() === 0) {
      assert.match(asked, /^IS_SANDBOX=1 /);
    } else {
      assert.doesNotMatch(asked, /IS_SANDBOX/);
    }
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
    fs.rmSync(stateDir, { recursive: true, force: true });
  }
});

// The one line that lied. A spawn RETURNING is a claim that there is a session;
// round 3 of the install test found that claim printed over a consent modal the
// person had never answered — the brief typed into a menu, the caller told it
// worked. Every failure path was honest; the success path was the one nobody
// re-checked.
test('spawn refuses to report success over a screen that is waiting for a person', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bc-claude-spawn-'));
  const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), 'bc-claude-state-'));
  const mock = mockTmux({ readyTail:
    '  WARNING: Claude Code running in Bypass Permissions mode\n\n  ❯ 1. No, exit\n    2. Yes, I accept' });
  try {
    await assert.rejects(
      () => claude.spawn(dir, 'a brief', { session: 'bc-consent', stateDir }),
      (e) => {
        assert.match(e.message, /Yes, I accept/, 'the screen rides back on the failure');
        return true;
      });
  } finally {
    mock.restore();
    fs.rmSync(dir, { recursive: true, force: true });
    fs.rmSync(stateDir, { recursive: true, force: true });
  }
});

// …and the check is a check, not a new way to fail: a real UI still spawns.
test('spawn still returns for a pane that is genuinely a running session', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bc-claude-spawn-'));
  const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), 'bc-claude-state-'));
  const mock = mockTmux({ readyTail: '⏵⏵ bypass permissions on (shift+tab to cycle)\n❯ ' });
  try {
    const ref = await claude.spawn(dir, 'a brief', { session: 'bc-good', stateDir });
    assert.strictEqual(ref.session, 'bc-good');
  } finally {
    mock.restore();
    fs.rmSync(dir, { recursive: true, force: true });
    fs.rmSync(stateDir, { recursive: true, force: true });
  }
});

// alive() is what the board drops worker records on: false means "that pane is
// gone", and a record dropped on it is a session nothing points at any more. So
// the answer has to be an ANSWER — a tmux that could not be read at all is a
// question that went unasked, and the port's rule for a verb it cannot honor is
// to throw with the reason rather than silently succeed.
test('alive throws when tmux cannot be read, rather than reporting the pane gone', async () => {
  const mock = mockTmux({ readyTail: '❯ ', readFails: true });
  try {
    await assert.rejects(
      () => claude.alive({ harness: 'claude-tmux', session: 'bc-lt', window: 'w-card', cwd: '/tmp' }),
      (e) => {
        assert.match(e.message, /tmux/, 'the reason rides back');
        return true;
      });
  } finally { mock.restore(); }
});

// …and tmux ANSWERING that the window is not there is still a plain false: the
// distinction is between absence and an unread tmux, not a new failure mode.
test('alive is still false when tmux answers that the window is not there', async () => {
  const mock = mockTmux({ readyTail: '❯ ' });
  try {
    assert.strictEqual(
      await claude.alive({ harness: 'claude-tmux', session: 'bc-lt', window: 'w-card', cwd: '/tmp' }),
      false);
  } finally { mock.restore(); }
});
