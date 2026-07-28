'use strict';
// Unit tests for harness/command-tmux.js — the harness whose session runs a
// command line instead of an agent. tmux is mocked (tmux-mock.js), so these
// are plain deterministic unit tests.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const cmd = require('../command-tmux.js');
const tmuxMod = require('../tmux.js');
const { isHarnessRef, getHarness, VERBS } = require('../port.js');
const { mockTmux } = require('./tmux-mock.js');

test('it is a registered builtin implementing all seven verbs', () => {
  const impl = getHarness('command');
  for (const verb of VERBS) assert.strictEqual(typeof impl[verb], 'function', verb);
});

test('spawn types the command line, presses Enter, and puts it in the ref', async () => {
  const m = mockTmux({ readyTail: '' });
  try {
    const ref = await cmd.spawn(os.tmpdir(), '  node run.js card-7  ',
      { session: 'bc-lt-x', window: 'w-card-7' });
    assert.ok(isHarnessRef(ref));
    assert.deepStrictEqual(ref, {
      harness: 'command', session: 'bc-lt-x', cwd: path.resolve(os.tmpdir()),
      command: 'node run.js card-7', window: 'w-card-7',
    });
    const typed = m.calls.filter((c) => c.fn === 'sendLiteral').map((c) => c.args[1]);
    assert.deepStrictEqual(typed, ['node run.js card-7'], 'the line is typed once, trimmed');
    assert.ok(m.calls.some((c) => c.fn === 'sendKey' && c.args[1] === 'Enter'), 'and submitted');
    assert.ok(!m.calls.some((c) => c.fn === 'submit'), 'no composer machinery — this is a shell');
    // the window is created with the requested name, in the requested cwd
    assert.ok(m.calls.some((c) => c.fn === 'tmux' && c.args[0] === 'new-session'
      && c.args.includes('bc-lt-x') && c.args.includes('w-card-7')));
  } finally {
    m.restore();
  }
});

test('spawn writes no prompt file — there is no brief to attach', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bc-cmd-state-'));
  const m = mockTmux({ readyTail: '' });
  try {
    await cmd.spawn(os.tmpdir(), 'echo hi', { session: 'bc-p1', stateDir: dir });
    assert.deepStrictEqual(fs.readdirSync(dir), []);
  } finally {
    m.restore();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('spawn refuses an empty command line and a missing cwd', async () => {
  const m = mockTmux({ readyTail: '' });
  try {
    await assert.rejects(() => cmd.spawn(os.tmpdir(), '   ', { session: 'bc-p2' }), /empty command line/);
    await assert.rejects(() => cmd.spawn('/nope/nowhere', 'echo hi', { session: 'bc-p3' }), /cwd does not exist/);
  } finally {
    m.restore();
  }
});

test('send always throws, naming the command and the reason', async () => {
  const ref = { harness: 'command', session: 'bc-lt-x', window: 'w-card-7', cwd: '/tmp', command: 'node run.js card-7' };
  await assert.rejects(() => cmd.send(ref, 'please also fix the tests'), (e) => {
    assert.match(e.message, /runs a command, not an agent/);
    assert.match(e.message, /no composer/);
    assert.match(e.message, /node run\.js card-7/, 'the message shows what it IS running');
    assert.match(e.message, /bc-lt-x:w-card-7/, 'and which session refused');
    return true;
  });
});

// alive/onTurnEnd read the pane's current command, so they need finer control
// than the shared mock's canned answer: patch tryTmux per case.
function withPaneCommand(answer, fn) {
  const original = { tryTmux: tmuxMod.tryTmux, sleep: tmuxMod.sleep };
  tmuxMod.sleep = async () => {};
  tmuxMod.tryTmux = async (...args) => {
    if (args[0] === 'display-message' && args.includes('#{pane_current_command}')) return answer();
    if (args[0] === 'list-windows') return 'w-card-7\n';
    if (args[0] === 'has-session') return '';
    return null;
  };
  return Promise.resolve(fn()).finally(() => Object.assign(tmuxMod, original));
}

test('alive is true while the process runs and false once the pane is back at a shell', async () => {
  const ref = { harness: 'command', session: 'bc-lt-x', window: 'w-card-7', cwd: '/tmp', command: 'node run.js' };
  await withPaneCommand(() => 'node', async () => {
    assert.strictEqual(await cmd.alive(ref), true);
  });
  await withPaneCommand(() => 'bash', async () => {
    assert.strictEqual(await cmd.alive(ref), false, 'a finished command leaves its shell in the pane');
  });
});

test('resumable answers on the recorded command line, not on any memory', async () => {
  assert.strictEqual(await cmd.resumable({ harness: 'command', session: 'bc-a', cwd: '/tmp', command: 'x' }), true);
  assert.strictEqual(await cmd.resumable({ harness: 'command', session: 'bc-a', cwd: '/tmp' }), false);
});

test('resume runs the SAME line again and keeps the ref addressable', async () => {
  const m = mockTmux({ readyTail: '' });
  // the shared mock answers pane_current_command 'agent' (alive) — force dead
  // so resume does its work instead of short-circuiting.
  const originalTry = tmuxMod.tryTmux;
  tmuxMod.tryTmux = async (...args) => {
    if (args[0] === 'display-message' && args.includes('#{pane_current_command}')) return 'bash';
    if (args[0] === 'list-windows') return 'w-card-7\n';
    return originalTry(...args);
  };
  try {
    const ref = { harness: 'command', session: 'bc-lt-x', window: 'w-card-7', cwd: os.tmpdir(), command: 'node run.js card-7' };
    const out = await cmd.resume(ref);
    assert.deepStrictEqual(out, ref, 'the ref is unchanged — there is no new session id to carry');
    const typed = m.calls.filter((c) => c.fn === 'sendLiteral').map((c) => c.args[1]);
    assert.deepStrictEqual(typed, ['node run.js card-7'], 'from the top — resume keeps no place');
  } finally {
    tmuxMod.tryTmux = originalTry;
    m.restore();
  }
});

test('resume with no recorded command line says so instead of opening a bare shell', async () => {
  await withPaneCommand(() => 'bash', async () => {
    await assert.rejects(() => cmd.resume({ harness: 'command', session: 'bc-a', window: 'w-card-7', cwd: '/tmp' }),
      /carries no command line/);
  });
});

test('onTurnEnd fires exactly once — on the process exiting', async () => {
  const ref = { harness: 'command', session: 'bc-lt-x', window: 'w-card-7', cwd: '/tmp', command: 'node run.js' };
  let paneCmd = 'node';
  const events = [];
  await withPaneCommand(() => paneCmd, async () => {
    const off = cmd.onTurnEnd(ref, (e) => events.push(e), { intervalMs: 5 });
    await new Promise((r) => setTimeout(r, 40));
    assert.deepStrictEqual(events, [], 'a running process has not ended its turn');
    paneCmd = 'bash';
    await new Promise((r) => setTimeout(r, 60));
    assert.strictEqual(events.length, 1, 'exit is the one turn boundary');
    assert.strictEqual(events[0].event, 'exit');
    assert.strictEqual(events[0].session, 'bc-lt-x:w-card-7');
    await new Promise((r) => setTimeout(r, 40));
    assert.strictEqual(events.length, 1, 'and it never repeats — it unsubscribed itself');
    off();
  });
});
