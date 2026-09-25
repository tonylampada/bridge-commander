'use strict';
// Board permission approvals — POST /api/permission holds a PermissionRequest
// hook's HTTP request open until the captain decides on the board
// (POST /api/permission/:id/decide), the server cap answers null, or the hook
// hangs up. The held asks ride the board payload as `permissions`, in memory
// only. Also: config.json permissionMode reaches every launch's opts, observed
// through the recording harness (test/recording-harness.js).
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const { startServer, startServerWithLieutenant, withOwner, sleep } = require('./helper');
const { summarize, permissionMode } = require('../server/permissions.js');

const PRELOAD = path.join(__dirname, 'recording-harness.js');
const QUIET = { BC_SUPERVISE_INTERVAL_MS: '0', BC_PRWATCH_INTERVAL_MS: '0' };

async function until(what, fn, ms = 8000) {
  const deadline = Date.now() + ms;
  for (;;) {
    const v = await fn();
    if (v) return v;
    if (Date.now() > deadline) throw new Error('timeout waiting for: ' + what);
    await sleep(50);
  }
}
function seedBoard(dir, board) {
  const sd = path.join(dir, '.bridge-commander');
  fs.mkdirSync(sd, { recursive: true });
  fs.writeFileSync(path.join(sd, 'board.json'), JSON.stringify(Object.assign({
    title: 'seeded', seq: 0, lieutenants: [], cards: [], events: [], labels: [], reads: {}, kinds: {},
    projects: [], workers: [],
  }, board), null, 2));
}
function writeConfig(dir, extra) {
  const f = path.join(dir, '.bridge-commander', 'config.json');
  let c = {};
  try { c = JSON.parse(fs.readFileSync(f, 'utf8')); } catch (e) {}
  fs.mkdirSync(path.dirname(f), { recursive: true });
  fs.writeFileSync(f, JSON.stringify(Object.assign(c, extra), null, 2) + '\n');
}
function launches(logFile) {
  try { return fs.readFileSync(logFile, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l)); }
  catch (e) { return []; }
}

// One lieutenant with a live ref, one Working card and its worker — enough to
// attribute an ask either way without git or tmux.
function seed(workerSpawnedAt) {
  const nowIso = new Date().toISOString();
  return {
    lieutenants: [{ id: 'ada', name: 'Ada', color: '#58b6ff', prefix: 'ADA', cardSeq: 0, chat: [], created: nowIso,
      ref: { harness: 'fake', session: 'bc-lt-ada', window: 'lt', cwd: '/tmp', resumeId: 'lt-uuid' } }],
    cards: [{
      id: 'fix', title: 'Fix login', type: 'implementation', owner: 'ada', column: 'working',
      labels: [], attributes: { repo: 'proj', session: 'bc-lt-ada:w-fix' }, body: '',
      created: nowIso, updated: nowIso, threadStart: null, pendingOrder: null, events: [], thread: [],
    }],
    workers: [{ card: 'fix', ref: { harness: 'fake', session: 'bc-lt-ada', window: 'w-fix', cwd: '/tmp', resumeId: 'w-uuid' },
      worktree: { path: '/tmp/none', tool: 'git' }, branch: 'bc/fix', project: 'proj',
      spawnedAt: workerSpawnedAt || nowIso, done: false }],
  };
}

// ask(s, body) -> { reply: Promise<{status, body}>, abort } — the hook's side:
// a POST that stays pending until the server answers.
function ask(s, body) {
  const ctl = new AbortController();
  const reply = fetch(s.base + '/api/permission', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(Object.assign({ ts: new Date().toISOString() }, body)), signal: ctl.signal,
  }).then(async (r) => ({ status: r.status, body: await r.json() }));
  reply.catch(() => {}); // an aborted ask rejects; the test that aborts does not await it
  return { reply, abort: () => ctl.abort() };
}
const pending = async (s) => (await s.api('GET', '/api/board')).body.permissions;
const waitPending = (s, n) => until(n + ' pending permission(s)', async () => {
  const p = await pending(s);
  return p.length === n ? p : null;
});

