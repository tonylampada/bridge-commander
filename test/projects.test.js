'use strict';
// F6 — the project registry: workspace.addProject clones into
// <workspace>/projects/<name> and records {name, path}; the registry is board
// state (survives restarts) and gates card.start. There is no delivery mode on
// a project — how finished work leaves the worktree is the CARD's brief.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const { startServerWithLieutenant, runCli } = require('./helper');

function makeRepo(root, name) {
  const repo = path.join(root, name);
  fs.mkdirSync(repo, { recursive: true });
  execFileSync('git', ['init', '-q', '-b', 'main', repo], { stdio: ['ignore', 'pipe', 'pipe'] });
  fs.writeFileSync(path.join(repo, 'README.md'), 'hi\n');
  execFileSync('git', ['-C', repo, 'add', '.'], { stdio: ['ignore', 'pipe', 'pipe'] });
  execFileSync('git', ['-C', repo, '-c', 'user.email=t@t', '-c', 'user.name=t', 'commit', '-q', '-m', 'init'],
    { stdio: ['ignore', 'pipe', 'pipe'] });
  return repo;
}

test('project add: clone + register {name, path}; validation; list; persistence', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'bc-projects-'));
  const repo = makeRepo(root, 'myapp');
  const wsDir = path.join(root, 'ws');
  fs.mkdirSync(wsDir);
  let s = await startServerWithLieutenant({ dir: wsDir });
  try {
    // missing source
    let r = await s.api('POST', '/api/projects', {});
    assert.strictEqual(r.status, 400);
    assert.match(r.body.error, /source required/);

    // a mode is no longer a thing: it is neither required nor recorded
    r = await s.api('POST', '/api/projects', { source: repo, mode: 'yolo' });
    assert.strictEqual(r.status, 200, JSON.stringify(r.body));
    assert.strictEqual(r.body.project.name, 'myapp');
    assert.strictEqual(r.body.project.mode, undefined);
    assert.strictEqual(r.body.project.path, path.join(wsDir, 'projects', 'myapp'));
    assert.ok(fs.existsSync(path.join(wsDir, 'projects', 'myapp', 'README.md')), 'really cloned');

    // duplicate name refused; explicit --name carves a second registration
    r = await s.api('POST', '/api/projects', { source: repo });
    assert.strictEqual(r.status, 409);
    r = await s.api('POST', '/api/projects', { source: repo, name: 'myapp-2' });
    assert.strictEqual(r.status, 200);

    // clone failure = clean error, nothing registered
    r = await s.api('POST', '/api/projects', { source: path.join(root, 'nope'), name: 'ghost' });
    assert.strictEqual(r.status, 502);
    assert.match(r.body.error, /clone failed/);

    // list via CLI
    const cli = await runCli(['project', 'list', '--workspace', wsDir, '--port', String(s.port)]);
    assert.strictEqual(cli.code, 0, cli.stderr);
    assert.match(cli.stdout, /myapp\t\//);
    assert.match(cli.stdout, /myapp-2\t\//);

    // registry survives a restart (board is truth)
    await s.stop();
    s = await startServerWithLieutenant({ dir: wsDir });
    const list = (await s.api('GET', '/api/projects')).body.projects;
    assert.deepStrictEqual(list.map((p) => p.name).sort(), ['myapp', 'myapp-2']);
    // a `mode` that was persisted before this change is dropped on the next write
    assert.ok(list.every((p) => p.mode === undefined), 'no mode survives a reload');
    assert.strictEqual((await s.api('GET', '/api/status')).body.projects, 2);
  } finally {
    await s.stop();
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('project add via CLI clones and registers', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'bc-projects-'));
  const repo = makeRepo(root, 'cli-app');
  const wsDir = path.join(root, 'ws');
  fs.mkdirSync(wsDir);
  const s = await startServerWithLieutenant({ dir: wsDir });
  try {
    const r = await runCli(['project', 'add', repo, '--workspace', wsDir, '--port', String(s.port)]);
    assert.strictEqual(r.code, 0, r.stderr);
    assert.match(r.stdout, /project cli-app registered at /);
    // --mode is gone, and gone loudly: an unknown flag is refused rather than
    // slid into the positionals where it would half-work
    const stale = await runCli(['project', 'add', repo, '--mode', 'no-mistakes',
      '--name', 'stale', '--workspace', wsDir, '--port', String(s.port)]);
    assert.strictEqual(stale.code, 1);
    assert.match(stale.stderr, /unknown flag --mode/);
  } finally {
    await s.stop();
    fs.rmSync(root, { recursive: true, force: true });
  }
});
