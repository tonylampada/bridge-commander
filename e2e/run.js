#!/usr/bin/env node
// e2e — API-level end-to-end scenarios against a real server on a throwaway
// workspace under the OS temp dir. Node built-ins only, zero deps.
//
//   node e2e/run.js
//
// Covers: board init, lieutenant create, cards of each type, captain message →
// queue item drained + acked, drag-order → queue item, archive/restore, bell
// derivation. Exits non-zero on the first failure.
'use strict';

const { spawn } = require('node:child_process');
const assert = require('node:assert');
const net = require('node:net');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const SERVER_JS = path.join(__dirname, '..', 'server', 'server.js');
const CLI = path.join(__dirname, '..', 'cli', 'bc-axi');

function freePort() {
  return new Promise((resolve, reject) => {
    const srv = net.createServer();
    srv.once('error', reject);
    srv.listen(0, '127.0.0.1', () => {
      const { port } = srv.address();
      srv.close(() => resolve(port));
    });
  });
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function runCli(args, extra = []) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [CLI, ...args, ...extra], { stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '', stderr = '';
    child.stdout.on('data', (c) => (stdout += c));
    child.stderr.on('data', (c) => (stderr += c));
    child.on('close', (code) => resolve({ code, stdout, stderr }));
  });
}

let passed = 0;
async function step(name, fn) {
  try {
    await fn();
    passed++;
    console.log('  ✔ ' + name);
  } catch (e) {
    console.error('  ✖ ' + name);
    console.error(e && e.stack ? e.stack : e);
    process.exitCode = 1;
    throw e;
  }
}

