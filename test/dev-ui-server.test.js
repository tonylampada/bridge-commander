'use strict';
// dev/ui-server.js — the frontend-only dev playground harness. These tests keep
// the fake board honest: static UI serve, fixture board shape, the board SSE,
// and a write route that mutates + rebroadcasts.
const { test, before, after } = require('node:test');
const assert = require('node:assert');
const http = require('node:http');
const path = require('node:path');

const { createDevServer } = require(path.join(__dirname, '..', 'dev', 'ui-server.js'));

let dev, port;
before(async () => {
  dev = createDevServer();
  await new Promise((resolve) => dev.server.listen(0, '127.0.0.1', resolve));
  port = dev.server.address().port;
});
after(async () => { await dev.stop(); });

const base = () => 'http://127.0.0.1:' + port;
async function getJson(p) {
  const r = await fetch(base() + p);
  assert.strictEqual(r.status, 200, p);
  return r.json();
}
async function postJson(p, body) {
  const r = await fetch(base() + p, {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
  });
  return { status: r.status, body: await r.json() };
}
// collect SSE events from a path until pred(events) is satisfied (or timeout)
function collectSse(p, pred, ms) {
  return new Promise((resolve, reject) => {
    const req = http.get(base() + p, (res) => {
      let buf = '';
      const events = [];
      res.on('data', (d) => {
        buf += d;
        let i;
        while ((i = buf.indexOf('\n\n')) >= 0) {
          const block = buf.slice(0, i); buf = buf.slice(i + 2);
          const ev = /^event: (.+)$/m.exec(block);
          const data = /^data: (.*)$/m.exec(block);
          if (ev) events.push({ event: ev[1], data: data ? JSON.parse(data[1]) : null });
        }
        if (pred(events)) { req.destroy(); resolve(events); }
      });
      res.on('error', () => {});
    });
    req.on('error', (e) => { if (e.code !== 'ECONNRESET') reject(e); });
    setTimeout(() => { req.destroy(); reject(new Error('SSE timeout on ' + p)); }, ms || 5000).unref();
  });
}

test('serves the UI index from this worktree', async () => {
  const r = await fetch(base() + '/');
  assert.strictEqual(r.status, 200);
  assert.match(r.headers.get('content-type'), /text\/html/);
  assert.strictEqual(r.headers.get('cache-control'), 'no-cache');
  const html = await r.text();
  assert.match(html, /bridge/i);
  const js = await fetch(base() + '/ui/js/main.js');
  assert.strictEqual(js.status, 200);
});

test('GET /api/board serves the fixture board with derived fields', async () => {
  const doc = await getJson('/api/board');
  assert.ok(doc.boot.startsWith('dev-'));
  assert.strictEqual(doc.lieutenants.length, 4);
  assert.ok(doc.kinds.created.emoji, 'effective kinds map present');
  assert.ok(doc.kinds['pr-merged'], 'registered fixture kind merged in');
  for (const col of ['backlog', 'working', 'review', 'peer']) {
    assert.ok(doc.cards.some((c) => c.column === col), 'a card in ' + col);
  }
  const oauth = doc.cards.find((c) => c.id === 'oauth-token-refresh');
  assert.strictEqual(oauth.status.worker.state, 'working');
  assert.strictEqual(oauth.status.owedState, 'seen');
  assert.ok(oauth.activity, 'derived activity present');
  // the expired lease decays to idle at read time (the dead-lieutenant fixture)
  const dark = doc.cards.find((c) => c.id === 'dashboard-dark-mode');
  assert.strictEqual(dark.status.worker.state, 'idle');
  const quill = doc.lieutenants.find((l) => l.id === 'quill');
  assert.strictEqual(quill.chatOwed, true);
  assert.strictEqual(quill.chatQueued, true);
});

test('board SSE emits the fixture board on connect', async () => {
  const events = await collectSse('/api/events', (evs) => evs.some((e) => e.event === 'board'));
  const doc = events.find((e) => e.event === 'board').data;
  assert.strictEqual(doc.lieutenants.length, 4);
  assert.ok(doc.cards.length >= 10);
});

test('a write route mutates the fixture and rebroadcasts', async () => {
  const seen = collectSse('/api/events', (evs) =>
    evs.filter((e) => e.event === 'board').some((e) =>
      e.data.cards.find((c) => c.id === 'readme-overhaul').thread.some((m) => m.text === 'sse-proof')));
  await new Promise((r) => setTimeout(r, 50)); // let the subscriber attach first
  const r = await postJson('/api/feedback', { target: 'card:readme-overhaul', text: 'sse-proof' });
  assert.strictEqual(r.status, 200);
  await seen; // the mutated board reached the SSE client
  const doc = await getJson('/api/board');
  const card = doc.cards.find((c) => c.id === 'readme-overhaul');
  assert.strictEqual(card.thread.at(-1).text, 'sse-proof');
  assert.strictEqual(card.status.owed, true, 'captain message marks the target owed');
});

test('a drag to working becomes a start-order (pendingOrder, no move)', async () => {
  const r = await postJson('/api/cards/refactor-queue-backoff/move', { column: 'working', actor: 'user' });
  assert.strictEqual(r.status, 200);
  assert.strictEqual(r.body.ordered, 'start-order');
  const doc = await getJson('/api/board');
  const card = doc.cards.find((c) => c.id === 'refactor-queue-backoff');
  assert.strictEqual(card.column, 'backlog', 'order does not move the card');
  assert.strictEqual(card.pendingOrder.kind, 'start-order');
});
