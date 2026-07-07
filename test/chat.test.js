'use strict';
// Chat: agent say (main and card thread), user feedback. The "owes a reply"
// signal is card.status.owed (status.test.js); no separate awaiting feed exists.
const test = require('node:test');
const assert = require('node:assert');
const { startServerWithColumns } = require('./helper');

test('agent say to main chat lands in board.chat and rings a level-1 event', async () => {
  const s = await startServerWithColumns();
  try {
    const r = await s.api('POST', '/api/message', { target: 'chat', text_md: 'hello there' });
    assert.strictEqual(r.status, 200);
    const board = (await s.api('GET', '/api/board')).body;
    assert.strictEqual(board.chat.length, 1);
    assert.strictEqual(board.chat[0].author, 'agent');
    assert.strictEqual(board.chat[0].text, 'hello there');
    // a main-chat agent message doubles as a level-1 board event
    const ev = board.events.filter((e) => e.level === 1 && e.text === 'hello there');
    assert.strictEqual(ev.length, 1);

    // empty text rejected
    const bad = await s.api('POST', '/api/message', { target: 'chat', text_md: '  ' });
    assert.strictEqual(bad.status, 400);
  } finally {
    await s.stop();
  }
});

test('agent say to a card thread appends to card.thread, sets threadStart, no board event', async () => {
  const s = await startServerWithColumns();
  try {
    await s.api('POST', '/api/cards', { title: 'Chatty' });
    const r = await s.api('POST', '/api/message', { target: 'card:chatty', text: 'per-card reply' });
    assert.strictEqual(r.status, 200);
    const board = (await s.api('GET', '/api/board')).body;
    const card = board.cards[0];
    assert.strictEqual(card.thread.length, 1);
    assert.strictEqual(card.thread[0].author, 'agent');
    assert.strictEqual(card.threadStart, card.thread[0].ts);
    assert.deepStrictEqual(board.events, []); // card-thread messages do not hit the board stream

    // unknown card target is a 404
    const bad = await s.api('POST', '/api/message', { target: 'card:ghost', text: 'x' });
    assert.strictEqual(bad.status, 404);
  } finally {
    await s.stop();
  }
});

test('user feedback lands in the thread and queues a message feedback line', async () => {
  const s = await startServerWithColumns();
  try {
    await s.api('POST', '/api/cards', { title: 'Askable' });
    const r = await s.api('POST', '/api/feedback', { target: 'card:askable', text: 'please look at this' });
    assert.strictEqual(r.status, 200);
    assert.strictEqual(r.body.seq, 1);

    const card = (await s.api('GET', '/api/cards/askable')).body;
    assert.strictEqual(card.thread.length, 1);
    assert.strictEqual(card.thread[0].author, 'user');

    const poll = await s.api('GET', '/api/poll?nowait=1');
    assert.strictEqual(poll.body.events.length, 1);
    assert.strictEqual(poll.body.events[0].kind, 'message');
    assert.strictEqual(poll.body.events[0].target, 'card:askable');
    assert.strictEqual(poll.body.events[0].text, 'please look at this');
  } finally {
    await s.stop();
  }
});

test('GET /api/status carries no legacy awaiting/stale arrays', async () => {
  const s = await startServerWithColumns();
  try {
    await s.api('POST', '/api/feedback', { target: 'chat', text: 'anyone home?' });
    const st = (await s.api('GET', '/api/status')).body;
    assert.strictEqual('awaiting' in st, false);
    assert.strictEqual('stale' in st, false);
  } finally {
    await s.stop();
  }
});
