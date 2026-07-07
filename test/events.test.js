'use strict';
// Event append (card and board level), levels, seq ordering, notifications/read state.
const test = require('node:test');
const assert = require('node:assert');
const { startServerWithColumns } = require('./helper');

test('card events: default level 2, explicit level 1, open kind tokens, monotonic seq', async () => {
  const s = await startServerWithColumns();
  try {
    await s.api('POST', '/api/cards', { title: 'Evented' });

    let r = await s.api('POST', '/api/cards/evented/events', { text: 'quiet note' });
    assert.strictEqual(r.status, 200);
    assert.strictEqual(r.body.event.level, 2); // card events default to timeline-only
    assert.strictEqual(r.body.event.kind, undefined); // no kind given: none stored
    const seq1 = r.body.event.seq;

    r = await s.api('POST', '/api/cards/evented/events', { text: 'ring the bell', level: 1, kind: 'alert' });
    assert.strictEqual(r.body.event.level, 1);
    assert.strictEqual(r.body.event.kind, 'alert');
    assert.strictEqual(r.body.event.seq, seq1 + 1); // global monotonic seq

    // a kind is an open token: unknown kinds are stored as-is (opaque)
    r = await s.api('POST', '/api/cards/evented/events', { text: 'weird', kind: 'bogus' });
    assert.strictEqual(r.body.event.kind, 'bogus');
    assert.strictEqual(r.body.event.level, 2); // not in the kinds map: level falls back

    // text is required
    r = await s.api('POST', '/api/cards/evented/events', { text: '  ' });
    assert.strictEqual(r.status, 400);

    const card = (await s.api('GET', '/api/cards/evented')).body;
    assert.strictEqual(card.events.length, 4); // birth event + 3 appended
  } finally {
    await s.stop();
  }
});

test('board-level events default to level 1', async () => {
  const s = await startServerWithColumns();
  try {
    let r = await s.api('POST', '/api/events', { text: 'board-wide notice' });
    assert.strictEqual(r.status, 200);
    assert.strictEqual(r.body.event.level, 1);
    r = await s.api('POST', '/api/events', { text: 'quiet one', level: 2 });
    assert.strictEqual(r.body.event.level, 2);
    r = await s.api('POST', '/api/events', { text: '' });
    assert.strictEqual(r.status, 400);
  } finally {
    await s.stop();
  }
});

test('notifications: level-1 slice of the unified stream, read state persists per user', async () => {
  const s = await startServerWithColumns();
  try {
    await s.api('POST', '/api/cards', { title: 'Noisy' }); // level-2 birth event
    await s.api('POST', '/api/cards/noisy/events', { text: 'important', level: 1 });
    await s.api('POST', '/api/events', { text: 'board alert' }); // level 1

    let r = await s.api('GET', '/api/notifications');
    assert.strictEqual(r.body.items.length, 2); // only level-1 events
    assert.strictEqual(r.body.unread, 2);
    // newest first; the card event carries its card reference
    assert.strictEqual(r.body.items[0].text, 'board alert');
    assert.strictEqual(r.body.items[1].card, 'noisy');

    // mark one seq read
    const seq = r.body.items[1].seq;
    await s.api('POST', '/api/notifications/read', { seqs: [seq] });
    r = await s.api('GET', '/api/notifications');
    assert.strictEqual(r.body.unread, 1);

    // mark all read
    await s.api('POST', '/api/notifications/read', { all: true });
    r = await s.api('GET', '/api/notifications');
    assert.strictEqual(r.body.unread, 0);

    // read state is per user
    r = await s.api('GET', '/api/notifications?user=other');
    assert.strictEqual(r.body.unread, 2);
  } finally {
    await s.stop();
  }
});

test('thread read markers are stored per user and target', async () => {
  const s = await startServerWithColumns();
  try {
    await s.api('POST', '/api/cards', { title: 'Readable' });
    let r = await s.api('POST', '/api/read', { target: 'card:readable', ts: '2026-01-01T00:00:00.000Z' });
    assert.strictEqual(r.status, 200);
    r = await s.api('POST', '/api/read', { target: 'chat' });
    assert.strictEqual(r.status, 200);
    r = await s.api('POST', '/api/read', { target: 'bogus' });
    assert.strictEqual(r.status, 400);

    const board = (await s.api('GET', '/api/board')).body;
    assert.strictEqual(board.reads.user.threads['card:readable'], '2026-01-01T00:00:00.000Z');
    assert.ok(board.reads.user.threads.chat);
  } finally {
    await s.stop();
  }
});
