'use strict';
// GET /api/archive pagination — the read behind the UI's 🧊 archived mode:
// limit+offset windows over the append-only jsonl, newest first, plus the
// total; and the restore round-trip the mode's unarchive action rides on.
const test = require('node:test');
const assert = require('node:assert');
const { startServerWithLieutenant, withOwner } = require('./helper');

test('empty archive: {archive: [], total: 0}', async () => {
  const s = await startServerWithLieutenant();
  try {
    const r = await s.api('GET', '/api/archive');
    assert.strictEqual(r.status, 200);
    assert.deepStrictEqual(r.body.archive, []);
    assert.strictEqual(r.body.total, 0);
  } finally {
    await s.stop();
  }
});

test('limit+offset windows, newest first, stable total; offset-less keeps the old meaning', async () => {
  const s = await startServerWithLieutenant();
  try {
    for (let i = 1; i <= 5; i++) {
      await s.api('POST', '/api/cards', withOwner({ title: 'Card ' + i }));
      const r = await s.api('POST', '/api/cards/card-' + i + '/archive', { reason: i % 2 ? 'killed' : 'merged' });
      assert.strictEqual(r.status, 200, 'archive card-' + i);
    }
    // newest first across the whole log
    const all = await s.api('GET', '/api/archive');
    assert.strictEqual(all.body.total, 5);
    assert.deepStrictEqual(all.body.archive.map((r) => r.card.id),
      ['card-5', 'card-4', 'card-3', 'card-2', 'card-1']);
    // windows: contiguous, non-overlapping, each carrying the same total
    const p1 = await s.api('GET', '/api/archive?limit=2&offset=0');
    const p2 = await s.api('GET', '/api/archive?limit=2&offset=2');
    const p3 = await s.api('GET', '/api/archive?limit=2&offset=4');
    assert.deepStrictEqual(p1.body.archive.map((r) => r.card.id), ['card-5', 'card-4']);
    assert.deepStrictEqual(p2.body.archive.map((r) => r.card.id), ['card-3', 'card-2']);
    assert.deepStrictEqual(p3.body.archive.map((r) => r.card.id), ['card-1']);
    for (const p of [p1, p2, p3]) assert.strictEqual(p.body.total, 5);
    // past the end: empty window, total intact
    const past = await s.api('GET', '/api/archive?limit=2&offset=10');
    assert.deepStrictEqual(past.body.archive, []);
    assert.strictEqual(past.body.total, 5);
    // offset-less with a limit = the newest `limit` records (the CLI's call shape)
    const top = await s.api('GET', '/api/archive?limit=3');
    assert.deepStrictEqual(top.body.archive.map((r) => r.card.id), ['card-5', 'card-4', 'card-3']);
  } finally {
    await s.stop();
  }
});

test('restore from a page: loud level-1 resurrected event; the log keeps the record', async () => {
  const s = await startServerWithLieutenant();
  try {
    await s.api('POST', '/api/cards', withOwner({ title: 'Doomed' }));
    await s.api('POST', '/api/cards/doomed/archive', { reason: 'killed' });
    const r = await s.api('POST', '/api/cards/doomed/restore', { actor: 'user' });
    assert.strictEqual(r.status, 200);
    const ev = r.body.card.events.at(-1);
    assert.strictEqual(ev.kind, 'resurrected');
    assert.strictEqual(ev.level, 1); // loud — rings the bell
    // live again on the board…
    const board = await s.api('GET', '/api/board');
    assert.ok(board.body.cards.some((c) => c.id === 'doomed'));
    // …while the append-only log still holds the frozen record (board is truth
    // for liveness — the UI drops the row by id, not by the record vanishing)
    const arch = await s.api('GET', '/api/archive');
    assert.strictEqual(arch.body.total, 1);
    assert.strictEqual(arch.body.archive[0].card.id, 'doomed');
  } finally {
    await s.stop();
  }
});
