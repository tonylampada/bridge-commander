'use strict';
const test = require('node:test');
const assert = require('node:assert');
const { VERBS, registerHarness, getHarness, isHarnessRef, harnessFor } = require('../port.js');

test('getHarness returns builtin fake with all seven verbs', () => {
  const h = getHarness('fake');
  for (const verb of VERBS) assert.strictEqual(typeof h[verb], 'function', verb);
});

test('getHarness returns builtin codex with all seven verbs + the pane capability verbs', () => {
  const h = getHarness('codex');
  for (const verb of VERBS) assert.strictEqual(typeof h[verb], 'function', verb);
  assert.strictEqual(typeof h.openPane, 'function', 'openPane (UI pane peek)');
  assert.strictEqual(typeof h.paneSnapshot, 'function', 'paneSnapshot');
});

test('getHarness throws on unknown harness', () => {
  assert.throws(() => getHarness('nope'), /unknown harness "nope"/);
});

test('registerHarness validates the seven verbs', () => {
  assert.throws(() => registerHarness('bad', { spawn() {} }), /missing verb/);
  assert.throws(() => registerHarness('no-kill', {
    spawn() {}, send() {}, alive() {}, resumable() {}, resume() {}, onTurnEnd() {},
  }), /missing verb kill/);
  assert.throws(() => registerHarness('no-resumable', {
    spawn() {}, send() {}, alive() {}, resume() {}, kill() {}, onTurnEnd() {},
  }), /missing verb resumable/);
  const impl = {
    spawn() {}, send() {}, alive() {}, resumable() {}, resume() {}, kill() {}, onTurnEnd() {},
  };
  registerHarness('custom', impl);
  assert.strictEqual(getHarness('custom'), impl);
});

test('HarnessRef is JSON-serializable and survives a round trip', () => {
  const ref = { harness: 'claude', session: 'bc-ab12cd', cwd: '/tmp/x', resumeId: 'uuid-1' };
  const back = JSON.parse(JSON.stringify(ref));
  assert.deepStrictEqual(back, ref);
  assert.ok(isHarnessRef(back));
});

test('isHarnessRef rejects malformed refs', () => {
  assert.ok(!isHarnessRef(null));
  assert.ok(!isHarnessRef({}));
  assert.ok(!isHarnessRef({ harness: 'claude', session: 'bc-1' })); // no cwd
  assert.ok(!isHarnessRef({ harness: '', session: 'bc-1', cwd: '/x' }));
  assert.ok(!isHarnessRef({ harness: 'claude', session: 'bc-1', cwd: '/x', resumeId: 42 }));
  assert.ok(isHarnessRef({ harness: 'claude', session: 'bc-1', cwd: '/x' })); // resumeId optional
});

test('harnessFor dispatches by ref.harness', () => {
  const ref = { harness: 'fake', session: 'bc-1', cwd: '/x' };
  assert.strictEqual(harnessFor(ref), getHarness('fake'));
  assert.throws(() => harnessFor({ harness: 'fake' }), /not a HarnessRef/);
});

// The cap used to be 64 KB — four times what tmux can swallow — so a big
// SINGLE-LINE paste passed validation, reached `send-keys -l -- <text>` and
// came back as a 502 whose body was the failed command, payload and all.
test('the text cap fits inside tmux\'s single-command budget', () => {
  const { PANE_INPUT_MAX } = require('../port.js');
  // Measured on tmux 3.4: `send-keys -t <target> -l -- <text>` fails once
  // target.length + text.length exceeds 16343 (one imsg, MAX_IMSGSIZE 16384
  // less its header and the fixed argv words). Room must be left for the
  // longest pane target we can build: `=bc-<6 hex>:=<window>`.
  assert.ok(PANE_INPUT_MAX + 256 < 16343,
    `cap ${PANE_INPUT_MAX} must sit below tmux's budget with room for the target`);
});

// String.length counts UTF-16 units; argv is UTF-8. A payload of emoji is four
// bytes each, so a length-based cap let ~4x the byte budget through, and the
// refusal came back as `spawn E2BIG` instead of a clean "too long".
test('the cap counts BYTES, not UTF-16 units', () => {
  const { validatePaneInput, PANE_INPUT_MAX } = require('../port.js');
  const emoji = '😀'; // 2 UTF-16 units, 4 UTF-8 bytes
  const under = emoji.repeat(Math.floor(PANE_INPUT_MAX / 4));
  assert.ok(under.length < PANE_INPUT_MAX, 'shorter than the cap by String.length');
  assert.strictEqual(validatePaneInput({ text: under }).text, under);

  const over = under + emoji; // still short by String.length, 4 bytes past by weight
  assert.ok(over.length < PANE_INPUT_MAX, 'a length check would wave this through');
  assert.throws(() => validatePaneInput({ text: over }), /text too long .*bytes/);

  // and the boundary in plain ASCII, where one char is one byte
  assert.doesNotThrow(() => validatePaneInput({ text: 'x'.repeat(PANE_INPUT_MAX) }));
  assert.throws(() => validatePaneInput({ text: 'x'.repeat(PANE_INPUT_MAX + 1) }), /text too long/);
});
