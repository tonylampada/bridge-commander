'use strict';
// Chat: lieutenant say (main chat and card thread), captain feedback. Each
// lieutenant has its own main chat; a card thread's interlocutor is the owning
// lieutenant. The "owes a reply" signal is card.status.owed (status.test.js).
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const { startServerWithLieutenant, withOwner, runCli, LT } = require('./helper');

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

test('say author defaults to the session-resolved CALLER, not the target lieutenant', async () => {
  const s = await startServerWithLieutenant();
  try {
    await s.api('POST', '/api/lieutenants', { name: 'Grace', id: 'grace', ref: { harness: 'fake', session: 'bc-grace', cwd: '/tmp' } });
    await s.api('POST', '/api/cards', withOwner({ title: 'Cross' })); // owned by Ada

    // Grace (identified by her session) posts on Ada's card → stamped Grace
    let r = await s.api('POST', '/api/message', { target: 'card:cross', text: 'peer input', session: 'bc-grace' });
    assert.strictEqual(r.status, 200);
    let card = (await s.api('GET', '/api/cards/cross')).body;
    assert.strictEqual(card.thread[0].author, 'Grace');

    // explicit author still wins over the session
    await s.api('POST', '/api/message', { target: 'card:cross', text: 'as someone else', session: 'bc-grace', author: 'custom' });
    card = (await s.api('GET', '/api/cards/cross')).body;
    assert.strictEqual(card.thread[1].author, 'custom');

    // an unresolved session falls back to the target's lieutenant (unidentified callers)
    await s.api('POST', '/api/message', { target: 'card:cross', text: 'anonymous', session: 'bc-nobody' });
    card = (await s.api('GET', '/api/cards/cross')).body;
    assert.strictEqual(card.thread[2].author, 'Ada');

    // Grace saying into another lieutenant's MAIN chat is stamped Grace too
    await s.api('POST', '/api/message', { target: 'lieutenant:' + LT, text_md: 'handoff note', session: 'bc-grace' });
    const ada = (await s.api('GET', '/api/board')).body.lieutenants.find((l) => l.id === LT);
    assert.strictEqual(ada.chat[0].author, 'Grace');
  } finally {
    await s.stop();
  }
});

test('cli: say self-identifies by its tmux session', async () => {
  const s = await startServerWithLieutenant();
  try {
    await s.api('POST', '/api/lieutenants', { name: 'Grace', id: 'grace', ref: { harness: 'fake', session: 'bc-grace', cwd: '/tmp' } });
    await s.api('POST', '/api/cards', withOwner({ title: 'Cli cross' }));
    // stub tmux on PATH answering the caller's session name
    const bin = path.join(s.dir, 'bin');
    fs.mkdirSync(bin);
    fs.writeFileSync(path.join(bin, 'tmux'), '#!/bin/sh\necho bc-grace\n');
    fs.chmodSync(path.join(bin, 'tmux'), 0o755);
    const textFile = path.join(s.dir, 'say.txt');
    fs.writeFileSync(textFile, 'hello from grace');
    const r = await runCli(['say', 'card:cli-cross', '--text-file', textFile,
      '--workspace', s.dir, '--port', String(s.port)],
    { TMUX: '/tmp/stub,1,0', PATH: bin + ':' + process.env.PATH });
    assert.strictEqual(r.code, 0, r.stderr);
    const card = (await s.api('GET', '/api/cards/cli-cross')).body;
    assert.strictEqual(card.thread[0].author, 'Grace');
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