test('summary: the risky field per tool, else trimmed JSON; unknown modes read as auto', () => {
  assert.strictEqual(summarize('Bash', { command: 'rm -rf  /tmp/x\n&& ls' }), 'rm -rf /tmp/x && ls');
  assert.strictEqual(summarize('Edit', { file_path: '/a/b.js', old_string: 'x' }), '/a/b.js');
  assert.strictEqual(summarize('WebFetch', { url: 'https://x.dev', prompt: 'p' }), 'https://x.dev');
  assert.strictEqual(summarize('mcp__x__y', { a: 1 }), '{"a":1}');
  assert.strictEqual(summarize('Glob', { pattern: 'x'.repeat(400) }).length, 200);
  assert.strictEqual(permissionMode(undefined), 'auto');
  assert.strictEqual(permissionMode('yolo'), 'auto');
  assert.strictEqual(permissionMode('acceptEdits'), 'acceptEdits');
});

test('an unattributed ask is held, shown on the board and the SSE stream, and allow answers the hook', async () => {
  const s = await startServer({ env: QUIET });
  const sse = new AbortController();
  try {
    assert.strictEqual((await s.api('GET', '/api/config')).body.permissionMode, 'auto');
    const res = await fetch(s.base + '/api/events', { signal: sse.signal });
    const reader = res.body.getReader();
    const a = ask(s, { session: 'stray', session_id: 'nobody', cwd: '/work/some-repo', tool_name: 'Bash',
      tool_input: { command: 'npm publish' }, permission_mode: 'auto' });
    const [p] = await waitPending(s, 1);
    assert.match(p.id, /^perm-/);
    assert.ok(!Number.isNaN(Date.parse(p.ts)));
    assert.deepStrictEqual(
      { tool_name: p.tool_name, tool_input: p.tool_input, summary: p.summary, lieutenant: p.lieutenant,
        card: p.card, worker: p.worker, agentLabel: p.agentLabel },
      { tool_name: 'Bash', tool_input: { command: 'npm publish' }, summary: 'npm publish', lieutenant: null,
        card: null, worker: null, agentLabel: 'some-repo' });
    // The SSE board event carries it too — read until a frame lists it.
    let buf = '';
    const dec = new TextDecoder();
    await until('permission on the SSE board', async () => {
      const { value } = await reader.read();
      buf += dec.decode(value);
      return buf.includes('"id":"' + p.id + '"');
    });

    const d = await s.api('POST', '/api/permission/' + p.id + '/decide', { decision: 'allow' });
    assert.deepStrictEqual(d, { status: 200, body: { ok: true } });
    assert.deepStrictEqual(await a.reply, { status: 200, body: { decision: 'allow' } });
    assert.deepStrictEqual(await pending(s), []);
  } finally {
    sse.abort();
    await s.stop();
  }
});

test('deny carries the message; 404 for an unknown id, 400 for a bad decision (the ask stays)', async () => {
  const s = await startServer({ env: QUIET });
  try {
    const a = ask(s, { session: 'x', tool_name: 'Write', tool_input: { file_path: '/etc/hosts', content: '' } });
    const [p] = await waitPending(s, 1);
    assert.strictEqual(p.summary, '/etc/hosts');
    assert.strictEqual(p.agentLabel, 'unknown agent');
    assert.strictEqual((await s.api('POST', '/api/permission/perm-nope/decide', { decision: 'allow' })).status, 404);
    assert.strictEqual((await s.api('POST', '/api/permission/' + p.id + '/decide', { decision: 'maybe' })).status, 400);
    assert.strictEqual((await pending(s)).length, 1, 'a bad decision decides nothing');
    await s.api('POST', '/api/permission/' + p.id + '/decide', { decision: 'deny', message: '  not on prod  ' });
    assert.deepStrictEqual((await a.reply).body, { decision: 'deny', message: 'not on prod' });
    assert.strictEqual((await s.api('POST', '/api/permission/' + p.id + '/decide', { decision: 'allow' })).status, 404,
      'a decided ask is gone');
  } finally {
    await s.stop();
  }
});

