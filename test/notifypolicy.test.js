'use strict';
// ui/js/notifypolicy.js — pure toast+sound decision logic behind the
// notifications settings panel. No DOM/WebAudio, so it's imported directly.
const test = require('node:test');
const assert = require('node:assert');
const path = require('node:path');
const { pathToFileURL } = require('node:url');

let categorize, defaultCategoryPolicy, policyFor, selectNewEvents;
test.before(async () => {
  ({ categorize, defaultCategoryPolicy, policyFor, selectNewEvents } =
    await import(pathToFileURL(path.join(__dirname, '..', 'ui', 'js', 'notifypolicy.js')).href));
});

test('categorize: work-finished kinds map to done', () => {
  for (const kind of ['worker-done', 'landed', 'handoff', 'done']) {
    assert.strictEqual(categorize(kind, 1), 'done');
  }
});

test('categorize: lieutenant-message kinds map to chat', () => {
  for (const kind of ['reply', 'question', 'message']) {
    assert.strictEqual(categorize(kind, 1), 'chat');
  }
});

test('categorize: needs-captain-now kinds map to error', () => {
  for (const kind of ['needs-captain', 'needs-you', 'failed', 'blocked', 'worker-died', 'worker-stalled']) {
    assert.strictEqual(categorize(kind, 1), 'error');
  }
});

test('categorize: everything else, including unknown kinds, maps to other', () => {
  for (const kind of ['created', 'moved', 'started', 'brand-new-kind']) {
    assert.strictEqual(categorize(kind, 2), 'other');
  }
});

test('defaultCategoryPolicy: done/chat/error toast on with non-none sounds', () => {
  const d = defaultCategoryPolicy();
  for (const cat of ['done', 'chat', 'error']) {
    assert.strictEqual(d[cat].toast, true);
    assert.notStrictEqual(d[cat].sound, 'none');
  }
});

test('defaultCategoryPolicy: other is toast off + no sound', () => {
  const d = defaultCategoryPolicy();
  assert.deepStrictEqual(d.other, { toast: false, sound: 'none' });
});

test('policyFor: a saved category override wins over its default', () => {
  const settings = { master: true, categories: { done: { toast: false, sound: 'ding' } } };
  assert.deepStrictEqual(policyFor('worker-done', 1, settings), { toast: false, sound: 'ding' });
});

test('policyFor: a partial override only replaces the given field', () => {
  const settings = { master: true, categories: { done: { sound: 'blip' } } };
  const p = policyFor('landed', 1, settings);
  assert.strictEqual(p.sound, 'blip');
  assert.strictEqual(p.toast, true); // falls through to the category default
});

test('policyFor: master:false suppresses everything, override or not', () => {
  const settings = { master: false, categories: { error: { toast: true, sound: 'alert' } } };
  assert.deepStrictEqual(policyFor('failed', 1, settings), { toast: false, sound: 'none' });
});

test('policyFor: an event whose category has no override uses that category default', () => {
  const settings = { master: true, categories: {} };
  assert.deepStrictEqual(policyFor('question', 1, settings), defaultCategoryPolicy().chat);
  assert.deepStrictEqual(policyFor('created', 2, settings), defaultCategoryPolicy().other);
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
