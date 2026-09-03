'use strict';
// Slash commands + agentStatus. A captain chat message that IS a "/command"
// routes to the target harness's runCommand (lieutenant chat → the
// lieutenant's session, card thread → the card's WORKER session) instead of
// becoming a say: command + reply land in the thread, nothing rides the
// delivery queue. /api/commands feeds the composer autocomplete; turn-end
// refreshes agentStatus onto the board payload. All on the file-backed fake
// harness (BC_FAKE_STATE) — no tmux.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const { startServer, startServerWithLieutenant, withOwner, LT } = require('./helper');
const { lieutenantSession, workerWindow } = require('../server/names.js');

function fakeSession(dir, session) {
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, session + '.json'), JSON.stringify({ cwd: '/tmp', resumeId: null }) + '\n');
}
function readSends(dir, session) {
  try {
    return fs.readFileSync(path.join(dir, session + '.sends.jsonl'), 'utf8')
      .split('\n').filter(Boolean).map((l) => JSON.parse(l));
  } catch {
    return [];
  }
}
async function bootWithFakeLt(extraEnv = {}) {
  const fdir = fs.mkdtempSync(path.join(os.tmpdir(), 'bc-cmd-fake-'));
  const s = await startServerWithLieutenant({ env: Object.assign({ BC_FAKE_STATE: fdir }, extraEnv) });
  fakeSession(fdir, 'bc-fk1');
  const ref = { harness: 'fake', session: 'bc-fk1', cwd: '/tmp', resumeId: 'uuid-fk1' };
  assert.strictEqual((await s.api('POST', '/api/lieutenants', { name: 'Fake', id: 'fk1', ref })).status, 200);
  const teardown = async () => { await s.stop(); fs.rmSync(fdir, { recursive: true, force: true }); };
  return { s, fdir, teardown };
}
async function chatOf(s, id) {
  return (await s.api('GET', '/api/board')).body.lieutenants.find((l) => l.id === id).chat || [];
}

test('GET /api/commands: target harness list; no session / no worker → empty; bad targets error', async () => {
  const { s, teardown } = await bootWithFakeLt();
  try {
    // a live-ref lieutenant answers with the fake's canned commands
    let r = await s.api('GET', '/api/commands?target=lieutenant:fk1');
    assert.strictEqual(r.status, 200);
    assert.strictEqual(r.body.harness, 'fake');
    // …plus the board's own, which no harness supplies
    assert.deepStrictEqual(r.body.commands.map((c) => c.name), ['/status', '/compact', '/help', '/reset']);

    // a ref-less lieutenant (Ada) has no session to address, so the harness
    // offers nothing — but /reset is precisely how a lieutenant with no live
    // session comes back, so the board still offers that one.
    r = await s.api('GET', '/api/commands?target=lieutenant:' + LT);
    assert.strictEqual(r.status, 200);
    assert.deepStrictEqual(r.body.commands.map((c) => c.name), ['/reset']);

    // a card without a worker — empty too (the composer just shows nothing)
    await s.api('POST', '/api/cards', withOwner({ title: 'Bare' }));
    r = await s.api('GET', '/api/commands?target=card:bare');
    assert.strictEqual(r.status, 200);
    assert.deepStrictEqual(r.body.commands, []);

    // unknown targets 404, malformed 400
    assert.strictEqual((await s.api('GET', '/api/commands?target=lieutenant:ghost')).status, 404);
    assert.strictEqual((await s.api('GET', '/api/commands?target=card:ghost')).status, 404);
    assert.strictEqual((await s.api('GET', '/api/commands?target=junk')).status, 400);
  } finally {
    await teardown();
  }
});

