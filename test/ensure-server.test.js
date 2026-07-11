'use strict';
// ensureServer auto-boot: verified, logged, never silent (bc/ensure-server).
// Covers the three failure shapes from the papercut: a boot that never
// answers must leave a real logfile and a real error (not stdio:'ignore'
// swallowing everything); a stale/recycled server.pid must not block a real
// boot; and the ordinary success path must still print the URL.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawn } = require('node:child_process');
const { runCli, freePort, sleep } = require('./helper');

function tmpWorkspace() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'bc-ensure-'));
}

async function stopViaPidFile(dir) {
  const pidFile = path.join(dir, '.bridge-commander', 'server.pid');
  let pid;
  try { pid = parseInt(fs.readFileSync(pidFile, 'utf8'), 10); } catch (e) { return; }
  if (!pid) return;
  try { process.kill(pid, 'SIGTERM'); } catch (e) {}
}

test('ensureServer success path: fresh workspace auto-boots, prints the URL, logs to server.log', async () => {
  const dir = tmpWorkspace();
  const port = await freePort();
  try {
    const r = await runCli(['open', '--workspace', dir, '--port', String(port)]);
    assert.strictEqual(r.code, 0, r.stderr);
    assert.match(r.stdout, /http:\/\/localhost:\d+\//);
    assert.match(r.stdout, /started workspace=/);
    const logFile = path.join(dir, '.bridge-commander', 'server.log');
    assert.ok(fs.existsSync(logFile), 'server.log written on boot');
    assert.match(fs.readFileSync(logFile, 'utf8'), /bridge-commander server up/);
  } finally {
    await stopViaPidFile(dir);
    await sleep(100);
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('ensureServer boot failure: surfaces a real error pointing at the logfile, non-zero exit, log has the crash', async () => {
  const dir = tmpWorkspace();
  const port = await freePort();
  const crasher = path.join(dir, 'crash-server.js');
  fs.writeFileSync(crasher, '#!/usr/bin/env node\nconsole.error("boom: simulated crash for test");\nprocess.exit(1);\n');
  try {
    const r = await runCli(['open', '--workspace', dir, '--port', String(port)], { BC_SERVER_JS: crasher });
    assert.notStrictEqual(r.code, 0, 'non-zero exit on boot failure');
    assert.match(r.stderr, /server failed to start/);
    assert.match(r.stderr, /server\.log/);
    const logFile = path.join(dir, '.bridge-commander', 'server.log');
    assert.ok(fs.existsSync(logFile), 'server.log written even on a crashing boot');
    assert.match(fs.readFileSync(logFile, 'utf8'), /boom: simulated crash for test/);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('ensureServer stale pid: a live pid recycled to a non-bc process does not block a real boot', async () => {
  const dir = tmpWorkspace();
  const port = await freePort();
  const stateDir = path.join(dir, '.bridge-commander');
  fs.mkdirSync(stateDir, { recursive: true });
  // A genuinely alive process whose cmdline does NOT mention server.js —
  // stands in for "pid recycled to a non-bc process" without racing a real pid reuse.
  const impostor = spawn(process.execPath, ['-e', 'setTimeout(() => {}, 10000)'], { stdio: 'ignore' });
  fs.writeFileSync(path.join(stateDir, 'server.pid'), String(impostor.pid));
  try {
    const r = await runCli(['open', '--workspace', dir, '--port', String(port)]);
    assert.strictEqual(r.code, 0, r.stderr);
    assert.match(r.stdout, /started workspace=/, 'boots for real instead of no-op-ing on the stale pidfile');
    const pidOnDisk = parseInt(fs.readFileSync(path.join(stateDir, 'server.pid'), 'utf8'), 10);
    assert.notStrictEqual(pidOnDisk, impostor.pid, 'pidfile now holds the real server pid, not the impostor');
  } finally {
    impostor.kill('SIGKILL');
    await stopViaPidFile(dir);
    await sleep(100);
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('ensureServer stale pid: a dead pid does not block a real boot (pre-existing behavior, still green)', async () => {
  const dir = tmpWorkspace();
  const port = await freePort();
  const stateDir = path.join(dir, '.bridge-commander');
  fs.mkdirSync(stateDir, { recursive: true });
  // A pid almost certainly not alive: spawn+exit immediately, then reuse its number.
  const dead = spawn(process.execPath, ['-e', '0'], { stdio: 'ignore' });
  await new Promise((resolve) => dead.on('exit', resolve));
  fs.writeFileSync(path.join(stateDir, 'server.pid'), String(dead.pid));
  try {
    const r = await runCli(['open', '--workspace', dir, '--port', String(port)]);
    assert.strictEqual(r.code, 0, r.stderr);
    assert.match(r.stdout, /started workspace=/);
  } finally {
    await stopViaPidFile(dir);
    await sleep(100);
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
