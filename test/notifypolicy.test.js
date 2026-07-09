'use strict';
// ui/js/notifypolicy.js — pure toast+sound decision logic behind the
// notifications settings panel. No DOM/WebAudio, so it's imported directly.
const test = require('node:test');
const assert = require('node:assert');
const path = require('node:path');
const { pathToFileURL } = require('node:url');

let defaultsFor, policyFor, selectNewEvents;
test.before(async () => {
  ({ defaultsFor, policyFor, selectNewEvents } =
    await import(pathToFileURL(path.join(__dirname, '..', 'ui', 'js', 'notifypolicy.js')).href));
});

test('defaultsFor: red level-1 kinds get alert + toast', () => {
  for (const kind of ['failed', 'needs-you', 'blocked', 'worker-died']) {
    assert.deepStrictEqual(defaultsFor(kind, 1), { toast: true, sound: 'alert' });
  }
});

test('defaultsFor: other level-1 kinds get a toast + non-none sound', () => {
  for (const kind of ['done', 'handoff', 'question', 'worker-stalled', 'worker-stopped', 'something-new']) {
    const d = defaultsFor(kind, 1);
    assert.strictEqual(d.toast, true);
    assert.notStrictEqual(d.sound, 'none');
  }
});

test('defaultsFor: level-2 kinds are silent regardless of name', () => {
  for (const kind of ['progress', 'pr-opened', 'worker-linked', 'failed']) {
    assert.deepStrictEqual(defaultsFor(kind, 2), { toast: false, sound: 'none' });
  }
});

test('policyFor: a saved per-kind override wins over the level default', () => {
  const settings = { master: true, kinds: { done: { toast: false, sound: 'ding' } } };
  assert.deepStrictEqual(policyFor('done', 1, settings), { toast: false, sound: 'ding' });
});

test('policyFor: a partial override only replaces the given field', () => {
  const settings = { master: true, kinds: { done: { sound: 'blip' } } };
  const p = policyFor('done', 1, settings);
  assert.strictEqual(p.sound, 'blip');
  assert.strictEqual(p.toast, true); // falls through to the level default
});

test('policyFor: master:false suppresses everything, override or not', () => {
  const settings = { master: false, kinds: { failed: { toast: true, sound: 'alert' } } };
  assert.deepStrictEqual(policyFor('failed', 1, settings), { toast: false, sound: 'none' });
});

test('policyFor: an unknown kind with no override falls through to its level default', () => {
  const settings = { master: true, kinds: {} };
  assert.deepStrictEqual(policyFor('brand-new-kind', 1, settings), defaultsFor('brand-new-kind', 1));
  assert.deepStrictEqual(policyFor('brand-new-kind', 2, settings), { toast: false, sound: 'none' });
});

test('selectNewEvents: returns only unseen seqs ascending and mutates the seen set', () => {
  const doc = { events: [{ seq: 3, kind: 'done' }, { seq: 1, kind: 'created' }], cards: [
    { id: 'c1', title: 'Card 1', events: [{ seq: 2, kind: 'question' }] },
  ] };
  const seen = new Set();
  const first = selectNewEvents(seen, doc);
  assert.deepStrictEqual(first.map((e) => e.seq), [1, 2, 3]);
  assert.deepStrictEqual([...seen].sort(), [1, 2, 3]);
});

test('selectNewEvents: a second call with the same doc returns nothing (dedup across SSE resends)', () => {
  const doc = { events: [{ seq: 1, kind: 'created' }] };
  const seen = new Set();
  selectNewEvents(seen, doc);
  const second = selectNewEvents(seen, doc);
  assert.deepStrictEqual(second, []);
});

test('selectNewEvents: a doc with a brand-new higher-seq event returns just that one', () => {
  const seen = new Set([1, 2]);
  const doc = { events: [{ seq: 1 }, { seq: 2 }, { seq: 5, kind: 'done' }] };
  const out = selectNewEvents(seen, doc);
  assert.deepStrictEqual(out.map((e) => e.seq), [5]);
  assert.ok(seen.has(5));
});
