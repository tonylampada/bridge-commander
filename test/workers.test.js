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
const { startServerWithLieutenant, withOwner, runCli, sleep, LT } = require('./helper');
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
      { title: 'Tile click clears selection', owner: LT, playbook: 'default', attributes: { repo: 'proj' } })).body.card;
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

    // the brief: the card's playbook (`default`) rendered against the card as
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

test('investigation: the playbook carries the report contract, no branch; done attaches the report artifact', async () => {
  const { s, fdir, teardown } = await boot();
  try {
    await s.api('POST', '/api/cards', withOwner({
      title: 'Why slow', id: 'why-slow', type: 'investigation', playbook: 'investigation',
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

test('worker turn-end without done on a Working card wakes the owner (worker-stopped), once per stop', async () => {
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

    // every further stop is a stop of its own (CMD-26: re-sent, stopped again
    // in silence, and the owner never heard) — the second turn-end posts again
    await s.api('POST', '/api/turn-end', { session: key, session_id: w.ref.resumeId });
    assert.strictEqual((await stopItems()).length, 2);
    assert.strictEqual(
      (await s.api('GET', '/api/cards/wedged')).body.events.filter((e) => e.kind === 'worker-stopped').length, 2);

    // a signal in between changes nothing about that: the next stop notifies
    await s.api('POST', '/api/cards/wedged/worker/signal', { text: 'steered — back at it' });
    await s.api('POST', '/api/turn-end', { session: key, session_id: w.ref.resumeId });
    assert.strictEqual((await stopItems()).length, 3);

    // the drain hint names the stop and the session:window to peek
    const cli = await runCli(['drain', '--lieutenant', LT, '--workspace', s.dir, '--port', String(s.port)]);
    assert.strictEqual(cli.code, 0, cli.stderr);
    assert.match(cli.stdout, /WORKER STOPPED — card wedged/);
    assert.match(cli.stdout, new RegExp('tmux attach -t ' + key.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));

    // after done, turn-ends only bump counters — never a worker-stopped item
    await s.api('POST', '/api/cards/wedged/worker/done', { outcome: 'finished for real' });
    await s.api('POST', '/api/turn-end', { session: key, session_id: w.ref.resumeId });
    assert.strictEqual((await stopItems()).length, 3);
  } finally { await teardown(); }
});

test('a worker that stops, is re-sent, and stops again with no signal in between rings twice (hook → event → drain)', async () => {
  const { s, teardown } = await boot();
  try {
    await s.api('POST', '/api/cards', withOwner({ title: 'Twice', id: 'twice', attributes: { repo: 'proj' } }));
    const w = (await s.api('POST', '/api/cards/twice/start', { harness: 'fake' })).body.worker;
    const key = w.ref.session + ':' + w.ref.window;
    const stopItems = async () => (await s.api('GET', '/api/feed?lieutenant=' + LT)).body.items
      .filter((i) => i.kind === 'worker-stopped' && i.card === 'twice');

    // stop #1: the Stop hook POSTs, the owner gets one item
    await s.api('POST', '/api/turn-end', { session: key, session_id: w.ref.resumeId });
    assert.strictEqual((await stopItems()).length, 1);
    // the lieutenant re-sends; the worker ends its turn again saying nothing
    const sent = await s.api('POST', '/api/cards/twice/worker/send', { text: 'finish the gate' });
    assert.strictEqual(sent.status, 200, JSON.stringify(sent.body));
    await s.api('POST', '/api/turn-end', { session: key, session_id: w.ref.resumeId });
    assert.strictEqual((await stopItems()).length, 2, 'the second stop is a second item');
    const evs = (await s.api('GET', '/api/cards/twice')).body.events.filter((e) => e.kind === 'worker-stopped');
    assert.strictEqual(evs.length, 2, 'two worker-stopped events on the card');
    // the drain carries both stops
    const cli = await runCli(['drain', '--lieutenant', LT, '--workspace', s.dir, '--port', String(s.port)]);
    assert.strictEqual(cli.code, 0, cli.stderr);
    assert.strictEqual((cli.stdout.match(/WORKER STOPPED — card twice/g) || []).length, 2);
  } finally { await teardown(); }
});

async function untilItems(s, cardId, kind, n, ms = 15000) {
  const deadline = Date.now() + ms;
  for (;;) {
    const items = (await s.api('GET', '/api/feed?lieutenant=' + LT)).body.items
      .filter((i) => i.kind === kind && i.card === cardId);
    if (items.length >= n) return items;
    if (Date.now() > deadline) throw new Error('timeout waiting for ' + n + ' ' + kind + ' items (have ' + items.length + ')');
    await sleep(50);
  }
}

test('a live worker silent for 2× BC_WORKER_STALE_SECS stalls twice: level 2, then level 1 naming its last word; a signal resets the ladder; a turn-end clears staleNotified', async () => {
  const { s, teardown } = await boot({ BC_SUPERVISE_INTERVAL_MS: '100', BC_WORKER_STALE_SECS: '1' });
  try {
    await s.api('POST', '/api/cards', withOwner({ title: 'Mute', id: 'mute', attributes: { repo: 'proj' } }));
    const w = (await s.api('POST', '/api/cards/mute/start', { harness: 'fake' })).body.worker;
    const key = w.ref.session + ':' + w.ref.window;
    const stalls = async () => (await s.api('GET', '/api/cards/mute')).body.events.filter((e) => e.kind === 'worker-stalled');
    // the worker says one thing, then goes quiet inside a turn (LEN-25's AskUserQuestion)
    await s.api('POST', '/api/cards/mute/worker/signal', { text: 'need a ruling: keep the old flag?' });

    await untilItems(s, 'mute', 'worker-stalled', 1);
    let evs = await stalls();
    assert.strictEqual(evs.length, 1);
    assert.strictEqual(evs[0].level, 2, 'the first stall is the owner\'s');
    await untilItems(s, 'mute', 'worker-stalled', 2);
    evs = await stalls();
    assert.strictEqual(evs.length, 2);
    assert.strictEqual(evs[1].level, 1, 'the second consecutive stall rings the captain');
    assert.match(evs[1].text, /silent for \d+min/);
    assert.match(evs[1].text, /still silent, alert #2/);
    assert.match(evs[1].text, /last said: "need a ruling: keep the old flag\?"/);
    // the drain carries both
    const cli = await runCli(['drain', '--lieutenant', LT, '--workspace', s.dir, '--port', String(s.port)]);
    assert.strictEqual(cli.code, 0, cli.stderr);
    assert.ok(cli.stdout.includes('alive but silent'), cli.stdout);

    // a signal between ticks resets the escalation: the next stall is level 2 again
    await s.api('POST', '/api/cards/mute/worker/signal', { text: 'back — reading the answer' });
    let b = boardOnDisk(s).workers.find((x) => x.card === 'mute');
    assert.ok(!b.staleNotified && !b.staleNotifiedAt && !b.staleHits, 'signal cleared the stale-state');
    await untilItems(s, 'mute', 'worker-stalled', 3);
    evs = await stalls();
    assert.strictEqual(evs[2].level, 2, 'escalation restarted from quiet');

    // the turn-end hook clears staleNotified too, and its last words feed the next alert
    await s.api('POST', '/api/turn-end', { session: key, session_id: w.ref.resumeId, text: 'done with the gate, waiting' });
    b = boardOnDisk(s).workers.find((x) => x.card === 'mute');
    assert.ok(!b.staleNotified && !b.staleNotifiedAt, 'turn-end cleared staleNotified');
    assert.strictEqual(b.lastTurnEndText, 'done with the gate, waiting');

    // a signal newer than the turn-end is the last word the level-1 alert quotes
    await sleep(5);
    await s.api('POST', '/api/cards/mute/worker/signal', { text: 'need a ruling: keep flag X?' });
    await untilItems(s, 'mute', 'worker-stalled', 5);
    evs = await stalls();
    assert.strictEqual(evs[4].level, 1);
    assert.match(evs[4].text, /last said: "need a ruling: keep flag X\?"/);
    assert.doesNotMatch(evs[4].text, /done with the gate/);
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

// The fetch was real and landed in the clone the board registered; the
// checkout read a DIFFERENT clone's `origin/<branch>`. treehouse keeps one pool
// per repository per machine, so which clone backs it is decided by whoever
// asked for it first — often a checkout in another workspace entirely. When the
// two agreed the start looked fine, which is why this was intermittent.
//
// The fake pool below is exactly that shape: worktrees cut from a SECOND clone
// that is behind and never fetches.
function writeFakeTreehouse(root, poolClone) {
  const bin = path.join(root, 'fakebin');
  fs.mkdirSync(bin, { recursive: true });
  const pool = path.join(root, 'pool');
  fs.mkdirSync(pool, { recursive: true });
  const sh = [
    '#!/bin/sh',
    'set -e',
    'POOL=' + JSON.stringify(pool),
    'CLONE=' + JSON.stringify(poolClone),
    'case "$1" in',
    '  --version) echo "fake-treehouse 0.0.0" ;;',
    '  get)',
    '    slot="$POOL/1"',
    '    if [ ! -d "$slot" ]; then',
    // the pool leaves a worktree on ITS clone's stale tip — never the board's
    '      git -C "$CLONE" worktree add -q -d "$slot" origin/main >&2',
    '    fi',
    '    echo "$slot" ;;',
    '  return) : ;;',
    '  *) exit 1 ;;',
    'esac',
    '',
  ].join('\n');
  fs.writeFileSync(path.join(bin, 'treehouse'), sh, { mode: 0o755 });
  return bin;
}

test('a pooled worktree lands on the tip the board fetched, not on the pool clone\'s stale one', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'bc-pool-'));
  try {
    const repo = makeRepo(root);
    // the pool's clone is taken NOW and never fetches again — a June checkout
    // in somebody else's workspace, which is what backs the real pool here
    const poolClone = path.join(root, 'poolclone');
    execFileSync('git', ['clone', '-q', repo, poolClone], { stdio: ['ignore', 'pipe', 'pipe'] });
    const stale = git(poolClone, 'rev-parse', 'origin/main');

    const bin = writeFakeTreehouse(root, poolClone);
    const s = await startServerWithLieutenant({
      env: {
        BC_FAKE_STATE: path.join(root, 'fake'), BC_WORKTREE_TOOL: 'treehouse',
        PATH: bin + path.delimiter + process.env.PATH,
        BC_SUPERVISE_INTERVAL_MS: '0', BC_PRWATCH_INTERVAL_MS: '0',
      },
    });
    try {
      assert.strictEqual((await s.api('POST', '/api/projects', { source: repo, name: 'proj' })).status, 200);
      // origin moves on after both clones exist — the pool clone never learns
      fs.writeFileSync(path.join(repo, 'NEW.md'), 'pushed between starts\n');
      git(repo, 'add', '.');
      git(repo, '-c', 'user.email=t@t', '-c', 'user.name=t', 'commit', '-q', '-m', 'moved on');
      const tip = git(repo, 'rev-parse', 'HEAD');
      assert.notStrictEqual(tip, stale, 'the pool clone really is behind');

      await s.api('POST', '/api/cards', withOwner({
        title: 'Pooled', id: 'pooled', attributes: { repo: 'proj' },
      }));
      const r = await s.api('POST', '/api/cards/pooled/start', { harness: 'fake' });
      assert.strictEqual(r.status, 200, JSON.stringify(r.body));
      const w = r.body.worker;
      assert.strictEqual(w.worktree.tool, 'treehouse');
      // the pooled worktree hangs off the OTHER clone — the bug's precondition
      assert.match(git(w.worktree.path, 'rev-parse', '--git-common-dir'), rx(fs.realpathSync(poolClone)));
      assert.strictEqual(git(w.worktree.path, 'rev-parse', 'HEAD'), tip,
        'the worker stands on the sha the board fetched, not the pool clone\'s origin/main');
      assert.strictEqual(w.worktree.baseSha, tip);
      assert.ok(fs.existsSync(path.join(w.worktree.path, 'NEW.md')));
      // nothing to say: the base was refreshed
      assert.deepStrictEqual((await cardEvents(s, 'pooled')).filter((e) => e.kind === 'stale-base'), []);
      // The carried tip is held by a REAL ref in the lease's own ref store, not
      // by FETCH_HEAD alone: releaseWorktree reads `--branches --tags --remotes`
      // to decide whether HEAD carries work nothing else holds, and a worker
      // that committed nothing must never look like one that did.
      assert.strictEqual(
        git(w.worktree.path, 'rev-list', '--max-count=1', 'HEAD', '--not', '--branches', '--tags', '--remotes'),
        '', 'the base is reachable from a ref, so the release is not refused');
      // and that ref is named for the CARD: refs/remotes/* is shared by every
      // worktree of the pool clone, so a per-branch name is one ref that two
      // boards on the same repo race to force-update under each other.
      assert.strictEqual(git(w.worktree.path, 'rev-parse', 'refs/remotes/bc-base/pooled'), tip);
      assert.throws(() => git(w.worktree.path, 'rev-parse', '--verify', 'refs/remotes/bc-base/main'),
        'the destination is scoped to the card, never to the branch');
      const { releaseWorktree } = require('../server/worktrees.js');
      const realPath = process.env.PATH;
      process.env.PATH = bin + path.delimiter + realPath; // the fake pool, as the server sees it
      let rel;
      try { rel = await releaseWorktree(w.worktree, path.join(s.dir, 'projects', 'proj')); }
      finally { process.env.PATH = realPath; }
      assert.strictEqual(rel.released, true, JSON.stringify(rel));
    } finally { await s.stop(); }
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test('a second start after a push to origin gets the new commit — the actual sha, plain git', async () => {
  const { s, repo, teardown } = await boot();
  try {
    const commit = (msg, file) => {
      fs.writeFileSync(path.join(repo, file), msg + '\n');
      git(repo, 'add', '.');
      git(repo, '-c', 'user.email=t@t', '-c', 'user.name=t', 'commit', '-q', '-m', msg);
      return git(repo, 'rev-parse', 'HEAD');
    };
    const first = commit('before', 'ONE.md');
    await s.api('POST', '/api/cards', withOwner({ title: 'One', id: 'one', attributes: { repo: 'proj' } }));
    const r1 = await s.api('POST', '/api/cards/one/start', { harness: 'fake' });
    assert.strictEqual(git(r1.body.worker.worktree.path, 'rev-parse', 'HEAD'), first);

    const second = commit('after', 'TWO.md');
    await s.api('POST', '/api/cards', withOwner({ title: 'Two', id: 'two', attributes: { repo: 'proj' } }));
    const r2 = await s.api('POST', '/api/cards/two/start', { harness: 'fake' });
    assert.strictEqual(git(r2.body.worker.worktree.path, 'rev-parse', 'HEAD'), second,
      'the second worker starts on the commit pushed between the two starts');
    assert.strictEqual(r2.body.worker.worktree.baseSha, second);
  } finally { await teardown(); }
});

test('a fetch that fails says so on the card, at level 1 — not on a stderr nobody reads', async () => {
  const { s, teardown } = await boot();
  try {
    const clone = path.join(s.dir, 'projects', 'proj');
    git(clone, 'remote', 'set-url', 'origin', path.join(s.dir, 'gone-forever.git'));
    await s.api('POST', '/api/cards', withOwner({ title: 'Stale', id: 'stale', attributes: { repo: 'proj' } }));
    const r = await s.api('POST', '/api/cards/stale/start', { harness: 'fake' });
    assert.strictEqual(r.status, 200, 'a failed fetch never blocks the board');
    const ev = (await cardEvents(s, 'stale')).find((e) => e.kind === 'stale-base');
    assert.ok(ev, 'the timeline carries the stale base');
    assert.strictEqual(ev.level, 1);
    assert.match(ev.text, /fetch failed/);
    assert.match(ev.text, rx(clone));
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
    // keep_worktree: the checkout outlives the handoff, so the RESTART is what
    // releases it — the subject of this test
    writePlaybook(s, 'kept', ['---', 'keep_worktree: true', '---', '{{TASK}}', ''].join('\n'));
    await s.api('POST', '/api/cards', withOwner({
      title: 'Redo', id: 'redo', playbook: 'kept', attributes: { repo: 'proj' },
    }));
    const first = (await s.api('POST', '/api/cards/redo/start', { harness: 'fake' })).body.worker;
    await s.api('POST', '/api/cards/redo/worker/done', { outcome: 'first pass done' });
    // lieutenant hands off, captain sends it back — the card leaves Working
    await s.api('POST', '/api/cards/redo/move', { column: 'review', actor: 'agent' });

    // the old session is still alive and its worktree is right there → never
    // spawned over (the one exception is a done worker whose worktree was
    // already released — it has nothing left to steer)
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
    // reworked in place: the playbook keeps the worktree, so there is still a
    // checkout for the reopened turn to write in
    writePlaybook(s, 'kept', ['---', 'keep_worktree: true', '---', '{{TASK}}', ''].join('\n'));
    await s.api('POST', '/api/cards', withOwner({
      title: 'Reopen', id: 'reopen', playbook: 'kept', attributes: { repo: 'proj' },
    }));
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

// A playbook is a repeatable procedure, and part of the procedure is WHAT RUNS
// IT: the playbook may open with frontmatter naming harness, model, the
// attributes it cannot work without, and whether a branch is cut. Precedence is
// explicit CLI flag > frontmatter > config default. Observed through a 'recfake'
// harness preloaded into the server process (test/recording-harness.js via
// NODE_OPTIONS) that captures the extraArgs card.start builds — the harness port
// (harness/) itself stays untouched.
function writePlaybook(s, id, text) {
  const dir = path.join(s.dir, '.bridge-commander', 'playbooks');
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, id + '.md'), text);
  return id;
}

test('playbook frontmatter names the harness and model; an explicit flag still wins', async () => {
  const recFile = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'bc-rec-')), 'extraargs.json');
  const preload = path.join(__dirname, 'recording-harness.js');
  const { s, teardown } = await boot({
    NODE_OPTIONS: '--require ' + preload,
    BC_REC_EXTRAARGS: recFile,
  });
  const readExtra = () => JSON.parse(fs.readFileSync(recFile, 'utf8')).extraArgs;
  const clearExtra = () => { try { fs.unlinkSync(recFile); } catch (e) {} };
  try {
    writePlaybook(s, 'runs-on-recfake', [
      '---', 'harness: recfake', 'model: template-model', '---', '# {{CARD_TITLE}}', '',
    ].join('\n'));

    // (a) no flags: the template decides. recfake is reachable ONLY through the
    // frontmatter here, so its extraArgs file being written proves the harness
    // key fired; the --model proves the model key fired.
    await s.api('POST', '/api/cards', withOwner({
      title: 'FM A', id: 'fm-a', playbook: 'runs-on-recfake', attributes: { repo: 'proj' },
    }));
    clearExtra();
    let r = await s.api('POST', '/api/cards/fm-a/start', {});
    assert.strictEqual(r.status, 200, JSON.stringify(r.body));
    assert.deepStrictEqual(readExtra(), ['--model', 'template-model']);

    // (b) explicit --model overrides the template's model
    await s.api('POST', '/api/cards', withOwner({
      title: 'FM B', id: 'fm-b', playbook: 'runs-on-recfake', attributes: { repo: 'proj' },
    }));
    clearExtra();
    r = await s.api('POST', '/api/cards/fm-b/start', { model: 'cli-model' });
    assert.strictEqual(r.status, 200, JSON.stringify(r.body));
    assert.deepStrictEqual(readExtra(), ['--model', 'cli-model']);

    // (c) explicit --harness overrides the template's harness: the plain 'fake'
    // never writes the extraArgs file, so its absence is the proof.
    await s.api('POST', '/api/cards', withOwner({
      title: 'FM C', id: 'fm-c', playbook: 'runs-on-recfake', attributes: { repo: 'proj' },
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
    writePlaybook(s, 'needs-pr', [
      '---', 'requires: [pr_url, repo_slug]', '---', 'review {{ATTR_PR_URL}}', '',
    ].join('\n'));
    await s.api('POST', '/api/cards', withOwner({
      title: 'Review it', id: 'needy', playbook: 'needs-pr',
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
    writePlaybook(s, 'needs-upper', [
      '---', 'requires: [PR_URL, Repo-Slug]', '---', 'review {{ATTR_PR_URL}}', '',
    ].join('\n'));
    await s.api('POST', '/api/cards', withOwner({
      title: 'Review it', id: 'shouty', playbook: 'needs-upper',
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
// playbook. And prs is the board's to write — so the refusal names it without
// handing out an --attr recipe that would flatten the recorded list.
test('`requires` counts a recorded list as present, an empty one as missing, and offers no recipe for what the board owns', async () => {
  const { s, teardown } = await boot();
  try {
    writePlaybook(s, 'needs-prs', ['---', 'requires: [prs]', '---', 'review the PRs', ''].join('\n'));
    const pr = { url: 'https://github.com/o/r/pull/11', state: 'open' };
    await s.api('POST', '/api/cards', withOwner({
      title: 'Has PRs', id: 'haspr', playbook: 'needs-prs', attributes: { repo: 'proj', prs: [pr] },
    }));
    const ok = await s.api('POST', '/api/cards/haspr/start', { harness: 'fake' });
    assert.strictEqual(ok.status, 200, JSON.stringify(ok.body));
    assert.deepStrictEqual(ok.body.card.attributes.prs, [pr], 'the recorded list is untouched');

    // an empty list carries nothing
    await s.api('POST', '/api/cards', withOwner({
      title: 'No PRs', id: 'nopr', playbook: 'needs-prs', attributes: { repo: 'proj', prs: [] },
    }));
    const r = await s.api('POST', '/api/cards/nopr/start', { harness: 'fake' });
    assert.strictEqual(r.status, 400, JSON.stringify(r.body));
    // anchored on the attribute: a bare /prs/ would pass on the playbook id alone
    assert.match(r.body.error, /requires the attribute prs\./, 'the refusal names the attribute');
    assert.doesNotMatch(r.body.error, /--attr prs=/, 'and never a recipe that would flatten the list');
    assert.match(r.body.error, /recorded by the board itself/);
    assert.deepStrictEqual(boardOnDisk(s).workers.filter((w) => w.card === 'nopr'), []);
  } finally { await teardown(); }
});

test('`branch: false` cuts no branch — the playbook owns the delivery contract, not the card type', async () => {
  const { s, teardown } = await boot();
  try {
    writePlaybook(s, 'no-branch', ['---', 'branch: false', '---', 'read only: {{TASK}}', ''].join('\n'));
    // an IMPLEMENTATION card — under the old rule its type alone would cut bc/<id>
    await s.api('POST', '/api/cards', withOwner({
      title: 'Just look', id: 'look', playbook: 'no-branch', attributes: { repo: 'proj' },
    }));
    const r = await s.api('POST', '/api/cards/look/start', { harness: 'fake' });
    assert.strictEqual(r.status, 200, JSON.stringify(r.body));
    assert.strictEqual(r.body.worker.branch, undefined);
    assert.strictEqual(r.body.card.attributes.branch, undefined);
    assert.strictEqual(git(r.body.worker.worktree.path, 'rev-parse', '--abbrev-ref', 'HEAD'), 'HEAD',
      'detached HEAD: there is nothing to push');

    // and with no `branch` key the card type still decides, exactly as before
    writePlaybook(s, 'silent', ['# {{CARD_TITLE}}', ''].join('\n'));
    await s.api('POST', '/api/cards', withOwner({
      title: 'Ship it', id: 'shipit', playbook: 'silent', attributes: { repo: 'proj' },
    }));
    const r2 = await s.api('POST', '/api/cards/shipit/start', { harness: 'fake' });
    assert.strictEqual(r2.body.worker.branch, 'bc/shipit');
    await s.api('POST', '/api/cards', withOwner({
      title: 'Why slow', id: 'why', type: 'investigation', playbook: 'silent', attributes: { repo: 'proj' },
    }));
    const r3 = await s.api('POST', '/api/cards/why/start', { harness: 'fake' });
    assert.strictEqual(r3.body.worker.branch, undefined);
  } finally { await teardown(); }
});

// The branch is a per-START decision now, so it has to be UNSET as readily as
// it is set: everything downstream (lifecycle hooks, the rendered brief) reads
// the attribute, and a leftover from the last run points them at a branch that
// this run never cut.
test('a restart on a `branch: false` playbook clears the branch the previous run cut', async () => {
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
    writePlaybook(s, 'cuts-one', ['# {{CARD_TITLE}}', ''].join('\n'));
    writePlaybook(s, 'cuts-none', ['---', 'branch: false', '---', 'read only', ''].join('\n'));
    await s.api('POST', '/api/cards', withOwner({
      title: 'Two ways', id: 'twoways', playbook: 'cuts-one', attributes: { repo: 'proj' },
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

    await s.api('PATCH', '/api/cards/twoways', { playbook: 'cuts-none' });
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

// A worktree outlived the work: card.start provisions one and nothing gave it
// back until somebody archived the card, so finished cards sat on their
// checkouts. It goes when the card LEAVES WORKING — the handoff, once the
// lieutenant has read the diff in it — with archive as the backstop, and
// `keep_worktree: true` as the exception for a card reworked in place.
async function until(what, fn, ms = 6000) {
  const deadline = Date.now() + ms;
  for (;;) {
    const v = await fn();
    if (v) return v;
    if (Date.now() > deadline) throw new Error('timeout waiting for: ' + what);
    await sleep(50);
  }
}
const cardEvents = async (s, id) => ((await s.api('GET', '/api/cards/' + id)).body.events || []);
const rx = (p) => new RegExp(p.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'));

test('the handoff releases the worktree — `worker done` leaves it for the lieutenant to read', async () => {
  const { s, teardown } = await boot();
  try {
    await s.api('POST', '/api/cards', withOwner({
      title: 'Ship it', id: 'goes', attributes: { repo: 'proj' },
    }));
    const w = (await s.api('POST', '/api/cards/goes/start', { harness: 'fake' })).body.worker;
    await s.api('POST', '/api/cards/goes/worker/done', { outcome: 'shipped' });
    await sleep(400);
    assert.ok(fs.existsSync(w.worktree.path),
      'done starts the lieutenant\'s half: verifying the work means reading the diff in there');

    // the handoff out of Working is the end of the work — the move answers as
    // soon as the card has left, and the release follows on the timeline
    assert.strictEqual((await s.api('POST', '/api/cards/goes/move', { column: 'review', actor: 'agent' })).status, 200);
    await until('worktree released after the handoff', async () => !fs.existsSync(w.worktree.path));
    const ev = await until('the timeline says the worktree went',
      async () => (await cardEvents(s, 'goes')).find((e) => /worktree released/.test(e.text)));
    assert.match(ev.text, rx(w.worktree.path));
    await until('the attribute stops pointing at a directory that is gone',
      async () => (await s.api('GET', '/api/cards/goes')).body.attributes.worktree === undefined);
    // the clone knows too: a stale registration would block the next add
    assert.strictEqual(git(path.join(s.dir, 'projects', 'proj'), 'worktree', 'list').split('\n').filter(Boolean).length, 1);
  } finally { await teardown(); }
});

// ...and it does NOT wait for it. The release queues behind the per-clone lock,
// which a concurrent `card start` holds across `git fetch` + `git worktree add`
// — seconds, minutes on a big repo. The move used to sit inside that wait with
// the card still visibly in Working, which reads as a frozen board.
test('a concurrent start holding the clone lock does not hold up the move', async () => {
  const { s, teardown } = await boot();
  try {
    const proj = path.join(s.dir, 'projects', 'proj');
    await s.api('POST', '/api/cards', withOwner({
      title: 'Handed off', id: 'handoff', attributes: { repo: 'proj' },
    }));
    const w = (await s.api('POST', '/api/cards/handoff/start', { harness: 'fake' })).body.worker;
    await s.api('POST', '/api/cards/handoff/worker/done', { outcome: 'shipped' });

    // a fetch that takes its time, so the lock is provably still held when the
    // move arrives (the fetch fails after it; freshBase falls back to origin/HEAD)
    git(proj, 'config', 'protocol.ext.allow', 'always');
    git(proj, 'remote', 'set-url', 'origin', 'ext::sleep 4');
    await s.api('POST', '/api/cards', withOwner({
      title: 'Next one', id: 'slowstart', attributes: { repo: 'proj' },
    }));
    const starting = s.api('POST', '/api/cards/slowstart/start', { harness: 'fake' });
    await sleep(300); // the start is inside the fetch by now, holding the lock

    const t0 = Date.now();
    const mv = await s.api('POST', '/api/cards/handoff/move', { column: 'review', actor: 'agent' });
    const took = Date.now() - t0;
    assert.strictEqual(mv.status, 200, JSON.stringify(mv.body));
    assert.ok(took < 1500, 'the move answered in ' + took + 'ms — it queued behind the lock');
    assert.strictEqual((await s.api('GET', '/api/cards/handoff')).body.column, 'review');

    assert.strictEqual((await starting).status, 200);
    await until('the release lands once the lock frees', async () => !fs.existsSync(w.worktree.path));
  } finally { await teardown(); }
});

test('`keep_worktree: true` survives the handoff; archiving releases it anyway', async () => {
  const { s, teardown } = await boot();
  try {
    writePlaybook(s, 'reworked', ['---', 'keep_worktree: true', '---', 'rework me', ''].join('\n'));
    await s.api('POST', '/api/cards', withOwner({
      title: 'Rework in place', id: 'stays', playbook: 'reworked', attributes: { repo: 'proj' },
    }));
    const k = (await s.api('POST', '/api/cards/stays/start', { harness: 'fake' })).body.worker;
    assert.strictEqual(k.keepWorktree, true);
    await s.api('POST', '/api/cards/stays/worker/done', { outcome: 'first pass' });
    await s.api('POST', '/api/cards/stays/move', { column: 'review', actor: 'agent' });
    assert.ok(fs.existsSync(k.worktree.path), 'kept: this card is expected to be reworked in place');
    assert.strictEqual((await s.api('GET', '/api/cards/stays')).body.attributes.worktree, k.worktree.path);

    // archive is the backstop, and it never keeps: nothing is left to rework
    assert.strictEqual((await s.api('POST', '/api/cards/stays/archive', { reason: 'killed' })).status, 200);
    await until('worktree released at archive', async () => !fs.existsSync(k.worktree.path));
  } finally { await teardown(); }
});

test('a worker that never reported done keeps its worktree AND its session through the move', async () => {
  const { s, fdir, teardown } = await boot();
  try {
    await s.api('POST', '/api/cards', withOwner({
      title: 'Moved out from under it', id: 'live', attributes: { repo: 'proj' },
    }));
    const w = (await s.api('POST', '/api/cards/live/start', { harness: 'fake' })).body.worker;
    await s.api('POST', '/api/cards/live/move', { column: 'review', actor: 'agent' });
    await sleep(400);
    assert.ok(fs.existsSync(w.worktree.path),
      'a card moved out from under a live or crashed worker: that checkout is still the only copy');
    assert.ok(fs.existsSync(path.join(fdir, workerKey(s.dir, 'live') + '.json')),
      'and so is the conversation in it');
    assert.ok(((await s.api('GET', '/api/board')).body.workers || []).some((x) => x.card === 'live'));
  } finally { await teardown(); }
});

test('a dirty worktree survives the handoff, and the timeline says why', async () => {
  const { s, teardown } = await boot();
  try {
    await s.api('POST', '/api/cards', withOwner({
      title: 'Left work behind', id: 'dirty', attributes: { repo: 'proj' },
    }));
    const w = (await s.api('POST', '/api/cards/dirty/start', { harness: 'fake' })).body.worker;
    fs.writeFileSync(path.join(w.worktree.path, 'unsaved.txt'), 'not committed\n');
    await s.api('POST', '/api/cards/dirty/worker/done', { outcome: 'done, sort of' });

    await s.api('POST', '/api/cards/dirty/move', { column: 'review', actor: 'agent' });
    const ev = await until('the refusal is on the timeline',
      async () => (await cardEvents(s, 'dirty')).find((e) => /worktree kept/.test(e.text)));
    assert.match(ev.text, /uncommitted changes/); // the reason
    assert.match(ev.text, rx(w.worktree.path)); // the path
    assert.strictEqual(ev.level, 2, 'a refused release is not an alarm');
    assert.ok(fs.existsSync(path.join(w.worktree.path, 'unsaved.txt')), 'nothing was discarded');
    assert.strictEqual((await s.api('GET', '/api/cards/dirty')).body.attributes.worktree, w.worktree.path);
  } finally { await teardown(); }
});

// A worktree is created DETACHED and the branch is cut inside it, so a run that
// commits without cutting one is referenced by this HEAD and nothing else —
// removing it would drop the commits. Same rule as the dirty check, same reason.
test('commits on a HEAD no ref holds keep the worktree, exactly like uncommitted changes', async () => {
  const { s, teardown } = await boot();
  try {
    writePlaybook(s, 'no-branch', ['---', 'branch: false', '---', 'read only', ''].join('\n'));
    await s.api('POST', '/api/cards', withOwner({
      title: 'Committed on detached HEAD', id: 'dangling', playbook: 'no-branch', attributes: { repo: 'proj' },
    }));
    const w = (await s.api('POST', '/api/cards/dangling/start', { harness: 'fake' })).body.worker;
    assert.strictEqual(git(w.worktree.path, 'rev-parse', '--abbrev-ref', 'HEAD'), 'HEAD', 'detached');
    fs.writeFileSync(path.join(w.worktree.path, 'notes.md'), 'findings\n');
    git(w.worktree.path, 'add', '.');
    git(w.worktree.path, '-c', 'user.email=t@t', '-c', 'user.name=t', 'commit', '-q', '-m', 'work');
    const sha = git(w.worktree.path, 'rev-parse', 'HEAD');
    await s.api('POST', '/api/cards/dangling/worker/done', { outcome: 'committed, no branch' });

    await s.api('POST', '/api/cards/dangling/move', { column: 'review', actor: 'agent' });
    const ev = await until('the refusal is on the timeline',
      async () => (await cardEvents(s, 'dangling')).find((e) => /worktree kept/.test(e.text)));
    assert.match(ev.text, /no branch or tag holds/);
    assert.match(ev.text, rx(sha.slice(0, 8)));
    assert.strictEqual(git(w.worktree.path, 'rev-parse', 'HEAD'), sha, 'the commit is still reachable');
  } finally { await teardown(); }
});

test('archiving a card whose worktree is already gone is a no-op, not an error', async () => {
  const { s, teardown } = await boot();
  try {
    await s.api('POST', '/api/cards', withOwner({
      title: 'Twice released', id: 'twice', attributes: { repo: 'proj' },
    }));
    const w = (await s.api('POST', '/api/cards/twice/start', { harness: 'fake' })).body.worker;
    await s.api('POST', '/api/cards/twice/worker/done', { outcome: 'shipped' });
    await s.api('POST', '/api/cards/twice/move', { column: 'review', actor: 'agent' });
    await until('released at the handoff', async () => !(await s.api('GET', '/api/cards/twice')).body.attributes.worktree);
    assert.ok(!fs.existsSync(w.worktree.path));

    const r = await s.api('POST', '/api/cards/twice/archive', { reason: 'killed' });
    assert.strictEqual(r.status, 200, JSON.stringify(r.body));
    await sleep(400);
    const evs = (await s.api('GET', '/api/board')).body.events.filter((e) => e.card === 'twice');
    assert.deepStrictEqual(evs.filter((e) => /worktree/.test(e.text)), [], 'nothing happened, nothing said');
  } finally { await teardown(); }
});

// MNC-114 — the handoff is the worker's DEATH. Your review is the standing-room
// column and the captain is the bottleneck, so every card waiting there used to
// pin one idle agent process for the whole wait, answering nothing: rework after
// a handoff is a fresh start by the DNA's own rule.
test('the handoff kills the worker: no window, no record, and the card keeps the run\'s address', async () => {
  const { s, fdir, teardown } = await boot();
  try {
    await s.api('POST', '/api/cards', withOwner({
      title: 'Handed off for good', id: 'dies', attributes: { repo: 'proj' },
    }));
    const w = (await s.api('POST', '/api/cards/dies/start', { harness: 'fake' })).body.worker;
    const marker = path.join(fdir, workerKey(s.dir, 'dies') + '.json');
    assert.ok(fs.existsSync(marker), 'the window is up while the card is Working');
    const resumeId = JSON.parse(fs.readFileSync(marker, 'utf8')).resumeId;
    assert.ok(resumeId);

    await s.api('POST', '/api/cards/dies/worker/done', { outcome: 'shipped' });
    await sleep(300);
    assert.ok(fs.existsSync(marker), 'done alone never kills it — the lieutenant still has questions');

    assert.strictEqual((await s.api('POST', '/api/cards/dies/move', { column: 'review', actor: 'agent' })).status, 200);
    await until('the worker window is gone', async () => !fs.existsSync(marker));
    await until('and so is its registry record',
      async () => ((await s.api('GET', '/api/board')).body.workers || []).every((x) => x.card !== 'dies'));
    const ev = await until('the timeline says the worker was closed',
      async () => (await cardEvents(s, 'dies')).find((e) => /worker .* closed/.test(e.text)));
    assert.strictEqual(ev.level, 2, 'an expected death is not an alarm');

    // what outlives the record: the card's own address for the run, so the
    // transcript stays readable long after the window is gone
    const card = (await s.api('GET', '/api/cards/dies')).body;
    assert.strictEqual(card.attributes.session, workerKey(s.dir, 'dies'));
    assert.strictEqual(card.attributes.resumeId, resumeId);

    // and it rides the archive snapshot, which is where forensics look
    assert.strictEqual((await s.api('POST', '/api/cards/dies/archive', { reason: 'merged' })).status, 200);
    const arch = (await s.api('GET', '/api/archive')).body.archive.find((r) => r.card.id === 'dies');
    assert.strictEqual(arch.card.attributes.resumeId, resumeId);
    assert.ok(!fs.existsSync(w.worktree.path));
  } finally { await teardown(); }
});

// Archiving straight out of Working takes the other order: archiveCard freezes
// the card into the snapshot synchronously, while the kill and the drop are
// detached and land when there is no card left to stamp. The address has to be
// on the card BEFORE the freeze, or the transcript is unfindable afterwards.
test('a card archived straight out of Working still carries the run\'s address into the snapshot', async () => {
  const { s, fdir, teardown } = await boot();
  try {
    await s.api('POST', '/api/cards', withOwner({
      title: 'Killed mid-flight', id: 'midair', attributes: { repo: 'proj' },
    }));
    const w = (await s.api('POST', '/api/cards/midair/start', { harness: 'fake' })).body.worker;
    const marker = path.join(fdir, workerKey(s.dir, 'midair') + '.json');
    const resumeId = JSON.parse(fs.readFileSync(marker, 'utf8')).resumeId;
    assert.ok(resumeId);

    assert.strictEqual((await s.api('POST', '/api/cards/midair/archive', { reason: 'killed' })).status, 200);
    const arch = (await s.api('GET', '/api/archive')).body.archive.find((r) => r.card.id === 'midair');
    assert.strictEqual(arch.card.attributes.session, workerKey(s.dir, 'midair'));
    assert.strictEqual(arch.card.attributes.resumeId, resumeId);

    // and the archive is still the backstop for everything the handoff would
    // have done: the window goes, its record with it, and the ground after
    await until('the window is gone', async () => !fs.existsSync(marker));
    await until('and its registry record',
      async () => ((await s.api('GET', '/api/board')).body.workers || []).every((x) => x.card !== 'midair'));
    await until('and the worktree released', async () => !fs.existsSync(w.worktree.path));
  } finally { await teardown(); }
});

// Both ways back into a finished worker name the same way out — a fresh worker —
// instead of failing somewhere deep inside the harness on a session that is gone.
test('after the handoff, resume and worker send both refuse and point at a fresh start', async () => {
  const { s, teardown } = await boot();
  try {
    await s.api('POST', '/api/cards', withOwner({
      title: 'No way back', id: 'noback', attributes: { repo: 'proj' },
    }));
    const w = (await s.api('POST', '/api/cards/noback/start', { harness: 'fake' })).body.worker;
    await s.api('POST', '/api/cards/noback/worker/done', { outcome: 'shipped' });
    await s.api('POST', '/api/cards/noback/move', { column: 'review', actor: 'agent' });
    await until('the record is gone',
      async () => ((await s.api('GET', '/api/board')).body.workers || []).every((x) => x.card !== 'noback'));
    // the record goes with the window; the worktree follows behind the clone lock
    await until('and the worktree with it', async () => !fs.existsSync(w.worktree.path));

    const send = await s.api('POST', '/api/cards/noback/worker/send', { text: 'one more thing' });
    assert.strictEqual(send.status, 404, JSON.stringify(send.body));
    assert.match(send.body.error, /no worker bound to card noback/);
    assert.match(send.body.error, /card start noback/);

    const res = await s.api('POST', '/api/cards/noback/start', { resume: true });
    assert.match(res.body.error, /nothing to resume/);
    assert.match(res.body.error, /card start noback/);

    // and the way out both refusals name really is one
    const fresh = await s.api('POST', '/api/cards/noback/start', { harness: 'fake' });
    assert.strictEqual(fresh.status, 200, JSON.stringify(fresh.body));
    assert.ok(fs.existsSync(fresh.body.worker.worktree.path), 'a new worktree, at the same deterministic path');
    assert.strictEqual((await s.api('GET', '/api/cards/noback')).body.column, 'working');
  } finally { await teardown(); }
});

// The exceptions are the worktree release's, and for the same reason: a card
// reworked in place needs the conversation as much as the checkout.
test('`keep_worktree: true` keeps the worker alive through the handoff, worktree and all', async () => {
  const { s, fdir, teardown } = await boot();
  try {
    writePlaybook(s, 'reworked', ['---', 'keep_worktree: true', '---', 'rework me', ''].join('\n'));
    await s.api('POST', '/api/cards', withOwner({
      title: 'Rework in place', id: 'kept', playbook: 'reworked', attributes: { repo: 'proj' },
    }));
    const k = (await s.api('POST', '/api/cards/kept/start', { harness: 'fake' })).body.worker;
    await s.api('POST', '/api/cards/kept/worker/done', { outcome: 'first pass' });
    await s.api('POST', '/api/cards/kept/move', { column: 'review', actor: 'agent' });
    await sleep(400);
    const marker = path.join(fdir, workerKey(s.dir, 'kept') + '.json');
    assert.ok(fs.existsSync(marker), 'the session is half of what keep_worktree keeps');
    assert.ok(fs.existsSync(k.worktree.path));
    assert.ok(((await s.api('GET', '/api/board')).body.workers || []).some((x) => x.card === 'kept'));

    // and a send still reopens it in place — the whole point of the exception
    const send = await s.api('POST', '/api/cards/kept/worker/send', { text: 'one more pass' });
    assert.strictEqual(send.status, 200, JSON.stringify(send.body));
    assert.strictEqual((await s.api('GET', '/api/cards/kept')).body.column, 'working');
  } finally { await teardown(); }
});

// The record is the only handle anyone has on a live agent process, so it is
// dropped ONLY by a path that watched the pane go. A kill that cannot be
// verified keeps the record and rings the captain — a session nothing points at
// is worse than the idle one this whole change exists to end.
test('a worker the board cannot kill keeps its record, loudly', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'bc-workers-'));
  const repo = makeRepo(root);
  const wsDir = path.join(root, 'ws');
  fs.mkdirSync(wsDir);
  const env = {
    BC_FAKE_STATE: path.join(root, 'fake'), BC_WORKTREE_TOOL: 'git',
    BC_SUPERVISE_INTERVAL_MS: '0', BC_PRWATCH_INTERVAL_MS: '0',
  };
  let s = await startServerWithLieutenant({ dir: wsDir, env });
  try {
    await s.api('POST', '/api/projects', { source: repo, name: 'proj' });
    await s.api('POST', '/api/cards', withOwner({
      title: 'Undead', id: 'undead', attributes: { repo: 'proj' },
    }));
    await s.api('POST', '/api/cards/undead/start', { harness: 'fake' });
    await s.api('POST', '/api/cards/undead/worker/done', { outcome: 'done' });

    // a harness this server has no implementation for: the kill throws, so the
    // pane can never be shown to be gone
    await s.stop();
    const file = path.join(wsDir, '.bridge-commander', 'board.json');
    const doc = JSON.parse(fs.readFileSync(file, 'utf8'));
    doc.workers.find((w) => w.card === 'undead').ref.harness = 'ghost';
    fs.writeFileSync(file, JSON.stringify(doc, null, 2));
    s = await startServerWithLieutenant({ dir: wsDir, env });

    assert.strictEqual((await s.api('POST', '/api/cards/undead/move', { column: 'review', actor: 'agent' })).status, 200);
    const ev = await until('the failed kill is on the timeline',
      async () => (await cardEvents(s, 'undead')).find((e) => e.kind === 'worker-kill-failed'));
    assert.strictEqual(ev.level, 1, 'a session nobody can reach is the captain\'s problem');
    assert.match(ev.text, /could NOT be killed/);
    assert.match(ev.text, /unknown harness/);
    assert.ok(((await s.api('GET', '/api/board')).body.workers || []).some((x) => x.card === 'undead'),
      'the record is kept: it is the only thing pointing at that session');
  } finally {
    await s.stop();
    fs.rmSync(root, { recursive: true, force: true });
  }
});

// The rule only fires on the move, so everything already sitting in the
// registry when a board upgrades to it needs one pass: ~30 records for cards
// long since handed off, and windows whose agent died months ago.
test('the boot sweep ends every worker whose card is not Working — and the orphans', async () => {
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
    for (const id of ['handedoff', 'orphan', 'live']) {
      await s.api('POST', '/api/cards', withOwner({ title: id, id, attributes: { repo: 'proj' } }));
      await s.api('POST', '/api/cards/' + id + '/start', { harness: 'fake' });
      await s.api('POST', '/api/cards/' + id + '/worker/done', { outcome: 'done' });
    }
    const marker = (id) => path.join(fdir, workerKey(wsDir, id) + '.json');

    // Fake the board this change inherits: a card handed off with its worker
    // left alive (the old behaviour), and a record whose card is gone entirely.
    await s.stop();
    const file = path.join(wsDir, '.bridge-commander', 'board.json');
    const doc = JSON.parse(fs.readFileSync(file, 'utf8'));
    doc.cards.find((c) => c.id === 'handedoff').column = 'review';
    // the legacy this inherits: the old handoff DID release the worktree, it
    // just left the process running — a record holding no ground any more
    doc.workers.find((w) => w.card === 'handedoff').worktree.released = true;
    doc.cards = doc.cards.filter((c) => c.id !== 'orphan');
    fs.writeFileSync(file, JSON.stringify(doc, null, 2));
    assert.ok(fs.existsSync(marker('handedoff')) && fs.existsSync(marker('orphan')));

    s = await startServerWithLieutenant({ dir: wsDir, env });
    await until('the handed-off worker is swept', async () => !fs.existsSync(marker('handedoff')));
    await until('the orphan window goes too', async () => !fs.existsSync(marker('orphan')));
    await until('and both records with them', async () => {
      const ws = (await s.api('GET', '/api/board')).body.workers || [];
      return ws.length === 1 && ws[0].card === 'live';
    });
    assert.ok(fs.existsSync(marker('live')), 'a Working card keeps its worker, swept board or not');
  } finally {
    await s.stop();
    fs.rmSync(root, { recursive: true, force: true });
  }
});

// The pointer-only state — a card still naming a checkout with no worker record
// behind it — is what a handoff leaves when its release never landed (the board
// restarted mid-release, or the boot sweep retired the record without touching
// ground). The restart releases against that pointer, and the pointer alone has
// to say which TOOL owns the ground: a POOLED lease answered with
// `git worktree remove` is refused forever, and the card can never start again.
test('a restart against a pointer-only POOLED checkout releases it and starts', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'bc-pool-ptr-'));
  try {
    const repo = makeRepo(root);
    const poolClone = path.join(root, 'poolclone');
    execFileSync('git', ['clone', '-q', repo, poolClone], { stdio: ['ignore', 'pipe', 'pipe'] });
    const bin = writeFakeTreehouse(root, poolClone);
    const wsDir = path.join(root, 'ws');
    fs.mkdirSync(wsDir);
    const env = {
      BC_FAKE_STATE: path.join(root, 'fake'), BC_WORKTREE_TOOL: 'treehouse',
      PATH: bin + path.delimiter + process.env.PATH,
      BC_SUPERVISE_INTERVAL_MS: '0', BC_PRWATCH_INTERVAL_MS: '0',
    };
    let s = await startServerWithLieutenant({ dir: wsDir, env });
    try {
      await s.api('POST', '/api/projects', { source: repo, name: 'proj' });
      await s.api('POST', '/api/cards', withOwner({
        title: 'Pooled rework', id: 'poolptr', attributes: { repo: 'proj' },
      }));
      const w = (await s.api('POST', '/api/cards/poolptr/start', { harness: 'fake' })).body.worker;
      assert.strictEqual(w.worktree.tool, 'treehouse');
      await s.api('POST', '/api/cards/poolptr/worker/done', { outcome: 'shipped' });

      // the state a handoff leaves when its release never landed: the record is
      // gone, the card still points at the lease
      await s.stop();
      const file = path.join(wsDir, '.bridge-commander', 'board.json');
      const doc = JSON.parse(fs.readFileSync(file, 'utf8'));
      doc.cards.find((c) => c.id === 'poolptr').column = 'review';
      doc.workers = doc.workers.filter((x) => x.card !== 'poolptr');
      fs.writeFileSync(file, JSON.stringify(doc, null, 2));
      assert.strictEqual(JSON.parse(fs.readFileSync(file, 'utf8'))
        .cards.find((c) => c.id === 'poolptr').attributes.worktree, w.worktree.path);

      s = await startServerWithLieutenant({ dir: wsDir, env });
      const r = await s.api('POST', '/api/cards/poolptr/start', { harness: 'fake' });
      assert.strictEqual(r.status, 200, JSON.stringify(r.body));
      assert.strictEqual((await s.api('GET', '/api/cards/poolptr')).body.column, 'working');
    } finally { await s.stop(); }
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

// The sweep ends processes; it does not touch ground. So the one record it must
// never end is the one still HOLDING ground: `card.park` shelves a card to be
// resumed in that very checkout, and a release that REFUSED left an unspent
// `teardown` archive is contracted to retry. Both are on the board, both are
// out of Working, and both used to be swept — losing the only handle on them.
test('the boot sweep spares a worker whose worktree is still unreleased', async () => {
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
    const marker = (id) => path.join(fdir, workerKey(wsDir, id) + '.json');

    // parked: reported done, then its session ended by itself, then shelved.
    // Record AND worktree are kept on purpose — `card start --resume` goes back
    // into that same checkout. (The session has to die outside this server
    // process for park to see it dead, hence the restart.)
    await s.api('POST', '/api/cards', withOwner({ title: 'Shelved', id: 'parked', attributes: { repo: 'proj' } }));
    const pw = (await s.api('POST', '/api/cards/parked/start', { harness: 'fake' })).body.worker;
    await s.api('POST', '/api/cards/parked/worker/done', { outcome: 'shelved' });
    await s.stop();
    fs.rmSync(marker('parked'));
    s = await startServerWithLieutenant({ dir: wsDir, env });
    const pk = await s.api('POST', '/api/cards/parked/park', {});
    assert.strictEqual(pk.status, 200, JSON.stringify(pk.body));

    // handed off with a dirty worktree: the release refused, the record kept
    await s.api('POST', '/api/cards', withOwner({ title: 'Unfinished', id: 'refused', attributes: { repo: 'proj' } }));
    const rw = (await s.api('POST', '/api/cards/refused/start', { harness: 'fake' })).body.worker;
    fs.writeFileSync(path.join(rw.worktree.path, 'unsaved.txt'), 'not committed\n');
    await s.api('POST', '/api/cards/refused/worker/done', { outcome: 'done, sort of' });
    await s.api('POST', '/api/cards/refused/move', { column: 'review', actor: 'agent' });
    await until('the release refused',
      async () => (await cardEvents(s, 'refused')).some((e) => /worktree kept/.test(e.text)));

    // and the record that holds NOTHING: handed off, ground already gone. It is
    // registered last, and the sweep walks the registry in order, so its drop
    // is the proof that the two above were considered and spared.
    await s.api('POST', '/api/cards', withOwner({ title: 'Legacy', id: 'legacy', attributes: { repo: 'proj' } }));
    await s.api('POST', '/api/cards/legacy/start', { harness: 'fake' });
    await s.api('POST', '/api/cards/legacy/worker/done', { outcome: 'shipped' });

    await s.stop();
    const file = path.join(wsDir, '.bridge-commander', 'board.json');
    const doc = JSON.parse(fs.readFileSync(file, 'utf8'));
    doc.cards.find((c) => c.id === 'legacy').column = 'review';
    doc.workers.find((w) => w.card === 'legacy').worktree.released = true;
    fs.writeFileSync(file, JSON.stringify(doc, null, 2));

    s = await startServerWithLieutenant({ dir: wsDir, env });
    await until('the sweep retired the record holding no ground',
      async () => ((await s.api('GET', '/api/board')).body.workers || []).every((x) => x.card !== 'legacy'));
    const ws = (await s.api('GET', '/api/board')).body.workers || [];
    assert.ok(ws.some((x) => x.card === 'parked'), 'the parked card keeps its resume handle');
    assert.ok(ws.some((x) => x.card === 'refused'), 'the refused release keeps its last handle');
    assert.ok(fs.existsSync(pw.worktree.path), 'and the parked checkout is untouched');
    assert.ok(fs.existsSync(path.join(rw.worktree.path, 'unsaved.txt')), 'and nothing was discarded');

    // the handle still works: resume goes back into that same checkout
    const r = await s.api('POST', '/api/cards/parked/start', { harness: 'fake', resume: true });
    assert.strictEqual(r.status, 200, JSON.stringify(r.body));
    assert.strictEqual((await s.api('GET', '/api/cards/parked')).body.column, 'working');
  } finally {
    await s.stop();
    fs.rmSync(root, { recursive: true, force: true });
  }
});

// A refused release keeps its record ON PURPOSE — that worktree may hold the
// only copy of the work — so the way back into it is still open. The handoff's
// "there is nothing left to reincarnate" is about the record it DROPPED.
test('resume still works after a handoff whose release refused', async () => {
  const { s, fdir, teardown } = await boot();
  try {
    await s.api('POST', '/api/cards', withOwner({
      title: 'Unfinished business', id: 'unfin', attributes: { repo: 'proj' },
    }));
    const w = (await s.api('POST', '/api/cards/unfin/start', { harness: 'fake' })).body.worker;
    fs.writeFileSync(path.join(w.worktree.path, 'unsaved.txt'), 'not committed\n');
    await s.api('POST', '/api/cards/unfin/worker/done', { outcome: 'done, sort of' });
    await s.api('POST', '/api/cards/unfin/move', { column: 'review', actor: 'agent' });

    await until('the window is gone all the same', async () => !fs.existsSync(path.join(fdir, workerKey(s.dir, 'unfin') + '.json')));
    await until('the release refused',
      async () => (await cardEvents(s, 'unfin')).some((e) => /worktree kept/.test(e.text)));

    const r = await s.api('POST', '/api/cards/unfin/start', { harness: 'fake', resume: true });
    assert.strictEqual(r.status, 200, JSON.stringify(r.body));
    assert.strictEqual(r.body.worker.worktree.path, w.worktree.path, 'back into the same checkout');
    assert.strictEqual((await s.api('GET', '/api/cards/unfin')).body.column, 'working');
    assert.ok(fs.existsSync(path.join(w.worktree.path, 'unsaved.txt')), 'with the work still in it');
  } finally { await teardown(); }
});

// The restart drops the old record, so it obeys the same verify-then-drop rule
// as the handoff: a pane it cannot show to be gone is a 409, not a second
// worker spawned over a live one that nothing on the board points at.
test('a restart over a pane the board cannot end refuses instead of spawning', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'bc-workers-'));
  const repo = makeRepo(root);
  const wsDir = path.join(root, 'ws');
  fs.mkdirSync(wsDir);
  const env = {
    BC_FAKE_STATE: path.join(root, 'fake'), BC_WORKTREE_TOOL: 'git',
    BC_SUPERVISE_INTERVAL_MS: '0', BC_PRWATCH_INTERVAL_MS: '0',
  };
  let s = await startServerWithLieutenant({ dir: wsDir, env });
  try {
    await s.api('POST', '/api/projects', { source: repo, name: 'proj' });
    await s.api('POST', '/api/cards', withOwner({
      title: 'Zombie', id: 'zombie', attributes: { repo: 'proj' },
    }));
    await s.api('POST', '/api/cards/zombie/start', { harness: 'fake' });
    await s.api('POST', '/api/cards/zombie/worker/done', { outcome: 'done' });

    // a harness this server has no implementation for: the board can neither
    // read the pane's liveness nor end it, so the handoff kept the record
    await s.stop();
    const file = path.join(wsDir, '.bridge-commander', 'board.json');
    const doc = JSON.parse(fs.readFileSync(file, 'utf8'));
    doc.workers.find((w) => w.card === 'zombie').ref.harness = 'ghost';
    fs.writeFileSync(file, JSON.stringify(doc, null, 2));
    s = await startServerWithLieutenant({ dir: wsDir, env });
    assert.strictEqual((await s.api('POST', '/api/cards/zombie/move', { column: 'review', actor: 'agent' })).status, 200);
    await until('the failed kill is on the timeline',
      async () => (await cardEvents(s, 'zombie')).find((e) => e.kind === 'worker-kill-failed'));

    // the rework move the board teaches — and it must NOT quietly spawn
    const r = await s.api('POST', '/api/cards/zombie/start', { harness: 'fake' });
    assert.strictEqual(r.status, 409, JSON.stringify(r.body));
    assert.match(r.body.error, /could not be ended/);
    assert.match(r.body.error, rx(workerKey(wsDir, 'zombie')));
    assert.match(r.body.error, /by hand/);
    assert.ok(((await s.api('GET', '/api/board')).body.workers || []).some((x) => x.card === 'zombie'),
      'the record stays: it is the only thing pointing at that session');
    assert.notStrictEqual((await s.api('GET', '/api/cards/zombie')).body.column, 'working');
  } finally {
    await s.stop();
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('a malformed frontmatter block refuses the start and names the line', async () => {
  const { s, teardown } = await boot();
  try {
    writePlaybook(s, 'broken', ['---', 'harness: codex', 'hrness: claude', '---', 'body', ''].join('\n'));
    await s.api('POST', '/api/cards', withOwner({
      title: 'Bad playbook', id: 'bad-fm', playbook: 'broken', attributes: { repo: 'proj' },
    }));
    const r = await s.api('POST', '/api/cards/bad-fm/start', { harness: 'fake' });
    assert.strictEqual(r.status, 400, JSON.stringify(r.body));
    assert.match(r.body.error, /broken\.md: frontmatter line 3: unknown key "hrness"/);
    assert.deepStrictEqual(boardOnDisk(s).workers, []);
  } finally { await teardown(); }
});

// An unknown harness names the file that asked for it: the person starting the
// card is rarely the person who typed the name, and a workspace holds several
// playbooks to hunt through.
test('an unknown harness from the frontmatter names the playbook it came from', async () => {
  const { s, teardown } = await boot();
  try {
    writePlaybook(s, 'typo-harness', ['---', 'harness: codx', '---', 'body', ''].join('\n'));
    await s.api('POST', '/api/cards', withOwner({
      title: 'Typo', id: 'typo-h', playbook: 'typo-harness', attributes: { repo: 'proj' },
    }));
    let r = await s.api('POST', '/api/cards/typo-h/start', {});
    assert.strictEqual(r.status, 400, JSON.stringify(r.body));
    assert.match(r.body.error, /codx/);
    assert.match(r.body.error, /from playbook .*typo-harness\.md/);

    // the flag won, so the playbook did not ask: none named back
    r = await s.api('POST', '/api/cards/typo-h/start', { harness: 'nosuchharness' });
    assert.strictEqual(r.status, 400, JSON.stringify(r.body));
    assert.doesNotMatch(r.body.error, /from playbook/);
    assert.deepStrictEqual(boardOnDisk(s).workers, []);
  } finally { await teardown(); }
});

// There is ONE way for a card to start: the card's playbook, read on every
// start. `--command` was the second one, and it is gone — the flag has to fail
// at the CLI's own front door rather than slide in as a positional.
test('--command is gone: the CLI refuses the flag outright', async () => {
  const { s, teardown } = await boot();
  try {
    await s.api('POST', '/api/cards', withOwner({ title: 'Runner', id: 'runner', attributes: { repo: 'proj' } }));
    const cli = await runCli(['card', 'start', 'runner', '--command', 'node bin/thing.js',
      '--workspace', s.dir, '--port', String(s.port)]);
    assert.notStrictEqual(cli.code, 0);
    assert.match(cli.stderr, /unknown flag --command/);
    // and nothing was started behind it
    assert.deepStrictEqual(boardOnDisk(s).workers, []);
  } finally {
    await teardown();
  }
});

// The wire has no unknown-flag guard, so it says it itself. A caller that asks
// for the second way must not quietly get the first one: spawning an agent on
// the playbook is not what it asked for, and silence would let old callers keep
// believing the launcher is there.
test('--command is gone: the API refuses the field by name', async () => {
  const { s, teardown } = await boot();
  try {
    await s.api('POST', '/api/cards', withOwner({ title: 'Runner', id: 'apirunner', attributes: { repo: 'proj' } }));
    const r = await s.api('POST', '/api/cards/apirunner/start', { command: 'node bin/thing.js' });
    assert.strictEqual(r.status, 400, JSON.stringify(r.body));
    assert.match(r.body.error, /--command was removed/);
    assert.match(r.body.error, /--playbook/);
    assert.deepStrictEqual(boardOnDisk(s).workers, []);
  } finally {
    await teardown();
  }
});
