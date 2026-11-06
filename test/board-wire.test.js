'use strict';
// What GET /api/board carries of the history (MNC-303). Storage keeps every
// event; the board on the wire keeps the newest 200 board-level and the newest
// 30 per card, says how many it left out, and an opened card fetches itself
// whole from GET /api/cards/:id. Derived state (the bell's unread count) is
// computed off the whole history, so the cut never changes what he is told.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const http = require('node:http');
const zlib = require('node:zlib');
const { pathToFileURL } = require('node:url');
const { startServerWithLieutenant, withOwner } = require('./helper');

const utilMod = import(pathToFileURL(path.join(__dirname, '..', 'ui', 'js', 'util.js')).href);

function getRaw(base, p, headers) {
  return new Promise((resolve, reject) => {
    http.get(base + p, { headers }, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body: Buffer.concat(chunks) }));
    }).on('error', reject);
  });
}

test('the board ships the newest 200 board events and 30 per card, with counts of the rest', async () => {
  const s = await startServerWithLieutenant();
  try {
    await s.api('POST', '/api/cards', withOwner({ title: 'Chatty' }));
    await s.api('POST', '/api/cards', withOwner({ title: 'Quiet' }));
    // the birth event + 49 = 50 on the chatty card
    for (let i = 0; i < 49; i++) await s.api('POST', '/api/cards/chatty/events', { text: 'card note ' + i });
    const before = (await s.api('GET', '/api/board')).body.events.length; // lieutenant registered, cards created…
    for (let i = 0; i < 230; i++) await s.api('POST', '/api/events', { text: 'board note ' + i, level: 2 });
    const totalBoard = before + 230;

    const b = (await s.api('GET', '/api/board')).body;
    assert.strictEqual(b.events.length, 200);
    assert.strictEqual(b.eventsOmitted, totalBoard - 200);
    assert.strictEqual(b.events.at(-1).text, 'board note 229', 'the newest are the ones kept');
    for (let i = 1; i < b.events.length; i++) assert.ok(b.events[i].seq > b.events[i - 1].seq, 'still in order');

    const chatty = b.cards.find((c) => c.id === 'chatty');
    assert.strictEqual(chatty.events.length, 30);
    assert.strictEqual(chatty.eventsOmitted, 20);
    assert.strictEqual(chatty.events.at(-1).text, 'card note 48');
    const quiet = b.cards.find((c) => c.id === 'quiet');
    assert.strictEqual(quiet.events.length, 1, 'a short history goes out whole');
    assert.strictEqual(quiet.eventsOmitted, undefined, 'and says nothing about a rest it does not have');

    // the opened card, whole
    const full = (await s.api('GET', '/api/cards/chatty')).body;
    assert.strictEqual(full.events.length, 50);
    assert.strictEqual(full.events[0].kind, 'created');
    assert.ok(full.status && full.activity, 'the same public card shape the board carries');

    // storage stays complete: the cut is the wire format only
    const disk = JSON.parse(fs.readFileSync(path.join(s.dir, '.bridge-commander', 'board.json'), 'utf8'));
    assert.strictEqual(disk.events.length, totalBoard);
    assert.strictEqual(disk.cards.find((c) => c.id === 'chatty').events.length, 50);
  } finally {
    await s.stop();
  }
});

test('GET /api/cards/:id goes out gzipped to a client that takes it', async () => {
  const s = await startServerWithLieutenant();
  try {
    await s.api('POST', '/api/cards', withOwner({ title: 'Long' }));
    for (let i = 0; i < 40; i++) await s.api('POST', '/api/cards/long/events', { text: 'a line of history, number ' + i });
    const r = await getRaw(s.base, '/api/cards/long', { 'Accept-Encoding': 'gzip' });
    assert.strictEqual(r.status, 200);
    assert.strictEqual(r.headers['content-encoding'], 'gzip');
    const card = JSON.parse(zlib.gunzipSync(r.body).toString());
    assert.strictEqual(card.events.length, 41);
    assert.strictEqual(card.eventsOmitted, undefined);
  } finally {
    await s.stop();
  }
});

