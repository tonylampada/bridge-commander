'use strict';
// F6 — the project registry: workspace.addProject clones into
// <workspace>/projects/<name> and records {name, path}; the registry is board
// state (survives restarts) and gates card.start. There is no delivery mode on
// a project — how finished work leaves the worktree is the CARD's playbook.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const { startServerWithLieutenant, withOwner, runCli } = require('./helper');

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

// ---------- what the projects tab reads ----------
// The registry alone does not say whether a project is worth looking at, nor
// whether a start off it will work. `cards` is board data and always there;
// remote and default branch are read off the clone and only for a caller that
// asks, because every other caller of this route wants neither.
test('GET /api/projects: live-card count always, git facts only with ?git=1, ordered by use', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'bc-projects-'));
  const repo = makeRepo(root, 'alpha');
  const wsDir = path.join(root, 'ws');
  fs.mkdirSync(wsDir);
  const s = await startServerWithLieutenant({ dir: wsDir });
  try {
    for (const name of ['alpha', 'beta', 'gamma']) {
      assert.strictEqual((await s.api('POST', '/api/projects', { source: repo, name })).status, 200);
    }
    // gamma: two live cards. alpha: one live and one archived — the archived one
    // does not count. beta: none.
    await s.api('POST', '/api/cards', withOwner({ title: 'g one', attributes: { repo: 'gamma' } }));
    await s.api('POST', '/api/cards', withOwner({ title: 'g two', attributes: { repo: 'gamma' } }));
    await s.api('POST', '/api/cards', withOwner({ title: 'a one', attributes: { repo: 'alpha' } }));
    await s.api('POST', '/api/cards', withOwner({ title: 'a gone', attributes: { repo: 'alpha' } }));
    assert.strictEqual((await s.api('POST', '/api/cards/a-gone/archive', { actor: 'agent' })).status, 200);

    let list = (await s.api('GET', '/api/projects')).body.projects;
    assert.deepStrictEqual(list.map((p) => [p.name, p.cards]),
      [['gamma', 2], ['alpha', 1], ['beta', 0]], 'card count descending, then name');
    assert.ok(list.every((p) => p.remote === undefined && p.branch === undefined),
      'no git read for a caller that did not ask');

    list = (await s.api('GET', '/api/projects?git=1')).body.projects;
    const gamma = list.find((p) => p.name === 'gamma');
    assert.strictEqual(gamma.remote, repo, 'a real checkout says where it pushes');
    assert.strictEqual(gamma.branch, 'main', 'and the branch a worktree starts detached from');
    assert.strictEqual(gamma.missing, false);
    assert.strictEqual(gamma.cards, 2, 'the count is there either way');
  } finally {
    await s.stop();
    fs.rmSync(root, { recursive: true, force: true });
  }
});

// A path that is gone, or is a directory that was never a checkout, is exactly
// when the row matters — so it renders with what there is, and the request is
// still a 200.
test('GET /api/projects?git=1: an unreadable clone is null fields, never an error', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'bc-projects-'));
  const repo = makeRepo(root, 'app');
  const wsDir = path.join(root, 'ws');
  fs.mkdirSync(wsDir);
  const s = await startServerWithLieutenant({ dir: wsDir });
  try {
    for (const name of ['ghost', 'bare']) {
      assert.strictEqual((await s.api('POST', '/api/projects', { source: repo, name })).status, 200);
    }
    fs.rmSync(path.join(wsDir, 'projects', 'ghost'), { recursive: true, force: true });
    fs.rmSync(path.join(wsDir, 'projects', 'bare', '.git'), { recursive: true, force: true });

    const r = await s.api('GET', '/api/projects?git=1');
    assert.strictEqual(r.status, 200);
    const by = Object.fromEntries(r.body.projects.map((p) => [p.name, p]));
    assert.deepStrictEqual([by.ghost.remote, by.ghost.branch], [null, null], 'nothing on disk to read');
    assert.strictEqual(by.ghost.missing, true, 'and the row says the path is gone');
    assert.deepStrictEqual([by.bare.remote, by.bare.branch], [null, null], 'a directory is not a checkout');
    assert.strictEqual(by.bare.missing, false, 'the path is there — it is just not a repo');
  } finally {
    await s.stop();
    fs.rmSync(root, { recursive: true, force: true });
  }
});
