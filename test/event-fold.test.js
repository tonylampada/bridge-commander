'use strict';
// A caller saying the same thing again — a cron's `progress-check` every fifteen
// minutes — folds into the entry it repeats instead of growing the card
// (MNC-303: one card carried 2,200 of them, 1.9 MB). Only a consecutive repeat
// from the same caller folds; the fresh entry keeps a new seq, so the bell and
// push treat it as the new event it is.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const { startServerWithLieutenant, withOwner, LT } = require('./helper');

const CHECK = { text: 'Own the endpoint: inspect board, keep 3–5 review steps ahead', kind: 'progress-check', source: 'copyshared-progress' };

test('consecutive progress-checks fold into one counted entry', async () => {
  const s = await startServerWithLieutenant();
  try {
    await s.api('POST', '/api/cards', withOwner({ title: 'Heartbeat' }));
    const r1 = (await s.api('POST', '/api/cards/heartbeat/events', CHECK)).body.event;
    const r2 = (await s.api('POST', '/api/cards/heartbeat/events', CHECK)).body.event;
    const r3 = (await s.api('POST', '/api/cards/heartbeat/events', CHECK)).body.event;
    assert.strictEqual(r1.repeats, undefined, 'the first one is just an entry');
    assert.strictEqual(r2.repeats, 2);
    assert.strictEqual(r3.repeats, 3);
    assert.strictEqual(r3.firstTs, r1.ts, 'when the run started');
    assert.ok(r3.seq > r2.seq && r2.seq > r1.seq, 'each repeat is a fresh seq');

    const card = (await s.api('GET', '/api/cards/heartbeat')).body;
    const checks = card.events.filter((e) => e.kind === 'progress-check');
    assert.strictEqual(checks.length, 1, 'one line on the timeline');
    assert.strictEqual(checks[0].seq, r3.seq);
    assert.strictEqual(card.events.at(-1).seq, r3.seq);

    const disk = JSON.parse(fs.readFileSync(path.join(s.dir, '.bridge-commander', 'board.json'), 'utf8'));
    assert.strictEqual(disk.cards.find((c) => c.id === 'heartbeat').events.length, 2, 'birth + the folded check: the card stopped growing');
  } finally {
    await s.stop();
  }
});

test('anything in between, or any difference, keeps entries apart', async () => {
  const s = await startServerWithLieutenant();
  try {
    await s.api('POST', '/api/cards', withOwner({ title: 'Mixed' }));
    const post = (b) => s.api('POST', '/api/cards/mixed/events', b);
    await post(CHECK);
    await post({ text: 'CI failed', kind: 'ci-failed' });
    await post(CHECK);                                          // a new run after the interruption
    await post(Object.assign({}, CHECK, { source: 'other' }));  // another caller
    await post(Object.assign({}, CHECK, { text: 'different words' }));
    await post(Object.assign({}, CHECK, { level: 1 }));         // louder is not the same entry
    await post(Object.assign({}, CHECK, { level: 1, key: 'k1' })); // a keyed caller manages its own repeats
    const card = (await s.api('GET', '/api/cards/mixed')).body;
    assert.strictEqual(card.events.length, 8, 'birth + seven separate entries');
    assert.ok(card.events.every((e) => !e.repeats));
  } finally {
    await s.stop();
  }
});

test('a folded repeat still wakes the owner each time it asks to', async () => {
  const s = await startServerWithLieutenant();
  try {
    await s.api('POST', '/api/cards', withOwner({ title: 'Waker' }));
    for (let i = 0; i < 3; i++) {
      await s.api('POST', '/api/cards/waker/events', Object.assign({ wakeOwner: true }, CHECK));
    }
    const items = (await s.api('GET', '/api/feed?lieutenant=' + LT)).body.items.filter((i) => i.kind === 'card-event');
    assert.strictEqual(items.length, 3, 'folding is about the timeline, not the delivery');
  } finally {
    await s.stop();
  }
});
