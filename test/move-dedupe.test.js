'use strict';
// ui/js/api.js — one move per card in flight.
//
// The board redraws off SSE, so between the drop and the broadcast the card is
// still visibly in the column it left. A second drag in that gap used to post a
// second move; it now rides the answer of the move already going.
//
// api.js is DOM-free at import (FileReader is only touched inside a call), so
// it imports straight into node with a stubbed `fetch` — same shape as
// selection.test.js.
const test = require('node:test');
const assert = require('node:assert');
const path = require('node:path');
const { pathToFileURL } = require('node:url');

let api;
const calls = [];
let settle; // resolves the in-flight fetch: every test drives the timing itself

test.before(async () => {
  globalThis.fetch = (url, opts) => new Promise((resolve, reject) => {
    calls.push({ url, body: JSON.parse(opts.body) });
    settle = { resolve, reject };
  });
  ({ api } = await import(pathToFileURL(path.join(__dirname, '..', 'ui', 'js', 'api.js')).href));
});
const ok = (body) => ({ ok: true, json: async () => body });
const reset = () => { calls.length = 0; settle = null; };

test('a second move on the same card in flight posts nothing and rides the first answer', async () => {
  reset();
  const first = api.moveCard('c1', 'review');
  const second = api.moveCard('c1', 'review');
  assert.strictEqual(calls.length, 1, 'the duplicate never reached the server');
  settle.resolve(ok({ ok: true }));
  assert.deepStrictEqual(await first, { ok: true });
  assert.deepStrictEqual(await second, { ok: true }, 'the duplicate got the real move\'s answer');
});

test('a different card moves in parallel — the guard is per card, not a global mutex', async () => {
  reset();
  const a = api.moveCard('c1', 'review');
  const first = settle;
  const b = api.moveCard('c2', 'review');
  assert.strictEqual(calls.length, 2);
  assert.deepStrictEqual(calls.map((c) => c.body.column), ['review', 'review']);
  settle.resolve(ok({ ok: true }));
  first.resolve(ok({ ok: true }));
  await Promise.all([a, b]);
});

test('once the move settles the card is movable again — success or failure', async () => {
  reset();
  const failing = api.moveCard('c1', 'review');
  settle.reject(new Error('network'));
  await assert.rejects(failing, /network/);
  api.moveCard('c1', 'backlog').catch(() => {});
  assert.strictEqual(calls.length, 2, 'a failed move does not wedge the card');
  assert.strictEqual(calls[1].body.column, 'backlog');
  settle.resolve(ok({ ok: true }));
});
