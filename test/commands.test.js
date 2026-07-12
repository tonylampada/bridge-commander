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
const { startServerWithLieutenant, withOwner, LT } = require('./helper');
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
    assert.deepStrictEqual(r.body.commands.map((c) => c.name), ['/status', '/compact', '/help']);

    // a ref-less lieutenant (Ada) has no session to address — empty, not an error
    r = await s.api('GET', '/api/commands?target=lieutenant:' + LT);
    assert.strictEqual(r.status, 200);
    assert.deepStrictEqual(r.body.commands, []);

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

test('a harness without the capability (BC_FAKE_NO_COMMANDS) degrades to an empty list + in-thread notice', async () => {
  const { s, teardown } = await bootWithFakeLt({ BC_FAKE_NO_COMMANDS: '1' });
  try {
    const r = await s.api('GET', '/api/commands?target=lieutenant:fk1');
    assert.strictEqual(r.status, 200);
    assert.deepStrictEqual(r.body.commands, []);
    assert.strictEqual((await s.api('POST', '/api/feedback', { target: 'lieutenant:fk1', text: '/status' })).status, 200);
    const chat = await chatOf(s, 'fk1');
    assert.strictEqual(chat.length, 2);
    assert.match(chat[1].text, /no slash commands/);
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
    assert.strictEqual((await s.api('POST', '/api/projects', { source: repo, name: 'proj', mode: 'local-only' })).status, 200);
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
    assert.match(card.thread[1].text, /compaction requested/);

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
