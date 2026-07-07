#!/usr/bin/env node
// prwatch e2e — the PR watch against a REAL GitHub PR. Node built-ins only.
//
//   node e2e/prwatch.e2e.js
//
// Needs: tmux, claude (authenticated), gh (authenticated). Uses ONE dedicated
// PRIVATE scratch repo, `<login>/bc-e2e-scratch`, under the authenticated gh
// account — created on first run, reused (and left in place) afterwards. No
// other repo is ever touched.
//
// Scenario, on a throwaway workspace + a PRIVATE tmux server (TMUX_TMPDIR):
//   1. server boots (PR watch every 10s); lieutenant registered; the scratch
//      GitHub repo is registered as a direct-PR project (real clone over https).
//   2. an implementation card asks for a trivial unique change; `card start`
//      spawns a REAL claude worker in a REAL isolated worktree.
//   3. the worker implements on bc/<card>, pushes, opens a REAL PR via gh, and
//      reports done — the PR URL auto-populates the card's `prs` attribute.
//   4. the test merges the PR itself with gh (squash), and asserts the PR watch
//      end-to-end effect: card archived (reason merged, landed level-1 bell),
//      worktree released, worker session KILLED, pr-merged QueueItem queued.
// Cleanup: sessions, private tmux server, workspace server, temp tree. The
// scratch repo intentionally survives for the next run.
'use strict';

const { spawn, execFileSync } = require('node:child_process');
const assert = require('node:assert');
const crypto = require('node:crypto');
const net = require('node:net');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const CLI = path.join(__dirname, '..', 'cli', 'bc-axi');
const SERVER_JS = path.join(__dirname, '..', 'server', 'server.js');
const SCRATCH = 'bc-e2e-scratch';

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
const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'bc-prwatch-e2e-'));
const ws = path.join(tmpRoot, 'workspace');
fs.mkdirSync(ws);
const ENV = Object.assign({}, process.env, {
  TMUX_TMPDIR: path.join(tmpRoot, 'tmux'),
  BC_HARNESS_STATE: path.join(tmpRoot, 'hstate'),
  BC_WORKTREE_TOOL: 'git',
  BC_PRWATCH_INTERVAL_MS: '10000', // fast merge detection for the test
  PATH: path.dirname(CLI) + ':' + process.env.PATH,
});
delete ENV.TMUX;
fs.mkdirSync(ENV.TMUX_TMPDIR);

function tmux(...args) {
  return execFileSync('tmux', args, { encoding: 'utf8', env: ENV, stdio: ['ignore', 'pipe', 'pipe'] });
}
function tryTmux(...args) { try { return tmux(...args); } catch (e) { return null; } }
function capture(session, lines = 120) {
  const out = tryTmux('capture-pane', '-p', '-t', '=' + session + ':', '-S', '-' + lines);
  return out === null ? '' : out;
}
function gh(...args) {
  return execFileSync('gh', args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
}
function runCli(args) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [CLI, ...args], { env: ENV, stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '', stderr = '';
    child.stdout.on('data', (c) => (stdout += c));
    child.stderr.on('data', (c) => (stderr += c));
    child.on('close', (code) => resolve({ code, stdout, stderr }));
  });
}
async function until(what, fn, ms, step = 2000) {
  const deadline = Date.now() + ms;
  for (;;) {
    const v = await fn();
    if (v) return v;
    if (Date.now() > deadline) throw new Error('timeout waiting for: ' + what);
    await sleep(step);
  }
}

const RUN = crypto.randomBytes(3).toString('hex');
const CARD = 'prwatch-' + RUN;
const SESSION = require(path.join(__dirname, '..', 'server', 'names.js')).workerSession(ws, CARD);
const FILE = 'runs/' + RUN + '.txt';
const WANT = 'pr watch e2e ' + RUN;

