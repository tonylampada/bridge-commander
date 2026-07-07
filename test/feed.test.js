'use strict';
// Delivery queues — the at-least-once contract: durable per-lieutenant jsonl
// files with a GLOBAL seq; drain re-offers unacked items on every call; only an
// explicit ack commits the cursor. Dedupe is the consumer's job.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { startServer, startServerWithLieutenant, LT } = require('./helper');

function queueDir(s) { return path.join(s.dir, '.bridge-command', 'queue'); }

test('unacked items re-offer on every drain; ack commits and persists the cursor', async () => {
  const s = await startServerWithLieutenant();
  try {
    await s.api('POST', '/api/feedback', { target: 'lieutenant:' + LT, text: 'first' });
    await s.api('POST', '/api/feedback', { target: 'lieutenant:' + LT, text: 'second' });

    // both offered, and durable on disk
    let r = await s.api('GET', '/api/feed?lieutenant=' + LT);
    assert.deepStrictEqual(r.body.items.map((e) => e.seq), [1, 2]);
    assert.strictEqual(r.body.head, 2);
    const onDisk = fs.readFileSync(path.join(queueDir(s), LT + '.jsonl'), 'utf8')
      .split('\n').filter(Boolean).map((l) => JSON.parse(l));
    assert.deepStrictEqual(onDisk.map((e) => e.seq), [1, 2]);

    // drain does NOT advance the cursor: the same items re-offer
    r = await s.api('GET', '/api/feed?lieutenant=' + LT);
    assert.deepStrictEqual(r.body.items.map((e) => e.seq), [1, 2]);

    // partial ack: only what's past the committed cursor re-offers
    let a = await s.api('POST', '/api/feed/ack', { seq: 1 });
    assert.strictEqual(a.body.ack, 1);
    assert.strictEqual(a.body.lieutenant, LT);
    r = await s.api('GET', '/api/feed?lieutenant=' + LT);
    assert.deepStrictEqual(r.body.items.map((e) => e.seq), [2]);

    // full ack: queue drained
    await s.api('POST', '/api/feed/ack', { seq: 2 });
    r = await s.api('GET', '/api/feed?lieutenant=' + LT);
    assert.deepStrictEqual(r.body.items, []);

    // the committed cursor is durable (own file under queue/)
    assert.strictEqual(fs.readFileSync(path.join(queueDir(s), LT + '.ack'), 'utf8'), '2');

    // ack never regresses; an unknown seq is rejected
    await s.api('POST', '/api/feed/ack', { seq: 1 });
    r = await s.api('GET', '/api/feed?lieutenant=' + LT);
    assert.deepStrictEqual(r.body.items, []); // still committed at 2
    a = await s.api('POST', '/api/feed/ack', { seq: 99 });
    assert.strictEqual(a.status, 400);
    a = await s.api('POST', '/api/feed/ack', {});
    assert.strictEqual(a.status, 400);
  } finally {
    await s.stop();
  }
});

test('queue and ack cursor survive a server restart', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bc-test-'));
  const s1 = await startServerWithLieutenant({ dir });
  try {
    await s1.api('POST', '/api/feedback', { target: 'lieutenant:' + LT, text: 'one' });
    await s1.api('POST', '/api/feedback', { target: 'lieutenant:' + LT, text: 'two' });
    await s1.api('POST', '/api/feed/ack', { seq: 1 });
  } finally {
    await s1.stop();
  }
  const s2 = await startServer({ dir });
  try {
    const r = await s2.api('GET', '/api/feed?lieutenant=' + LT);
    assert.deepStrictEqual(r.body.items.map((e) => e.seq), [2]); // unacked item re-offered after restart
    // the global seq continues past everything stored
    await s2.api('POST', '/api/feedback', { target: 'lieutenant:' + LT, text: 'three' });
    const r2 = await s2.api('GET', '/api/feed?lieutenant=' + LT);
    assert.deepStrictEqual(r2.body.items.map((e) => e.seq), [2, 3]);
  } finally {
    await s2.stop();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('the seq is global across lieutenants; drain filters by lieutenant, acks stay per-queue', async () => {
  const s = await startServerWithLieutenant();
  try {
    await s.api('POST', '/api/lieutenants', { name: 'Grace', id: 'grace' });
    await s.api('POST', '/api/feedback', { target: 'lieutenant:' + LT, text: 'to ada' });      // seq 1
    await s.api('POST', '/api/feedback', { target: 'lieutenant:grace', text: 'to grace' });    // seq 2
    await s.api('POST', '/api/feedback', { target: 'lieutenant:' + LT, text: 'to ada again' });// seq 3

    // no filter: everything pending, seq-ordered board-wide
    let r = await s.api('GET', '/api/feed');
    assert.deepStrictEqual(r.body.items.map((e) => [e.seq, e.lieutenant]), [[1, LT], [2, 'grace'], [3, LT]]);

    // per-lieutenant drain
    r = await s.api('GET', '/api/feed?lieutenant=grace');
    assert.deepStrictEqual(r.body.items.map((e) => e.seq), [2]);

    // acking seq 3 commits ada's cursor past seq 1 too (per-queue ascending), but
    // never touches grace's queue
    await s.api('POST', '/api/feed/ack', { seq: 3 });
    r = await s.api('GET', '/api/feed');
    assert.deepStrictEqual(r.body.items.map((e) => e.seq), [2]);

    // unknown lieutenant filter is a 404
    assert.strictEqual((await s.api('GET', '/api/feed?lieutenant=ghost')).status, 404);
  } finally {
    await s.stop();
  }
});
