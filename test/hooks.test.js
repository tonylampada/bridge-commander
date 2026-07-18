'use strict';
// Card-lifecycle hooks — the workspace's own executable scripts in
// .bridge-commander/hooks/<event>/ run on worker-done / worker-died /
// card-archived, alphabetical, sequential, context via BC_* env, fire-and-
// forget (per-hook timeout then kill). Results land as timeline events:
// hook-ran (level 2) / hook-failed (level 1 — the bell). The one ordering
// guarantee: card-archived hooks finish BEFORE the worktree release.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const { runHooks } = require('../server/hooks.js');
const { startServerWithLieutenant, startServer, withOwner, sleep, LT } = require('./helper');

function writeHook(ws, event, name, body, mode = 0o755) {
  const dir = path.join(ws, '.bridge-commander', 'hooks', event);
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, name);
  fs.writeFileSync(file, body);
  fs.chmodSync(file, mode);
  return file;
}
function shHook(ws, event, name, script, mode) {
  return writeHook(ws, event, name, '#!/bin/sh\n' + script + '\n', mode);
}

async function until(what, fn, ms = 6000) {
  const deadline = Date.now() + ms;
  for (;;) {
    const v = await fn();
    if (v) return v;
    if (Date.now() > deadline) throw new Error('timeout waiting for: ' + what);
    await sleep(50);
  }
}

// ---------- unit: runHooks against a scratch workspace ----------

function scratchWs() { return fs.mkdtempSync(path.join(os.tmpdir(), 'bc-hooks-')); }

test('runHooks: missing hooks dir is a no-op', async () => {
  const ws = scratchWs();
  try {
    assert.deepStrictEqual(await runHooks('worker-done', { workspace: ws }), []);
  } finally { fs.rmSync(ws, { recursive: true, force: true }); }
});

test('runHooks: happy run — BC_* env visible, exit 0, output captured, cwd = workspace', async () => {
  const ws = scratchWs();
  try {
    shHook(ws, 'worker-done', 'env.sh',
      'echo "$BC_EVENT|$BC_CARD|$BC_REPO|$BC_WORKTREE|$BC_BRANCH" > env.out\necho hello');
    const results = await runHooks('worker-done',
      { workspace: ws, card: 'c1', repo: '/r', worktree: '/w', branch: 'bc/c1' });
    assert.strictEqual(results.length, 1);
    assert.deepStrictEqual(
      { hook: results[0].hook, ok: results[0].ok, code: results[0].code, output: results[0].output },
      { hook: 'env.sh', ok: true, code: 0, output: 'hello' });
    // env.out written relative to cwd — the workspace root
    assert.strictEqual(fs.readFileSync(path.join(ws, 'env.out'), 'utf8').trim(),
      'worker-done|c1|/r|/w|bc/c1');
  } finally { fs.rmSync(ws, { recursive: true, force: true }); }
});

test('runHooks: empty string for N/A context fields', async () => {
  const ws = scratchWs();
  try {
    shHook(ws, 'card-archived', 'env.sh', 'printf "%s|%s" "$BC_WORKTREE" "$BC_BRANCH" > env.out');
    await runHooks('card-archived', { workspace: ws, card: 'c1' });
    assert.strictEqual(fs.readFileSync(path.join(ws, 'env.out'), 'utf8'), '|');
  } finally { fs.rmSync(ws, { recursive: true, force: true }); }
});

test('runHooks: alphabetical order, sequential; non-executable skipped silently', async () => {
  const ws = scratchWs();
  try {
    // written in non-alphabetical order on purpose
    shHook(ws, 'worker-done', '20-second.sh', 'echo second >> order.out');
    shHook(ws, 'worker-done', '10-first.sh', 'echo first >> order.out');
    shHook(ws, 'worker-done', '15-skipme.sh', 'echo NEVER >> order.out', 0o644); // not executable
    const results = await runHooks('worker-done', { workspace: ws, card: 'c1' });
    assert.deepStrictEqual(results.map((r) => r.hook), ['10-first.sh', '20-second.sh']);
    assert.strictEqual(fs.readFileSync(path.join(ws, 'order.out'), 'utf8'), 'first\nsecond\n');
  } finally { fs.rmSync(ws, { recursive: true, force: true }); }
});

test('runHooks: failing hook reports ok:false + exit code, later hooks still run', async () => {
  const ws = scratchWs();
  try {
    shHook(ws, 'worker-done', '1-bad.sh', 'echo boom >&2\nexit 3');
    shHook(ws, 'worker-done', '2-good.sh', 'exit 0');
    const results = await runHooks('worker-done', { workspace: ws, card: 'c1' });
    assert.deepStrictEqual(results.map((r) => [r.hook, r.ok, r.code]),
      [['1-bad.sh', false, 3], ['2-good.sh', true, 0]]);
    assert.strictEqual(results[0].output, 'boom'); // stderr captured too
  } finally { fs.rmSync(ws, { recursive: true, force: true }); }
});

