'use strict';
// Test helper — boots a bridge-commander server against a fresh temp WORKSPACE
// on an ephemeral port, and tears it down cleanly. Node built-ins only.
//
// Run the suite with:
//   node --test test/*.test.js
// (Node 24 does not expand a bare directory argument for --test.)
const { spawn } = require('node:child_process');
const net = require('node:net');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const SERVER_JS = path.join(__dirname, '..', 'server', 'server.js');
const CLI = path.join(__dirname, '..', 'cli', 'bc-axi');

// The fixed column frame the server owns (mirrors server/server.js).
const COLUMNS = [
  { id: 'backlog', title: '📋 Backlog' },
  { id: 'working', title: '🔨 Working' },
  { id: 'review', title: '👀 Your review' },
  { id: 'peer', title: '🤝 Peer review' },
];

// A port is only yours while something is bound to it. `listen(0)` + `close()`
// hands back a number the kernel is free to give to the very next caller —
// itself, another test file, anything — so a port picked that way and used a
// moment later is a coin flip that gets worse the more test files run at once.
//
// reservePort() KEEPS the socket bound, so nobody else can be handed the
// number, and release() gives it up at the moment the real server takes over.
// The gap between those two is unavoidable (the server binds in another
// process), so every caller that spawns a binder ALSO retries on EADDRINUSE —
// see startServer and retryOnPortClash.
function reservePort() {
  return new Promise((resolve, reject) => {
    const srv = net.createServer();
    srv.once('error', reject);
    srv.listen(0, '127.0.0.1', () => {
      const { port } = srv.address();
      resolve({ port, release: () => new Promise((r) => srv.close(r)) });
    });
  });
}

// A bare port number, released immediately — for callers that hand it to a
// process they spawn themselves. They must survive losing the race:
// wrap the boot in retryOnPortClash().
async function freePort() {
  const held = await reservePort();
  await held.release();
  return held.port;
}

const PORT_CLASH = /EADDRINUSE/;

// Retry an async block that boots something on a port, on the one failure that
// means "somebody else took the number": EADDRINUSE. Any other error is the
// caller's real failure and comes straight back out.
async function retryOnPortClash(fn, attempts = 10) {
  for (let i = 1; ; i++) {
    try {
      return await fn();
    } catch (e) {
      if (i >= attempts || !PORT_CLASH.test(String(e && e.message))) throw e;
    }
  }
}

// startServer({ dir?, port?, env?, seed? }) -> { dir, port, base, api, stop, child }
//   dir: the WORKSPACE (state lives in <dir>/.bridge-commander)
//   seed: optional (dir) => {} callback to pre-populate state before the server boots
async function startServer(opts = {}) {
  const dir = opts.dir || fs.mkdtempSync(path.join(os.tmpdir(), 'bc-test-'));
  const ownDir = !opts.dir;
  if (opts.seed) opts.seed(dir);
  // A pinned port is the caller's assertion (sse.test.js restarts on the same
  // one); it gets no retry here, because a retry would silently move it.
  // Everyone else boots on a reserved port and tries again if it is taken.
  if (opts.port) return bootServer(opts, dir, ownDir, opts.port);
  return retryOnPortClash(async () => {
    const held = await reservePort();
    return bootServer(opts, dir, ownDir, held.port, held);
  });
}