test('/api/commands passes a command\'s `args` through untouched (the composer\'s second stage)', async () => {
  // `args` is optional metadata a harness may attach to a command (port.js);
  // the server must not strip a field it does not itself understand. claude's
  // /output-style is the one that carries it, so this asks the REAL harness —
  // pointed at a temp styles dir so the answer does not depend on this machine.
  const styles = fs.mkdtempSync(path.join(os.tmpdir(), 'bc-styles-'));
  fs.writeFileSync(path.join(styles, 'eli5.md'),
    '---\nname: ELI5\ndescription: keep it simple pls\n---\nbody\n');
  const { s, teardown } = await bootWithFakeLt({ BC_CLAUDE_OUTPUT_STYLES_DIR: styles });
  try {
    const ref = { harness: 'claude', session: 'bc-cl1', cwd: '/tmp', resumeId: 'uuid-cl1' };
    assert.strictEqual((await s.api('POST', '/api/lieutenants', { name: 'Claudia', id: 'cl1', ref })).status, 200);

    const r = await s.api('GET', '/api/commands?target=lieutenant:cl1');
    assert.strictEqual(r.status, 200);
    assert.strictEqual(r.body.harness, 'claude');
    const os_ = r.body.commands.find((c) => c.name === '/output-style');
    assert.ok(os_, 'claude offers /output-style');
    assert.ok(Array.isArray(os_.args), 'and its args survived the trip');
    assert.ok(os_.args.some((a) => a.value === 'ELI5' && a.description === 'keep it simple pls'),
      'value AND description, verbatim');
    assert.ok(os_.args.some((a) => a.value === 'default'), 'built-ins too');

    // the commands that take nothing must not sprout the field on the way out
    for (const c of r.body.commands.filter((c) => c.name !== '/output-style')) {
      assert.strictEqual(c.args, undefined, c.name);
    }

    // ...and the fake, which reports no args at all, is unchanged
    const fake = await s.api('GET', '/api/commands?target=lieutenant:fk1');
    for (const c of fake.body.commands) assert.strictEqual(c.args, undefined, 'fake ' + c.name);
  } finally {
    await teardown();
    fs.rmSync(styles, { recursive: true, force: true });
  }
});

test('a codex target never offers /output-style — codex has no output styles', async () => {
  const { s, teardown } = await bootWithFakeLt();
  try {
    const ref = { harness: 'codex', session: 'bc-cx1', cwd: '/tmp' };
    assert.strictEqual((await s.api('POST', '/api/lieutenants', { name: 'Cody', id: 'cx1', ref })).status, 200);
    const r = await s.api('GET', '/api/commands?target=lieutenant:cx1');
    assert.strictEqual(r.status, 200);
    assert.deepStrictEqual(r.body.commands.map((c) => c.name), ['/status', '/compact', '/help', '/reset']);
  } finally {
    await teardown();
  }
});

test('a harness without the capability (BC_FAKE_NO_COMMANDS) degrades to the board list + an in-thread notice', async () => {
  const { s, teardown } = await bootWithFakeLt({ BC_FAKE_NO_COMMANDS: '1' });
  try {
    // the harness contributes nothing; the board's own command is still there
    const r = await s.api('GET', '/api/commands?target=lieutenant:fk1');
    assert.strictEqual(r.status, 200);
    assert.deepStrictEqual(r.body.commands.map((c) => c.name), ['/reset']);
    assert.strictEqual((await s.api('POST', '/api/feedback', { target: 'lieutenant:fk1', text: '/status' })).status, 200);
    const chat = await chatOf(s, 'fk1');
    assert.strictEqual(chat.length, 2);
    // Still a graceful in-thread notice rather than an HTTP failure — and now
    // it names what IS available instead of only what is not.
    assert.match(chat[1].text, /unknown command \/status/);
    assert.match(chat[1].text, /available: \/reset/);
  } finally {
    await teardown();
  }
});

test('chat "/command" routes to runCommand: command + reply in the thread, nothing on the queue', async () => {
  const { s, fdir, teardown } = await bootWithFakeLt();
  try {
    // /status — the harness reply, stamped with the harness name
    let r = await s.api('POST', '/api/feedback', { target: 'lieutenant:fk1', text: '/status' });
    assert.strictEqual(r.status, 200);
    assert.strictEqual(r.body.command, '/status');
    let chat = await chatOf(s, 'fk1');
    assert.strictEqual(chat.length, 2);
    assert.deepStrictEqual([chat[0].author, chat[0].text], ['user', '/status']);
    assert.strictEqual(chat[1].author, 'fake');
    assert.match(chat[1].text, /fake-model[\s\S]*50,000 \/ 200,000 tokens \(25%\)/);

    // /help renders the command list
    await s.api('POST', '/api/feedback', { target: 'lieutenant:fk1', text: '/help' });
    chat = await chatOf(s, 'fk1');
    assert.match(chat[3].text, /\/status[\s\S]*\/compact[\s\S]*\/help/);

    // /compact types the literal "/compact" into the session (send path)
    await s.api('POST', '/api/feedback', { target: 'lieutenant:fk1', text: '/compact' });
    const sends = readSends(fdir, 'bc-fk1');
    assert.ok(sends.some((x) => x.text === '/compact'), 'literal /compact reached the session');

    // unknown /xyz → helpful in-thread error, still a 200
    await s.api('POST', '/api/feedback', { target: 'lieutenant:fk1', text: '/xyz' });
    chat = await chatOf(s, 'fk1');
    assert.match(chat[chat.length - 1].text, /unknown command \/xyz.*\/status, \/compact, \/help/);

    // NONE of it rode the delivery queue (no wake, no owed)
    const feed = await s.api('GET', '/api/feed?lieutenant=fk1');
    assert.deepStrictEqual(feed.body.items, []);
    const lt = (await s.api('GET', '/api/board')).body.lieutenants.find((l) => l.id === 'fk1');
    assert.strictEqual(lt.chatOwed, false, 'a slash command never reads as owed');

    // a normal message still queues (the say path is untouched)
    await s.api('POST', '/api/feedback', { target: 'lieutenant:fk1', text: 'real message' });
    assert.strictEqual((await s.api('GET', '/api/feed?lieutenant=fk1')).body.items.length, 1);
  } finally {
    await teardown();
  }
});

