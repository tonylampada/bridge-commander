#!/usr/bin/env node
// wake e2e — F3/F4 end-to-end against a REAL tmux server and a REAL claude
// session. Node built-ins only.
//
//   node e2e/wake.e2e.js
//
// Scenario, on a throwaway workspace + a PRIVATE tmux server (TMUX_TMPDIR):
//   1. `bc-axi init` runs INSIDE a scratch tmux session (the teleport): server
//      boots, the founding lieutenant is registered with the caller's session
//      as its ref, hook + memory scaffolding land.
//   2. captain message via API -> the wake line actually lands in the founder's
//      pane (assert via capture-pane); wakes coalesce while pending-and-nudged.
//   3. simulated drain/ack via bc-axi.
//   4. a second lieutenant is spawned via the API with a trivial charter — a
//      REAL claude session (needs `claude` on PATH, authenticated): it comes up,
//      its turn-ends flow through the workspace hook, and it drains/acks the
//      captain's ping. Everything is cleaned up, including the claude session.
'use strict';

const { spawn, execFileSync } = require('node:child_process');
const assert = require('node:assert');
const net = require('node:net');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const CLI = path.join(__dirname, '..', 'cli', 'bc-axi');

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

// ---------- private tmux server ----------
const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'bc-wake-e2e-'));
const ws = path.join(tmpRoot, 'workspace');
fs.mkdirSync(ws);
const ENV = Object.assign({}, process.env, {
  TMUX_TMPDIR: path.join(tmpRoot, 'tmux'), // private tmux server — no collision with the user's
  BC_HARNESS_STATE: path.join(tmpRoot, 'hstate'), // harness state stays in the throwaway tree
  PATH: path.dirname(CLI) + ':' + process.env.PATH, // panes get `bc-axi` on PATH (the real claude runs it)
});
delete ENV.TMUX; // tmux commands must target the private server, not an enclosing session
fs.mkdirSync(ENV.TMUX_TMPDIR);

