'use strict';
// The bell includes unseen lieutenant card-thread replies: level-1 events UNION
// lieutenant-authored thread messages, cleared by reading (card open / mark-all),
// never double-counting lieutenant main-chat messages, never surfacing level-2.
const test = require('node:test');
const assert = require('node:assert');
const { startServerWithLieutenant, withOwner, LT, sleep } = require('./helper');

test('lieutenant card-thread reply notifies unread; the captain\'s own message never does', async () => {
  const s = await startServerWithLieutenant();
  try {
    await s.api('POST', '/api/cards', withOwner({ title: 'Convo' })); // level-2 birth event only
    await s.api('POST', '/api/feedback', { target: 'card:convo', text: 'how is it going?' });
    await s.api('POST', '/api/message', { target: 'card:convo', text: 'halfway there' });

    const r = await s.api('GET', '/api/notifications');
    assert.strictEqual(r.body.unread, 1);
    const replies = r.body.items.filter((e) => e.kind === 'reply');
    assert.strictEqual(replies.length, 1); // the lieutenant reply, not the captain's message
    const it = replies[0];
    // shaped like an event item for the drawer: ts/text/actor/card/cardTitle/read + kind
    assert.strictEqual(it.text, 'halfway there');
    assert.strictEqual(it.actor, 'Ada'); // the owning lieutenant is the interlocutor
    assert.strictEqual(it.card, 'convo');
    assert.strictEqual(it.cardTitle, 'Convo');
    assert.strictEqual(it.level, 1);
    assert.strictEqual(it.read, false);
    assert.ok(it.ts);
    assert.ok(!r.body.items.some((e) => e.text === 'how is it going?'), 'captain message absent');
  } finally {
    await s.stop();
  }
});

test('opening the card (thread read marker) clears reply notifications', async () => {
  const s = await startServerWithLieutenant();
  try {
    await s.api('POST', '/api/cards', withOwner({ title: 'Openable' }));
    await s.api('POST', '/api/message', { target: 'card:openable', text: 'status update' });
    assert.strictEqual((await s.api('GET', '/api/notifications')).body.unread, 1);

    await s.api('POST', '/api/read', { target: 'card:openable' }); // what opening the card sends
    const r = await s.api('GET', '/api/notifications');
    assert.strictEqual(r.body.unread, 0);
    assert.strictEqual(r.body.items.find((e) => e.kind === 'reply').read, true); // still listed, read

    // a NEW reply after the read notifies again
    await s.api('POST', '/api/message', { target: 'card:openable', text: 'another update' });
    assert.strictEqual((await s.api('GET', '/api/notifications')).body.unread, 1);
  } finally {
    await s.stop();
  }
});

test('mark-all clears unseen replies too, per user', async () => {
  const s = await startServerWithLieutenant();
  try {
    await s.api('POST', '/api/cards', withOwner({ title: 'Marked' }));
    await s.api('POST', '/api/cards/marked/events', { text: 'ring', level: 1 });
    await s.api('POST', '/api/message', { target: 'card:marked', text: 'reply too' });
    assert.strictEqual((await s.api('GET', '/api/notifications')).body.unread, 2);

    await s.api('POST', '/api/notifications/read', { all: true });
    assert.strictEqual((await s.api('GET', '/api/notifications')).body.unread, 0);
    // read state is per user: another user still sees both unseen
    assert.strictEqual((await s.api('GET', '/api/notifications?user=other')).body.unread, 2);
  } finally {
    await s.stop();
  }
});

test('lieutenant main-chat message rides its level-1 event once — never doubled as a reply', async () => {
  const s = await startServerWithLieutenant();
  try {
    await s.api('POST', '/api/message', { target: 'lieutenant:' + LT, text: 'board-wide word' });
    const r = await s.api('GET', '/api/notifications');
    const hits = r.body.items.filter((e) => e.text === 'board-wide word');
    assert.strictEqual(hits.length, 1); // the free-form level-1 event, exactly once
    assert.notStrictEqual(hits[0].kind, 'reply');
    assert.strictEqual(r.body.items.filter((e) => e.kind === 'reply').length, 0);
    assert.strictEqual(r.body.unread, 1);
  } finally {
    await s.stop();
  }
});

test('level-2 stays timeline-only; items come newest first across events and replies', async () => {
  const s = await startServerWithLieutenant();
  try {
    await s.api('POST', '/api/cards', withOwner({ title: 'Ordered' }));
    await s.api('POST', '/api/cards/ordered/events', { text: 'quiet note', level: 2 });
    await s.api('POST', '/api/cards/ordered/events', { text: 'loud note', level: 1 });
    await sleep(5); // items interleave by ts (replies carry no seq): keep it unambiguous
    await s.api('POST', '/api/message', { target: 'card:ordered', text: 'then a reply' });

    const r = await s.api('GET', '/api/notifications');
    assert.ok(!r.body.items.some((e) => e.text === 'quiet note'), 'level 2 never notifies');
    assert.deepStrictEqual(r.body.items.map((e) => e.text), ['then a reply', 'loud note']);
  } finally {
    await s.stop();
  }
});
