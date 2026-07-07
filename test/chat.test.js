'use strict';
// Chat: lieutenant say (main chat and card thread), captain feedback. Each
// lieutenant has its own main chat; a card thread's interlocutor is the owning
// lieutenant. The "owes a reply" signal is card.status.owed (status.test.js).
const test = require('node:test');
const assert = require('node:assert');
const { startServerWithLieutenant, withOwner, LT } = require('./helper');

test('lieutenant say to its main chat lands in lieutenant.chat and rings a level-1 event', async () => {
  const s = await startServerWithLieutenant();
  try {
    const r = await s.api('POST', '/api/message', { target: 'lieutenant:' + LT, text_md: 'hello there' });
    assert.strictEqual(r.status, 200);
    const board = (await s.api('GET', '/api/board')).body;
    const lt = board.lieutenants[0];
    assert.strictEqual(lt.chat.length, 1);
    assert.strictEqual(lt.chat[0].author, 'Ada'); // author defaults to the lieutenant's name
    assert.strictEqual(lt.chat[0].text, 'hello there');
    // a main-chat lieutenant message doubles as a level-1 board event
    const ev = board.events.filter((e) => e.level === 1 && e.text === 'hello there');
    assert.strictEqual(ev.length, 1);

    // empty text rejected; unknown lieutenant 404
    assert.strictEqual((await s.api('POST', '/api/message', { target: 'lieutenant:' + LT, text_md: '  ' })).status, 400);
    assert.strictEqual((await s.api('POST', '/api/message', { target: 'lieutenant:ghost', text_md: 'x' })).status, 404);
  } finally {
    await s.stop();
  }
});

test('lieutenant say to a card thread appends to card.thread, sets threadStart, no board event', async () => {
  const s = await startServerWithLieutenant();
  try {
    await s.api('POST', '/api/cards', withOwner({ title: 'Chatty' }));
    const r = await s.api('POST', '/api/message', { target: 'card:chatty', text: 'per-card reply' });
    assert.strictEqual(r.status, 200);
    const board = (await s.api('GET', '/api/board')).body;
    const card = board.cards[0];
    assert.strictEqual(card.thread.length, 1);
    assert.strictEqual(card.thread[0].author, 'Ada'); // the interlocutor is the owning lieutenant
    assert.strictEqual(card.threadStart, card.thread[0].ts);
    // card-thread messages do not hit the board stream (only the lieutenant-joined event is there)
    assert.deepStrictEqual(board.events.filter((e) => e.text !== 'lieutenant Ada joined the bridge'), []);

    // unknown card target is a 404
    const bad = await s.api('POST', '/api/message', { target: 'card:ghost', text: 'x' });
    assert.strictEqual(bad.status, 404);
  } finally {
    await s.stop();
  }
});

test('captain feedback lands in the thread and queues a message item to the owner', async () => {
  const s = await startServerWithLieutenant();
  try {
    await s.api('POST', '/api/cards', withOwner({ title: 'Askable' }));
    const r = await s.api('POST', '/api/feedback', { target: 'card:askable', text: 'please look at this' });
    assert.strictEqual(r.status, 200);
    assert.strictEqual(r.body.seq, 1);

    const card = (await s.api('GET', '/api/cards/askable')).body;
    assert.strictEqual(card.thread.length, 1);
    assert.strictEqual(card.thread[0].author, 'user');

    const feed = await s.api('GET', '/api/feed?lieutenant=' + LT);
    assert.strictEqual(feed.body.items.length, 1);
    assert.strictEqual(feed.body.items[0].kind, 'message');
    assert.strictEqual(feed.body.items[0].lieutenant, LT);
    assert.strictEqual(feed.body.items[0].target, 'card:askable');
    assert.strictEqual(feed.body.items[0].text, 'please look at this');
  } finally {
    await s.stop();
  }
});

test('captain feedback to a lieutenant main chat routes to that lieutenant queue', async () => {
  const s = await startServerWithLieutenant();
  try {
    await s.api('POST', '/api/lieutenants', { name: 'Grace', id: 'grace' });
    await s.api('POST', '/api/feedback', { target: 'lieutenant:grace', text: 'status?' });
    const ada = await s.api('GET', '/api/feed?lieutenant=' + LT);
    assert.deepStrictEqual(ada.body.items, []);
    const grace = await s.api('GET', '/api/feed?lieutenant=grace');
    assert.strictEqual(grace.body.items.length, 1);
    assert.strictEqual(grace.body.items[0].target, 'lieutenant:grace');

    const board = (await s.api('GET', '/api/board')).body;
    const g = board.lieutenants.find((l) => l.id === 'grace');
    assert.strictEqual(g.chat.length, 1);
    assert.strictEqual(g.chat[0].author, 'user');
  } finally {
    await s.stop();
  }
});
