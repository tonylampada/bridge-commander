'use strict';
// Workspace bootstrapping: state under <workspace>/.bridge-commander, fixed column
// frame, config.json port, pidfile, isolation between workspaces.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { startServer, startServerWithLieutenant, withOwner, COLUMNS } = require('./helper');

test('fresh board bootstraps empty with the fixed column frame, state under .bridge-commander', async () => {
  const s = await startServer();
  try {
    const stateDir = path.join(s.dir, '.bridge-commander');
    assert.ok(fs.existsSync(stateDir), '.bridge-commander under the workspace');
    assert.ok(fs.existsSync(path.join(stateDir, 'queue')), 'queue dir created');
    // pidfile lands under .bridge-commander and holds the server pid
    const pidFile = path.join(stateDir, 'server.pid');
    assert.strictEqual(parseInt(fs.readFileSync(pidFile, 'utf8'), 10), s.child.pid);
    // config.json records the resolved port
    const cfg = JSON.parse(fs.readFileSync(path.join(stateDir, 'config.json'), 'utf8'));
    assert.strictEqual(cfg.port, s.port);

    const r = await s.api('GET', '/api/board');
    assert.strictEqual(r.status, 200);
    assert.strictEqual(r.body.title, path.basename(s.dir)); // default title = workspace name
    assert.strictEqual(r.body.seq, 0);
    assert.deepStrictEqual(r.body.columns, COLUMNS); // the fixed frame, no setup call
    assert.deepStrictEqual(r.body.lieutenants, []);
    assert.deepStrictEqual(r.body.cards, []);
    assert.deepStrictEqual(r.body.events, []);
    assert.deepStrictEqual(r.body.labels, []);
    assert.deepStrictEqual(r.body.reads, {});
  } finally {
    await s.stop();
  }
});

test('the column frame is fixed: no columns endpoint, board files cannot change it', async () => {
  const s = await startServer({
    seed: (dir) => {
      const stateDir = path.join(dir, '.bridge-commander');
      fs.mkdirSync(stateDir, { recursive: true });
      // a hand-edited board file with a foreign frame is normalized back
      fs.writeFileSync(path.join(stateDir, 'board.json'), JSON.stringify({
        columns: [{ id: 'todo', title: 'To do' }],
        cards: [],
      }));
    },
  });
  try {
    const r = await s.api('GET', '/api/board');
    assert.deepStrictEqual(r.body.columns, COLUMNS);
    const put = await s.api('PUT', '/api/columns', COLUMNS);
    assert.strictEqual(put.status, 404); // the endpoint is gone — the frame is not board data
  } finally {
    await s.stop();
  }
});

test('mutations persist to board.json and survive a restart', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bc-test-'));
  const s1 = await startServerWithLieutenant({ dir });
  let seqBefore;
  try {
    const c = await s1.api('POST', '/api/cards', withOwner({ title: 'Persisted card' }));
    assert.strictEqual(c.status, 200);
    const boardFile = path.join(dir, '.bridge-commander', 'board.json');
    assert.ok(fs.existsSync(boardFile), 'board.json written under .bridge-commander');
    const onDisk = JSON.parse(fs.readFileSync(boardFile, 'utf8'));
    assert.strictEqual(onDisk.cards.length, 1);
    assert.strictEqual(onDisk.lieutenants.length, 1);
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
    assert.strictEqual(r.body.cards[0].owner, 'ada');
    assert.strictEqual(r.body.lieutenants[0].id, 'ada');
    assert.strictEqual(r.body.seq, seqBefore); // seq recomputed >= every stored event
  } finally {
    await s2.stop();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('two servers with distinct workspaces do not share state', async () => {
  const a = await startServerWithLieutenant();
  const b = await startServer();
  try {
    await a.api('POST', '/api/cards', withOwner({ title: 'Only in A' }));
    const rb = await b.api('GET', '/api/board');
    assert.deepStrictEqual(rb.body.cards, []);
    assert.deepStrictEqual(rb.body.lieutenants, []);
  } finally {
    await a.stop();
    await b.stop();
  }
});

test('pidfile makes a second server on the same workspace exit as a no-op', async () => {
  const s = await startServer();
  try {
    const { spawn } = require('node:child_process');
    const dup = spawn(process.execPath, [require('./helper').SERVER_JS, s.dir, '--port', String(s.port), '--host', '127.0.0.1'], {
      stdio: 'ignore',
    });
    const code = await new Promise((resolve) => dup.on('close', resolve));
    assert.strictEqual(code, 0);
    const st = await s.api('GET', '/api/status');
    assert.strictEqual(st.body.pid, s.child.pid); // original still owns the workspace
  } finally {
    await s.stop();
  }
});

test('GET /api/status reports workspace, lieutenants, and queue state', async () => {
  const s = await startServerWithLieutenant();
  try {
    await s.api('POST', '/api/feedback', { target: 'lieutenant:ada', text: 'anyone home?' });
    const st = (await s.api('GET', '/api/status')).body;
    assert.ok(path.isAbsolute(st.workspace), 'workspace is an absolute path');
    assert.strictEqual(st.port, s.port);
    assert.strictEqual(st.lieutenants, 1);
    assert.strictEqual(st.queue_pending, 1);
  } finally {
    await s.stop();
  }
});