test('runHooks: broken interpreter is a failed result, not a crash', async () => {
  const ws = scratchWs();
  try {
    writeHook(ws, 'worker-done', 'broken.sh', '#!/no/such/interpreter\necho hi\n');
    const results = await runHooks('worker-done', { workspace: ws, card: 'c1' });
    assert.strictEqual(results.length, 1);
    assert.strictEqual(results[0].ok, false);
    assert.ok(results[0].error || results[0].code !== 0, 'spawn failure surfaced');
  } finally { fs.rmSync(ws, { recursive: true, force: true }); }
});

test('runHooks: timeout kills the hook (injectable timeoutMs)', async () => {
  const ws = scratchWs();
  try {
    shHook(ws, 'worker-done', 'hang.sh', 'sleep 30');
    const t0 = Date.now();
    const results = await runHooks('worker-done', { workspace: ws, card: 'c1' }, { timeoutMs: 300 });
    assert.ok(Date.now() - t0 < 5000, 'did not wait for the sleep');
    assert.strictEqual(results[0].ok, false);
    assert.strictEqual(results[0].timedOut, true);
  } finally { fs.rmSync(ws, { recursive: true, force: true }); }
});

test('runHooks: output capped at a few KB', async () => {
  const ws = scratchWs();
  try {
    shHook(ws, 'worker-done', 'noisy.sh', 'i=0; while [ $i -lt 2000 ]; do echo aaaaaaaaaaaaaaaa; i=$((i+1)); done');
    const results = await runHooks('worker-done', { workspace: ws, card: 'c1' });
    assert.strictEqual(results[0].ok, true);
    assert.ok(results[0].output.length <= 4096, 'capped');
    assert.strictEqual(results[0].truncated, true);
  } finally { fs.rmSync(ws, { recursive: true, force: true }); }
});

// ---------- integration: the server fires hooks on lifecycle events ----------

function makeRepo(root) {
  const repo = path.join(root, 'srcrepo');
  fs.mkdirSync(repo, { recursive: true });
  execFileSync('git', ['init', '-q', '-b', 'main', repo], { stdio: ['ignore', 'pipe', 'pipe'] });
  fs.writeFileSync(path.join(repo, 'README.md'), 'hi\n');
  execFileSync('git', ['-C', repo, 'add', '.'], { stdio: ['ignore', 'pipe', 'pipe'] });
  execFileSync('git', ['-C', repo, '-c', 'user.email=t@t', '-c', 'user.name=t', 'commit', '-q', '-m', 'init'],
    { stdio: ['ignore', 'pipe', 'pipe'] });
  return repo;
}

async function bootWithProject(extraEnv = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'bc-hooks-int-'));
  const repo = makeRepo(root);
  const s = await startServerWithLieutenant({
    env: Object.assign({
      BC_FAKE_STATE: path.join(root, 'fake'), BC_WORKTREE_TOOL: 'git',
      BC_SUPERVISE_INTERVAL_MS: '0', BC_PRWATCH_INTERVAL_MS: '0',
    }, extraEnv),
  });
  await s.api('POST', '/api/projects', { source: repo, name: 'proj', mode: 'direct-PR' });
  const teardown = async () => { await s.stop(); fs.rmSync(root, { recursive: true, force: true }); };
  return { s, root, teardown };
}

test('worker-done hooks: env context from the worker record, hook-ran level-2 card event', async () => {
  const { s, root, teardown } = await bootWithProject();
  try {
    const out = path.join(root, 'wd-env.out');
    shHook(s.dir, 'worker-done', 'capture.sh',
      'echo "$BC_EVENT|$BC_CARD|$BC_REPO|$BC_WORKTREE|$BC_BRANCH" > ' + JSON.stringify(out) + '\necho swept');
    await s.api('POST', '/api/cards', withOwner({ title: 'Hooked', id: 'hooked', attributes: { repo: 'proj' } }));
    const w = (await s.api('POST', '/api/cards/hooked/start', { harness: 'fake' })).body.worker;
    await s.api('POST', '/api/cards/hooked/worker/done', { outcome: 'all done' });

    const ev = await until('hook-ran event on the card', async () => {
      const c = (await s.api('GET', '/api/cards/hooked')).body;
      return (c.events || []).find((e) => e.kind === 'hook-ran');
    });
    assert.strictEqual(ev.level, 2);
    assert.match(ev.text, /capture\.sh/);
    assert.match(ev.text, /exit 0/);
    assert.match(ev.text, /swept/); // trimmed output included
    const project = path.join(s.dir, 'projects', 'proj');
    assert.strictEqual(fs.readFileSync(out, 'utf8').trim(),
      'worker-done|hooked|' + project + '|' + w.worktree.path + '|bc/hooked');
  } finally { await teardown(); }
});