test('card-thread "/command": absent worker → friendly in-thread error; unknown card stays 404', async () => {
  const { s, teardown } = await bootWithFakeLt();
  try {
    await s.api('POST', '/api/cards', withOwner({ title: 'Lonely' }));
    const r = await s.api('POST', '/api/feedback', { target: 'card:lonely', text: '/status' });
    assert.strictEqual(r.status, 200);
    const card = (await s.api('GET', '/api/cards/lonely')).body;
    assert.strictEqual(card.thread.length, 2);
    assert.strictEqual(card.thread[0].text, '/status');
    assert.strictEqual(card.thread[1].author, 'bridge');
    assert.match(card.thread[1].text, /no worker on card lonely/);
    assert.ok(card.threadStart, 'threadStart set by the command exchange');
    // nothing queued for the owner
    assert.deepStrictEqual((await s.api('GET', '/api/feed?lieutenant=' + LT)).body.items, []);

    assert.strictEqual((await s.api('POST', '/api/feedback', { target: 'card:ghost', text: '/status' })).status, 404);
  } finally {
    await teardown();
  }
});

test('card-thread commands address the WORKER session; worker turn-end refreshes its agentStatus', async () => {
  // real card.start machinery: fake harness + git worktree over a throwaway repo
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'bc-cmd-worker-'));
  const repo = path.join(root, 'srcrepo');
  fs.mkdirSync(repo);
  execFileSync('git', ['init', '-q', '-b', 'main', repo], { stdio: ['ignore', 'pipe', 'pipe'] });
  fs.writeFileSync(path.join(repo, 'README.md'), 'hello\n');
  execFileSync('git', ['-C', repo, 'add', '.'], { stdio: ['ignore', 'pipe', 'pipe'] });
  execFileSync('git', ['-C', repo, '-c', 'user.email=t@t', '-c', 'user.name=t', 'commit', '-q', '-m', 'init'],
    { stdio: ['ignore', 'pipe', 'pipe'] });
  const fdir = path.join(root, 'fake');
  const s = await startServerWithLieutenant({
    env: { BC_FAKE_STATE: fdir, BC_WORKTREE_TOOL: 'git', BC_SUPERVISE_INTERVAL_MS: '0', BC_PRWATCH_INTERVAL_MS: '0' },
  });
  try {
    assert.strictEqual((await s.api('POST', '/api/projects', { source: repo, name: 'proj' })).status, 200);
    await s.api('POST', '/api/cards', withOwner({ title: 'Task', attributes: { repo: 'proj' } }));
    assert.strictEqual((await s.api('POST', '/api/cards/task/start', { harness: 'fake' })).status, 200);
    const key = lieutenantSession(s.dir, LT) + ':' + workerWindow('task');

    // the card target's command list is the worker harness's
    const r = await s.api('GET', '/api/commands?target=card:task');
    assert.strictEqual(r.status, 200);
    assert.deepStrictEqual(r.body.commands.map((c) => c.name), ['/status', '/compact', '/help']);

    // /compact in the card thread types into the WORKER pane, not the lieutenant's
    await s.api('POST', '/api/feedback', { target: 'card:task', text: '/compact' });
    const sends = readSends(fdir, key);
    assert.ok(sends.some((x) => x.text === '/compact'), 'literal /compact reached the worker session: ' + JSON.stringify(sends));
    const card = (await s.api('GET', '/api/cards/task')).body;
    assert.strictEqual(card.thread[0].text, '/compact');
    assert.match(card.thread[1].text, /"\/compact" submitted/);

    // a worker turn-end refreshes the worker record's agentStatus
    const te = await s.api('POST', '/api/turn-end', { session: key });
    assert.strictEqual(te.status, 200);
    assert.strictEqual(te.body.worker, 'task');
    const w = (await s.api('GET', '/api/board')).body.workers.find((x) => x.card === 'task');
    assert.strictEqual(w.agentStatus.model, 'fake-model');
    assert.strictEqual(w.agentStatus.contextUsed, 50000);
  } finally {
    await s.stop();
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('turn-end refreshes agentStatus onto the board payload (lieutenant)', async () => {
  const { s, teardown } = await bootWithFakeLt();
  try {
    let lt = (await s.api('GET', '/api/board')).body.lieutenants.find((l) => l.id === 'fk1');
    assert.strictEqual(lt.agentStatus, undefined, 'no status before the first turn-end');

    const r = await s.api('POST', '/api/turn-end', { session: 'bc-fk1', session_id: 'uuid-fk1' });
    assert.strictEqual(r.status, 200);
    assert.strictEqual(r.body.lieutenant, 'fk1');

    lt = (await s.api('GET', '/api/board')).body.lieutenants.find((l) => l.id === 'fk1');
    assert.strictEqual(lt.agentStatus.model, 'fake-model');
    assert.strictEqual(lt.agentStatus.contextUsed, 50000);
    assert.strictEqual(lt.agentStatus.contextWindow, 200000);
    assert.ok(lt.agentStatus.ts, 'stamped with the refresh time');
  } finally {
    await teardown();
  }
});

// A status is only ever refreshed at turn-end, and a failed refresh leaves the
// last successful reading in place (refreshAgentStatus returns false and
// touches nothing). Without an age mark the board presents that frozen reading
// as current — which is how a lieutenant whose status read is broken shows a
// confident number nobody has measured in hours. The server marks it; the UI
// decides what to do with the mark.
test('a reading older than the stale window is marked stale on the payload; a fresh one is not', async () => {
  const nowIso = new Date().toISOString();
  const iso = (agoMs) => new Date(Date.now() - agoMs).toISOString();
  const st = (ts) => ({ model: 'gpt-5.6-sol', contextUsed: 140190, contextWindow: 258400, ts });
  const s = await startServer({
    seed: (dir) => {
      const sd = path.join(dir, '.bridge-commander');
      fs.mkdirSync(sd, { recursive: true });
      fs.writeFileSync(path.join(sd, 'board.json'), JSON.stringify({
        title: 'seeded', events: [], labels: [], reads: {}, kinds: {}, projects: [],
        seq: 0,
        // RX-1 is Working on purpose: the boot sweep ends every worker whose
        // card is not, and this test is about a reading, not a lifecycle.
        cards: [{ id: 'RX-1', title: 'Live work', owner: 'rex', column: 'working', type: 'implementation',
          created: nowIso, updated: nowIso, events: [], thread: [], attributes: {} }],
        lieutenants: [
          { id: 'rex', name: 'Rex', color: '#58b6ff', chat: [], created: nowIso,
            ref: { harness: 'fake', session: 'bc-rex', window: 'lt', cwd: '/tmp' },
            agentStatus: st(iso(3 * 60 * 60 * 1000)) },
          { id: 'freya', name: 'Freya', color: '#58b6ff', chat: [], created: nowIso,
            ref: { harness: 'fake', session: 'bc-freya', window: 'lt', cwd: '/tmp' },
            agentStatus: st(iso(30 * 1000)) },
        ],
        workers: [{ card: 'RX-1', project: 'p', ref: { harness: 'fake', session: 'bc-rex', window: 'w-rx-1', cwd: '/tmp' },
          worktree: { path: '/tmp/wt', tool: 'git' }, agentStatus: st(iso(3 * 60 * 60 * 1000)) }],
      }, null, 2));
    },
  });
  try {
    const board = (await s.api('GET', '/api/board')).body;
    const lt = (id) => board.lieutenants.find((l) => l.id === id);
    assert.strictEqual(lt('rex').agentStatus.stale, true, 'a three-hour-old reading is not current');
    assert.strictEqual(lt('rex').agentStatus.contextUsed, 140190, 'the numbers still ride along');
    assert.strictEqual(lt('freya').agentStatus.stale, undefined, 'a fresh reading carries no mark');
    assert.strictEqual(board.workers[0].agentStatus.stale, true, 'workers are marked the same way');

    // the mark is derived, never written — the stored record stays untouched
    const stored = JSON.parse(fs.readFileSync(path.join(s.dir, '.bridge-commander', 'board.json'), 'utf8'));
    const storedRex = stored.lieutenants.find((l) => l.id === 'rex');
    if (storedRex.agentStatus) assert.strictEqual(storedRex.agentStatus.stale, undefined);
  } finally {
    await s.stop();
  }
});
