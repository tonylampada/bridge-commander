'use strict';
const test = require('node:test');
const assert = require('node:assert');
const { VERBS, registerHarness, getHarness, isHarnessRef, harnessFor } = require('../port.js');

test('getHarness returns builtin fake with all five verbs', () => {
  const h = getHarness('fake');
  for (const verb of VERBS) assert.strictEqual(typeof h[verb], 'function', verb);
});

test('getHarness throws on unknown harness', () => {
  assert.throws(() => getHarness('nope'), /unknown harness "nope"/);
});

test('registerHarness validates the five verbs', () => {
  assert.throws(() => registerHarness('bad', { spawn() {} }), /missing verb/);
  const impl = {
    spawn() {}, send() {}, alive() {}, resume() {}, onTurnEnd() {},
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
