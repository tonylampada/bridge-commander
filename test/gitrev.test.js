'use strict';
// gitrev — the server records the commit it booted from, and the CLI announces
// when the checkout has moved past it. Three states matter: same commit
// (silence), drifted (one line), git unavailable (unknown, never an error).
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const gitrev = require('../server/gitrev.js');
const { startServer, runCli } = require('./helper');

const A = 'a'.repeat(40);
const B = 'b'.repeat(40);

function tmpdir() { return fs.mkdtempSync(path.join(os.tmpdir(), 'bc-gitrev-')); }

// A checkout fabricated by hand: headCommit never runs git, so the file layout
// alone is enough — and these tests then need no git binary to pass.
function fakeRepo(commit, opts = {}) {
  const dir = tmpdir();
  const g = path.join(dir, '.git');
  fs.mkdirSync(path.join(g, 'refs', 'heads'), { recursive: true });
  if (opts.detached) {
    fs.writeFileSync(path.join(g, 'HEAD'), commit + '\n');
  } else {
    fs.writeFileSync(path.join(g, 'HEAD'), 'ref: refs/heads/main\n');
    if (opts.packed) fs.writeFileSync(path.join(g, 'packed-refs'), '# pack-refs with: peeled\n' + commit + ' refs/heads/main\n');
    else fs.writeFileSync(path.join(g, 'refs', 'heads', 'main'), commit + '\n');
  }
  return dir;
}
function setHead(dir, commit) {
  fs.writeFileSync(path.join(dir, '.git', 'refs', 'heads', 'main'), commit + '\n');
}