let passed = 0;
async function stepCase(name, fn) {
  try {
    await fn();
    passed++;
    console.log('  ✔ ' + name);
  } catch (e) {
    console.error('  ✖ ' + name);
    console.error(e && e.stack ? e.stack : e);
    console.error('--- worker pane tail ---\n' + capture(SESSION).split('\n').slice(-60).join('\n'));
    process.exitCode = 1;
    throw e;
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
  console.log('workspace: ' + ws + '  port: ' + port + '  run: ' + RUN);

  let server = null;
  let worktree = null;
  let prUrl = null;
  try {
    const login = gh('api', 'user', '-q', '.login');
    const repoUrl = 'https://github.com/' + login + '/' + SCRATCH + '.git';

    await stepCase('scratch repo ' + login + '/' + SCRATCH + ' exists (created private on first run, reused after)', async () => {
      try {
        assert.strictEqual(gh('repo', 'view', login + '/' + SCRATCH, '--json', 'visibility', '-q', '.visibility'), 'PRIVATE');
      } catch (e) {
        gh('repo', 'create', login + '/' + SCRATCH, '--private', '--add-readme',
          '--description', 'bridge-command e2e scratch repo');
        await until('fresh repo visible', async () => {
          try { return gh('repo', 'view', login + '/' + SCRATCH, '--json', 'visibility', '-q', '.visibility') === 'PRIVATE'; }
          catch (e2) { return false; }
        }, 30000);
      }
    });

    await stepCase('server boots; lieutenant + direct-PR project registered (real clone from GitHub)', async () => {
      server = spawn(process.execPath, [SERVER_JS, ws, '--port', String(port)],
        { env: ENV, detached: false, stdio: ['ignore', 'pipe', 'pipe'] });
      await until('server up', async () => (await api('GET', '/api/status').catch(() => null))?.status === 200, 10000, 200);
      assert.strictEqual((await api('POST', '/api/lieutenants', { name: 'Ada', id: 'ada' })).status, 200);
      const r = await runCli(['project', 'add', repoUrl, '--name', 'scratch', '--mode', 'direct-PR',
        '--workspace', ws, '--port', String(port)]);
      assert.strictEqual(r.code, 0, r.stderr);
      assert.ok(fs.existsSync(path.join(ws, 'projects', 'scratch', '.git')), 'cloned into the workspace');
    });

    await stepCase('card start: REAL worker spawned for the direct-PR card', async () => {
      const bodyFile = path.join(tmpRoot, 'card-body.md');
      fs.writeFileSync(bodyFile,
        'Create a file `' + FILE + '` containing exactly this single line:\n\n'
        + '    ' + WANT + '\n\n'
        + '(no other changes; create parent dirs as needed). Commit it with message "add ' + FILE + '".\n'
        + 'Then follow your delivery contract: push the branch and open a PR titled "e2e: add ' + FILE + '"\n'
        + 'with a one-line body. Acceptance: the PR exists and contains only that file.\n');
      let r = await runCli(['card', 'create', '--title', 'PR watch e2e ' + RUN, '--id', CARD, '--owner', 'ada',
        '--attr', 'repo=scratch', '--body-file', bodyFile, '--workspace', ws, '--port', String(port)]);
      assert.strictEqual(r.code, 0, r.stderr);
      r = await runCli(['card', 'start', CARD, '--workspace', ws, '--port', String(port)]);
      assert.strictEqual(r.code, 0, r.stderr + r.stdout);
      const card = (await api('GET', '/api/cards/' + CARD)).body;
      assert.strictEqual(card.column, 'working');
      assert.strictEqual(card.attributes.branch, 'bc/' + CARD);
      worktree = card.attributes.worktree;
      assert.ok(worktree && fs.existsSync(worktree), 'worktree exists: ' + worktree);
    });

    await stepCase('worker pushes a REAL branch and opens a REAL PR (done outcome carries the URL)', async () => {
      await until('worker-done queue item with a PR url', async () => {
        const items = (await api('GET', '/api/feed?lieutenant=ada')).body.items || [];
        return items.some((i) => i.kind === 'worker-done' && i.card === CARD);
      }, 600000);
      const card = (await api('GET', '/api/cards/' + CARD)).body;
      const prs = card.attributes.prs || [];
      assert.strictEqual(prs.length, 1, 'exactly one PR on the card: ' + JSON.stringify(prs));
      assert.strictEqual(prs[0].state, 'open');
      prUrl = prs[0].url;
      assert.ok(prUrl.startsWith('https://github.com/' + login + '/' + SCRATCH + '/pull/'), prUrl);
      // the PR is real and open on GitHub
      assert.strictEqual(gh('pr', 'view', prUrl, '--json', 'state', '-q', '.state'), 'OPEN');
      console.log('    PR: ' + prUrl);
    });

    await stepCase('captain merges with gh → PR watch archives (merged), releases worktree, kills the worker session', async () => {
      gh('pr', 'merge', prUrl, '--squash', '--delete-branch');
      // the watch (10s cadence) must see MERGED and do the whole cleanup
      await until('card archived on merge', async () =>
        (await api('GET', '/api/cards/' + CARD)).status === 404, 120000);
      const rec = (await api('GET', '/api/archive')).body.archive.find((r) => r.card.id === CARD);
      assert.strictEqual(rec.reason, 'merged');
      assert.ok(rec.note.includes(prUrl), 'archive note carries the PR URL: ' + rec.note);
      assert.strictEqual(rec.card.attributes.prs[0].state, 'merged');
      // landed level-1 bell on the board stream
      const b = (await api('GET', '/api/board')).body;
      const landed = b.events.find((e) => e.kind === 'landed' && e.card === CARD);
      assert.ok(landed && landed.level === 1, 'landed level-1 event');
      // worktree released (worker committed everything — clean)
      await until('worktree released', async () => !fs.existsSync(worktree), 30000);
      // the lingering done-worker session was killed (harness.kill)
      await until('worker session killed', async () => tryTmux('has-session', '-t', '=' + SESSION + ':') === null, 30000);
      // the owner got the pr-merged QueueItem
      const items = (await api('GET', '/api/feed?lieutenant=ada')).body.items;
      assert.ok(items.some((i) => i.kind === 'pr-merged' && i.card === CARD && i.text === prUrl), 'pr-merged QueueItem');
      // the merge is real on GitHub too
      assert.strictEqual(gh('pr', 'view', prUrl, '--json', 'state', '-q', '.state'), 'MERGED');
    });

    console.log('\nprwatch e2e: ' + passed + ' steps passed (scratch repo left in place)');
  } finally {
    tryTmux('kill-session', '-t', '=' + SESSION + ':');
    tryTmux('kill-server');
    if (server && server.exitCode == null) server.kill('SIGTERM');
    await sleep(300);
    fs.rmSync(tmpRoot, { recursive: true, force: true });
  }
})().catch(() => { process.exitCode = 1; });