test('the hook hanging up drops the ask; the server cap answers null and drops it', async () => {
  const s = await startServer({ env: Object.assign({ BC_PERMISSION_TIMEOUT_MS: '1500' }, QUIET) });
  try {
    const a = ask(s, { session: 'x', tool_name: 'Bash', tool_input: { command: 'sleep 1' } });
    await waitPending(s, 1);
    a.abort();
    await waitPending(s, 0);

    const b = ask(s, { session: 'x', tool_name: 'Bash', tool_input: { command: 'sleep 2' } });
    await waitPending(s, 1);
    assert.deepStrictEqual(await b.reply, { status: 200, body: { decision: null } });
    assert.deepStrictEqual(await pending(s), []);
  } finally {
    await s.stop();
  }
});

test('attribution: a worker ask names its card, owner and window; the decision lands on the card; a lieutenant ask names her', async () => {
  const s = await startServer({ env: QUIET, seed: (dir) => seedBoard(dir, seed()) });
  try {
    // Worker by state key (session:window), with a session_id the board never saw.
    const w = ask(s, { session: 'bc-lt-ada:w-fix', session_id: 'fresh', tmux_session: 'bc-lt-ada',
      tool_name: 'Bash', tool_input: { command: 'git push --force' } });
    // Lieutenant by resumeId.
    const l = ask(s, { session: 'whatever', session_id: 'lt-uuid', tool_name: 'Read', tool_input: { file_path: '/x' } });
    const [pw, pl] = await waitPending(s, 2);
    assert.deepStrictEqual([pw.lieutenant, pw.card, pw.worker, pw.agentLabel],
      ['ada', 'fix', 'bc-lt-ada:w-fix', 'worker on Fix login']);
    assert.deepStrictEqual([pl.lieutenant, pl.card, pl.worker, pl.agentLabel], ['ada', null, null, 'Ada']);
    const b = (await s.api('GET', '/api/board')).body;
    assert.strictEqual(b.workers[0].ref.resumeId, 'w-uuid', 'an ask never adopts a resumeId');
    // The worker's ask saved the board (its stall clock moved) — without the asks.
    const disk = JSON.parse(fs.readFileSync(path.join(s.dir, '.bridge-commander', 'board.json'), 'utf8'));
    assert.ok(!('permissions' in disk), 'board.json never carries held asks');
    assert.ok(disk.workers[0].lastPermissionAt, 'the ask is activity on the worker record');

    await s.api('POST', '/api/permission/' + pw.id + '/decide', { decision: 'deny', message: 'no force' });
    assert.strictEqual((await w.reply).body.decision, 'deny');
    const card = (await s.api('GET', '/api/cards/fix')).body;
    const ev = card.events.find((e) => e.kind === 'permission');
    assert.ok(ev, 'decision event on the card');
    assert.strictEqual(ev.actor, 'captain');
    assert.strictEqual(ev.text, 'captain denied Bash: git push --force — no force');

    await s.api('POST', '/api/permission/' + pl.id + '/decide', { decision: 'allow' });
    assert.strictEqual((await l.reply).body.decision, 'allow');
  } finally {
    await s.stop();
  }
});

test('a pending ask holds the stall ladder; after the decision it runs again', async () => {
  const fdir = fs.mkdtempSync(path.join(os.tmpdir(), 'bc-fake-'));
  fs.writeFileSync(path.join(fdir, 'bc-lt-ada:w-fix.json'), JSON.stringify({ cwd: '/tmp', resumeId: 'w-uuid' }) + '\n');
  const s = await startServer({
    env: { BC_FAKE_STATE: fdir, BC_SUPERVISE_INTERVAL_MS: '150', BC_PRWATCH_INTERVAL_MS: '0', BC_WORKER_STALE_SECS: '2' },
    seed: (dir) => seedBoard(dir, seed()),
  });
  const stalled = async () => (await s.api('GET', '/api/cards/fix')).body.events.some((e) => e.kind === 'worker-stalled');
  try {
    const a = ask(s, { session: 'bc-lt-ada:w-fix', tool_name: 'Bash', tool_input: { command: 'make' } });
    const [p] = await waitPending(s, 1);
    await sleep(3500); // well past the 2s window
    assert.strictEqual(await stalled(), false, 'waiting on the captain is not hung');
    await s.api('POST', '/api/permission/' + p.id + '/decide', { decision: 'allow' });
    await a.reply;
    await until('worker-stalled after the decision', stalled, 8000);
  } finally {
    await s.stop();
    fs.rmSync(fdir, { recursive: true, force: true });
  }
});

