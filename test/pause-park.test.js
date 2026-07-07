'use strict';
// Papercuts #2 + #5 — the deliberate worker-stop lifecycle.
//   worker.pause: kills the worker session but records the stop as DELIBERATE
//     (worker-paused event) so supervision never fires the worker-died alarm;
//     the registry entry + worktree survive for card start --resume.
//   card.park: the narrow lieutenant door out of Working — Backlog, legal ONLY
//     when the recorded worker is absent or dead (liveness re-checked server
//     side); a live worker refuses loudly. worker pause --park composes both.
// Uses the file-backed fake harness + real git worktrees (like workers.test.js)
// and a fast supervision tick where died-vs-paused detection matters.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const { startServer, startServerWithLieutenant, withOwner, runCli, sleep } = require('./helper');
const { workerSession } = require('../server/names.js');

function git(dir, ...args) {
  return execFileSync('git', ['-C', dir, ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
}
function makeRepo(root, name = 'srcrepo') {
  const repo = path.join(root, name);
  fs.mkdirSync(repo, { recursive: true });
  execFileSync('git', ['init', '-q', '-b', 'main', repo], { stdio: ['ignore', 'pipe', 'pipe'] });
  fs.writeFileSync(path.join(repo, 'README.md'), 'hello\n');
  git(repo, 'add', '.');
  git(repo, '-c', 'user.email=t@t', '-c', 'user.name=t', 'commit', '-q', '-m', 'init');
  return repo;
}
async function boot(extraEnv = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'bc-pause-'));
  const repo = makeRepo(root);
  const fdir = path.join(root, 'fake');
  const s = await startServerWithLieutenant({
    env: Object.assign({
      BC_FAKE_STATE: fdir, BC_WORKTREE_TOOL: 'git',
      BC_SUPERVISE_INTERVAL_MS: '0', BC_PRWATCH_INTERVAL_MS: '0',
    }, extraEnv),
  });
  const r = await s.api('POST', '/api/projects', { source: repo, name: 'proj', mode: 'local-only' });
  assert.strictEqual(r.status, 200, JSON.stringify(r.body));
  const teardown = async () => { await s.stop(); fs.rmSync(root, { recursive: true, force: true }); };
  return { s, root, repo, fdir, teardown };
}
function boardOnDisk(s) {
  return JSON.parse(fs.readFileSync(path.join(s.dir, '.bridge-command', 'board.json'), 'utf8'));
}
function seedBoard(dir, board) {
  const sd = path.join(dir, '.bridge-command');
  fs.mkdirSync(sd, { recursive: true });
  fs.writeFileSync(path.join(sd, 'board.json'), JSON.stringify(Object.assign({
    title: 'seeded', seq: 0, lieutenants: [], cards: [], events: [], labels: [], reads: {}, kinds: {},
    projects: [], workers: [],
  }, board), null, 2));
}

test('worker pause: deliberate stop — session killed, worker-paused event, NO worker-died on later ticks, --resume revives', async () => {
  const { s, fdir, teardown } = await boot({ BC_SUPERVISE_INTERVAL_MS: '150' });
  try {
    await s.api('POST', '/api/cards', withOwner({ title: 'Nap', id: 'nap', attributes: { repo: 'proj' } }));
    const started = await s.api('POST', '/api/cards/nap/start', { harness: 'fake' });
    assert.strictEqual(started.status, 200, JSON.stringify(started.body));
    const session = workerSession(s.dir, 'nap');

    const r = await s.api('POST', '/api/cards/nap/worker/pause', { actor: 'agent' });
    assert.strictEqual(r.status, 200, JSON.stringify(r.body));
    assert.strictEqual(r.body.session, session);
    // the session is really gone (file-backed fake: kill removes the marker)
    assert.ok(!fs.existsSync(path.join(fdir, session + '.json')), 'session killed');

    let card = (await s.api('GET', '/api/cards/nap')).body;
    assert.strictEqual(card.column, 'working', 'pause alone does not move the card');
    const ev = card.events.find((e) => e.kind === 'worker-paused');
    assert.ok(ev, 'worker-paused event on the card');
    assert.strictEqual(ev.level, 2);
    assert.match(ev.text, /paused \(deliberate\)/);
    assert.match(ev.text, /--resume/);

    // the resumable record survives, marked paused
    let w = boardOnDisk(s).workers.find((x) => x.card === 'nap');
    assert.ok(w && w.paused, 'registry entry kept and marked paused');
    assert.strictEqual(w.done, false);

    // several supervision ticks over the dead-but-paused session: NO died alarm
    await sleep(700);
    card = (await s.api('GET', '/api/cards/nap')).body;
    assert.ok(!card.events.some((e) => e.kind === 'worker-died'), 'no worker-died event for a deliberate pause');
    const items = (await s.api('GET', '/api/feed?lieutenant=ada')).body.items;
    assert.ok(!items.some((i) => i.kind === 'worker-died'), 'no worker-died queue item for a deliberate pause');

    // pausing an already-paused (dead) worker is refusable only via kill — it
    // stays idempotent-ish here: the record is intact, so --resume revives it
    const rez = await s.api('POST', '/api/cards/nap/start', { resume: true, harness: 'fake' });
    assert.strictEqual(rez.status, 200, JSON.stringify(rez.body));
    assert.strictEqual(rez.body.resumed, true);
    assert.strictEqual((await s.api('GET', '/api/cards/nap')).body.column, 'working');
    w = boardOnDisk(s).workers.find((x) => x.card === 'nap');
    assert.ok(!w.paused, 'resume clears the paused marker — supervision watches again');
  } finally { await teardown(); }
});