test('worker-done failing hook: hook-failed level-1 card event + hook-failed QueueItem to the owner', async () => {
  const { s, teardown } = await bootWithProject();
  try {
    shHook(s.dir, 'worker-done', 'bad.sh', 'echo teardown exploded >&2\nexit 7');
    await s.api('POST', '/api/cards', withOwner({ title: 'Bad hook', id: 'bad-hook', attributes: { repo: 'proj' } }));
    await s.api('POST', '/api/cards/bad-hook/start', { harness: 'fake' });
    await s.api('POST', '/api/cards/bad-hook/worker/done', { outcome: 'done anyway' });

    const ev = await until('hook-failed event on the card', async () => {
      const c = (await s.api('GET', '/api/cards/bad-hook')).body;
      return (c.events || []).find((e) => e.kind === 'hook-failed');
    });
    assert.strictEqual(ev.level, 1, 'the bell — the captain must see hook failures');
    assert.match(ev.text, /bad\.sh/);
    assert.match(ev.text, /exit 7/);
    assert.match(ev.text, /teardown exploded/);
    const items = (await s.api('GET', '/api/feed?lieutenant=' + LT)).body.items;
    assert.ok(items.some((i) => i.kind === 'hook-failed' && i.card === 'bad-hook'));
  } finally { await teardown(); }
});

test('worker-done with no hooks dir: lifecycle unaffected, no hook events', async () => {
  const { s, teardown } = await bootWithProject();
  try {
    await s.api('POST', '/api/cards', withOwner({ title: 'Plain', id: 'plain', attributes: { repo: 'proj' } }));
    await s.api('POST', '/api/cards/plain/start', { harness: 'fake' });
    const r = await s.api('POST', '/api/cards/plain/worker/done', { outcome: 'fin' });
    assert.strictEqual(r.status, 200);
    await sleep(400);
    const c = (await s.api('GET', '/api/cards/plain')).body;
    assert.ok(!c.events.some((e) => e.kind === 'hook-ran' || e.kind === 'hook-failed'));
    assert.ok(c.events.some((e) => e.kind === 'worker-done'));
  } finally { await teardown(); }
});

test('hook timeout: BC_HOOK_TIMEOUT_MS override, hook-failed says timed out, lifecycle unharmed', async () => {
  const { s, teardown } = await bootWithProject({ BC_HOOK_TIMEOUT_MS: '300' });
  try {
    shHook(s.dir, 'worker-done', 'hang.sh', 'sleep 30');
    await s.api('POST', '/api/cards', withOwner({ title: 'Hang', id: 'hang', attributes: { repo: 'proj' } }));
    await s.api('POST', '/api/cards/hang/start', { harness: 'fake' });
    await s.api('POST', '/api/cards/hang/worker/done', { outcome: 'fin' });
    const ev = await until('timed-out hook-failed event', async () => {
      const c = (await s.api('GET', '/api/cards/hang')).body;
      return (c.events || []).find((e) => e.kind === 'hook-failed');
    });
    assert.match(ev.text, /hang\.sh/);
    assert.match(ev.text, /timed out/);
  } finally { await teardown(); }
});

