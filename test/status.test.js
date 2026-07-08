'use strict';
// Status model: worker lease via status.set, server-derived owed/unread,
// restart survival (leases and derivations live in persisted state, no timers).
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { startServer, startServerWithLieutenant, withOwner, runCli, sleep } = require('./helper');

async function cardStatus(s, id) {
  const r = await s.api('GET', '/api/cards/' + id);
  assert.strictEqual(r.status, 200);
  return r.body.status;
}

test('status.set validates worker shape, state, and ttl', async () => {
  const s = await startServerWithLieutenant();
  try {
    await s.api('POST', '/api/cards', withOwner({ title: 'Task' }));

    let r = await s.api('POST', '/api/cards/nope/status', { worker: { id: 'w1', state: 'working' } });
    assert.strictEqual(r.status, 404);
    r = await s.api('POST', '/api/cards/task/status', {});
    assert.strictEqual(r.status, 400); // worker required
    r = await s.api('POST', '/api/cards/task/status', { worker: 'working' });
    assert.strictEqual(r.status, 400); // worker must be an object (or null)
    r = await s.api('POST', '/api/cards/task/status', { worker: { id: 'w1', state: 'busy' } });
    assert.strictEqual(r.status, 400); // bad state rejected
    r = await s.api('POST', '/api/cards/task/status', { worker: { state: 'working' } });
    assert.strictEqual(r.status, 400); // id required for a linked state
    r = await s.api('POST', '/api/cards/task/status', { worker: { id: 'w1', state: 'working' }, ttl: 0 });
    assert.strictEqual(r.status, 400); // ttl must be > 0
    r = await s.api('POST', '/api/cards/task/status', { worker: { id: 'w1', state: 'working' }, ttl: -5 });
    assert.strictEqual(r.status, 400);

    r = await s.api('POST', '/api/cards/task/status', { worker: { id: 'w1', state: 'working' } });
    assert.strictEqual(r.status, 200);
    assert.strictEqual(r.body.status.worker.id, 'w1');
    assert.strictEqual(r.body.status.worker.state, 'working');
  } finally {
    await s.stop();
  }
});

test('absent when no worker; state absent (or worker null) unlinks', async () => {
  const s = await startServerWithLieutenant();
  try {
    await s.api('POST', '/api/cards', withOwner({ title: 'Bare' }));
    let st = await cardStatus(s, 'bare');
    assert.deepStrictEqual(st, { worker: { id: null, state: 'absent' }, owed: false, owedState: null, unread: false });

    await s.api('POST', '/api/cards/bare/status', { worker: { id: 'w1', state: 'idle' } });
    st = await cardStatus(s, 'bare');
    assert.strictEqual(st.worker.state, 'idle');
    assert.strictEqual(st.worker.id, 'w1');

    await s.api('POST', '/api/cards/bare/status', { worker: { state: 'absent' } });
    st = await cardStatus(s, 'bare');
    assert.deepStrictEqual(st.worker, { id: null, state: 'absent' });

    await s.api('POST', '/api/cards/bare/status', { worker: { id: 'w1', state: 'working' } });
    await s.api('POST', '/api/cards/bare/status', { worker: null });
    st = await cardStatus(s, 'bare');
    assert.deepStrictEqual(st.worker, { id: null, state: 'absent' });
  } finally {
    await s.stop();
  }
});

test('working/needs-you lease decays to idle after its ttl; idle does not decay further', async () => {
  const s = await startServerWithLieutenant();
  try {
    await s.api('POST', '/api/cards', withOwner({ title: 'Leased' }));

    await s.api('POST', '/api/cards/leased/status', { worker: { id: 'w1', state: 'working' }, ttl: 0.3 });
    let st = await cardStatus(s, 'leased');
    assert.strictEqual(st.worker.state, 'working');
    await sleep(450);
    st = await cardStatus(s, 'leased');
    assert.strictEqual(st.worker.state, 'idle'); // honest "not currently working"
    assert.strictEqual(st.worker.id, 'w1'); // still linked

    await s.api('POST', '/api/cards/leased/status', { worker: { id: 'w1', state: 'needs-you' }, ttl: 0.3 });
    await sleep(450);
    st = await cardStatus(s, 'leased');
    assert.strictEqual(st.worker.state, 'idle');

    await s.api('POST', '/api/cards/leased/status', { worker: { id: 'w1', state: 'idle' }, ttl: 0.3 });
    await sleep(450);
    st = await cardStatus(s, 'leased');
    assert.strictEqual(st.worker.state, 'idle'); // idle is the decay floor, never absent
  } finally {
    await s.stop();
  }
});