test('headCommit resolves HEAD through a loose ref, no git binary involved', () => {
  const dir = fakeRepo(A);
  try { assert.strictEqual(gitrev.headCommit(dir), A); } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('headCommit reads a detached HEAD directly', () => {
  const dir = fakeRepo(B, { detached: true });
  try { assert.strictEqual(gitrev.headCommit(dir), B); } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('headCommit falls back to packed-refs when the loose ref is gone', () => {
  const dir = fakeRepo(A, { packed: true });
  try { assert.strictEqual(gitrev.headCommit(dir), A); } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('headCommit follows a linked worktree: .git pointer file plus commondir', () => {
  // The shape every bridge-commander WORKER runs in — its .git is a file and
  // its refs live back in the clone.
  const clone = fakeRepo(A);
  const wt = tmpdir();
  try {
    const wtGit = path.join(clone, '.git', 'worktrees', 'w1');
    fs.mkdirSync(wtGit, { recursive: true });
    fs.writeFileSync(path.join(wtGit, 'HEAD'), 'ref: refs/heads/main\n');
    fs.writeFileSync(path.join(wtGit, 'commondir'), '../..\n');
    fs.writeFileSync(path.join(wt, '.git'), 'gitdir: ' + wtGit + '\n');
    assert.strictEqual(gitrev.headCommit(wt), A);
  } finally {
    fs.rmSync(clone, { recursive: true, force: true });
    fs.rmSync(wt, { recursive: true, force: true });
  }
});

test('headCommit answers unknown, not an error, where there is no git at all', () => {
  const dir = tmpdir();
  try {
    assert.strictEqual(gitrev.headCommit(dir), null);
    assert.strictEqual(gitrev.headCommit('/nonexistent-' + process.pid), null);
    assert.strictEqual(gitrev.headCommit(null), null);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('bootRecord on a checkout with no git reports unknown and skips the git call', () => {
  const dir = tmpdir();
  try {
    const r = gitrev.bootRecord(dir);
    assert.strictEqual(r.commit, null);
    assert.strictEqual(r.short, null);
    assert.strictEqual(r.dirty, null); // unknown — never a thrown error
    assert.strictEqual(r.root, dir);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('bootRecord records a dirty working tree as part of the record', () => {
  const repo = tmpdir();
  try {
    execFileSync('git', ['init', '-q', '-b', 'main', repo], { stdio: ['ignore', 'pipe', 'pipe'] });
    fs.writeFileSync(path.join(repo, 'a.txt'), 'one\n');
    execFileSync('git', ['-C', repo, 'add', '.'], { stdio: ['ignore', 'pipe', 'pipe'] });
    execFileSync('git', ['-C', repo, '-c', 'user.email=t@t', '-c', 'user.name=t', 'commit', '-q', '-m', 'init'],
      { stdio: ['ignore', 'pipe', 'pipe'] });

    const clean = gitrev.bootRecord(repo);
    assert.match(clean.commit, /^[0-9a-f]{40}$/);
    assert.strictEqual(clean.short, clean.commit.slice(0, 7));
    assert.strictEqual(clean.dirty, false);

    fs.writeFileSync(path.join(repo, 'a.txt'), 'two\n');
    assert.strictEqual(gitrev.bootRecord(repo).dirty, true);
  } finally { fs.rmSync(repo, { recursive: true, force: true }); }
});

test('driftLine is silent on a match and on either side unknown', () => {
  assert.strictEqual(gitrev.driftLine({ commit: A }, A), null);
  assert.strictEqual(gitrev.driftLine({ commit: null }, A), null);
  assert.strictEqual(gitrev.driftLine({ commit: A }, null), null);
  assert.strictEqual(gitrev.driftLine(null, A), null);
});

test('driftLine names both commits and the restart command', () => {
  const line = gitrev.driftLine({ commit: A }, B);
  assert.match(line, /OLD code/);
  assert.match(line, new RegExp(A.slice(0, 7)));
  assert.match(line, new RegExp(B.slice(0, 7)));
  assert.match(line, /bc-axi stop && bc-axi open/);
  assert.ok(!line.includes('\n'), 'one line');
  assert.match(gitrev.driftLine({ commit: A, dirty: true }, B), /dirty tree/);
});

// ---------- the server's record, and the CLI surfaces that read it ----------

test('the server records its boot commit and /api/status hands it over', async () => {
  const code = fakeRepo(A);
  const s = await startServer({ env: { BC_CODE_ROOT: code } });
  try {
    const r = await s.api('GET', '/api/status');
    assert.strictEqual(r.body.code.commit, A);
    assert.strictEqual(r.body.code.short, A.slice(0, 7));
    assert.strictEqual(r.body.code.root, code);
  } finally {
    await s.stop();
    fs.rmSync(code, { recursive: true, force: true });
  }
});

test('bc-axi status prints the commit and stays silent while it matches', async () => {
  const code = fakeRepo(A);
  const s = await startServer({ env: { BC_CODE_ROOT: code } });
  try {
    const r = await runCli(['status', '--workspace', s.dir, '--port', String(s.port)]);
    assert.strictEqual(r.code, 0, r.stderr);
    assert.match(r.stdout, /code=aaaaaaa/);
    assert.ok(!r.stdout.includes('⚠'), 'no drift line while the commits match:\n' + r.stdout);
  } finally {
    await s.stop();
    fs.rmSync(code, { recursive: true, force: true });
  }
});

test('bc-axi status announces drift once the checkout moves past the running server', async () => {
  const code = fakeRepo(A);
  const s = await startServer({ env: { BC_CODE_ROOT: code } });
  try {
    setHead(code, B); // the merge: files move, the running server does not
    const r = await runCli(['status', '--workspace', s.dir, '--port', String(s.port)]);
    assert.strictEqual(r.code, 0, 'drift is a report, not a failure');
    assert.match(r.stdout, /⚠ server is running OLD code/);
    assert.match(r.stdout, /aaaaaaa/);
    assert.match(r.stdout, /bbbbbbb/);
    assert.match(r.stdout, /bc-axi stop && bc-axi open/);
  } finally {
    await s.stop();
    fs.rmSync(code, { recursive: true, force: true });
  }
});

test('drift reports, never gates: card operations keep working against a stale server', async () => {
  const code = fakeRepo(A);
  const s = await startServer({ env: { BC_CODE_ROOT: code } });
  try {
    await s.api('POST', '/api/lieutenants', { name: 'Monica', id: 'monica', prefix: 'MON' });
    setHead(code, B);
    const r = await runCli(['card', 'create', '--title', 'still works', '--owner', 'monica',
      '--workspace', s.dir, '--port', String(s.port)]);
    assert.strictEqual(r.code, 0, r.stderr);
    assert.ok(!r.stdout.includes('⚠'), 'card operations carry no drift line: ' + r.stdout);
    assert.ok(!r.stderr.includes('⚠'), 'card operations carry no drift line: ' + r.stderr);
  } finally {
    await s.stop();
    fs.rmSync(code, { recursive: true, force: true });
  }
});

test('the usage screen carries the drift line, and drops it when the commits match', async () => {
  const code = fakeRepo(A);
  const s = await startServer({ env: { BC_CODE_ROOT: code } });
  try {
    let r = await runCli(['--workspace', s.dir, '--port', String(s.port)]);
    assert.strictEqual(r.code, 1); // usage always exits 1
    assert.match(r.stderr, /agent CLI for the bridge-commander board/);
    assert.ok(!r.stderr.includes('⚠'), 'silent while the commits match');

    setHead(code, B);
    r = await runCli(['--workspace', s.dir, '--port', String(s.port)]);
    assert.match(r.stderr, /⚠ server is running OLD code/);
    assert.match(r.stderr, /bc-axi stop && bc-axi open/);
  } finally {
    await s.stop();
    fs.rmSync(code, { recursive: true, force: true });
  }
});

test('git unavailable: the server reports unknown and nothing else changes', async () => {
  const code = tmpdir(); // a directory with no .git anywhere
  const s = await startServer({ env: { BC_CODE_ROOT: code } });
  try {
    const st = await s.api('GET', '/api/status');
    assert.strictEqual(st.body.code.commit, null);
    assert.strictEqual(st.body.code.dirty, null);

    const r = await runCli(['status', '--workspace', s.dir, '--port', String(s.port)]);
    assert.strictEqual(r.code, 0, r.stderr);
    assert.match(r.stdout, /code=unknown/);
    assert.ok(!r.stdout.includes('⚠'), 'unknown is not drift:\n' + r.stdout);
  } finally {
    await s.stop();
    fs.rmSync(code, { recursive: true, force: true });
  }
});

test('a down server costs the usage screen nothing', async () => {
  const dir = tmpdir();
  try {
    const r = await runCli(['--workspace', dir, '--port', '1']); // nothing listening
    assert.strictEqual(r.code, 1);
    assert.match(r.stderr, /agent CLI for the bridge-commander board/);
    assert.ok(!r.stderr.includes('⚠'));
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});
