'use strict';
// Board state bootstrapping + BRIDGE_DIR plumbing.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { startServer, startServerWithColumns, freePort, COLUMNS } = require('./helper');

test('fresh board bootstraps empty, with state rooted at BRIDGE_DIR', async () => {
  const s = await startServer();
  try {
    // boards dir is created under BRIDGE_DIR, not under the home dir
    assert.ok(fs.existsSync(path.join(s.dir, 'boards')), 'boards dir under BRIDGE_DIR');
    // pidfile lands under BRIDGE_DIR and holds the server pid
    const pidFile = path.join(s.dir, 'server-' + s.port + '.pid');
    assert.strictEqual(parseInt(fs.readFileSync(pidFile, 'utf8'), 10), s.child.pid);

    const r = await s.api('GET', '/api/board');
    assert.strictEqual(r.status, 200);
    assert.strictEqual(r.body.title, s.board); // default title = board name
    assert.strictEqual(r.body.seq, 0);
    assert.deepStrictEqual(r.body.columns, []);
    assert.deepStrictEqual(r.body.cards, []);
    assert.deepStrictEqual(r.body.chat, []);
    assert.deepStrictEqual(r.body.events, []);
    assert.deepStrictEqual(r.body.labels, []);
    assert.deepStrictEqual(r.body.reads, {});
  } finally {
    await s.stop();
  }
});

test('mutations persist to <board>.json under BRIDGE_DIR and survive a restart', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bridge-test-'));
  const s1 = await startServerWithColumns({ dir });
  let seqBefore;
  try {
    const c = await s1.api('POST', '/api/cards', { title: 'Persisted card' });
    assert.strictEqual(c.status, 200);
    const boardFile = path.join(dir, 'boards', s1.board + '.json');
    assert.ok(fs.existsSync(boardFile), 'board json written under BRIDGE_DIR');
    const onDisk = JSON.parse(fs.readFileSync(boardFile, 'utf8'));
    assert.strictEqual(onDisk.cards.length, 1);
    seqBefore = (await s1.api('GET', '/api/board')).body.seq;
    assert.ok(seqBefore > 0);
  } finally {
    await s1.stop();
  }

  const s2 = await startServer({ dir });
  try {
    const r = await s2.api('GET', '/api/board');
    assert.deepStrictEqual(r.body.columns, COLUMNS);
    assert.strictEqual(r.body.cards.length, 1);
    assert.strictEqual(r.body.cards[0].id, 'persisted-card');
    assert.strictEqual(r.body.seq, seqBefore); // seq recomputed >= every stored event
  } finally {
    await s2.stop();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('columns replace is idempotent and validated', async () => {
  const s = await startServer();
  try {
    let r = await s.api('PUT', '/api/columns', COLUMNS);
    assert.strictEqual(r.status, 200);
    assert.strictEqual(r.body.columns, COLUMNS.length);
    r = await s.api('PUT', '/api/columns', COLUMNS);
    assert.strictEqual(r.body.unchanged, true);
    r = await s.api('PUT', '/api/columns', [{ id: 1 }]);
    assert.strictEqual(r.status, 400);
  } finally {
    await s.stop();
  }
});

test('two servers with distinct BRIDGE_DIRs do not share state', async () => {
  const a = await startServerWithColumns();
  const b = await startServer();
  try {
    await a.api('POST', '/api/cards', { title: 'Only in A' });
    const rb = await b.api('GET', '/api/board');
    assert.deepStrictEqual(rb.body.cards, []);
  } finally {
    await a.stop();
    await b.stop();
  }
});

test('pidfile makes a second server on the same port+dir exit as a no-op', async () => {
  const s = await startServer();
  try {
    // spawning again with the same BRIDGE_DIR and port exits quietly (live pidfile)
    const { spawn } = require('node:child_process');
    const dup = spawn(process.execPath, [require('./helper').SERVER_JS, '--port', String(s.port), '--board', s.board, '--host', '127.0.0.1'], {
      env: Object.assign({}, process.env, { BRIDGE_DIR: s.dir }),
      stdio: 'ignore',
    });
    const code = await new Promise((resolve) => dup.on('close', resolve));
    assert.strictEqual(code, 0);
    const st = await s.api('GET', '/api/status');
    assert.strictEqual(st.body.pid, s.child.pid); // original still owns the port
  } finally {
    await s.stop();
  }
});
