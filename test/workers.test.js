'use strict';
// F5 — workers. card.start is ONE atomic op (isolated worktree + real spawn via
// the harness port + bind + system move → Working); worker signal/done wake the
// owning lieutenant through the durable queue; turn-end resolution extends to
// worker refs. Uses the file-backed fake harness (BC_FAKE_STATE) and the git
// worktree tool (BC_WORKTREE_TOOL=git) against a real throwaway git repo.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const { startServerWithLieutenant, withOwner, runCli, LT } = require('./helper');
const { lieutenantSession, workerWindow } = require('../server/names.js');

// A worker's harness key/address: a WINDOW inside the owning lieutenant's
// session (papercut #8) — `session:window`, the form marker files and
// turn-end payloads carry.
function workerKey(dir, cardId) {
  return lieutenantSession(dir, LT) + ':' + workerWindow(cardId);
}

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

// One temp tree per boot: fake-harness state + source repo + workspace.
async function boot(extraEnv = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'bc-workers-'));
  const repo = makeRepo(root);
  const fdir = path.join(root, 'fake');
  const s = await startServerWithLieutenant({
    env: Object.assign({
      BC_FAKE_STATE: fdir, BC_WORKTREE_TOOL: 'git',
      BC_SUPERVISE_INTERVAL_MS: '0', BC_PRWATCH_INTERVAL_MS: '0',
    }, extraEnv),
  });
  const r = await s.api('POST', '/api/projects', { source: repo, name: 'proj' });
  assert.strictEqual(r.status, 200, JSON.stringify(r.body));
  const teardown = async () => { await s.stop(); fs.rmSync(root, { recursive: true, force: true }); };
  return { s, root, repo, fdir, teardown };
}
function boardOnDisk(s) {
  return JSON.parse(fs.readFileSync(path.join(s.dir, '.bridge-commander', 'board.json'), 'utf8'));
}

test('cards cannot be created in Working (Working ⇔ live worker)', async () => {
  const { s, teardown } = await boot();
  try {
    const r = await s.api('POST', '/api/cards', withOwner({ title: 'Sneaky', column: 'working' }));
    assert.strictEqual(r.status, 400);
    assert.match(r.body.error, /card\.start/);
    const cli = await runCli(['card', 'create', '--title', 'Sneaky CLI', '--owner', LT,
      '--column', 'working', '--workspace', s.dir, '--port', String(s.port)]);
    assert.strictEqual(cli.code, 1);
    assert.match(cli.stderr, /Working/);
  } finally { await teardown(); }
});

test('a minted card starts on bc/<id>: branch, window and worktree all follow the id', async () => {
  const { s, teardown } = await boot();
  try {
    // no id pinned — the owner mints it, and everything downstream follows it
    const card = (await s.api('POST', '/api/cards',
      { title: 'Tile click clears selection', owner: LT, brief: 'default', attributes: { repo: 'proj' } })).body.card;
    assert.strictEqual(card.id, 'ADA-1');

    const r = await s.api('POST', '/api/cards/ADA-1/start', { harness: 'fake' });
    assert.strictEqual(r.status, 200, JSON.stringify(r.body));
    // deliberately the id and nothing else — no title slug appended (the captain
    // reads branch names and wants them aligned with the card).
    assert.strictEqual(r.body.worker.branch, 'bc/ADA-1');
    assert.strictEqual(r.body.card.attributes.branch, 'bc/ADA-1');
    assert.strictEqual(r.body.worker.ref.window, 'w-ADA-1');
    assert.strictEqual(path.basename(r.body.worker.worktree.path), 'ADA-1');
  } finally { await teardown(); }
});

test('card.start refusals: plan cards, missing/unregistered repo, already Working', async () => {
  const { s, teardown } = await boot();
  try {
    await s.api('POST', '/api/cards', withOwner({ title: 'A plan', type: 'plan', attributes: { repo: 'proj' } }));
    let r = await s.api('POST', '/api/cards/a-plan/start', { harness: 'fake' });
    assert.strictEqual(r.status, 400);
    assert.match(r.body.error, /plan cards never start/);

    await s.api('POST', '/api/cards', withOwner({ title: 'No repo' }));
    r = await s.api('POST', '/api/cards/no-repo/start', { harness: 'fake' });
    assert.strictEqual(r.status, 400);
    assert.match(r.body.error, /no repo attribute/);

    await s.api('POST', '/api/cards', withOwner({ title: 'Bad repo', attributes: { repo: 'nope' } }));
    r = await s.api('POST', '/api/cards/bad-repo/start', { harness: 'fake' });
    assert.strictEqual(r.status, 400);
    assert.match(r.body.error, /unregistered project: nope/);

    await s.api('POST', '/api/cards', withOwner({ title: 'Task', attributes: { repo: 'proj' } }));
    assert.strictEqual((await s.api('POST', '/api/cards/task/start', { harness: 'fake' })).status, 200);
    r = await s.api('POST', '/api/cards/task/start', { harness: 'fake' });
    assert.strictEqual(r.status, 409);
    assert.match(r.body.error, /already Working/);
  } finally { await teardown(); }
});