async function bootServer(opts, dir, ownDir, port, held) {
  // Hold the reservation until the last possible instant — the child binds the
  // port itself, so it has to be free when it does.
  if (held) await held.release();
  const child = spawn(
    process.execPath,
    [SERVER_JS, dir, '--port', String(port), '--host', '127.0.0.1'],
    {
      env: Object.assign({}, process.env, opts.env || {}),
      stdio: ['ignore', 'pipe', 'pipe'],
    }
  );
  let stderr = '';
  child.stderr.on('data', (c) => (stderr += c));
  // 'close' rather than 'exit': the reason the child died is in stderr, and
  // only 'close' promises stderr has been fully drained. A boot that lost the
  // port says EADDRINUSE there, and that word is what earns a retry.
  let closed = false;
  const drained = new Promise((r) => child.once('close', () => { closed = true; r(); }));
  const base = 'http://127.0.0.1:' + port;

  const deadline = Date.now() + 10000;
  for (;;) {
    if (closed) throw new Error('server exited early: ' + stderr);
    // A lost port race has a second face: somebody else's server answers on it
    // first, and the test spends its life talking to a stranger's board. Ours
    // is the one whose pid is our child's — anything else is the clash, and
    // our own child is dying of EADDRINUSE behind it.
    let foreign = false;
    try {
      const res = await fetch(base + '/api/status');
      if (res.ok) {
        const st = await res.json().catch(() => null);
        if (st && st.pid === child.pid) break;
        foreign = true;
      }
    } catch (e) {}
    if (foreign) {
      child.kill('SIGKILL');
      await Promise.race([drained, sleep(1000)]);
      throw new Error('EADDRINUSE: 127.0.0.1:' + port + ' already answers for another server');
    }
    if (Date.now() > deadline) {
      child.kill('SIGKILL');
      await Promise.race([drained, sleep(1000)]);
      throw new Error('server did not become ready: ' + stderr);
    }
    await sleep(50);
  }

  async function api(method, p, body) {
    const res = await fetch(base + p, {
      method,
      headers: body != null ? { 'Content-Type': 'application/json' } : {},
      body: body != null ? JSON.stringify(body) : undefined,
    });
    const text = await res.text();
    let json;
    try { json = JSON.parse(text); } catch (e) { json = text; }
    return { status: res.status, body: json };
  }

  async function stop() {
    if (child.exitCode == null) {
      const exited = new Promise((resolve) => child.once('exit', resolve));
      child.kill('SIGTERM');
      await Promise.race([exited, sleep(3000).then(() => child.kill('SIGKILL'))]);
    }
    if (ownDir) fs.rmSync(dir, { recursive: true, force: true });
  }

  return { dir, port, base, api, stop, child };
}

// Convenience: server with one lieutenant ("ada") already registered — most
// card operations need an owner (every card belongs to exactly one lieutenant).
const LT = 'ada';
async function startServerWithLieutenant(opts = {}) {
  const s = await startServer(opts);
  const r = await s.api('POST', '/api/lieutenants', { name: 'Ada', id: LT, color: '#58b6ff' });
  if (r.status !== 200 && !(r.status === 409 && opts.dir)) { // reused workspace already has her
    await s.stop();
    throw new Error('lieutenant setup failed: ' + JSON.stringify(r.body));
  }
  return s;
}

// Card create body with the default owner filled in, and — unless the caller
// pins one — a hand-written SLUG id from the title, the way ids were written
// before lieutenants minted them. So the bulk of the suite keeps exercising
// every verb against a slug id, which is exactly the guarantee the boards
// carrying 60-odd of them need. Minting (<PREFIX>-<n>) is asserted directly,
// without this helper, in cards.test.js.
// Cards are born with a playbook here, as they are from the UI: `default` always
// resolves (the packaged playbooks are the fallback for a workspace nobody
// seeded), so any test that goes on to start the card has one. Pass `playbook`
// explicitly — including `playbook: ''` — to say otherwise.
function withOwner(card) {
  const id = card.id || String(card.title || '').toLowerCase()
    .replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 40) || 'card';
  return Object.assign({ owner: LT, id, playbook: 'default' }, card);
}

// Run bc-axi and capture output.
function runCli(args, env = {}) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [CLI, ...args], {
      env: Object.assign({}, process.env, env),
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (c) => (stdout += c));
    child.stderr.on('data', (c) => (stderr += c));
    child.on('close', (code) => resolve({ code, stdout, stderr }));
  });
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

module.exports = { startServer, startServerWithLieutenant, withOwner, runCli, freePort, reservePort, retryOnPortClash, sleep, COLUMNS, LT, SERVER_JS, CLI };
