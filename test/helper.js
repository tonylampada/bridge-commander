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

// startServer({ dir?, port?, env?, seed? }) -> { dir, port, base, api, stop, child }
//   dir: the WORKSPACE (state lives in <dir>/.bridge-commander)
//   seed: optional (dir) => {} callback to pre-populate state before the server boots
async function startServer(opts = {}) {
  const dir = opts.dir || fs.mkdtempSync(path.join(os.tmpdir(), 'bc-test-'));
  const ownDir = !opts.dir;
  if (opts.seed) opts.seed(dir);
  const port = opts.port || (await freePort());
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
  const base = 'http://127.0.0.1:' + port;

  const deadline = Date.now() + 10000;
  for (;;) {
    if (child.exitCode != null) throw new Error('server exited early: ' + stderr);
    try {
      const res = await fetch(base + '/api/status');
      if (res.ok) break;
    } catch (e) {}
    if (Date.now() > deadline) {
      child.kill('SIGKILL');
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

// Card create body with the default owner filled in.
function withOwner(card) { return Object.assign({ owner: LT }, card); }

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

module.exports = { startServer, startServerWithLieutenant, withOwner, runCli, freePort, sleep, COLUMNS, LT, SERVER_JS, CLI };