test('worker pause refusals: no worker recorded (404), worker already done (409)', async () => {
  const { s, teardown } = await boot();
  try {
    await s.api('POST', '/api/cards', withOwner({ title: 'Bare', id: 'bare', attributes: { repo: 'proj' } }));
    let r = await s.api('POST', '/api/cards/bare/worker/pause', {});
    assert.strictEqual(r.status, 404);
    assert.match(r.body.error, /no worker recorded/);

    await s.api('POST', '/api/cards', withOwner({ title: 'Done', id: 'fin', attributes: { repo: 'proj' } }));
    await s.api('POST', '/api/cards/fin/start', { harness: 'fake' });
    await s.api('POST', '/api/cards/fin/worker/done', { outcome: 'shipped' });
    r = await s.api('POST', '/api/cards/fin/worker/pause', {});
    assert.strictEqual(r.status, 409);
    assert.match(r.body.error, /already reported done/);
  } finally { await teardown(); }
});

test('card park refuses while the worker is ALIVE (server-side liveness, 409) and off-Working cards', async () => {
  const { s, teardown } = await boot();
  try {
    await s.api('POST', '/api/cards', withOwner({ title: 'Busy', id: 'busy', attributes: { repo: 'proj' } }));
    await s.api('POST', '/api/cards/busy/start', { harness: 'fake' });
    let r = await s.api('POST', '/api/cards/busy/park', { actor: 'agent' });
    assert.strictEqual(r.status, 409);
    assert.match(r.body.error, /ALIVE/);
    assert.match(r.body.error, /pause/);
    assert.strictEqual((await s.api('GET', '/api/cards/busy')).body.column, 'working', 'refused park moves nothing');

    // a done worker whose session still lives is neither absent nor dead:
    // park refuses and points at the normal verify-and-handoff path
    await s.api('POST', '/api/cards', withOwner({ title: 'Wrap', id: 'wrap', attributes: { repo: 'proj' } }));
    await s.api('POST', '/api/cards/wrap/start', { harness: 'fake' });
    await s.api('POST', '/api/cards/wrap/worker/done', { outcome: 'shipped' });
    r = await s.api('POST', '/api/cards/wrap/park', { actor: 'agent' });
    assert.strictEqual(r.status, 409);
    assert.match(r.body.error, /reported done/);

    // park is a Working-only door
    await s.api('POST', '/api/cards', withOwner({ title: 'Idle', id: 'idle', attributes: { repo: 'proj' } }));
    r = await s.api('POST', '/api/cards/idle/park', { actor: 'agent' });
    assert.strictEqual(r.status, 409);
    assert.match(r.body.error, /Working/);
  } finally { await teardown(); }
});

