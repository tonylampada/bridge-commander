'use strict';
// harness/tmux-session.js — the pane INPUT half (⌨️ typing into the LIVE pane)
// and the poll burst it triggers. tmux.js is patched in place (the same trick
// tmux-mock.js uses and for the same reason: tmux-session.js calls t.foo() at
// call time), so these are plain deterministic unit tests with no tmux process.
const test = require('node:test');
const assert = require('node:assert');
const s = require('../tmux-session.js');
const t = require('../tmux.js');

const REF = { harness: 'claude', session: 'bc-typeable', window: 'w-card', cwd: '/tmp' };
const TARGET = '=bc-typeable:=w-card'; // s.paneTarget(REF.session, REF.window)

// patchTmux({ alive }) — record sendKey/sendLiteral, answer the existence probe
// (paneExists → list-windows for a window-granular ref) and hand out a fresh
// capture every time so every tick counts as a changed frame.
function patchTmux({ alive = true } = {}) {
  const names = ['tryTmux', 'sendKey', 'sendLiteral', 'captureStyled'];
  const original = {};
  for (const n of names) original[n] = t[n];
  const calls = [];
  let frame = 0;
  t.tryTmux = async (...args) => {
    if (args[0] === 'list-windows') return alive ? 'w-card\nw-other' : 'w-other';
    return null;
  };
  t.sendKey = async (target, key) => { calls.push({ fn: 'sendKey', target, key }); };
  t.sendLiteral = async (target, text) => { calls.push({ fn: 'sendLiteral', target, text }); };
  t.captureStyled = async () => 'frame ' + (frame += 1);
  return { calls, restore() { for (const n of names) t[n] = original[n]; } };
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

test('a named key goes out as send-keys, literal text as send-keys -l', async () => {
  const m = patchTmux();
  try {
    await s.paneInput(REF, { key: 'C-c' });
    await s.paneInput(REF, { key: 'BTab' });
    await s.paneInput(REF, { text: 'ls -la' });
    assert.deepStrictEqual(m.calls, [
      { fn: 'sendKey', target: TARGET, key: 'C-c' },
      { fn: 'sendKey', target: TARGET, key: 'BTab' },
      { fn: 'sendLiteral', target: TARGET, text: 'ls -la' },
    ]);
    // NOT the agent send path: no type→settle→Enter, no composer verification.
    assert.ok(!m.calls.some((c) => c.fn === 'sendKey' && c.key === 'Enter'),
      'a keystroke never gets an Enter of its own');
  } finally { m.restore(); }
});

test('multi-line text rides sendLiteral, which is where bracketed paste lives', async () => {
  const m = patchTmux();
  try {
    await s.paneInput(REF, { text: 'one\ntwo\n' });
    assert.deepStrictEqual(m.calls, [{ fn: 'sendLiteral', target: TARGET, text: 'one\ntwo\n' }]);
  } finally { m.restore(); }
});

test('a key name that tmux would read as a FLAG is refused before it becomes argv', async () => {
  const m = patchTmux();
  try {
    for (const bad of ['-X', '--', '-t other', 'C-c; rm -rf /', 'Up Down', '']) {
      await assert.rejects(() => s.paneInput(REF, { key: bad }), /invalid tmux key name|nothing to send/,
        JSON.stringify(bad));
    }
    assert.deepStrictEqual(m.calls, [], 'nothing reached tmux');
  } finally { m.restore(); }
});

test('the payload is key OR text — neither and both are errors', async () => {
  const m = patchTmux();
  try {
    await assert.rejects(() => s.paneInput(REF, {}), /nothing to send/);
    await assert.rejects(() => s.paneInput(REF), /nothing to send/);
    await assert.rejects(() => s.paneInput(REF, { key: 'Enter', text: 'x' }), /not both/);
    assert.deepStrictEqual(m.calls, []);
  } finally { m.restore(); }
});

test('typing into a pane that is gone fails instead of vanishing', async () => {
  const m = patchTmux({ alive: false });
  try {
    await assert.rejects(() => s.paneInput(REF, { key: 'Enter' }), /is gone/);
    assert.deepStrictEqual(m.calls, []);
  } finally { m.restore(); }
});

test('input bursts an open feed, then the poll returns to baseline on its own', async () => {
  const m = patchTmux();
  const frames = [];
  const feed = s.openPane(REF, {
    onFrame: (f) => frames.push(f),
    intervalMs: 300, burstMs: 20, burstWindowMs: 250,
  });
  try {
    await sleep(120); // baseline: the immediate frame, no tick due yet
    const beforeInput = frames.length;
    assert.strictEqual(beforeInput, 1, 'baseline poll has not ticked inside 120ms');

    await s.paneInput(REF, { text: 'x' });
    await sleep(200); // inside the 250ms burst window, at ~20ms a frame
    const burstFrames = frames.length - beforeInput;
    assert.ok(burstFrames >= 4, `burst should deliver several frames, got ${burstFrames}`);

    await sleep(200); // burst window expired — back to the 300ms baseline
    const settled = frames.length;
    await sleep(200);
    const afterFrames = frames.length - settled;
    assert.ok(afterFrames <= 1, `back to baseline, got ${afterFrames} frames in 200ms`);
  } finally {
    feed.close();
    m.restore();
  }
});

test('a burst cannot outlive its feed: closing, then typing, starts nothing', async () => {
  const m = patchTmux();
  const frames = [];
  const feed = s.openPane(REF, {
    onFrame: (f) => frames.push(f), intervalMs: 300, burstMs: 20, burstWindowMs: 5000,
  });
  try {
    await s.paneInput(REF, { text: 'a' }); // burst is live…
    feed.close(); // …and the feed goes away mid-burst
    const atClose = frames.length;
    await sleep(150);
    assert.strictEqual(frames.length, atClose, 'a closed feed delivers nothing, burst or not');

    // typing into an unwatched pane registers no burst at all — nothing to leak
    await s.paneInput(REF, { text: 'b' });
    await sleep(100);
    assert.strictEqual(frames.length, atClose);

    // and a FRESH feed starts at baseline, not carrying the old burst
    const again = [];
    const feed2 = s.openPane(REF, {
      onFrame: (f) => again.push(f), intervalMs: 300, burstMs: 20, burstWindowMs: 5000,
    });
    await sleep(150);
    feed2.close();
    assert.strictEqual(again.length, 1, 'baseline, not inherited fast polling');
  } finally {
    feed.close();
    m.restore();
  }
});

test('the pane feed never stacks captures: the next poll is scheduled after the last one returned', async () => {
  const m = patchTmux();
  let inFlight = 0;
  let overlapped = false;
  const slow = t.captureStyled;
  let n = 0;
  t.captureStyled = async (...args) => {
    if (inFlight > 0) overlapped = true;
    inFlight += 1;
    try {
      await sleep(60); // a capture slower than the poll interval
      return 'slow frame ' + (n += 1);
    } finally { inFlight -= 1; }
  };
  const feed = s.openPane(REF, { onFrame: () => {}, intervalMs: 10 });
  try {
    await sleep(300);
    assert.strictEqual(overlapped, false, 'a slow tmux must not stack children');
  } finally {
    feed.close();
    t.captureStyled = slow;
    m.restore();
  }
});
