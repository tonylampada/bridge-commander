'use strict';
// Test helper — boots a bridge server on an ephemeral port with BRIDGE_DIR
// pointing at a fresh temp dir, and tears it down cleanly. Node built-ins only.
//
// Run the suite with:
//   node --test skills/bridge/test/*.test.js
// (Node 24 does not expand a bare directory argument for --test.)
const { spawn } = require('node:child_process');
const net = require('node:net');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const SERVER_JS = path.join(__dirname, '..', 'server.js');
const CLI = path.join(__dirname, '..', 'bridge-axi');

// A neutral column frame for tests (columns are board configuration).
const COLUMNS = [
  { id: 'todo', title: 'To do' },
  { id: 'doing', title: 'Doing' },
  { id: 'review', title: 'Review' },
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

// startServer({ board?, dir?, port?, env?, seed? }) -> { dir, port, board, base, api, stop, child }
//   seed: optional (dir) => {} callback to pre-populate state before the server boots
async function startServer(opts = {}) {
  const dir = opts.dir || fs.mkdtempSync(path.join(os.tmpdir(), 'bridge-test-'));
  const ownDir = !opts.dir;
  if (opts.seed) opts.seed(dir);
  const port = opts.port || (await freePort());
  const board = opts.board || 'testboard';
  const child = spawn(
    process.execPath,
    [SERVER_JS, '--port', String(port), '--board', board, '--host', '127.0.0.1'],
    {
      env: Object.assign({}, process.env, { BRIDGE_DIR: dir }, opts.env || {}),
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

  return { dir, port, board, base, api, stop, child };
}

// Convenience: server with the neutral column frame already installed.
async function startServerWithColumns(opts = {}) {
  const s = await startServer(opts);
  const r = await s.api('PUT', '/api/columns', COLUMNS);
  if (r.status !== 200) {
    await s.stop();
    throw new Error('column setup failed: ' + JSON.stringify(r.body));
  }
  return s;
}

// Run bridge-axi and capture output.
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

module.exports = { startServer, startServerWithColumns, runCli, freePort, sleep, COLUMNS, SERVER_JS, CLI };
