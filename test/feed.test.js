'use strict';
// Feed poll/ack — the at-least-once contract: unacked lines re-offer on every
// poll; only an explicit ack commits the cursor. Dedupe is the consumer's job.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const { startServerWithColumns, startServer } = require('./helper');

test('unacked feedback re-offers on every poll; ack commits and persists the cursor', async () => {
  const s = await startServerWithColumns();
  try {
    await s.api('POST', '/api/feedback', { target: 'chat', text: 'first' });
    await s.api('POST', '/api/feedback', { target: 'chat', text: 'second' });

    // both offered
    let r = await s.api('GET', '/api/poll?nowait=1');
    assert.deepStrictEqual(r.body.events.map((e) => e.seq), [1, 2]);
    assert.strictEqual(r.body.cursor, 2);
    assert.strictEqual(r.body.ack, 0);

    // poll does NOT advance the cursor: the same lines re-offer
    r = await s.api('GET', '/api/poll?nowait=1');
    assert.deepStrictEqual(r.body.events.map((e) => e.seq), [1, 2]);

    // partial ack: only what's past the committed cursor re-offers
    let a = await s.api('POST', '/api/poll/ack', { seq: 1 });
    assert.strictEqual(a.body.ack, 1);
    r = await s.api('GET', '/api/poll?nowait=1');
    assert.deepStrictEqual(r.body.events.map((e) => e.seq), [2]);

    // full ack: queue drained
    await s.api('POST', '/api/poll/ack', { seq: 2 });
    r = await s.api('GET', '/api/poll?nowait=1');
    assert.deepStrictEqual(r.body.events, []);

    // the committed cursor is durable (own file under BRIDGE_DIR)
    const ackFile = path.join(s.dir, 'boards', s.board + '.feedback.ack');
    assert.strictEqual(fs.readFileSync(ackFile, 'utf8'), '2');

    // ack never regresses, and can't run past the queue head
    await s.api('POST', '/api/poll/ack', { seq: 1 });
    r = await s.api('GET', '/api/poll?nowait=1');
    assert.deepStrictEqual(r.body.events, []); // still committed at 2
    a = await s.api('POST', '/api/poll/ack', { seq: 99 });
    assert.strictEqual(a.status, 400);
    a = await s.api('POST', '/api/poll/ack', {});
    assert.strictEqual(a.status, 400);
  } finally {
    await s.stop();
  }
});

test('feedback queue and ack cursor survive a server restart', async () => {
  const fsx = require('node:fs');
  const os = require('node:os');
  const dir = fsx.mkdtempSync(path.join(os.tmpdir(), 'bridge-test-'));
  const s1 = await startServerWithColumns({ dir });
  try {
    await s1.api('POST', '/api/feedback', { target: 'chat', text: 'one' });
    await s1.api('POST', '/api/feedback', { target: 'chat', text: 'two' });
    await s1.api('POST', '/api/poll/ack', { seq: 1 });
  } finally {
    await s1.stop();
  }
  const s2 = await startServer({ dir });
  try {
    const r = await s2.api('GET', '/api/poll?nowait=1');
    assert.deepStrictEqual(r.body.events.map((e) => e.seq), [2]); // unacked line re-offered after restart
    assert.strictEqual(r.body.ack, 1);
  } finally {
    await s2.stop();
    fsx.rmSync(dir, { recursive: true, force: true });
  }
});

test('explicit ?since bypasses the committed cursor', async () => {
  const s = await startServerWithColumns();
  try {
    await s.api('POST', '/api/feedback', { target: 'chat', text: 'one' });
    await s.api('POST', '/api/poll/ack', { seq: 1 });
    const r = await s.api('GET', '/api/poll?since=0&nowait=1');
    assert.deepStrictEqual(r.body.events.map((e) => e.seq), [1]); // acked but still readable via since
  } finally {
    await s.stop();
  }
});

test('long-poll blocks until feedback arrives, then delivers it', async () => {
  const s = await startServerWithColumns();
  try {
    const pending = fetch(s.base + '/api/poll').then((r) => r.json());
    // give the poller a moment to register, then produce feedback
    await new Promise((r) => setTimeout(r, 150));
    await s.api('POST', '/api/feedback', { target: 'chat', text: 'wake up' });
    const r = await pending;
    assert.strictEqual(r.events.length, 1);
    assert.strictEqual(r.events[0].text, 'wake up');
    assert.strictEqual(r.events[0].seq, 1);
  } finally {
    await s.stop();
  }
});

test('the ack file is the only cursor: a stray legacy .cursor file is ignored', async () => {
  const s = await startServer({
    seed: (dir) => {
      const boards = path.join(dir, 'boards');
      fs.mkdirSync(boards, { recursive: true });
      // a leftover pre-rebuild CLI cursor must have no effect on delivery
      fs.writeFileSync(path.join(boards, 'testboard.cursor'), '2');
      const lines = [
        { seq: 1, ts: '2026-01-01T00:00:00.000Z', kind: 'message', target: 'chat', text: 'one' },
        { seq: 2, ts: '2026-01-01T00:00:01.000Z', kind: 'message', target: 'chat', text: 'two' },
        { seq: 3, ts: '2026-01-01T00:00:02.000Z', kind: 'message', target: 'chat', text: 'three' },
      ];
      fs.writeFileSync(path.join(boards, 'testboard.feedback.jsonl'), lines.map((l) => JSON.stringify(l)).join('\n') + '\n');
    },
  });
  try {
    let r = await s.api('GET', '/api/poll?nowait=1');
    assert.deepStrictEqual(r.body.events.map((e) => e.seq), [1, 2, 3]); // nothing acked yet
    await s.api('POST', '/api/poll/ack', { seq: 3 });
    r = await s.api('GET', '/api/poll?nowait=1');
    assert.deepStrictEqual(r.body.events, []); // only the ack file commits
  } finally {
    await s.stop();
  }
});
