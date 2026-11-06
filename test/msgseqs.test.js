'use strict';
// The owed/queued derivation reads "the latest captain message delivered to
// each target" off the delivery queues. The server keeps that map in memory —
// built from the queue files at boot, fed on every append, rebuilt when a queue
// file goes (MNC-303) — instead of re-reading every queue/*.jsonl per board
// build. A restart rebuilds it from the files alone, which is exactly the old
// full read: so the board a live server derives and the board a fresh boot on
// the same files derives must agree, at every step.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { startServer, withOwner } = require('./helper');

// Everything the queue map feeds, per card and per lieutenant.
async function derived(s) {
  const b = (await s.api('GET', '/api/board')).body;
  const out = {};
  for (const c of b.cards) out['card:' + c.id] = [c.status.owed, c.status.owedState];
  for (const l of b.lieutenants) out['lieutenant:' + l.id] = [l.chatOwed, l.chatQueued];
  return out;
}

test('the in-memory queue index matches a full read of the queue files', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bc-msgseqs-'));
  let s = await startServer({ dir });
  try {
    for (const [name, id] of [['Ada', 'ada'], ['Bob', 'bob'], ['Cy', 'cy']]) {
      await s.api('POST', '/api/lieutenants', { name, id, ref: { harness: 'fake', session: 'bc-' + id, cwd: '/tmp' } });
    }
    await s.api('POST', '/api/cards', withOwner({ title: 'Alpha', owner: 'ada' }));
    await s.api('POST', '/api/cards', withOwner({ title: 'Beta', owner: 'bob' }));
    await s.api('POST', '/api/cards', withOwner({ title: 'Gamma', owner: 'bob' }));
    await s.api('POST', '/api/cards', withOwner({ title: 'Delta', owner: 'cy' }));

    const steps = [
      () => s.api('POST', '/api/feedback', { target: 'card:alpha', text: 'one' }),
      () => s.api('POST', '/api/feedback', { target: 'lieutenant:bob', text: 'two' }),
      () => s.api('POST', '/api/feedback', { target: 'card:beta', text: 'three' }),
      () => s.api('GET', '/api/feed?lieutenant=bob'),                       // bob drains: queued → seen
      () => s.api('POST', '/api/feedback', { target: 'card:gamma', text: 'four' }),
      async () => {                                                        // ada drains and acks
        const items = (await s.api('GET', '/api/feed?lieutenant=ada')).body.items;
        await s.api('POST', '/api/feed/ack', { lieutenant: 'ada', seq: items.at(-1).seq });
      },
      () => s.api('POST', '/api/feedback', { target: 'lieutenant:cy', text: 'five' }),
      () => s.api('POST', '/api/feedback', { target: 'card:delta', text: 'for cy' }),
      () => s.api('PATCH', '/api/cards/delta', { owner: 'ada', actor: 'user' }),
      // cy's queue file goes with it — and with it the delivery that made delta
      // owed: a map that kept the entry would still say so
      () => s.api('DELETE', '/api/lieutenants/cy', { actor: 'user' }),
      () => s.api('POST', '/api/feedback', { target: 'card:alpha', text: 'six' }),
    ];
    let checked = 0;
    for (const step of steps) {
      const r = await step();
      assert.ok(r == null || r.status === 200, JSON.stringify(r && r.body));
      const live = await derived(s);
      await s.stop();
      s = await startServer({ dir }); // boots off the files alone: the full read
      assert.deepStrictEqual(await derived(s), live, 'after step ' + (++checked));
    }
    // and the walk actually exercised every state
    const end = await derived(s);
    assert.deepStrictEqual(end['card:alpha'], [true, 'queued']);
    assert.deepStrictEqual(end['card:beta'], [true, 'seen']);
    assert.deepStrictEqual(end['lieutenant:bob'], [true, false]);
    assert.deepStrictEqual(end['card:delta'], [false, null], 'the retired queue took its delivery along');
    assert.ok(!('lieutenant:cy' in end));
  } finally {
    await s.stop();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