test('lease survives a restart; expiry is derived on read, so decay happens even while down', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bc-test-'));
  let s = null;
  try {
    s = await startServerWithLieutenant({ dir });
    await s.api('POST', '/api/cards', withOwner({ title: 'Task' }));
    await s.api('POST', '/api/cards/task/status', { worker: { id: 'w1', state: 'working' }, ttl: 60 });
    await s.stop();

    s = await startServer({ dir }); // unexpired lease rides the board file
    let st = await cardStatus(s, 'task');
    assert.strictEqual(st.worker.state, 'working');

    await s.api('POST', '/api/cards/task/status', { worker: { id: 'w1', state: 'working' }, ttl: 0.2 });
    await s.stop();
    await sleep(350); // lease expires while the server is DOWN
    s = await startServer({ dir });
    st = await cardStatus(s, 'task');
    assert.strictEqual(st.worker.state, 'idle'); // decayed with no timer ever firing
    assert.strictEqual(st.worker.id, 'w1');
  } finally {
    if (s) await s.stop();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('owed: flips true on a captain thread message, false on lieutenant reply, survives restart', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bc-test-'));
  let s = null;
  try {
    s = await startServerWithLieutenant({ dir });
    await s.api('POST', '/api/cards', withOwner({ title: 'Ask' }));
    assert.strictEqual((await cardStatus(s, 'ask')).owed, false);

    await s.api('POST', '/api/feedback', { target: 'card:ask', text: 'please check' });
    assert.strictEqual((await cardStatus(s, 'ask')).owed, true);

    await s.api('POST', '/api/message', { target: 'card:ask', text: 'on it' });
    assert.strictEqual((await cardStatus(s, 'ask')).owed, false);

    await s.api('POST', '/api/feedback', { target: 'card:ask', text: 'and this?' });
    assert.strictEqual((await cardStatus(s, 'ask')).owed, true);

    // owed is derived from persisted state: a restart must not forget it
    await s.stop();
    s = await startServer({ dir });
    assert.strictEqual((await cardStatus(s, 'ask')).owed, true);

    await s.api('POST', '/api/message', { target: 'card:ask', text: 'answered' });
    assert.strictEqual((await cardStatus(s, 'ask')).owed, false);
  } finally {
    if (s) await s.stop();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('owedState: queued while the message sits unacked, seen after the drain is acked, null on reply', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bc-test-'));
  let s = null;
  try {
    s = await startServerWithLieutenant({ dir });
    await s.api('POST', '/api/cards', withOwner({ title: 'Tri' }));
    assert.strictEqual((await cardStatus(s, 'tri')).owedState, null);

    // captain message → durable queue item, unacked: the lieutenant has NOT seen it
    const f = await s.api('POST', '/api/feedback', { target: 'card:tri', text: 'you there?' });
    let st = await cardStatus(s, 'tri');
    assert.strictEqual(st.owed, true);
    assert.strictEqual(st.owedState, 'queued');

    // queued derives from the queue files, so a restart must not forget it
    await s.stop();
    s = await startServer({ dir });
    assert.strictEqual((await cardStatus(s, 'tri')).owedState, 'queued');

    // draining alone is not seeing — only the committed ack advances the cursor
    await s.api('GET', '/api/feed?lieutenant=ada');
    assert.strictEqual((await cardStatus(s, 'tri')).owedState, 'queued');
    await s.api('POST', '/api/feed/ack', { seq: f.body.seq });
    st = await cardStatus(s, 'tri');
    assert.strictEqual(st.owed, true);
    assert.strictEqual(st.owedState, 'seen'); // drained, reply still owed

    await s.api('POST', '/api/message', { target: 'card:tri', text: 'here' });
    st = await cardStatus(s, 'tri');
    assert.strictEqual(st.owed, false);
    assert.strictEqual(st.owedState, null);
  } finally {
    if (s) await s.stop();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('board payload: cards carry owedState and lieutenants carry chatQueued for the main chat', async () => {
  const s = await startServerWithLieutenant();
  try {
    await s.api('POST', '/api/cards', withOwner({ title: 'Pay' }));
    let b = (await s.api('GET', '/api/board')).body;
    assert.strictEqual(b.lieutenants[0].chatQueued, false);
    assert.strictEqual(b.cards[0].status.owedState, null);

    const f = await s.api('POST', '/api/feedback', { target: 'lieutenant:ada', text: 'ping' });
    const fc = await s.api('POST', '/api/feedback', { target: 'card:pay', text: 'ping card' });
    b = (await s.api('GET', '/api/board')).body;
    assert.strictEqual(b.lieutenants[0].chatQueued, true);
    assert.strictEqual(b.cards[0].status.owedState, 'queued');

    // ack both messages: main chat pickup and card pickup are independent bits
    await s.api('POST', '/api/feed/ack', { seq: Math.max(f.body.seq, fc.body.seq) });
    b = (await s.api('GET', '/api/board')).body;
    assert.strictEqual(b.lieutenants[0].chatQueued, false);
    assert.strictEqual(b.cards[0].status.owedState, 'seen');
  } finally {
    await s.stop();
  }
});

test('unread: level-1 event or lieutenant reply sets it; reading the card clears it; survives restart', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bc-test-'));
  let s = null;
  const read = () => s.api('POST', '/api/read', { user: 'user', target: 'card:watch' });
  try {
    s = await startServerWithLieutenant({ dir });
    await s.api('POST', '/api/cards', withOwner({ title: 'Watch' }));
    assert.strictEqual((await cardStatus(s, 'watch')).unread, false);

    await s.api('POST', '/api/cards/watch/events', { text: 'quiet progress', level: 2 });
    assert.strictEqual((await cardStatus(s, 'watch')).unread, false); // level 2 never rings

    await s.api('POST', '/api/cards/watch/events', { text: 'needs eyes', level: 1 });
    assert.strictEqual((await cardStatus(s, 'watch')).unread, true);

    await read();
    await sleep(10);
    assert.strictEqual((await cardStatus(s, 'watch')).unread, false);

    await s.api('POST', '/api/message', { target: 'card:watch', text: 'done, take a look' });
    assert.strictEqual((await cardStatus(s, 'watch')).unread, true); // lieutenant reply after last read

    // unread and its read marker are persisted state — a restart changes nothing
    await s.stop();
    s = await startServer({ dir });
    assert.strictEqual((await cardStatus(s, 'watch')).unread, true);

    await read();
    await sleep(10);
    assert.strictEqual((await cardStatus(s, 'watch')).unread, false);

    await s.api('POST', '/api/feedback', { target: 'card:watch', text: 'thanks' });
    const st = await cardStatus(s, 'watch');
    assert.strictEqual(st.unread, false); // the captain's own message is never unread to them
    assert.strictEqual(st.owed, true);
  } finally {
    if (s) await s.stop();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('cli: bc-axi status verb sets and reads the worker lease', async () => {
  const s = await startServerWithLieutenant();
  const args = ['--workspace', s.dir, '--port', String(s.port)];
  try {
    await s.api('POST', '/api/cards', withOwner({ title: 'CLI card' }));

    let r = await runCli(['status', 'cli-card', 'working', '--worker', 'fix-1', ...args]);
    assert.strictEqual(r.code, 0, r.stderr);
    assert.match(r.stdout, /worker=working\(fix-1\)/);
    assert.strictEqual((await cardStatus(s, 'cli-card')).worker.state, 'working');

    r = await runCli(['status', 'cli-card', ...args]); // read-back
    assert.match(r.stdout, /worker=working\(fix-1\) owed=false unread=false/);

    r = await runCli(['status', 'cli-card', 'working', ...args]); // missing --worker
    assert.strictEqual(r.code, 1);

    r = await runCli(['status', 'cli-card', 'bogus', '--worker', 'fix-1', ...args]);
    assert.strictEqual(r.code, 1); // server rejects bad state

    r = await runCli(['status', 'cli-card', 'absent', ...args]);
    assert.strictEqual(r.code, 0, r.stderr);
    assert.match(r.stdout, /worker=absent/);

    r = await runCli(['status', ...args]); // bare status = server status
    assert.match(r.stdout, /server: up/);
    assert.match(r.stdout, /lieutenants=1/);
  } finally {
    await s.stop();
  }
});

test('board payload: every card carries derived status; worker is never mirrored into attributes', async () => {
  const s = await startServerWithLieutenant();
  try {
    await s.api('POST', '/api/cards', withOwner({ title: 'Plain' }));
    await s.api('POST', '/api/cards', withOwner({ title: 'Leased' }));
    await s.api('POST', '/api/cards/leased/status', { worker: { id: 'w1', state: 'working' } });
    const b = (await s.api('GET', '/api/board')).body;
    for (const c of b.cards) {
      assert.ok(c.status && c.status.worker, c.id + ' carries status');
      assert.strictEqual('worker' in (c.attributes || {}), false, c.id + ' has no attributes.worker');
    }
    assert.strictEqual(b.cards.find((c) => c.id === 'plain').status.worker.state, 'absent');
    assert.strictEqual(b.cards.find((c) => c.id === 'leased').status.worker.state, 'working');
  } finally {
    await s.stop();
  }
});