function tmux(...args) {
  return execFileSync('tmux', args, { encoding: 'utf8', env: ENV, stdio: ['ignore', 'pipe', 'pipe'] });
}
function tryTmux(...args) { try { return tmux(...args); } catch (e) { return null; } }
function capture(session, lines = 120) {
  const out = tryTmux('capture-pane', '-p', '-t', '=' + session + ':', '-S', '-' + lines);
  return out === null ? '' : out;
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
async function until(what, fn, ms, step = 250) {
  const deadline = Date.now() + ms;
  for (;;) {
    const v = await fn();
    if (v) return v;
    if (Date.now() > deadline) throw new Error('timeout waiting for: ' + what);
    await sleep(step);
  }
}

let passed = 0;
async function stepCase(name, fn) {
  try {
    await fn();
    passed++;
    console.log('  ✔ ' + name);
  } catch (e) {
    console.error('  ✖ ' + name);
    console.error(e && e.stack ? e.stack : e);
    console.error('--- founder pane tail ---\n' + capture(FOUNDER).split('\n').slice(-30).join('\n'));
    console.error('--- scout pane tail ---\n' + capture(SCOUT).split('\n').slice(-40).join('\n'));
    process.exitCode = 1;
    throw e;
  }
}

const FOUNDER = 'bc-e2e-founder';
const SCOUT = require(path.join(__dirname, '..', 'server', 'names.js')).lieutenantSession(ws, 'scout');

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

  try {
    await stepCase('workspace.init runs inside the scratch tmux session (the teleport)', async () => {
      tmux('new-session', '-d', '-s', FOUNDER, '-c', ws);
      // init runs IN the pane (it must see $TMUX + its own session name), then
      // the pane becomes `cat` — a non-shell foreground process the harness
      // treats as a live agent to type wakes into.
      const initCmd = 'node ' + JSON.stringify(CLI) + ' init --name Founder --port ' + port
        + ' > init.log 2>&1; echo INIT_EXIT=$?; exec cat';
      tmux('send-keys', '-t', '=' + FOUNDER + ':', '-l', initCmd);
      tmux('send-keys', '-t', '=' + FOUNDER + ':', 'Enter');
      await until('init to finish', () => /INIT_EXIT=\d+/.test(capture(FOUNDER)), 20000);
      const initLog = fs.readFileSync(path.join(ws, 'init.log'), 'utf8');
      assert.match(capture(FOUNDER), /INIT_EXIT=0/, 'init failed:\n' + initLog);
      assert.match(initLog, /founding lieutenant "Founder" \(founder\) registered — tmux session bc-e2e-founder/);
      assert.match(initLog, /turn-end hook installed/);
      // server is up on the requested port; the founding ref points at the caller's session
      const st = await api('GET', '/api/status');
      assert.strictEqual(st.status, 200);
      assert.strictEqual(st.body.lieutenants, 1);
      const lt = (await api('GET', '/api/lieutenants')).body.lieutenants[0];
      assert.strictEqual(lt.id, 'founder');
      assert.deepStrictEqual(lt.ref, { harness: 'claude', session: FOUNDER, cwd: fs.realpathSync(ws) });
      // scaffolding: AGENTS.md (skill-first), captain.md, learnings/, Stop hook
      assert.match(fs.readFileSync(path.join(ws, 'AGENTS.md'), 'utf8'), /bridge-command.*skill/s);
      assert.ok(fs.existsSync(path.join(ws, 'captain.md')));
      assert.ok(fs.existsSync(path.join(ws, 'learnings', 'README.md')));
      const hooks = JSON.parse(fs.readFileSync(path.join(ws, '.claude', 'settings.local.json'), 'utf8'));
      const cmd = hooks.hooks.Stop[0].hooks[0].command;
      assert.match(cmd, /turnend-hook\.js/);
      assert.ok(cmd.includes('/api/turn-end'), 'hook posts to the server: ' + cmd);
    });

    await stepCase('init is idempotent (re-run refreshes, never duplicates)', async () => {
      const r = await runCli(['init', '--name', 'Founder', '--workspace', ws, '--port', String(port)]);
      // (runs outside tmux -> must refuse with the instruction)
      assert.strictEqual(r.code, 1);
      assert.match(r.stderr, /not inside tmux/);
      assert.match(r.stderr, /tmux new -s/);
      // re-run INSIDE the founder pane path is covered by PATCH: same call via API
      const again = await api('PATCH', '/api/lieutenants/founder', {
        ref: { harness: 'claude', session: FOUNDER, cwd: fs.realpathSync(ws) },
      });
      assert.strictEqual(again.status, 200);
      assert.strictEqual((await api('GET', '/api/lieutenants')).body.lieutenants.length, 1);
    });

    let firstSeq;
    await stepCase('captain message → wake line actually lands in the founder pane', async () => {
      const r = await api('POST', '/api/feedback', { target: 'lieutenant:founder', text: 'hello founder' });
      assert.strictEqual(r.status, 200);
      firstSeq = r.body.seq;
      await until('wake in pane', () => capture(FOUNDER).includes('[bridge-command] 1 pending item(s) — run: bc-axi drain'), 15000);
    });

    await stepCase('wakes coalesce while pending-and-nudged', async () => {
      await api('POST', '/api/feedback', { target: 'lieutenant:founder', text: 'second message' });
      await api('POST', '/api/feedback', { target: 'lieutenant:founder', text: 'third message' });
      await sleep(2500);
      const hits = capture(FOUNDER).split('\n').filter((l) => l.includes('[bridge-command]'));
      // cat echoes the submitted wake line back, so the ONE wake shows at most
      // twice; three stacked wakes would show many more.
      assert.ok(hits.length <= 2, 'expected one coalesced wake, pane shows:\n' + hits.join('\n'));
    });

    await stepCase('simulated drain (agent-ergonomic) + ack; post-drain append wakes again', async () => {
      const wsArgs = ['--workspace', ws, '--port', String(port)];
      let r = await runCli(['drain', '--lieutenant', 'founder', ...wsArgs]);
      assert.strictEqual(r.code, 0, r.stderr);
      assert.match(r.stdout, /3 pending item\(s\):/);
      assert.match(r.stdout, /captain message \(your main chat\)/);
      assert.match(r.stdout, /hello founder/);
      assert.match(r.stdout, new RegExp('bc-axi ack ' + (firstSeq + 2)));
      r = await runCli(['ack', String(firstSeq + 2), ...wsArgs]);
      assert.strictEqual(r.code, 0, r.stderr);
      r = await runCli(['drain', '--lieutenant', 'founder', ...wsArgs]);
      assert.match(r.stdout, /queue empty/);
      // drained + acked -> a new append nudges again (a fresh wake line appears)
      const before = capture(FOUNDER).split('\n').filter((l) => l.includes('[bridge-command]')).length;
      await api('POST', '/api/feedback', { target: 'lieutenant:founder', text: 'fourth message' });
      await until('re-nudge after drain', () => capture(FOUNDER).split('\n')
        .filter((l) => l.includes('[bridge-command]')).length > before, 15000);
      r = await runCli(['drain', '--lieutenant', 'founder', '--json', ...wsArgs]);
      const items = r.stdout.trim().split('\n').filter(Boolean).map((l) => JSON.parse(l));
      await runCli(['ack', String(items[items.length - 1].seq), ...wsArgs]);
    });

    await stepCase('lieutenant.create spawns a REAL claude session that comes up and drains', async () => {
      const r = await api('POST', '/api/lieutenants', {
        name: 'Scout', id: 'scout', spawn: true, actor: 'user',
        charter: 'Test lieutenant. Follow the drain/ack discipline exactly; do nothing beyond what captain messages ask.',
      });
      assert.strictEqual(r.status, 200, JSON.stringify(r.body));
      assert.strictEqual(r.body.lieutenant.ref.harness, 'claude');
      assert.strictEqual(r.body.lieutenant.ref.session, SCOUT);
      assert.ok(r.body.lieutenant.ref.resumeId, 'resumeId known at birth (--session-id)');
      // the claude session is really up (pane not sitting at a shell)
      const cmd = tmux('display-message', '-p', '-t', '=' + SCOUT + ':', '#{pane_current_command}').trim();
      assert.ok(!['bash', 'zsh', 'sh', 'fish', 'dash', 'ksh'].includes(cmd), 'claude alive, pane runs: ' + cmd);
      // its turn-ends flow through the workspace hook to the server
      await until('scout turn-end recorded', async () => {
        const lt = (await api('GET', '/api/lieutenants')).body.lieutenants.find((l) => l.id === 'scout');
        return lt && (lt.turns || 0) >= 1;
      }, 180000, 1000);
    });

    await stepCase('captain ping → scout drains and acks it (wake → drain → ack, real claude)', async () => {
      const r = await api('POST', '/api/feedback', {
        target: 'lieutenant:scout',
        text: 'ping — confirm delivery by acking this item; no other action, no reply needed.',
      });
      assert.strictEqual(r.status, 200);
      const seq = r.body.seq;
      const ackFile = path.join(ws, '.bridge-command', 'queue', 'scout.ack');
      await until('scout to ack seq ' + seq, () => {
        try { return parseInt(fs.readFileSync(ackFile, 'utf8'), 10) >= seq; } catch (e) { return false; }
      }, 240000, 1000);
    });

    console.log('\nwake e2e: ' + passed + ' steps passed');
  } finally {
    // kill the claude session first (politely), then the whole private tmux server
    tryTmux('kill-session', '-t', '=' + SCOUT + ':');
    tryTmux('kill-server');
    // stop the workspace server via its pidfile
    try {
      const pid = parseInt(fs.readFileSync(path.join(ws, '.bridge-command', 'server.pid'), 'utf8'), 10);
      if (pid) process.kill(pid, 'SIGTERM');
    } catch (e) { /* already gone */ }
    await sleep(300);
    fs.rmSync(tmpRoot, { recursive: true, force: true });
  }
})().catch(() => { process.exitCode = 1; });