(async () => {
  const ws = fs.mkdtempSync(path.join(os.tmpdir(), 'bc-e2e-'));
  const port = await freePort();
  const base = 'http://127.0.0.1:' + port;
  const wsArgs = ['--workspace', ws, '--port', String(port)];
  console.log('workspace: ' + ws + '  port: ' + port);

  const server = spawn(process.execPath, [SERVER_JS, ws, '--port', String(port), '--host', '127.0.0.1'], {
    stdio: ['ignore', 'ignore', 'pipe'],
  });
  let serverErr = '';
  server.stderr.on('data', (c) => (serverErr += c));

  async function api(method, p, body) {
    const res = await fetch(base + p, {
      method,
      headers: body != null ? { 'Content-Type': 'application/json' } : {},
      body: body != null ? JSON.stringify(body) : undefined,
    });
    const text = await res.text();
    let json; try { json = JSON.parse(text); } catch (e) { json = text; }
    return { status: res.status, body: json };
  }

  try {
    // wait for the server
    const deadline = Date.now() + 10000;
    for (;;) {
      if (server.exitCode != null) throw new Error('server exited early: ' + serverErr);
      try { if ((await fetch(base + '/api/status')).ok) break; } catch (e) {}
      if (Date.now() > deadline) throw new Error('server not ready: ' + serverErr);
      await sleep(50);
    }

    await step('board init: fixed frame, empty board, state under .bridge-command', async () => {
      const b = (await api('GET', '/api/board')).body;
      assert.deepStrictEqual(b.columns.map((c) => c.id), ['backlog', 'working', 'review', 'peer']);
      assert.deepStrictEqual(b.lieutenants, []);
      assert.deepStrictEqual(b.cards, []);
      assert.ok(fs.existsSync(path.join(ws, '.bridge-command', 'board.json')) ||
        fs.existsSync(path.join(ws, '.bridge-command')), 'state dir exists');
      const cfg = JSON.parse(fs.readFileSync(path.join(ws, '.bridge-command', 'config.json'), 'utf8'));
      assert.strictEqual(cfg.port, port);
      // the UI is served
      const html = await (await fetch(base + '/')).text();
      assert.ok(html.includes('id="lane"'), 'index.html has the lieutenant lane');
      assert.ok((await fetch(base + '/ui/js/main.js')).ok, 'ui modules served');
    });

    await step('lieutenant create (API + CLI)', async () => {
      const r = await api('POST', '/api/lieutenants', { name: 'Ada', id: 'ada', color: '#58b6ff', charter: 'own the port' });
      assert.strictEqual(r.status, 200);
      const cli = await runCli(['lieutenant', 'create', '--name', 'Grace'], wsArgs);
      assert.strictEqual(cli.code, 0, cli.stderr);
      const list = (await api('GET', '/api/lieutenants')).body.lieutenants;
      assert.deepStrictEqual(list.map((l) => l.id), ['ada', 'grace']);
      assert.notStrictEqual(list[0].color, list[1].color, 'distinct colors');
    });

    await step('cards of each type; owner is mandatory', async () => {
      for (const [type, title] of [['plan', 'Plan the port'], ['implementation', 'Build the queues'], ['investigation', 'Chase the flake']]) {
        const r = await api('POST', '/api/cards', { title, type, owner: 'ada' });
        assert.strictEqual(r.status, 200, JSON.stringify(r.body));
        assert.strictEqual(r.body.card.type, type);
        assert.strictEqual(r.body.card.column, 'backlog');
      }
      assert.strictEqual((await api('POST', '/api/cards', { title: 'Orphan' })).status, 400);
      assert.strictEqual((await api('POST', '/api/cards', { title: 'Bad', owner: 'ada', type: 'chore' })).status, 400);
    });

    await step('captain message → durable queue item → drained → acked', async () => {
      const r = await api('POST', '/api/feedback', { target: 'lieutenant:ada', text: 'how goes the port?' });
      assert.strictEqual(r.status, 200);
      const seq = r.body.seq;
      // durable on disk before anything else (write-ahead)
      const onDisk = fs.readFileSync(path.join(ws, '.bridge-command', 'queue', 'ada.jsonl'), 'utf8');
      assert.ok(onDisk.includes('how goes the port?'));
      // drained via CLI
      let cli = await runCli(['drain', '--lieutenant', 'ada'], wsArgs);
      assert.strictEqual(cli.code, 0, cli.stderr);
      const items = cli.stdout.trim().split('\n').filter(Boolean).map((l) => JSON.parse(l));
      assert.strictEqual(items.length, 1);
      assert.strictEqual(items[0].kind, 'message');
      assert.strictEqual(items[0].seq, seq);
      // re-offered until acked
      cli = await runCli(['drain', '--lieutenant', 'ada'], wsArgs);
      assert.strictEqual(cli.stdout.trim().split('\n').filter(Boolean).length, 1);
      // ack removes
      cli = await runCli(['ack', String(seq)], wsArgs);
      assert.strictEqual(cli.code, 0, cli.stderr);
      cli = await runCli(['drain', '--lieutenant', 'ada'], wsArgs);
      assert.strictEqual(cli.stdout.trim(), '');
    });

    await step('captain drag backlog→working = start-order queue item, card does not move', async () => {
      const r = await api('POST', '/api/cards/build-the-queues/move', { column: 'working', actor: 'user' });
      assert.strictEqual(r.body.ordered, 'start-order');
      const card = (await api('GET', '/api/cards/build-the-queues')).body;
      assert.strictEqual(card.column, 'backlog');
      assert.strictEqual(card.pendingOrder.kind, 'start-order');
      const feed = (await api('GET', '/api/feed?lieutenant=ada')).body;
      assert.strictEqual(feed.items.length, 1);
      assert.strictEqual(feed.items[0].kind, 'start-order');
      assert.strictEqual(feed.items[0].card, 'build-the-queues');
      await api('POST', '/api/feed/ack', { seq: feed.items[0].seq });
    });

    await step('lieutenant handoff → review; captain drag review→backlog = rework-order', async () => {
      // the lieutenant hands the card to the captain (CLI move, only → review)
      const cli = await runCli(['card', 'move', 'build-the-queues', 'review'], wsArgs);
      assert.strictEqual(cli.code, 0, cli.stderr);
      let card = (await api('GET', '/api/cards/build-the-queues')).body;
      assert.strictEqual(card.column, 'review');
      assert.strictEqual(card.pendingOrder, null, 'applied move cleared the pending order');
      // captain wants rework, with a comment
      const r = await api('POST', '/api/cards/build-the-queues/move', { column: 'backlog', actor: 'user', text: 'needs tests' });
      assert.strictEqual(r.body.ordered, 'rework-order');
      card = (await api('GET', '/api/cards/build-the-queues')).body;
      assert.strictEqual(card.column, 'review'); // still on the captain's desk
      const feed = (await api('GET', '/api/feed?lieutenant=ada')).body;
      assert.strictEqual(feed.items[0].kind, 'rework-order');
      assert.strictEqual(feed.items[0].text, 'needs tests');
      await api('POST', '/api/feed/ack', { seq: feed.items[0].seq });
    });

    await step('archive and restore with frozen state + loud resurrection', async () => {
      await api('POST', '/api/cards/chase-the-flake/archive', { reason: 'killed', note: 'wrong lead', actor: 'user' });
      assert.strictEqual((await api('GET', '/api/cards/chase-the-flake')).status, 404);
      const recs = fs.readFileSync(path.join(ws, '.bridge-command', 'archive.jsonl'), 'utf8')
        .split('\n').filter(Boolean).map((l) => JSON.parse(l));
      assert.strictEqual(recs[0].reason, 'killed');
      assert.strictEqual(recs[0].note, 'wrong lead');
      const r = await api('POST', '/api/cards/chase-the-flake/restore', { actor: 'user' });
      assert.strictEqual(r.status, 200);
      const card = (await api('GET', '/api/cards/chase-the-flake')).body;
      assert.strictEqual(card.type, 'investigation'); // frozen state intact
      const last = card.events[card.events.length - 1];
      assert.strictEqual(last.kind, 'resurrected');
      assert.strictEqual(last.level, 1); // loud
    });

    await step('bell derivation: level-1 events + lieutenant replies, cleared by reading', async () => {
      const before = (await api('GET', '/api/notifications')).body.unread;
      // a lieutenant reply on a card thread rings
      await api('POST', '/api/message', { target: 'card:plan-the-port', text: 'draft is up' });
      // a level-1 handoff rings; a level-2 event does not
      await api('POST', '/api/cards/plan-the-port/events', { text: 'quiet note', level: 2 });
      let n = (await api('GET', '/api/notifications')).body;
      assert.strictEqual(n.unread, before + 1, 'the reply rings; the level-2 event stays silent');
      assert.ok(n.items.some((i) => i.kind === 'reply' && i.text === 'draft is up'));
      assert.ok(!n.items.some((i) => i.text === 'quiet note'));
      // opening the card clears the reply; mark-all clears the rest
      await api('POST', '/api/read', { target: 'card:plan-the-port' });
      await api('POST', '/api/notifications/read', { all: true });
      n = (await api('GET', '/api/notifications')).body;
      assert.strictEqual(n.unread, 0);
    });

    await step('state survives a restart (board is truth)', async () => {
      server.kill('SIGTERM');
      await new Promise((r) => server.once('exit', r));
      const again = spawn(process.execPath, [SERVER_JS, ws, '--port', String(port), '--host', '127.0.0.1'], { stdio: 'ignore' });
      const deadline2 = Date.now() + 10000;
      for (;;) {
        try { if ((await fetch(base + '/api/status')).ok) break; } catch (e) {}
        if (Date.now() > deadline2) throw new Error('restarted server not ready');
        await sleep(50);
      }
      const b = (await api('GET', '/api/board')).body;
      assert.strictEqual(b.lieutenants.length, 2);
      assert.strictEqual(b.cards.length, 3);
      again.kill('SIGTERM');
      await sleep(200);
    });

    console.log('\ne2e: ' + passed + ' steps passed');
  } finally {
    if (server.exitCode == null) server.kill('SIGKILL');
    fs.rmSync(ws, { recursive: true, force: true });
  }
})().catch(() => { process.exitCode = 1; });
