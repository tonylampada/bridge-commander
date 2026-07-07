'use strict';
// The server never blocks its event loop on subprocesses (papercuts #4/#6/#11).
//
// A `git` shim on PATH sleeps on the expensive subcommands (clone, worktree)
// before delegating to the real git — the moral equivalent of a multi-GB repo.
// While those crawl, the server must keep answering: on the old execFileSync
// code every probe below stalled for the full sleep; now it answers in ms.
// The async window the conversion opens is guarded: a second start of the
// same card and a duplicate in-flight project add are refused, not raced.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const { startServerWithLieutenant, withOwner, sleep } = require('./helper');

const REAL_GIT = execFileSync('which', ['git'], { encoding: 'utf8' }).trim();

function git(dir, ...args) {
  return execFileSync(REAL_GIT, ['-C', dir, ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
}
function makeRepo(root, name = 'srcrepo') {
  const repo = path.join(root, name);
  fs.mkdirSync(repo, { recursive: true });
  execFileSync(REAL_GIT, ['init', '-q', '-b', 'main', repo], { stdio: ['ignore', 'pipe', 'pipe'] });
  fs.writeFileSync(path.join(repo, 'README.md'), 'hello\n');
  git(repo, 'add', '.');
  git(repo, '-c', 'user.email=t@t', '-c', 'user.name=t', 'commit', '-q', '-m', 'init');
  return repo;
}

// A git shim that sleeps SLOW_GIT_MS before clone/worktree work, then execs
// the real git. Fast plumbing (rev-parse, status) passes straight through.
function makeSlowGit(root, sleepMs) {
  const bin = path.join(root, 'slowbin');
  fs.mkdirSync(bin, { recursive: true });
  fs.writeFileSync(path.join(bin, 'git'),
    '#!/bin/bash\n' +
    'for a in "$@"; do\n' +
    '  if [ "$a" = "clone" ] || [ "$a" = "worktree" ]; then\n' +
    '    sleep ' + (sleepMs / 1000) + '\n' +
    '    break\n' +
    '  fi\n' +
    'done\n' +
    'exec ' + JSON.stringify(REAL_GIT) + ' "$@"\n');
  fs.chmodSync(path.join(bin, 'git'), 0o755);
  return bin;
}

async function boot(root, sleepMs) {
  const bin = makeSlowGit(root, sleepMs);
  return startServerWithLieutenant({
    env: {
      PATH: bin + path.delimiter + process.env.PATH,
      BC_FAKE_STATE: path.join(root, 'fake'), BC_WORKTREE_TOOL: 'git',
      BC_SUPERVISE_INTERVAL_MS: '0', BC_PRWATCH_INTERVAL_MS: '0',
    },
  });
}

// Probe latency while `work` is in flight. Fails loudly if `work` finished
// before the probe ran (the slow window never overlapped — a broken test).
async function probeDuring(work, probe) {
  let settled = false;
  const guarded = work.then((r) => { settled = true; return r; });
  await sleep(150); // let the slow subprocess start
  assert.strictEqual(settled, false, 'slow operation finished before the probe — widen the sleep');
  const t0 = Date.now();
  const res = await probe();
  const elapsed = Date.now() - t0;
  return { result: await guarded, elapsed, probeRes: res };
}

test('project add (slow clone) does not block other requests', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'bc-unblock-'));
  const repo = makeRepo(root);
  const s = await boot(root, 2000);
  try {
    const adding = s.api('POST', '/api/projects', { source: repo, name: 'proj', mode: 'local-only' });
    const { result, elapsed, probeRes } = await probeDuring(adding, () => s.api('GET', '/api/status'));
    assert.strictEqual(probeRes.status, 200);
    assert.ok(elapsed < 1000, '/api/status answered in ' + elapsed + 'ms while a 2s clone was in flight');
    assert.strictEqual(result.status, 200, JSON.stringify(result.body));
    assert.ok(fs.existsSync(path.join(s.dir, 'projects', 'proj', 'README.md')), 'really cloned');
  } finally {
    await s.stop();
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('card start burst (slow worktree add) keeps the board answering; all starts land', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'bc-unblock-'));
  const repo = makeRepo(root);
  const s = await boot(root, 2000);
  try {
    // registration pays the slow clone once, awaited up front
    const reg = await s.api('POST', '/api/projects', { source: repo, name: 'proj', mode: 'local-only' });
    assert.strictEqual(reg.status, 200, JSON.stringify(reg.body));
    for (const id of ['b1', 'b2', 'b3']) {
      await s.api('POST', '/api/cards', withOwner({ title: id, id, attributes: { repo: 'proj' } }));
    }
    // 3 concurrent starts: worktree adds are serialized per clone (git lock
    // safety), so the slow window is ~6s — the board must answer inside it.
    const burst = Promise.all(['b1', 'b2', 'b3'].map((id) =>
      s.api('POST', '/api/cards/' + id + '/start', { harness: 'fake' })));
    const { result, elapsed, probeRes } = await probeDuring(burst, () => s.api('GET', '/api/board'));
    assert.strictEqual(probeRes.status, 200);
    assert.ok(elapsed < 1000, '/api/board answered in ' + elapsed + 'ms during a 3-way start burst');
    for (const r of result) assert.strictEqual(r.status, 200, JSON.stringify(r.body));
    // every card really landed in Working with its own isolated worktree
    const worktrees = new Set();
    for (const id of ['b1', 'b2', 'b3']) {
      const card = (await s.api('GET', '/api/cards/' + id)).body;
      assert.strictEqual(card.column, 'working');
      worktrees.add(card.attributes.worktree);
    }
    assert.strictEqual(worktrees.size, 3, 'three distinct worktrees');
  } finally {
    await s.stop();
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('async window is guarded: same-card double start and duplicate in-flight project add refuse', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'bc-unblock-'));
  const repo = makeRepo(root);
  const s = await boot(root, 1000);
  try {
    const reg = await s.api('POST', '/api/projects', { source: repo, name: 'proj', mode: 'local-only' });
    assert.strictEqual(reg.status, 200, JSON.stringify(reg.body));
    await s.api('POST', '/api/cards', withOwner({ title: 'One', id: 'one', attributes: { repo: 'proj' } }));

    // two concurrent starts of the SAME card: exactly one wins
    const [a, b] = await Promise.all([
      s.api('POST', '/api/cards/one/start', { harness: 'fake' }),
      s.api('POST', '/api/cards/one/start', { harness: 'fake' }),
    ]);
    const statuses = [a.status, b.status].sort();
    assert.deepStrictEqual(statuses, [200, 409], JSON.stringify([a.body, b.body]));
    const loser = a.status === 409 ? a : b;
    assert.match(loser.body.error, /already in progress|already Working/);
    const disk = JSON.parse(fs.readFileSync(path.join(s.dir, '.bridge-command', 'board.json'), 'utf8'));
    assert.strictEqual(disk.workers.filter((w) => w.card === 'one').length, 1, 'exactly one worker bound');

    // two concurrent adds of the SAME project name: exactly one clone lands
    const [c, d] = await Promise.all([
      s.api('POST', '/api/projects', { source: repo, name: 'dup', mode: 'local-only' }),
      s.api('POST', '/api/projects', { source: repo, name: 'dup', mode: 'local-only' }),
    ]);
    assert.deepStrictEqual([c.status, d.status].sort(), [200, 409], JSON.stringify([c.body, d.body]));
    const projects = (await s.api('GET', '/api/projects')).body.projects;
    assert.strictEqual(projects.filter((p) => p.name === 'dup').length, 1);
  } finally {
    await s.stop();
    fs.rmSync(root, { recursive: true, force: true });
  }
});