test('card park on a DEAD worker: Working → Backlog, parked event, record stays resumable', async () => {
  const { s, teardown } = await boot();
  try {
    await s.api('POST', '/api/cards', withOwner({ title: 'Croak', id: 'croak', attributes: { repo: 'proj' } }));
    await s.api('POST', '/api/cards/croak/start', { harness: 'fake' });
    // kill the session the deliberate way, then park separately — park still
    // re-checks liveness itself and sees a dead session
    await s.api('POST', '/api/cards/croak/worker/pause', { actor: 'agent' });
    const r = await s.api('POST', '/api/cards/croak/park', { actor: 'agent' });
    assert.strictEqual(r.status, 200, JSON.stringify(r.body));
    const card = (await s.api('GET', '/api/cards/croak')).body;
    assert.strictEqual(card.column, 'backlog');
    const ev = card.events.find((e) => e.kind === 'parked');
    assert.ok(ev, 'parked event on the card');
    assert.match(ev.text, /Working|🔨/);
    // the worker record survived the park — resume brings the card back
    const rez = await s.api('POST', '/api/cards/croak/start', { resume: true, harness: 'fake' });
    assert.strictEqual(rez.status, 200, JSON.stringify(rez.body));
    assert.strictEqual((await s.api('GET', '/api/cards/croak')).body.column, 'working');
  } finally { await teardown(); }
});

test('card park with an ABSENT worker (no registry entry) parks too', async () => {
  // a Working card whose worker record was lost — seeded directly (the normal
  // API can never produce it: only card.start enters Working)
  const nowIso = new Date().toISOString();
  const s = await startServer({
    env: { BC_SUPERVISE_INTERVAL_MS: '0', BC_PRWATCH_INTERVAL_MS: '0' },
    seed: (dir) => seedBoard(dir, {
      lieutenants: [{ id: 'ada', name: 'Ada', color: '#58b6ff', charter: '', chat: [], created: nowIso }],
      cards: [{
        id: 'ghosted', title: 'Ghosted', type: 'implementation', owner: 'ada', column: 'working',
        labels: [], attributes: { repo: 'proj' }, body: '',
        created: nowIso, updated: nowIso, threadStart: null, pendingOrder: null, events: [], thread: [],
      }],
    }),
  });
  try {
    const r = await s.api('POST', '/api/cards/ghosted/park', { actor: 'agent' });
    assert.strictEqual(r.status, 200, JSON.stringify(r.body));
    const card = (await s.api('GET', '/api/cards/ghosted')).body;
    assert.strictEqual(card.column, 'backlog');
    assert.ok(card.events.some((e) => e.kind === 'parked' && /absent/.test(e.text)));
  } finally { await s.stop(); }
});

test('worker pause --park composes: one call, session dead + card in Backlog, no died alarm (CLI verbs too)', async () => {
  const { s, fdir, teardown } = await boot({ BC_SUPERVISE_INTERVAL_MS: '150' });
  try {
    await s.api('POST', '/api/cards', withOwner({ title: 'Shelve', id: 'shelve', attributes: { repo: 'proj' } }));
    await s.api('POST', '/api/cards/shelve/start', { harness: 'fake' });
    const cli = await runCli(['worker', 'pause', 'shelve', '--park', '--workspace', s.dir, '--port', String(s.port)]);
    assert.strictEqual(cli.code, 0, cli.stderr);
    assert.match(cli.stdout, /paused worker/);
    assert.match(cli.stdout, /parked shelve -> backlog/);
    const card = (await s.api('GET', '/api/cards/shelve')).body;
    assert.strictEqual(card.column, 'backlog');
    assert.ok(card.events.some((e) => e.kind === 'worker-paused'));
    assert.ok(card.events.some((e) => e.kind === 'parked'));
    assert.ok(!fs.existsSync(path.join(fdir, workerSession(s.dir, 'shelve') + '.json')), 'session killed');

    await sleep(700); // ticks over the paused+parked worker: silence
    const items = (await s.api('GET', '/api/feed?lieutenant=ada')).body.items;
    assert.ok(!items.some((i) => i.kind === 'worker-died'), 'no died alarm after pause --park');

    // and the plain CLI park refuses a live worker loudly
    await s.api('POST', '/api/cards', withOwner({ title: 'Live', id: 'live', attributes: { repo: 'proj' } }));
    await s.api('POST', '/api/cards/live/start', { harness: 'fake' });
    const parkCli = await runCli(['card', 'park', 'live', '--workspace', s.dir, '--port', String(s.port)]);
    assert.strictEqual(parkCli.code, 1);
    assert.match(parkCli.stderr, /ALIVE/);
  } finally { await teardown(); }
});