test('the bell counts unread level-1 events the cut left out; mark-all clears them', async () => {
  const s = await startServerWithLieutenant();
  try {
    await s.api('POST', '/api/cards', withOwner({ title: 'Loud' }));
    // 5 level-1 on the card, then 30 quiet ones push them out of the window
    for (let i = 0; i < 5; i++) await s.api('POST', '/api/cards/loud/events', { text: 'alarm ' + i, level: 1 });
    for (let i = 0; i < 30; i++) await s.api('POST', '/api/cards/loud/events', { text: 'quiet ' + i });
    // 3 level-1 board events, then 200 quiet ones push them out too
    for (let i = 0; i < 3; i++) await s.api('POST', '/api/events', { text: 'board alarm ' + i, level: 1 });
    for (let i = 0; i < 200; i++) await s.api('POST', '/api/events', { text: 'board quiet ' + i, level: 2 });

    const b = (await s.api('GET', '/api/board')).body;
    assert.ok(!b.cards.find((c) => c.id === 'loud').events.some((e) => e.level === 1), 'the alarms left the card window');
    assert.ok(!b.events.some((e) => e.level === 1), 'and the board window');
    // the server's own bell, off the whole history: every unread level-1 event
    // is outside both windows now, so all of them must be in the count
    const { items } = (await s.api('GET', '/api/notifications')).body;
    const unreadEvents = items.filter((n) => n.seq && !n.read).length;
    assert.ok(unreadEvents >= 8, 'the card alarms and the board alarms');
    assert.strictEqual(b.notifUnreadOmitted, unreadEvents, 'every unread level-1 event is still counted');

    // one read by seq lowers the count by one
    const one = items.find((n) => n.seq && !n.read);
    await s.api('POST', '/api/notifications/read', { seqs: [one.seq] });
    assert.strictEqual((await s.api('GET', '/api/board')).body.notifUnreadOmitted, unreadEvents - 1);

    await s.api('POST', '/api/notifications/read', { all: true });
    assert.strictEqual((await s.api('GET', '/api/board')).body.notifUnreadOmitted, 0);
  } finally {
    await s.stop();
  }
});

test('the open detail merges the whole card under the board window', async () => {
  const { mergeCardEvents } = await utilMod;
  const ev = (seq) => ({ seq, text: 'e' + seq });
  const full = { id: 'c', events: [1, 2, 3, 4, 5, 6].map(ev) };

  // nothing omitted: the board card is the whole story, no fetch wanted
  assert.deepStrictEqual(mergeCardEvents({ id: 'c', events: [ev(1)] }, null), { events: [ev(1)], missing: 0 });

  // omitted and not fetched yet: show the window, ask for the rest
  const board = { id: 'c', events: [ev(5), ev(6), ev(7)], eventsOmitted: 4 };
  assert.deepStrictEqual(mergeCardEvents(board, null), { events: board.events, missing: 4 });
  assert.strictEqual(mergeCardEvents(board, { id: 'other', events: [] }).missing, 4, 'another card is no answer');

  // fetched: the older part from the whole card, the fresher window from the board
  const m = mergeCardEvents(board, full);
  assert.strictEqual(m.missing, 0);
  assert.deepStrictEqual(m.events.map((e) => e.seq), [1, 2, 3, 4, 5, 6, 7]);

  // a folded repeat replaced the card's last entry since the fetch: the board wins
  const folded = { id: 'c', events: [ev(4), ev(5), { seq: 9, text: 'e6 again', repeats: 2 }], eventsOmitted: 3 };
  assert.deepStrictEqual(mergeCardEvents(folded, full).events.map((e) => e.seq), [1, 2, 3, 4, 5, 9]);

  // more than a window happened since the fetch: a gap, so fetch again
  const moved = { id: 'c', events: [ev(20), ev(21)], eventsOmitted: 19 };
  assert.strictEqual(mergeCardEvents(moved, full).missing, 19);
});