test('config permissionMode rides every launch: lieutenant spawn, worker start, worker resume (default auto)', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'bc-perm-'));
  const logFile = path.join(root, 'launches.jsonl');
  const repo = path.join(root, 'srcrepo');
  fs.mkdirSync(repo);
  const git = (...a) => execFileSync('git', ['-C', repo, ...a], { stdio: ['ignore', 'pipe', 'pipe'] });
  execFileSync('git', ['init', '-q', '-b', 'main', repo], { stdio: ['ignore', 'pipe', 'pipe'] });
  fs.writeFileSync(path.join(repo, 'README.md'), 'hi\n');
  git('add', '.');
  git('-c', 'user.email=t@t', '-c', 'user.name=t', 'commit', '-q', '-m', 'init');
  const s = await startServerWithLieutenant({
    env: Object.assign({ NODE_OPTIONS: '--require ' + PRELOAD, BC_FAKE_STATE: path.join(root, 'fake'),
      BC_REC_LOG: logFile, BC_WORKTREE_TOOL: 'git' }, QUIET),
  });
  try {
    // No key: auto.
    let r = await s.api('POST', '/api/lieutenants', { name: 'Bo', id: 'bo', spawn: true, harness: 'recfake' });
    assert.strictEqual(r.status, 200, JSON.stringify(r.body));
    assert.deepStrictEqual(launches(logFile).map((l) => [l.verb, l.permissionMode]), [['spawn', 'auto']]);

    // Read at launch time, not boot: the next launches follow the file.
    writeConfig(s.dir, { permissionMode: 'acceptEdits' });
    assert.strictEqual((await s.api('GET', '/api/config')).body.permissionMode, 'acceptEdits');
    assert.strictEqual((await s.api('POST', '/api/projects', { source: repo, name: 'proj' })).status, 200);
    r = await s.api('POST', '/api/cards', withOwner({ title: 'Ship it', id: 'ship', attributes: { repo: 'proj' } }));
    assert.strictEqual(r.status, 200, JSON.stringify(r.body));
    r = await s.api('POST', '/api/cards/ship/start', { harness: 'recfake' });
    assert.strictEqual(r.status, 200, JSON.stringify(r.body));
    assert.deepStrictEqual(launches(logFile).slice(1).map((l) => [l.verb, l.permissionMode]), [['spawn', 'acceptEdits']]);

    writeConfig(s.dir, { permissionMode: 'bypass' });
    r = await s.api('POST', '/api/cards/ship/start', { resume: true, harness: 'recfake' });
    assert.strictEqual(r.status, 200, JSON.stringify(r.body));
    assert.strictEqual(r.body.resumed, true);
    assert.deepStrictEqual(launches(logFile).slice(2).map((l) => [l.verb, l.permissionMode]), [['resume', 'bypass']]);

    // A value claude would refuse to start on launches as auto instead.
    writeConfig(s.dir, { permissionMode: 'yolo' });
    assert.strictEqual((await s.api('GET', '/api/config')).body.permissionMode, 'auto');
    r = await s.api('POST', '/api/lieutenants', { name: 'Cy', id: 'cy', spawn: true, harness: 'recfake' });
    assert.strictEqual(r.status, 200, JSON.stringify(r.body));
    assert.deepStrictEqual(launches(logFile).slice(3).map((l) => [l.verb, l.permissionMode]), [['spawn', 'auto']]);
  } finally {
    await s.stop();
    fs.rmSync(root, { recursive: true, force: true });
  }
});
