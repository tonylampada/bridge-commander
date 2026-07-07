#!/usr/bin/env node
// worker e2e — F5/F6 end-to-end with a REAL claude worker in a REAL isolated
// worktree. Node built-ins only.
//
//   node e2e/worker.e2e.js
//
// Scenario, on a throwaway workspace + a PRIVATE tmux server (TMUX_TMPDIR) + a
// local throwaway git repo registered as a local-only project:
//   1. server boots; lieutenant registered; `bc-axi project add` clones the repo.
//   2. an implementation card asks for a trivial, verifiable change (one file,
//      exact content); `bc-axi card start` provisions an isolated worktree and
//      spawns a REAL claude worker session with the brief as launch prompt —
//      the card auto-moves to Working.
//   3. the worker creates branch bc/<card>, makes the change, signals, and
//      reports done via `bc-axi worker done` — worker events land on the card
//      and the done QueueItem lands in the owner's queue.
//   4. asserts: branch exists in the worktree with the exact change; the card
//      was NOT auto-moved out of Working (the lieutenant owns the handoff).
// Everything is cleaned up: sessions, private tmux server, workspace server.
'use strict';

const { spawn, execFileSync } = require('node:child_process');
const assert = require('node:assert');
const net = require('node:net');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const CLI = path.join(__dirname, '..', 'cli', 'bc-axi');
const SERVER_JS = path.join(__dirname, '..', 'server', 'server.js');

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
const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'bc-worker-e2e-'));
const ws = path.join(tmpRoot, 'workspace');
fs.mkdirSync(ws);
const ENV = Object.assign({}, process.env, {
  TMUX_TMPDIR: path.join(tmpRoot, 'tmux'), // private tmux server — no collision with the user's
  BC_HARNESS_STATE: path.join(tmpRoot, 'hstate'),
  BC_WORKTREE_TOOL: 'git', // hermetic worktrees under the throwaway workspace
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
function git(dir, ...args) {
  return execFileSync('git', ['-C', dir, ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
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
async function until(what, fn, ms, step = 1000) {
  const deadline = Date.now() + ms;
  for (;;) {
    const v = await fn();
    if (v) return v;
    if (Date.now() > deadline) throw new Error('timeout waiting for: ' + what);
    await sleep(step);
  }
}

const CARD = 'hello-file';
const SESSION = 'bc-w-' + CARD;
const WANT = 'bridge command was here';

let passed = 0;
async function stepCase(name, fn) {
  try {
    await fn();
    passed++;
    console.log('  ✔ ' + name);
  } catch (e) {
    console.error('  ✖ ' + name);
    console.error(e && e.stack ? e.stack : e);
    console.error('--- worker pane tail ---\n' + capture(SESSION).split('\n').slice(-50).join('\n'));
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
  console.log('workspace: ' + ws + '  port: ' + port + '  tmux: ' + ENV.TMUX_TMPDIR);

  let server = null;
  let worktree = null;
  try {
    await stepCase('server boots; lieutenant + local-only project registered', async () => {
      server = spawn(process.execPath, [SERVER_JS, ws, '--port', String(port)],
        { env: ENV, detached: false, stdio: ['ignore', 'pipe', 'pipe'] });
      await until('server up', async () => (await api('GET', '/api/status').catch(() => null))?.status === 200, 10000, 200);
      assert.strictEqual((await api('POST', '/api/lieutenants', { name: 'Ada', id: 'ada' })).status, 200);

      // the throwaway repo — a purely local project (local-only: no remote, no PR)
      const repo = path.join(tmpRoot, 'srcrepo');
      fs.mkdirSync(repo);
      execFileSync('git', ['init', '-q', '-b', 'main', repo], { env: ENV, stdio: ['ignore', 'pipe', 'pipe'] });
      fs.writeFileSync(path.join(repo, 'README.md'), 'throwaway e2e repo\n');
      git(repo, 'add', '.');
      git(repo, '-c', 'user.email=e2e@bc', '-c', 'user.name=bc-e2e', 'commit', '-q', '-m', 'init');

      const r = await runCli(['project', 'add', repo, '--name', 'proj', '--mode', 'local-only',
        '--workspace', ws, '--port', String(port)]);
      assert.strictEqual(r.code, 0, r.stderr);
      assert.ok(fs.existsSync(path.join(ws, 'projects', 'proj', 'README.md')), 'cloned into the workspace');
    });

    await stepCase('card start: REAL claude worker in a REAL isolated worktree; card auto-moved to Working', async () => {
      const bodyFile = path.join(tmpRoot, 'card-body.md');
      fs.writeFileSync(bodyFile,
        'Create a file named `hello.txt` at the worktree root containing exactly this single line:\n\n'
        + '    ' + WANT + '\n\n'
        + '(no other changes). Commit it with message "add hello.txt". After committing, send one\n'
        + 'worker signal saying "committed". Then report done. Acceptance: `hello.txt` with exactly\n'
        + 'that content, committed on your task branch.\n');
      let r = await runCli(['card', 'create', '--title', 'Hello file', '--id', CARD, '--owner', 'ada',
        '--attr', 'repo=proj', '--body-file', bodyFile, '--workspace', ws, '--port', String(port)]);
      assert.strictEqual(r.code, 0, r.stderr);

      r = await runCli(['card', 'start', CARD, '--workspace', ws, '--port', String(port)]);
      assert.strictEqual(r.code, 0, r.stderr + r.stdout);
      assert.match(r.stdout, /started worker claude:bc-w-hello-file/);

      // the card moved to Working AT START (system move), attrs bound
      const card = (await api('GET', '/api/cards/' + CARD)).body;
      assert.strictEqual(card.column, 'working');
      assert.strictEqual(card.attributes.session, SESSION);
      assert.strictEqual(card.attributes.branch, 'bc/' + CARD);
      worktree = card.attributes.worktree;
      assert.ok(worktree && fs.existsSync(worktree), 'worktree exists: ' + worktree);
      assert.ok(card.events.some((e) => e.kind === 'started'), 'started event on the card');

      // isolation: distinct from the clone, a genuine linked worktree, shared history
      const clone = path.join(ws, 'projects', 'proj');
      assert.notStrictEqual(fs.realpathSync(worktree), fs.realpathSync(clone));
      assert.strictEqual(fs.realpathSync(git(worktree, 'rev-parse', '--show-toplevel')), fs.realpathSync(worktree));
      assert.notStrictEqual(git(worktree, 'rev-parse', '--absolute-git-dir'), git(clone, 'rev-parse', '--absolute-git-dir'));

      // the claude session is really up (pane not sitting at a shell)
      const cmd = tmux('display-message', '-p', '-t', '=' + SESSION + ':', '#{pane_current_command}').trim();
      assert.ok(!['bash', 'zsh', 'sh', 'fish', 'dash', 'ksh'].includes(cmd), 'worker alive, pane runs: ' + cmd);
    });

    await stepCase('worker signals and reports done (events on the card, done QueueItem to the owner)', async () => {
      await until('worker-done queue item for ada', async () => {
        const items = (await api('GET', '/api/feed?lieutenant=ada')).body.items || [];
        return items.some((i) => i.kind === 'worker-done' && i.card === CARD);
      }, 480000);
      const card = (await api('GET', '/api/cards/' + CARD)).body;
      assert.ok(card.events.some((e) => e.kind === 'signal'), 'worker signal event landed on the card');
      assert.ok(card.events.some((e) => e.kind === 'worker-done'), 'worker-done event landed on the card');
      const items = (await api('GET', '/api/feed?lieutenant=ada')).body.items;
      assert.ok(items.some((i) => i.kind === 'worker-signal' && i.card === CARD), 'signal QueueItem');
    });

    await stepCase('branch bc/<card> holds the exact change; the card was NOT auto-moved out of Working', async () => {
      assert.ok(git(worktree, 'rev-parse', '--verify', 'bc/' + CARD), 'branch exists');
      const content = git(worktree, 'show', 'bc/' + CARD + ':hello.txt');
      assert.strictEqual(content, WANT, 'exact file content on the branch, got: ' + JSON.stringify(content));
      const card = (await api('GET', '/api/cards/' + CARD)).body;
      assert.strictEqual(card.column, 'working', 'worker done does not move the card — the lieutenant hands off');
    });

    console.log('\nworker e2e: ' + passed + ' steps passed');
  } finally {
    tryTmux('kill-session', '-t', '=' + SESSION + ':');
    tryTmux('kill-server');
    if (server && server.exitCode == null) server.kill('SIGTERM');
    await sleep(300);
    fs.rmSync(tmpRoot, { recursive: true, force: true });
  }
})().catch(() => { process.exitCode = 1; });