test('worker-died hooks fire from the supervision loop', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'bc-hooks-died-'));
  const nowIso = new Date().toISOString();
  const wt = path.join(root, 'wt');
  fs.mkdirSync(wt, { recursive: true });
  const s = await startServer({
    env: { BC_FAKE_STATE: path.join(root, 'fake'), BC_SUPERVISE_INTERVAL_MS: '150', BC_PRWATCH_INTERVAL_MS: '0' },
    seed: (dir) => {
      const sd = path.join(dir, '.bridge-commander');
      fs.mkdirSync(sd, { recursive: true });
      fs.writeFileSync(path.join(sd, 'board.json'), JSON.stringify({
        title: 'seeded', seq: 0, labels: [], reads: {}, kinds: {}, events: [],
        lieutenants: [{ id: 'ada', name: 'Ada', color: '#58b6ff', charter: '', chat: [], created: nowIso }],
        projects: [{ name: 'proj', path: path.join(root, 'proj'), mode: 'direct-PR', added: nowIso }],
        cards: [{
          id: 'doomed', title: 'Doomed', type: 'implementation', owner: 'ada', column: 'working',
          labels: [], attributes: { repo: 'proj' }, body: '', created: nowIso, updated: nowIso,
          threadStart: null, pendingOrder: null, events: [], thread: [],
        }],
        // no fake session marker exists -> dead on the first tick
        workers: [{ card: 'doomed', ref: { harness: 'fake', session: 'bc-w-doomed', cwd: '/tmp', resumeId: 'x' },
          worktree: { path: wt, tool: 'git' }, branch: 'bc/doomed', project: 'proj', spawnedAt: nowIso, done: false }],
      }, null, 2));
    },
  });
  try {
    const out = path.join(root, 'died-env.out');
    shHook(s.dir, 'worker-died', 'capture.sh',
      'echo "$BC_EVENT|$BC_CARD|$BC_WORKTREE|$BC_BRANCH" > ' + JSON.stringify(out));
    const ev = await until('hook-ran after worker-died', async () => {
      const c = (await s.api('GET', '/api/cards/doomed')).body;
      return (c.events || []).find((e) => e.kind === 'hook-ran');
    });
    assert.match(ev.text, /worker-died hook capture\.sh ok/);
    assert.ok((await s.api('GET', '/api/cards/doomed')).body.events.some((e) => e.kind === 'worker-died'));
    assert.strictEqual(fs.readFileSync(out, 'utf8').trim(), 'worker-died|doomed|' + wt + '|bc/doomed');
  } finally {
    await s.stop();
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('card-archived hooks (manual archive): board-level events with a card ref; worktree untouched', async () => {
  const { s, root, teardown } = await bootWithProject();
  try {
    const out = path.join(root, 'arch-env.out');
    shHook(s.dir, 'card-archived', 'capture.sh',
      'if [ -d "$BC_WORKTREE" ]; then echo "worktree-present"; else echo "worktree-gone"; fi > ' + JSON.stringify(out));
    await s.api('POST', '/api/cards', withOwner({ title: 'Kill me', id: 'kill-me', attributes: { repo: 'proj' } }));
    const w = (await s.api('POST', '/api/cards/kill-me/start', { harness: 'fake' })).body.worker;
    const r = await s.api('POST', '/api/cards/kill-me/archive', { reason: 'killed', actor: 'user' });
    assert.strictEqual(r.status, 200);

    // the archived card can't take timeline events — they land on the board
    // stream with a card reference instead of being dropped
    const ev = await until('board-level hook-ran', async () => {
      const b = (await s.api('GET', '/api/board')).body;
      return b.events.find((e) => e.kind === 'hook-ran' && e.card === 'kill-me');
    });
    assert.strictEqual(ev.cardTitle, 'Kill me');
    assert.match(ev.text, /card-archived hook capture\.sh ok/);
    // manual archive never releases the worktree; the hook saw it in place
    assert.strictEqual(fs.readFileSync(out, 'utf8').trim(), 'worktree-present');
    assert.ok(fs.existsSync(w.worktree.path));
  } finally { await teardown(); }
});

test('card-archived hooks run BEFORE the worktree release on the merged-PR path', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'bc-hooks-merge-'));
  const repo = makeRepo(root);
  // gh stub: every PR is MERGED
  const stub = path.join(root, 'gh-stub');
  fs.writeFileSync(stub, '#!/usr/bin/env node\nconsole.log(JSON.stringify({ state: "MERGED", mergedAt: "2026-01-01T00:00:00Z" }));\n');
  fs.chmodSync(stub, 0o755);
  const s = await startServerWithLieutenant({
    env: {
      BC_FAKE_STATE: path.join(root, 'fake'), BC_WORKTREE_TOOL: 'git',
      BC_SUPERVISE_INTERVAL_MS: '0', BC_PRWATCH_INTERVAL_MS: '200', BC_GH_CMD: stub,
    },
  });
  try {
    await s.api('POST', '/api/projects', { source: repo, name: 'proj', mode: 'direct-PR' });
    const out = path.join(root, 'wt-check.out');
    shHook(s.dir, 'card-archived', 'check.sh',
      'if [ -d "$BC_WORKTREE" ]; then echo "worktree-present"; else echo "worktree-gone"; fi > ' + JSON.stringify(out));
    await s.api('POST', '/api/cards', withOwner({ title: 'Merge me', id: 'merge-me', attributes: { repo: 'proj' } }));
    const w = (await s.api('POST', '/api/cards/merge-me/start', { harness: 'fake' })).body.worker;
    await s.api('POST', '/api/cards/merge-me/worker/done',
      { outcome: 'PR: https://github.com/acme/proj/pull/1' });

    await until('card archived on merge', async () =>
      (await s.api('GET', '/api/cards/merge-me')).status === 404);
    // the hook ran while the worktree still existed; the release still happened after
    assert.strictEqual(fs.readFileSync(out, 'utf8').trim(), 'worktree-present');
    assert.ok(!fs.existsSync(w.worktree.path), 'worktree released after the hooks');
    const b = (await s.api('GET', '/api/board')).body;
    assert.ok(b.events.some((e) => e.kind === 'hook-ran' && e.card === 'merge-me'));
  } finally {
    await s.stop();
    fs.rmSync(root, { recursive: true, force: true });
  }
});
