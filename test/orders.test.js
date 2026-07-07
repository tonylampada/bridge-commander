'use strict';
// Captain drag semantics (data layer): backlog→working and review→backlog are
// ORDERS — the card does not move; a start-order / rework-order QueueItem goes
// to the owning lieutenant and the card carries pendingOrder. Every other
// captain drag applies normally. An applied move clears pendingOrder.
const test = require('node:test');
const assert = require('node:assert');
const { startServerWithLieutenant, withOwner, LT } = require('./helper');

test('captain backlog→working drag is a start-order, not a move', async () => {
  const s = await startServerWithLieutenant();
  try {
    await s.api('POST', '/api/cards', withOwner({ title: 'Startable' }));
    const r = await s.api('POST', '/api/cards/startable/move', { column: 'working', actor: 'user' });
    assert.strictEqual(r.status, 200);
    assert.strictEqual(r.body.ordered, 'start-order');

    // the card did NOT move; it carries the pending order marker
    const card = (await s.api('GET', '/api/cards/startable')).body;
    assert.strictEqual(card.column, 'backlog');
    assert.strictEqual(card.pendingOrder.kind, 'start-order');
    assert.strictEqual(card.pendingOrder.seq, r.body.seq);
    // the order is on the timeline (level 2 — the captain's own act, no bell)
    const ev = card.events[card.events.length - 1];
    assert.strictEqual(ev.kind, 'ordered');
    assert.strictEqual(ev.level, 2);

    // the owner got a durable start-order QueueItem
    const feed = await s.api('GET', '/api/feed?lieutenant=' + LT);
    assert.strictEqual(feed.body.items.length, 1);
    const it = feed.body.items[0];
    assert.strictEqual(it.kind, 'start-order');
    assert.strictEqual(it.card, 'startable');
    assert.strictEqual(it.from, 'backlog');
    assert.strictEqual(it.to, 'working');
  } finally {
    await s.stop();
  }
});

test('captain review→backlog drag is a rework-order carrying the comment', async () => {
  const s = await startServerWithLieutenant();
  try {
    await s.api('POST', '/api/cards', withOwner({ title: 'Rejected', column: 'review' }));
    const r = await s.api('POST', '/api/cards/rejected/move', {
      column: 'backlog', actor: 'user', text: 'tests are missing — please add coverage',
    });
    assert.strictEqual(r.body.ordered, 'rework-order');

    const card = (await s.api('GET', '/api/cards/rejected')).body;
    assert.strictEqual(card.column, 'review'); // still on the captain's desk
    assert.strictEqual(card.pendingOrder.kind, 'rework-order');

    const feed = await s.api('GET', '/api/feed?lieutenant=' + LT);
    const it = feed.body.items[0];
    assert.strictEqual(it.kind, 'rework-order');
    assert.strictEqual(it.card, 'rejected');
    assert.strictEqual(it.text, 'tests are missing — please add coverage');
  } finally {
    await s.stop();
  }
});

test('other captain drags apply normally; an applied move clears pendingOrder', async () => {
  const s = await startServerWithLieutenant();
  try {
    await s.api('POST', '/api/cards', withOwner({ title: 'Parked' }));
    // backlog → peer: a direct captain drag, applies
    let r = await s.api('POST', '/api/cards/parked/move', { column: 'peer', actor: 'user' });
    assert.strictEqual(r.body.ordered, undefined);
    assert.strictEqual((await s.api('GET', '/api/cards/parked')).body.column, 'peer');

    // put a start-order on another card, then have the lieutenant hand it to
    // review: the applied move clears the pending marker
    await s.api('POST', '/api/cards', withOwner({ title: 'Ordered then done' }));
    await s.api('POST', '/api/cards/ordered-then-done/move', { column: 'working', actor: 'user' });
    let card = (await s.api('GET', '/api/cards/ordered-then-done')).body;
    assert.strictEqual(card.pendingOrder.kind, 'start-order');
    await s.api('POST', '/api/cards/ordered-then-done/move', { column: 'review' }); // lieutenant handoff
    card = (await s.api('GET', '/api/cards/ordered-then-done')).body;
    assert.strictEqual(card.column, 'review');
    assert.strictEqual(card.pendingOrder, null);
  } finally {
    await s.stop();
  }
});

test('repeated order drags refresh the pending marker without moving the card', async () => {
  const s = await startServerWithLieutenant();
  try {
    await s.api('POST', '/api/cards', withOwner({ title: 'Eager' }));
    const r1 = await s.api('POST', '/api/cards/eager/move', { column: 'working', actor: 'user' });
    const r2 = await s.api('POST', '/api/cards/eager/move', { column: 'working', actor: 'user' });
    assert.ok(r2.body.seq > r1.body.seq);
    const card = (await s.api('GET', '/api/cards/eager')).body;
    assert.strictEqual(card.column, 'backlog');
    assert.strictEqual(card.pendingOrder.seq, r2.body.seq); // marker points at the latest order
    const feed = await s.api('GET', '/api/feed?lieutenant=' + LT);
    assert.strictEqual(feed.body.items.filter((e) => e.kind === 'start-order').length, 2);
  } finally {
    await s.stop();
  }
});
