#!/usr/bin/env node
// fullloop e2e — THE master agentic-loop test. Node built-ins only.
//
//   node e2e/fullloop.e2e.js
//
// Proves the whole system with NO scripted shortcuts on the lieutenant side:
// wake → drain → judgment → card.create → card.start → worker → done item →
// verification → handoff. The captain acts purely through the API.
//
// Scenario, on a throwaway workspace + a PRIVATE tmux server (TMUX_TMPDIR):
//   1. server boots; a throwaway local-only project is registered.
//   2. a REAL lieutenant is spawned (doctrine + a small mission charter as its
//      launch prompt).
//   3. the captain sends ONE chat message asking for an implementation card
//      (add greeting.txt containing 'ahoy'), started, verified, and handed to
//      review with a body that states what landed.
//   4. the test then only WAITS (budget ~15 min), polling board state:
//      - card created BY THE LIEUTENANT (its own act, not the captain's)
//      - card.start happened (real worker session existed, card → Working)
//      - worker reported done
//      - the LIEUTENANT moved the card to review (the handoff event)
//      - body rewritten, mentioning the change
//      - branch bc/<card> holds greeting.txt == 'ahoy'
//   If the lieutenant stalls, ONE captain nudge is allowed; needing a second
//   one fails the test (that is a doctrine/brief bug — fix it, don't nudge).
// On failure: dumps the lieutenant pane + its queue/ack state for diagnosis.
// Cleanup: all sessions, the private tmux server, the workspace server, tmp.
'use strict';

const { spawn, execFileSync } = require('node:child_process');
const assert = require('node:assert');
const net = require('node:net');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const CLI = path.join(__dirname, '..', 'cli', 'bc-axi');
const SERVER_JS = path.join(__dirname, '..', 'server', 'server.js');
const BUDGET_MS = 15 * 60 * 1000; // the whole agentic loop, captain message → review
const STALL_MS = 5 * 60 * 1000;   // no new milestone for this long = stalled (nudge once)

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

// ---------- throwaway tree + private tmux server ----------
const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'bc-fullloop-e2e-'));
const ws = path.join(tmpRoot, 'workspace');
fs.mkdirSync(ws);
const ENV = Object.assign({}, process.env, {
  TMUX_TMPDIR: path.join(tmpRoot, 'tmux'),
  BC_HARNESS_STATE: path.join(tmpRoot, 'hstate'),
  BC_WORKTREE_TOOL: 'git',
  BC_PRWATCH_INTERVAL_MS: '0', // local-only run — no gh polling
  PATH: path.dirname(CLI) + ':' + process.env.PATH,
});
delete ENV.TMUX;
fs.mkdirSync(ENV.TMUX_TMPDIR);

