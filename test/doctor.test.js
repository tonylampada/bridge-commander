'use strict';
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const net = require('node:net');
const { spawn } = require('node:child_process');
const { CLI } = require('./helper');

function runDoctor(args, opts = {}) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [CLI, 'doctor', ...args], {
      cwd: opts.cwd,
      env: Object.assign({}, process.env, opts.env || {}),
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (c) => (stdout += c));
    child.stderr.on('data', (c) => (stderr += c));
    child.on('close', (code) => resolve({ code, stdout, stderr }));
  });
}

function makeStub(binDir, name, script) {
  const file = path.join(binDir, name);
  fs.writeFileSync(file, script, { mode: 0o755 });
}

test('bc-axi doctor runs outside a workspace and reports actionable preflight state', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bc-doctor-'));
  try {
    const r = await runDoctor([], { cwd: dir });
    assert.notStrictEqual(r.code, 0, 'doctor should fail when prerequisites are missing');
    assert.match(r.stdout, /Bridge Commander doctor/i);
    assert.match(r.stdout, /workspace/i);
    assert.doesNotMatch(r.stderr, /no workspace found/i);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('bc-axi doctor checks command availability, auth, tmux, workspace, and busy port', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bc-doctor-'));
  const binDir = path.join(dir, 'bin');
  fs.mkdirSync(path.join(dir, '.bridge-commander'), { recursive: true });
  fs.mkdirSync(binDir, { recursive: true });
  const port = 48999;
  fs.writeFileSync(path.join(dir, '.bridge-commander', 'config.json'), JSON.stringify({ port }, null, 2));

  makeStub(binDir, 'tmux', '#!/bin/sh\nif [ "$1" = "display-message" ]; then\n  printf "bridge-session\\n"\n  exit 0\nfi\nexit 0\n');
  makeStub(binDir, 'git', '#!/bin/sh\nprintf "git version 2.45.0\\n"\n');
  makeStub(binDir, 'gh', '#!/bin/sh\nif [ "$1" = "auth" ] && [ "$2" = "status" ]; then\n  printf "logged in as botmarvin\\n"\n  exit 0\nfi\nprintf "gh version 2.45.0\\n"\n');
  makeStub(binDir, 'claude', '#!/bin/sh\nprintf "claude 1.0.0\\n"\n');
  makeStub(binDir, 'codex', '#!/bin/sh\nif [ "$1" = "login" ] && [ "$2" = "status" ]; then\n  printf "Logged in\\n"\n  exit 0\nfi\nprintf "codex 1.0.0\\n"\n');

  const busy = net.createServer();
  await new Promise((resolve) => busy.listen(port, '127.0.0.1', resolve));
  try {
    const env = {
      PATH: binDir + path.delimiter + process.env.PATH,
      TMUX: '/tmp/tmux-stub',
    };
    const r = await runDoctor(['--workspace', dir], { cwd: dir, env });
    assert.notStrictEqual(r.code, 0, 'doctor should fail on a busy port');
    assert.match(r.stdout, /node/i);
    assert.match(r.stdout, /tmux[\s\S]*installed/i);
    assert.match(r.stdout, /git[\s\S]*installed/i);
    assert.match(r.stdout, /gh[\s\S]*authenticated/i);
    assert.match(r.stdout, /claude[\s\S]*installed/i);
    assert.match(r.stdout, /codex[\s\S]*authenticated/i);
    assert.match(r.stdout, /inside tmux/i);
    assert.match(r.stdout, /workspace[\s\S]*yes/i);
    assert.match(r.stdout, new RegExp(String(port) + '[\\s\\S]*in use'));
  } finally {
    await new Promise((resolve) => busy.close(resolve));
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