test('card.start: worktree + spawn + bind + system move, brief contract, registry persisted', async () => {
  const { s, repo, fdir, teardown } = await boot();
  try {
    await s.api('POST', '/api/cards', withOwner({
      title: 'Fix login', id: 'fix-login', attributes: { repo: 'proj' },
      body: 'The login button 404s; make it work.',
    }));
    // captain context on the thread + a start-order (pendingOrder must clear on start)
    await s.api('POST', '/api/feedback', { target: 'card:fix-login', text: 'prioritize the mobile flow' });
    await s.api('POST', '/api/cards/fix-login/move', { column: 'working', actor: 'user' });
    assert.strictEqual((await s.api('GET', '/api/cards/fix-login')).body.pendingOrder.kind, 'start-order');

    const r = await s.api('POST', '/api/cards/fix-login/start', { harness: 'fake' });
    assert.strictEqual(r.status, 200, JSON.stringify(r.body));
    const w = r.body.worker;
    // the worker is a WINDOW inside the owning lieutenant's session; the
    // window name is w- prefixed so tmux never parses it as an index
    assert.strictEqual(w.ref.session, lieutenantSession(s.dir, LT));
    assert.strictEqual(w.ref.window, 'w-fix-login');
    const sess = workerKey(s.dir, 'fix-login');
    assert.match(sess, /^bc-[A-Za-z0-9-]+-lt-ada:w-fix-login$/);
    assert.ok(w.ref.resumeId, 'resumeId known at birth');
    assert.strictEqual(w.branch, 'bc/fix-login');
    assert.strictEqual(w.project, 'proj');

    // the card moved → Working (system move), pendingOrder cleared, attrs bound
    const card = r.body.card;
    assert.strictEqual(card.column, 'working');
    assert.strictEqual(card.pendingOrder, null);
    assert.strictEqual(card.attributes.session, sess);
    assert.strictEqual(card.attributes.worktree, w.worktree.path);
    assert.strictEqual(card.attributes.branch, 'bc/fix-login');
    const started = card.events[card.events.length - 1];
    assert.strictEqual(started.kind, 'started');
    assert.strictEqual(started.level, 2);
    assert.match(started.text, /📋 Backlog → 🔨 Working/);

    // the worktree is REAL and isolated: distinct from the clone, a genuine
    // worktree root, sharing history but not the clone's git dir
    const wt = w.worktree.path;
    assert.ok(fs.existsSync(wt));
    assert.notStrictEqual(fs.realpathSync(wt), fs.realpathSync(repo));
    assert.strictEqual(fs.realpathSync(git(wt, 'rev-parse', '--show-toplevel')), fs.realpathSync(wt));
    assert.notStrictEqual(git(wt, 'rev-parse', '--absolute-git-dir'), git(repo, 'rev-parse', '--absolute-git-dir'));
    assert.strictEqual(git(wt, 'rev-parse', 'HEAD'), git(repo, 'rev-parse', 'HEAD'));

    // the brief: the card's template (`default`) rendered against the card as
    // it stands — title, body, thread, branch, and the workspace-carrying CLI
    const rec = JSON.parse(fs.readFileSync(path.join(fdir, sess + '.json'), 'utf8'));
    assert.strictEqual(rec.cwd, wt);
    assert.match(rec.prompt, /^# Fix login \(fix-login\)/);
    assert.match(rec.prompt, /Load the `bridge-commander-worker` skill first/);
    assert.match(rec.prompt, /login button 404s/);
    assert.match(rec.prompt, /prioritize the mobile flow/);
    assert.match(rec.prompt, /git checkout -b bc\/fix-login/);
    assert.match(rec.prompt, /ready in branch bc\/fix-login/);
    assert.match(rec.prompt, new RegExp('--workspace ' + s.dir.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
    assert.doesNotMatch(rec.prompt, /\{\{/, 'every placeholder resolved');

    // the brief is auto-attached as a card artifact (label "brief"), pointing
    // at the SAME persisted prompt file the harness port treats as the
    // source of truth — and it is servable through the artifact preview endpoint
    const briefFile = path.join(s.dir, '.bridge-commander', 'harness', sess + '.prompt');
    assert.deepStrictEqual(card.attributes.artifacts, [{ uri: 'file://' + briefFile, label: 'brief', type: 'markdown' }]);
    const art = await s.api('GET', '/api/artifact?uri=' + encodeURIComponent('file://' + briefFile));
    assert.strictEqual(art.status, 200);
    assert.match(art.body.content, /^# Fix login \(fix-login\)/);

    // worker registry survives on disk (board is truth)
    const disk = boardOnDisk(s);
    assert.strictEqual(disk.workers.length, 1);
    assert.strictEqual(disk.workers[0].card, 'fix-login');
    assert.strictEqual(disk.workers[0].ref.session, lieutenantSession(s.dir, LT));
    assert.strictEqual(disk.workers[0].ref.window, 'w-fix-login');
  } finally { await teardown(); }
});

test('worker signal + done: card events, owner queue items, prs auto-populated, card does NOT move', async () => {
  const { s, teardown } = await boot();
  try {
    await s.api('POST', '/api/cards', withOwner({ title: 'Ship it', id: 'ship', attributes: { repo: 'proj' } }));
    await s.api('POST', '/api/cards/ship/start', { harness: 'fake' });
    const wsArgs = ['--workspace', s.dir, '--port', String(s.port)];

    // signal via the CLI verb (positional text)
    let r = await runCli(['worker', 'signal', 'ship', 'branch created, tests green', ...wsArgs]);
    assert.strictEqual(r.code, 0, r.stderr);
    let card = (await s.api('GET', '/api/cards/ship')).body;
    const sig = card.events[card.events.length - 1];
    assert.strictEqual(sig.kind, 'signal');
    assert.strictEqual(sig.level, 2);
    assert.strictEqual(sig.text, 'branch created, tests green');

    // done via the CLI verb; PR URL in the outcome populates prs (state open)
    r = await runCli(['worker', 'done', 'ship', '--outcome',
      'shipped: https://github.com/acme/proj/pull/7 checks green', ...wsArgs]);
    assert.strictEqual(r.code, 0, r.stderr);
    card = (await s.api('GET', '/api/cards/ship')).body;
    assert.strictEqual(card.column, 'working', 'done does NOT move the card — the lieutenant hands off');
    assert.deepStrictEqual(card.attributes.prs, [{ url: 'https://github.com/acme/proj/pull/7', state: 'open' }]);
    const done = card.events[card.events.length - 1];
    assert.strictEqual(done.kind, 'worker-done');
    assert.match(done.text, /shipped:/);

    // both landed as durable queue items for the owner, in order
    const items = (await s.api('GET', '/api/feed?lieutenant=' + LT)).body.items;
    const kinds = items.map((i) => i.kind);
    assert.ok(kinds.includes('worker-signal'), kinds.join(','));
    assert.ok(kinds.includes('worker-done'), kinds.join(','));
    const doneItem = items.find((i) => i.kind === 'worker-done');
    assert.strictEqual(doneItem.card, 'ship');
    assert.match(doneItem.text, /pull\/7/);

    // registry entry marked done (supervision stops watching it)
    const disk = boardOnDisk(s);
    assert.strictEqual(disk.workers[0].done, true);
    assert.match(disk.workers[0].outcome, /checks green/);

    // empty signal text rejected
    assert.strictEqual((await s.api('POST', '/api/cards/ship/worker/signal', { text: '  ' })).status, 400);
  } finally { await teardown(); }
});

test('investigation: brief carries the report contract, no branch; done attaches the report artifact', async () => {
  const { s, fdir, teardown } = await boot();
  try {
    await s.api('POST', '/api/cards', withOwner({
      title: 'Why slow', id: 'why-slow', type: 'investigation', brief: 'investigation',
      attributes: { repo: 'proj' }, body: 'Find out why the dashboard takes 30s.',
    }));
    const r = await s.api('POST', '/api/cards/why-slow/start', { harness: 'fake' });
    assert.strictEqual(r.status, 200, JSON.stringify(r.body));
    assert.strictEqual(r.body.worker.branch, undefined, 'investigations have no branch');
    const card0 = r.body.card;
    assert.strictEqual(card0.attributes.branch, undefined);

    const rec = JSON.parse(fs.readFileSync(path.join(fdir, workerKey(s.dir, 'why-slow') + '.json'), 'utf8'));
    assert.match(rec.prompt, /a report, not a change/);
    assert.match(rec.prompt, /reports\/why-slow\.md/);
    assert.doesNotMatch(rec.prompt, /git checkout -b/);
    assert.doesNotMatch(rec.prompt, /\{\{/);

    // card.start already auto-attached the brief itself, ahead of the report
    const briefFile = path.join(s.dir, '.bridge-commander', 'harness', workerKey(s.dir, 'why-slow') + '.prompt');
    assert.deepStrictEqual(card0.attributes.artifacts, [{ uri: 'file://' + briefFile, label: 'brief', type: 'markdown' }]);

    // the worker writes the report, then reports done → auto-attached artifact
    const report = path.join(s.dir, '.bridge-commander', 'reports', 'why-slow.md');
    fs.mkdirSync(path.dirname(report), { recursive: true });
    fs.writeFileSync(report, '# Findings\nIt was DNS.\n');
    await s.api('POST', '/api/cards/why-slow/worker/done', { outcome: 'report written: it was DNS' });
    const card = (await s.api('GET', '/api/cards/why-slow')).body;
    assert.deepStrictEqual(card.attributes.artifacts, [
      { uri: 'file://' + briefFile, label: 'brief', type: 'markdown' },
      { uri: 'file://' + report, label: 'report' },
    ]);
    // and the artifact is servable through the artifact preview endpoint
    const art = await s.api('GET', '/api/artifact?uri=' + encodeURIComponent('file://' + report));
    assert.strictEqual(art.status, 200);
    assert.match(art.body.content, /It was DNS/);
  } finally { await teardown(); }
});

test('turn-end resolves worker refs (before lieutenant adoption), hook payload is ground truth', async () => {
  const { s, teardown } = await boot();
  try {
    // a resumeId-less lieutenant ref — the adoption candidate a worker POST must NOT land on
    await s.api('PATCH', '/api/lieutenants/' + LT, { ref: { harness: 'fake', session: 'lt-tmux', cwd: '/tmp' } });
    await s.api('POST', '/api/cards', withOwner({ title: 'Turns', id: 'turns', attributes: { repo: 'proj' } }));
    const w = (await s.api('POST', '/api/cards/turns/start', { harness: 'fake' })).body.worker;
    const key = w.ref.session + ':' + w.ref.window; // what the worker's hook posts

    // match by the worker's resumeId
    let r = await s.api('POST', '/api/turn-end', { session: key, session_id: w.ref.resumeId });
    assert.strictEqual(r.body.worker, 'turns');
    assert.strictEqual(r.body.lieutenant, null);

    // match by the session:window key; a CHANGED session_id is adopted as ground truth
    r = await s.api('POST', '/api/turn-end', { session: key, session_id: 'uuid-after-resume' });
    assert.strictEqual(r.body.worker, 'turns');
    const disk = boardOnDisk(s);
    assert.strictEqual(disk.workers[0].ref.resumeId, 'uuid-after-resume');
    assert.strictEqual(disk.workers[0].turns, 2);
    assert.ok(disk.workers[0].lastTurnEnd);
    // the lieutenant was never touched (no mis-adoption)
    assert.strictEqual(disk.lieutenants[0].ref.resumeId, undefined);
  } finally { await teardown(); }
});

test('worker turn-end without done on a Working card wakes the owner (worker-stopped), coalesced per stop-state', async () => {
  const { s, teardown } = await boot();
  try {
    await s.api('POST', '/api/cards', withOwner({ title: 'Wedged', id: 'wedged', attributes: { repo: 'proj' } }));
    const w = (await s.api('POST', '/api/cards/wedged/start', { harness: 'fake' })).body.worker;
    const key = w.ref.session + ':' + w.ref.window;
    const stopItems = async () => (await s.api('GET', '/api/feed?lieutenant=' + LT)).body.items
      .filter((i) => i.kind === 'worker-stopped' && i.card === 'wedged');

    // first stop: QueueItem + level-2 card event; the card does NOT move
    let r = await s.api('POST', '/api/turn-end', { session: key, session_id: w.ref.resumeId });
    assert.strictEqual(r.body.worker, 'wedged');
    assert.strictEqual((await stopItems()).length, 1);
    const card = (await s.api('GET', '/api/cards/wedged')).body;
    assert.strictEqual(card.column, 'working');
    const ev = card.events.find((e) => e.kind === 'worker-stopped');
    assert.ok(ev, 'worker-stopped event on the card');
    assert.strictEqual(ev.level, 2);
    assert.match(ev.text, /stopped without reporting done/);

    // repeat turn-ends in the same stop-state coalesce — no stacking
    await s.api('POST', '/api/turn-end', { session: key, session_id: w.ref.resumeId });
    assert.strictEqual((await stopItems()).length, 1);

    // a signal opens a fresh stop-state: the next stop re-notifies
    await s.api('POST', '/api/cards/wedged/worker/signal', { text: 'steered — back at it' });
    await s.api('POST', '/api/turn-end', { session: key, session_id: w.ref.resumeId });
    assert.strictEqual((await stopItems()).length, 2);

    // the drain hint names the stop and the session:window to peek
    const cli = await runCli(['drain', '--lieutenant', LT, '--workspace', s.dir, '--port', String(s.port)]);
    assert.strictEqual(cli.code, 0, cli.stderr);
    assert.match(cli.stdout, /WORKER STOPPED — card wedged/);
    assert.match(cli.stdout, new RegExp('tmux attach -t ' + key.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));

    // after done, turn-ends only bump counters — never a worker-stopped item
    await s.api('POST', '/api/cards/wedged/worker/done', { outcome: 'finished for real' });
    await s.api('POST', '/api/turn-end', { session: key, session_id: w.ref.resumeId });
    assert.strictEqual((await stopItems()).length, 2);
  } finally { await teardown(); }
});

test('a worktree is cut from origin\'s tip, not from wherever the clone happens to stand', async () => {
  const { s, repo, teardown } = await boot();
  try {
    // the source moves on AFTER the project was registered — the shape of any
    // long-lived clone. Nothing pulls it, so its HEAD is now behind.
    fs.writeFileSync(path.join(repo, 'NEW.md'), 'landed after the clone\n');
    git(repo, 'add', '.');
    git(repo, '-c', 'user.email=t@t', '-c', 'user.name=t', 'commit', '-q', '-m', 'moved on');
    const tip = git(repo, 'rev-parse', 'HEAD');
    const clone = path.join(s.dir, 'projects', 'proj');
    assert.notStrictEqual(git(clone, 'rev-parse', 'HEAD'), tip, 'the clone really is behind');

    await s.api('POST', '/api/cards', withOwner({
      title: 'Late start', id: 'late-start', attributes: { repo: 'proj' },
    }));
    const r = await s.api('POST', '/api/cards/late-start/start', { harness: 'fake' });
    assert.strictEqual(r.status, 200, JSON.stringify(r.body));
    const wt = r.body.worker.worktree.path;
    assert.strictEqual(git(wt, 'rev-parse', 'HEAD'), tip, 'the worker starts from origin\'s tip');
    assert.ok(fs.existsSync(path.join(wt, 'NEW.md')), 'files added since the clone are present');
  } finally { await teardown(); }
});

test('card start --resume reincarnates a dead recorded worker in the same worktree', async () => {
  const { s, teardown } = await boot();
  try {
    await s.api('POST', '/api/cards', withOwner({ title: 'Crashy', id: 'crashy', attributes: { repo: 'proj' } }));
    const first = (await s.api('POST', '/api/cards/crashy/start', { harness: 'fake' })).body.worker;
    const cardBefore = (await s.api('GET', '/api/cards/crashy')).body;
    assert.strictEqual(cardBefore.attributes.artifacts.length, 1, 'brief attached on the fresh spawn');
    const briefUri = cardBefore.attributes.artifacts[0].uri;
    assert.strictEqual(cardBefore.attributes.artifacts[0].label, 'brief');

    // simulate worker-died state: the supervision loop would have flagged it
    // (BC state is on disk; here we drive the resume path directly)
    let r = await s.api('POST', '/api/cards/nope/start', { resume: true });
    assert.strictEqual(r.status, 404);
    r = await s.api('POST', '/api/cards/crashy/start', { resume: true, harness: 'fake' });
    assert.strictEqual(r.status, 200, JSON.stringify(r.body));
    assert.strictEqual(r.body.resumed, true);
    const w = r.body.worker;
    assert.strictEqual(w.ref.session, lieutenantSession(s.dir, LT));
    assert.strictEqual(w.ref.window, workerWindow('crashy'));
    assert.strictEqual(w.worktree.path, first.worktree.path, 'same worktree — context preserved');
    assert.strictEqual(w.done, false);
    const cardAfter = (await s.api('GET', '/api/cards/crashy')).body;
    assert.strictEqual(cardAfter.column, 'working');

    // idempotent: resume re-attaches the SAME brief uri, no duplicate entry
    assert.deepStrictEqual(cardAfter.attributes.artifacts, [{ uri: briefUri, label: 'brief', type: 'markdown' }]);

    // resume with no recorded worker refuses
    await s.api('POST', '/api/cards', withOwner({ title: 'Fresh', id: 'fresh', attributes: { repo: 'proj' } }));
    r = await s.api('POST', '/api/cards/fresh/start', { resume: true });
    assert.strictEqual(r.status, 400);
    assert.match(r.body.error, /nothing to resume/);
  } finally { await teardown(); }
});

test('fresh restart after done: refuses over a live session; releases the dead one\'s worktree and reprovisions', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'bc-workers-'));
  const repo = makeRepo(root);
  const wsDir = path.join(root, 'ws');
  fs.mkdirSync(wsDir);
  const fdir = path.join(root, 'fake');
  const env = {
    BC_FAKE_STATE: fdir, BC_WORKTREE_TOOL: 'git',
    BC_SUPERVISE_INTERVAL_MS: '0', BC_PRWATCH_INTERVAL_MS: '0',
  };
  let s = await startServerWithLieutenant({ dir: wsDir, env });
  try {
    await s.api('POST', '/api/projects', { source: repo, name: 'proj' });
    await s.api('POST', '/api/cards', withOwner({ title: 'Redo', id: 'redo', attributes: { repo: 'proj' } }));
    const first = (await s.api('POST', '/api/cards/redo/start', { harness: 'fake' })).body.worker;
    await s.api('POST', '/api/cards/redo/worker/done', { outcome: 'first pass done' });
    // lieutenant hands off, captain sends it back — the card leaves Working
    await s.api('POST', '/api/cards/redo/move', { column: 'review', actor: 'agent' });

    // the old session is still alive → never spawned over
    let r = await s.api('POST', '/api/cards/redo/start', { harness: 'fake' });
    assert.strictEqual(r.status, 409);
    assert.match(r.body.error, /still alive/);

    // the session dies (server restart clears the in-process fake; drop its
    // cross-process marker too), then a fresh start reprovisions
    await s.stop();
    fs.rmSync(path.join(fdir, workerKey(wsDir, 'redo') + '.json'), { force: true });
    s = await startServerWithLieutenant({ dir: wsDir, env });
    r = await s.api('POST', '/api/cards/redo/start', { harness: 'fake', brief: 'redo it with tests' });
    assert.strictEqual(r.status, 200, JSON.stringify(r.body));
    // released-then-reprovisioned: the clone still has exactly ONE linked
    // worktree (the release really ran — a second add at the same path would
    // have failed otherwise), and it is the new worker's
    const clone = path.join(wsDir, 'projects', 'proj');
    const wtList = git(clone, 'worktree', 'list').split('\n').filter(Boolean);
    assert.strictEqual(wtList.length, 2, 'clone + exactly one linked worktree:\n' + wtList.join('\n'));
    assert.ok(fs.existsSync(r.body.worker.worktree.path), 'new worktree provisioned');
    assert.strictEqual(r.body.worker.worktree.path, first.worktree.path, 'same deterministic path reused');
    assert.match(JSON.parse(fs.readFileSync(path.join(fdir, workerKey(wsDir, 'redo') + '.json'), 'utf8')).prompt, /redo it with tests/);
    const disk = boardOnDisk(s);
    assert.strictEqual(disk.workers.filter((w) => w.card === 'redo').length, 1, 'one registry entry per card');
    assert.strictEqual(disk.workers.find((w) => w.card === 'redo').done, false);
  } finally {
    await s.stop();
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('worker send: delivers into the live worker session + level-2 card event; loud errors when it cannot', async () => {
  const { s, fdir, teardown } = await boot();
  try {
    const wsArgs = ['--workspace', s.dir, '--port', String(s.port)];

    // no worker bound → clear error, API and CLI
    await s.api('POST', '/api/cards', withOwner({ title: 'Steer', id: 'steer', attributes: { repo: 'proj' } }));
    let r = await s.api('POST', '/api/cards/steer/worker/send', { text: 'too early' });
    assert.strictEqual(r.status, 404);
    assert.match(r.body.error, /no worker bound/);
    let cli = await runCli(['worker', 'send', 'steer', 'too early', ...wsArgs]);
    assert.strictEqual(cli.code, 1);
    assert.match(cli.stderr, /no worker bound/);

    // live worker → text typed into its window (the fake logs sends), event recorded
    assert.strictEqual((await s.api('POST', '/api/cards/steer/start', { harness: 'fake' })).status, 200);
    const sess = workerKey(s.dir, 'steer');
    cli = await runCli(['worker', 'send', 'steer', 'also fix the flaky test', ...wsArgs]);
    assert.strictEqual(cli.code, 0, cli.stderr);
    assert.match(cli.stdout, /sent -> worker /);
    const sends = fs.readFileSync(path.join(fdir, sess + '.sends.jsonl'), 'utf8')
      .trim().split('\n').map((l) => JSON.parse(l));
    assert.deepStrictEqual(sends.map((x) => x.text), ['also fix the flaky test']);
    const card = (await s.api('GET', '/api/cards/steer')).body;
    const ev = card.events[card.events.length - 1];
    assert.strictEqual(ev.kind, 'worker-send');
    assert.strictEqual(ev.level, 2);
    assert.match(ev.text, /also fix the flaky test/);

    // empty text rejected
    assert.strictEqual((await s.api('POST', '/api/cards/steer/worker/send', { text: '  ' })).status, 400);
  } finally { await teardown(); }
});

test('worker send reopens a done-but-alive worker: turn re-enters Working, record reset, text delivered', async () => {
  const { s, fdir, teardown } = await boot();
  try {
    await s.api('POST', '/api/cards', withOwner({ title: 'Reopen', id: 'reopen', attributes: { repo: 'proj' } }));
    assert.strictEqual((await s.api('POST', '/api/cards/reopen/start', { harness: 'fake' })).status, 200);
    const sess = workerKey(s.dir, 'reopen');

    // worker finishes; the lieutenant hands off, so the card leaves Working
    await s.api('POST', '/api/cards/reopen/worker/done', { outcome: 'first pass done' });
    await s.api('POST', '/api/cards/reopen/move', { column: 'review', actor: 'agent' });
    assert.strictEqual(boardOnDisk(s).workers[0].done, true);

    // its session is still alive+idle → a send reopens the turn in place (no 409)
    const r = await s.api('POST', '/api/cards/reopen/worker/send', { text: 'one more pass: add tests' });
    assert.strictEqual(r.status, 200, JSON.stringify(r.body));

    // the record is reset exactly like a resume; the card is back in Working
    const disk = boardOnDisk(s);
    assert.strictEqual(disk.workers[0].done, false);
    assert.strictEqual(disk.workers[0].outcome, undefined);
    const card = (await s.api('GET', '/api/cards/reopen')).body;
    assert.strictEqual(card.column, 'working');
    // a level-2 reopen event, then the send event
    const reopened = card.events.find((e) => e.kind === 'started' && /reopened for a new turn/.test(e.text));
    assert.ok(reopened, 'reopen event recorded');
    assert.match(reopened.text, /👀 Your review → 🔨 Working/);
    const sendEv = card.events[card.events.length - 1];
    assert.strictEqual(sendEv.kind, 'worker-send');
    assert.match(sendEv.text, /add tests/);

    // the text really reached the session (the fake logs sends)
    const sends = fs.readFileSync(path.join(fdir, sess + '.sends.jsonl'), 'utf8')
      .trim().split('\n').map((l) => JSON.parse(l));
    assert.deepStrictEqual(sends.map((x) => x.text), ['one more pass: add tests']);
  } finally { await teardown(); }
});

test('worker send on a done-but-DEAD worker still 409s and names the resume recipe', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'bc-workers-'));
  const repo = makeRepo(root);
  const wsDir = path.join(root, 'ws');
  fs.mkdirSync(wsDir);
  const fdir = path.join(root, 'fake');
  const env = {
    BC_FAKE_STATE: fdir, BC_WORKTREE_TOOL: 'git',
    BC_SUPERVISE_INTERVAL_MS: '0', BC_PRWATCH_INTERVAL_MS: '0',
  };
  let s = await startServerWithLieutenant({ dir: wsDir, env });
  try {
    await s.api('POST', '/api/projects', { source: repo, name: 'proj' });
    await s.api('POST', '/api/cards', withOwner({ title: 'Gone', id: 'gone', attributes: { repo: 'proj' } }));
    await s.api('POST', '/api/cards/gone/start', { harness: 'fake' });
    await s.api('POST', '/api/cards/gone/worker/done', { outcome: 'done' });

    // the session dies (restart clears the in-process fake; drop its marker so
    // cross-process alive() flips false) — done stays true on disk
    await s.stop();
    fs.rmSync(path.join(fdir, workerKey(wsDir, 'gone') + '.json'), { force: true });
    s = await startServerWithLieutenant({ dir: wsDir, env });

    const r = await s.api('POST', '/api/cards/gone/worker/send', { text: 'come back' });
    assert.strictEqual(r.status, 409);
    assert.match(r.body.error, /card start gone --resume/);
  } finally {
    await s.stop();
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('card start --resume refuses a brief and points at worker send (API + CLI)', async () => {
  const { s, teardown } = await boot();
  try {
    await s.api('POST', '/api/cards', withOwner({ title: 'Rez', id: 'rez', attributes: { repo: 'proj' } }));
    await s.api('POST', '/api/cards/rez/start', { harness: 'fake' });
    const r = await s.api('POST', '/api/cards/rez/start', { resume: true, brief: 'new instructions' });
    assert.strictEqual(r.status, 400);
    assert.match(r.body.error, /worker send rez/);
    // the CLI refuses loudly before even reaching the server
    const bf = path.join(s.dir, 'brief.md');
    fs.writeFileSync(bf, 'new instructions');
    const cli = await runCli(['card', 'start', 'rez', '--resume', '--brief-file', bf,
      '--workspace', s.dir, '--port', String(s.port)]);
    assert.strictEqual(cli.code, 1);
    assert.match(cli.stderr, /worker send rez/);
  } finally { await teardown(); }
});

// A brief is a flavour of SDLC, and part of that flavour is WHAT RUNS IT: the
// template may open with frontmatter naming harness, model, the attributes it
// cannot work without, and whether a branch is cut. Precedence is explicit CLI
// flag > frontmatter > config default. Observed through a 'recfake' harness
// preloaded into the server process (test/recording-harness.js via NODE_OPTIONS)
// that captures the extraArgs card.start builds — the harness port (harness/)
// itself stays untouched.
function writeTemplate(s, id, text) {
  const dir = path.join(s.dir, '.bridge-commander', 'briefs');
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, id + '.md'), text);
  return id;
}

test('brief frontmatter names the harness and model; an explicit flag still wins', async () => {
  const recFile = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'bc-rec-')), 'extraargs.json');
  const preload = path.join(__dirname, 'recording-harness.js');
  const { s, teardown } = await boot({
    NODE_OPTIONS: '--require ' + preload,
    BC_REC_EXTRAARGS: recFile,
  });
  const readExtra = () => JSON.parse(fs.readFileSync(recFile, 'utf8')).extraArgs;
  const clearExtra = () => { try { fs.unlinkSync(recFile); } catch (e) {} };
  try {
    writeTemplate(s, 'runs-on-recfake', [
      '---', 'harness: recfake', 'model: template-model', '---', '# {{CARD_TITLE}}', '',
    ].join('\n'));

    // (a) no flags: the template decides. recfake is reachable ONLY through the
    // frontmatter here, so its extraArgs file being written proves the harness
    // key fired; the --model proves the model key fired.
    await s.api('POST', '/api/cards', withOwner({
      title: 'FM A', id: 'fm-a', brief: 'runs-on-recfake', attributes: { repo: 'proj' },
    }));
    clearExtra();
    let r = await s.api('POST', '/api/cards/fm-a/start', {});
    assert.strictEqual(r.status, 200, JSON.stringify(r.body));
    assert.deepStrictEqual(readExtra(), ['--model', 'template-model']);

    // (b) explicit --model overrides the template's model
    await s.api('POST', '/api/cards', withOwner({
      title: 'FM B', id: 'fm-b', brief: 'runs-on-recfake', attributes: { repo: 'proj' },
    }));
    clearExtra();
    r = await s.api('POST', '/api/cards/fm-b/start', { model: 'cli-model' });
    assert.strictEqual(r.status, 200, JSON.stringify(r.body));
    assert.deepStrictEqual(readExtra(), ['--model', 'cli-model']);

    // (c) explicit --harness overrides the template's harness: the plain 'fake'
    // never writes the extraArgs file, so its absence is the proof.
    await s.api('POST', '/api/cards', withOwner({
      title: 'FM C', id: 'fm-c', brief: 'runs-on-recfake', attributes: { repo: 'proj' },
    }));
    clearExtra();
    r = await s.api('POST', '/api/cards/fm-c/start', { harness: 'fake' });
    assert.strictEqual(r.status, 200, JSON.stringify(r.body));
    assert.strictEqual(fs.existsSync(recFile), false, 'the flag won: recfake never ran');
  } finally {
    await teardown();
    fs.rmSync(path.dirname(recFile), { recursive: true, force: true });
  }
});

test('a card missing a `requires` attribute is refused before ANYTHING is provisioned', async () => {
  const { s, teardown } = await boot();
  try {
    writeTemplate(s, 'needs-pr', [
      '---', 'requires: [pr_url, repo_slug]', '---', 'review {{ATTR_PR_URL}}', '',
    ].join('\n'));
    await s.api('POST', '/api/cards', withOwner({
      title: 'Review it', id: 'needy', brief: 'needs-pr',
      attributes: { repo: 'proj', pr_url: 'https://github.com/o/r/pull/7' },
    }));
    const r = await s.api('POST', '/api/cards/needy/start', { harness: 'fake' });
    assert.strictEqual(r.status, 400, JSON.stringify(r.body));
    assert.match(r.body.error, /repo_slug/, 'the error names the missing attribute');
    assert.doesNotMatch(r.body.error, /pr_url,/, 'and only the missing one');
    // nothing was provisioned: no worktree, no worker, the card never moved
    assert.strictEqual(fs.existsSync(path.join(s.dir, '.bridge-commander', 'worktrees', 'needy')), false);
    assert.deepStrictEqual(boardOnDisk(s).workers, []);
    assert.strictEqual((await s.api('GET', '/api/cards/needy')).body.column, 'backlog');

    // set it and the same start goes through
    await s.api('PATCH', '/api/cards/needy', { attributes: { repo_slug: 'o/r' } });
    const ok = await s.api('POST', '/api/cards/needy/start', { harness: 'fake' });
    assert.strictEqual(ok.status, 200, JSON.stringify(ok.body));
  } finally { await teardown(); }
});

// A required name is matched the way the brief would READ it, not by exact
// spelling: the template author sees the uppercase placeholder, the card
// carries the lowercase key, and both have to name one attribute.
test('`requires` matches the attribute however it is spelled, and names the card key when it is missing', async () => {
  const { s, teardown } = await boot();
  try {
    writeTemplate(s, 'needs-upper', [
      '---', 'requires: [PR_URL, Repo-Slug]', '---', 'review {{ATTR_PR_URL}}', '',
    ].join('\n'));
    await s.api('POST', '/api/cards', withOwner({
      title: 'Review it', id: 'shouty', brief: 'needs-upper',
      attributes: { repo: 'proj', pr_url: 'https://github.com/o/r/pull/9' },
    }));
    const r = await s.api('POST', '/api/cards/shouty/start', { harness: 'fake' });
    assert.strictEqual(r.status, 400, JSON.stringify(r.body));
    // pr_url answered PR_URL, so only the genuinely missing one is named — and
    // named as the CARD needs it: an --attr Repo-Slug would earn a second
    // attribute resolving to the placeholder repo_slug already owns.
    assert.match(r.body.error, /--attr repo_slug=<value>/);
    assert.doesNotMatch(r.body.error, /PR_URL|Repo-Slug|REPO_SLUG/);

    await s.api('PATCH', '/api/cards/shouty', { attributes: { repo_slug: 'o/r' } });
    const ok = await s.api('POST', '/api/cards/shouty/start', { harness: 'fake' });
    assert.strictEqual(ok.status, 200, JSON.stringify(ok.body));
  } finally { await teardown(); }
});

// `requires` asks whether the card CARRIES the thing, which is a different
// question from whether the thing renders: prs has no text form, and "this
// card must have PRs recorded" is still a legitimate demand from a review
// brief. And prs is the board's to write — so the refusal names it without
// handing out an --attr recipe that would flatten the recorded list.
test('`requires` counts a recorded list as present, an empty one as missing, and offers no recipe for what the board owns', async () => {
  const { s, teardown } = await boot();
  try {
    writeTemplate(s, 'needs-prs', ['---', 'requires: [prs]', '---', 'review the PRs', ''].join('\n'));
    const pr = { url: 'https://github.com/o/r/pull/11', state: 'open' };
    await s.api('POST', '/api/cards', withOwner({
      title: 'Has PRs', id: 'haspr', brief: 'needs-prs', attributes: { repo: 'proj', prs: [pr] },
    }));
    const ok = await s.api('POST', '/api/cards/haspr/start', { harness: 'fake' });
    assert.strictEqual(ok.status, 200, JSON.stringify(ok.body));
    assert.deepStrictEqual(ok.body.card.attributes.prs, [pr], 'the recorded list is untouched');

    // an empty list carries nothing
    await s.api('POST', '/api/cards', withOwner({
      title: 'No PRs', id: 'nopr', brief: 'needs-prs', attributes: { repo: 'proj', prs: [] },
    }));
    const r = await s.api('POST', '/api/cards/nopr/start', { harness: 'fake' });
    assert.strictEqual(r.status, 400, JSON.stringify(r.body));
    // anchored on the attribute: a bare /prs/ would pass on the brief id alone
    assert.match(r.body.error, /requires the attribute prs\./, 'the refusal names the attribute');
    assert.doesNotMatch(r.body.error, /--attr prs=/, 'and never a recipe that would flatten the list');
    assert.match(r.body.error, /recorded by the board itself/);
    assert.deepStrictEqual(boardOnDisk(s).workers.filter((w) => w.card === 'nopr'), []);
  } finally { await teardown(); }
});

test('`branch: false` cuts no branch — the brief owns the delivery contract, not the card type', async () => {
  const { s, teardown } = await boot();
  try {
    writeTemplate(s, 'no-branch', ['---', 'branch: false', '---', 'read only: {{TASK}}', ''].join('\n'));
    // an IMPLEMENTATION card — under the old rule its type alone would cut bc/<id>
    await s.api('POST', '/api/cards', withOwner({
      title: 'Just look', id: 'look', brief: 'no-branch', attributes: { repo: 'proj' },
    }));
    const r = await s.api('POST', '/api/cards/look/start', { harness: 'fake' });
    assert.strictEqual(r.status, 200, JSON.stringify(r.body));
    assert.strictEqual(r.body.worker.branch, undefined);
    assert.strictEqual(r.body.card.attributes.branch, undefined);
    assert.strictEqual(git(r.body.worker.worktree.path, 'rev-parse', '--abbrev-ref', 'HEAD'), 'HEAD',
      'detached HEAD: there is nothing to push');

    // and with no `branch` key the card type still decides, exactly as before
    writeTemplate(s, 'silent', ['# {{CARD_TITLE}}', ''].join('\n'));
    await s.api('POST', '/api/cards', withOwner({
      title: 'Ship it', id: 'shipit', brief: 'silent', attributes: { repo: 'proj' },
    }));
    const r2 = await s.api('POST', '/api/cards/shipit/start', { harness: 'fake' });
    assert.strictEqual(r2.body.worker.branch, 'bc/shipit');
    await s.api('POST', '/api/cards', withOwner({
      title: 'Why slow', id: 'why', type: 'investigation', brief: 'silent', attributes: { repo: 'proj' },
    }));
    const r3 = await s.api('POST', '/api/cards/why/start', { harness: 'fake' });
    assert.strictEqual(r3.body.worker.branch, undefined);
  } finally { await teardown(); }
});

// The branch is a per-START decision now, so it has to be UNSET as readily as
// it is set: everything downstream (lifecycle hooks, the rendered brief) reads
// the attribute, and a leftover from the last run points them at a branch that
// this run never cut.
test('a restart on a `branch: false` template clears the branch the previous run cut', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'bc-workers-'));
  const repo = makeRepo(root);
  const wsDir = path.join(root, 'ws');
  fs.mkdirSync(wsDir);
  const fdir = path.join(root, 'fake');
  const env = {
    BC_FAKE_STATE: fdir, BC_WORKTREE_TOOL: 'git',
    BC_SUPERVISE_INTERVAL_MS: '0', BC_PRWATCH_INTERVAL_MS: '0',
  };
  let s = await startServerWithLieutenant({ dir: wsDir, env });
  try {
    await s.api('POST', '/api/projects', { source: repo, name: 'proj' });
    writeTemplate(s, 'cuts-one', ['# {{CARD_TITLE}}', ''].join('\n'));
    writeTemplate(s, 'cuts-none', ['---', 'branch: false', '---', 'read only', ''].join('\n'));
    await s.api('POST', '/api/cards', withOwner({
      title: 'Two ways', id: 'twoways', brief: 'cuts-one', attributes: { repo: 'proj' },
    }));
    let r = await s.api('POST', '/api/cards/twoways/start', { harness: 'fake' });
    assert.strictEqual(r.status, 200, JSON.stringify(r.body));
    assert.strictEqual(r.body.card.attributes.branch, 'bc/twoways');

    await s.api('POST', '/api/cards/twoways/worker/done', { outcome: 'first pass' });
    await s.api('POST', '/api/cards/twoways/move', { column: 'review', actor: 'agent' });
    // the session dies (restart clears the in-process fake; drop its marker so
    // the next start is a fresh spawn, not a resume)
    await s.stop();
    fs.rmSync(path.join(fdir, workerKey(wsDir, 'twoways') + '.json'), { force: true });
    s = await startServerWithLieutenant({ dir: wsDir, env });

    await s.api('PATCH', '/api/cards/twoways', { brief: 'cuts-none' });
    r = await s.api('POST', '/api/cards/twoways/start', { harness: 'fake' });
    assert.strictEqual(r.status, 200, JSON.stringify(r.body));
    assert.strictEqual(r.body.worker.branch, undefined);
    assert.strictEqual(r.body.card.attributes.branch, undefined, 'not the previous run\'s branch');
    const onDisk = boardOnDisk(s).cards.find((c) => c.id === 'twoways');
    assert.strictEqual(onDisk.attributes.branch, undefined);
  } finally {
    await s.stop();
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('a malformed frontmatter block refuses the start and names the line', async () => {
  const { s, teardown } = await boot();
  try {
    writeTemplate(s, 'broken', ['---', 'harness: codex', 'hrness: claude', '---', 'body', ''].join('\n'));
    await s.api('POST', '/api/cards', withOwner({
      title: 'Bad template', id: 'bad-fm', brief: 'broken', attributes: { repo: 'proj' },
    }));
    const r = await s.api('POST', '/api/cards/bad-fm/start', { harness: 'fake' });
    assert.strictEqual(r.status, 400, JSON.stringify(r.body));
    assert.match(r.body.error, /broken\.md: frontmatter line 3: unknown key "hrness"/);
    assert.deepStrictEqual(boardOnDisk(s).workers, []);
  } finally { await teardown(); }
});

// An unknown harness names the file that asked for it: the person starting the
// card is rarely the person who typed the name, and a workspace holds several
// templates to hunt through.
test('an unknown harness from the frontmatter names the template it came from', async () => {
  const { s, teardown } = await boot();
  try {
    writeTemplate(s, 'typo-harness', ['---', 'harness: codx', '---', 'body', ''].join('\n'));
    await s.api('POST', '/api/cards', withOwner({
      title: 'Typo', id: 'typo-h', brief: 'typo-harness', attributes: { repo: 'proj' },
    }));
    let r = await s.api('POST', '/api/cards/typo-h/start', {});
    assert.strictEqual(r.status, 400, JSON.stringify(r.body));
    assert.match(r.body.error, /codx/);
    assert.match(r.body.error, /from brief template .*typo-harness\.md/);

    // the flag won, so the template did not ask: no template named back
    r = await s.api('POST', '/api/cards/typo-h/start', { harness: 'nosuchharness' });
    assert.strictEqual(r.status, 400, JSON.stringify(r.body));
    assert.doesNotMatch(r.body.error, /brief template/);
    assert.deepStrictEqual(boardOnDisk(s).workers, []);
  } finally { await teardown(); }
});

// card.start --command: the SAME atomic op, except the session runs a command
// line instead of an agent with a brief. The board stays generic — what the
// command does is none of its business — so what is pinned here is only that
// the line reaches spawn untouched and that the two inputs never mix.
test('card.start --command starts the session on the command line, not on a brief', async () => {
  const { s, fdir, teardown } = await boot();
  try {
    await s.api('POST', '/api/cards', withOwner({
      title: 'Run a thing', id: 'runner', attributes: { repo: 'proj' },
      body: 'this body is NOT a brief for a command worker',
    }));
    // harness: 'fake' keeps the test tmux-free; the point under test is what
    // the server hands to spawn, which the fake records verbatim.
    const r = await s.api('POST', '/api/cards/runner/start',
      { harness: 'fake', command: '  node bin/thing.js runner  ' });
    assert.strictEqual(r.status, 200, JSON.stringify(r.body));

    // same binding as any other start: worktree, branch, Working
    const w = r.body.worker;
    assert.strictEqual(w.branch, 'bc/runner');
    assert.strictEqual(r.body.card.column, 'working');
    assert.strictEqual(r.body.card.attributes.worktree, w.worktree.path);

    // and the launch payload is the command line — trimmed, and nothing else
    const rec = JSON.parse(fs.readFileSync(path.join(fdir, workerKey(s.dir, 'runner') + '.json'), 'utf8'));
    assert.strictEqual(rec.prompt, 'node bin/thing.js runner');
    assert.ok(!/Worker brief|Ground rules/.test(rec.prompt), 'no brief was composed');
  } finally {
    await teardown();
  }
});

test('--command refuses to mix with a brief, and --resume re-runs the recorded line', async () => {
  const { s, teardown } = await boot();
  try {
    await s.api('POST', '/api/cards', withOwner({ title: 'Mix', id: 'mix', attributes: { repo: 'proj' } }));
    let r = await s.api('POST', '/api/cards/mix/start',
      { harness: 'fake', command: 'node x.js', brief: 'and also read this' });
    assert.strictEqual(r.status, 400);
    assert.match(r.body.error, /no brief to deliver/);

    r = await s.api('POST', '/api/cards/mix/start', { harness: 'fake', command: 'node x.js' });
    assert.strictEqual(r.status, 200, JSON.stringify(r.body));
    // resume takes no command: it re-runs the one the recorded worker carries
    r = await s.api('POST', '/api/cards/mix/start', { resume: true, command: 'node other.js' });
    assert.strictEqual(r.status, 400);
    assert.match(r.body.error, /re-runs the one the recorded worker was started with/);

    // the CLI refuses the mix before it ever reaches the server
    const cli = await runCli(['card', 'start', 'mix', '--command', 'node x.js',
      '--brief-file', '/nope/brief.md', '--workspace', s.dir, '--port', String(s.port)]);
    assert.notStrictEqual(cli.code, 0);
    assert.match(cli.stderr, /mutually exclusive/);
  } finally {
    await teardown();
  }
});