function tmux(...args) {
  return execFileSync('tmux', args, { encoding: 'utf8', env: ENV, stdio: ['ignore', 'pipe', 'pipe'] });
}
function tryTmux(...args) { try { return tmux(...args); } catch (e) { return null; } }
function capture(session, lines = 160) {
  const out = tryTmux('capture-pane', '-p', '-t', '=' + session + ':', '-S', '-' + lines);
  return out === null ? '' : out;
}
function git(dir, ...args) {
  return execFileSync('git', ['-C', dir, ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
}

const { lieutenantSession, workspaceDisc } = require(path.join(__dirname, '..', 'server', 'names.js'));

const LT = 'hopper';
const LT_SESSION = lieutenantSession(ws, LT); // workspace-discriminated

function elapsed(t0) { return ((Date.now() - t0) / 1000).toFixed(0) + 's'; }

function dumpDiagnostics() {
  console.error('\n--- lieutenant pane (' + LT_SESSION + ') ---');
  console.error(capture(LT_SESSION).split('\n').slice(-80).join('\n'));
  try {
    console.error('\n--- drain log (queue/' + LT + '.jsonl) ---');
    console.error(fs.readFileSync(path.join(ws, '.bridge-commander', 'queue', LT + '.jsonl'), 'utf8').trim());
    console.error('ack cursor: ' + fs.readFileSync(path.join(ws, '.bridge-commander', 'queue', LT + '.ack'), 'utf8').trim());
  } catch (e) { console.error('(no queue state: ' + e.message + ')'); }
  for (const s of (tryTmux('list-sessions', '-F', '#S') || '').split('\n').filter((x) => x.startsWith('bc-' + workspaceDisc(ws) + '-w-'))) {
    console.error('\n--- worker pane (' + s + ') ---');
    console.error(capture(s).split('\n').slice(-40).join('\n'));
  }
}

(async () => {
  const port = await freePort();
  const base = 'http://127.0.0.1:' + port;
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
  console.log('workspace: ' + ws + '  port: ' + port + '  tmux: ' + ENV.TMUX_TMPDIR);

  let server = null;
  let ok = false;
  try {
    // ---------- setup: server + local-only project ----------
    server = spawn(process.execPath, [SERVER_JS, ws, '--port', String(port)],
      { env: ENV, detached: false, stdio: ['ignore', 'pipe', 'pipe'] });
    {
      const deadline = Date.now() + 10000;
      for (;;) {
        try { if ((await fetch(base + '/api/status')).ok) break; } catch (e) {}
        if (Date.now() > deadline) throw new Error('server not ready');
        await sleep(200);
      }
    }
    const repo = path.join(tmpRoot, 'srcrepo');
    fs.mkdirSync(repo);
    execFileSync('git', ['init', '-q', '-b', 'main', repo], { env: ENV, stdio: ['ignore', 'pipe', 'pipe'] });
    fs.writeFileSync(path.join(repo, 'README.md'), 'throwaway fullloop repo\n');
    git(repo, 'add', '.');
    git(repo, '-c', 'user.email=e2e@bc', '-c', 'user.name=bc-e2e', 'commit', '-q', '-m', 'init');
    const pr = await api('POST', '/api/projects', { source: repo, name: 'proj', mode: 'local-only' });
    assert.strictEqual(pr.status, 200, JSON.stringify(pr.body));
    console.log('  ✔ setup: server up, local-only project registered');

    // ---------- a REAL lieutenant with a small mission charter ----------
    const t0 = Date.now();
    const r = await api('POST', '/api/lieutenants', {
      name: 'Hopper', id: LT, spawn: true, actor: 'user',
      charter: 'Mission: deliver small changes to the registered project `proj` (local-only). '
        + 'Be proactive inside this mission per your doctrine: create cards, start them, verify '
        + 'worker results, and hand finished work to the captain\'s review.',
    });
    assert.strictEqual(r.status, 200, JSON.stringify(r.body));
    assert.strictEqual(r.body.lieutenant.ref.session, LT_SESSION);
    console.log('  ✔ real lieutenant spawned (' + elapsed(t0) + ')');

    // ---------- the ONE captain message (pure API) ----------
    const ask = 'Create an implementation card to add a file greeting.txt containing exactly '
      + "'ahoy' to project proj, then start it, and when the worker finishes verify the change "
      + 'and hand the card to my review with a body that states what landed.';
    assert.strictEqual((await api('POST', '/api/feedback', { target: 'lieutenant:' + LT, text: ask })).status, 200);
    console.log('  ✔ captain message sent — now waiting (budget ' + BUDGET_MS / 60000 + ' min)');

    // ---------- wait and watch: milestones derived from board state only ----------
    const seen = {}; // milestone -> ms after t0
    let nudges = 0;
    let lastProgress = Date.now();
    let card = null;
    const deadline = Date.now() + BUDGET_MS;
    while (Date.now() < deadline) {
      await sleep(5000);
      const b = (await api('GET', '/api/board')).body;
      const cards = (b.cards || []).filter((c) => c.owner === LT);
      const mark = (m) => {
        if (seen[m]) return;
        seen[m] = Date.now() - t0;
        lastProgress = Date.now();
        console.log('    • ' + m + '  (' + elapsed(t0) + ')');
      };
      if (!card && cards.length) card = cards[0];
      if (card) {
        card = (b.cards || []).find((c) => c.id === card.id) || card;
        const ev = card.events || [];
        const created = ev.find((e) => e.kind === 'created');
        if (created && created.actor !== 'user') mark('card created by the lieutenant: ' + card.id);
        if (ev.some((e) => e.kind === 'started') || card.attributes.session) mark('card.start ran (worker spawned)');
        if (ev.some((e) => e.kind === 'worker-done')) mark('worker reported done');
        const handoff = ev.find((e) => e.kind === 'handoff' && e.actor !== 'user');
        if (card.column === 'review' && handoff) {
          mark('lieutenant handed off to review');
          break;
        }
      }
      // stall detection: one nudge allowed, ever
      if (Date.now() - lastProgress > STALL_MS) {
        if (nudges >= 1) throw new Error('lieutenant stalled again after the one allowed nudge — doctrine bug');
        nudges++;
        lastProgress = Date.now();
        console.log('    ! stalled ' + STALL_MS / 60000 + ' min — sending the ONE allowed captain nudge (' + elapsed(t0) + ')');
        await api('POST', '/api/feedback', {
          target: 'lieutenant:' + LT,
          text: 'Status check — please continue: create/start the card if you have not, and once the '
            + 'worker is done, verify the change and hand the card to my review with an updated body.',
        });
      }
    }

    // ---------- assertions: the whole loop happened, agentically ----------
    assert.ok(card, 'the lieutenant never created a card');
    const c = (await api('GET', '/api/cards/' + card.id)).body;
    const ev = c.events || [];
    const created = ev.find((e) => e.kind === 'created');
    assert.ok(created && created.actor !== 'user', 'card.create was the lieutenant\'s own act (actor: '
      + (created && created.actor) + ')');
    assert.strictEqual(c.type, 'implementation');
    assert.strictEqual(String(c.attributes.repo), 'proj');
    assert.ok(ev.some((e) => e.kind === 'started'), 'card.start happened (started event)');
    assert.ok(c.attributes.session && c.attributes.session.startsWith('bc-' + workspaceDisc(ws) + '-w-'), 'worker session bound: ' + c.attributes.session);
    assert.ok(ev.some((e) => e.kind === 'worker-done'), 'worker reported done');
    const handoff = ev.find((e) => e.kind === 'handoff' && e.actor !== 'user');
    assert.ok(handoff, 'the handoff event exists and is the lieutenant\'s');
    assert.strictEqual(c.column, 'review', 'card ended in review');
    assert.ok(/greeting\.txt|ahoy/i.test(c.body || ''), 'body rewritten, mentions the change:\n' + c.body);
    // the change is really on the branch, exactly as asked
    const branch = c.attributes.branch || 'bc/' + c.id;
    const clone = path.join(ws, 'projects', 'proj');
    const content = git(clone, 'show', branch + ':greeting.txt');
    assert.strictEqual(content, 'ahoy', 'greeting.txt == ahoy on ' + branch + ', got: ' + JSON.stringify(content));

    const total = elapsed(t0);
    console.log('\nfullloop e2e: PASSED — wake → drain → card.create → card.start → worker → done → '
      + 'verify → handoff, all agentic');
    console.log('  card: ' + c.id + '  branch: ' + branch + '  nudges used: ' + nudges + '  total: ' + total);
    console.log('  milestones: ' + Object.entries(seen).map(([m, ms]) => '[' + (ms / 1000).toFixed(0) + 's] ' + m).join(' | '));
    ok = true;
  } catch (e) {
    console.error('\nfullloop e2e: FAILED');
    console.error(e && e.stack ? e.stack : e);
    dumpDiagnostics();
    process.exitCode = 1;
  } finally {
    for (const s of (tryTmux('list-sessions', '-F', '#S') || '').split('\n').filter(Boolean)) {
      tryTmux('kill-session', '-t', '=' + s + ':');
    }
    tryTmux('kill-server');
    if (server && server.exitCode == null) server.kill('SIGTERM');
    await sleep(300);
    fs.rmSync(tmpRoot, { recursive: true, force: true });
  }
  if (!ok) process.exitCode = 1;
})().catch((e) => { console.error(e); process.exitCode = 1; });
