'use strict';
// F6 — the PR watch: cards whose `prs` attribute holds an open URL are polled
// through the gh CLI (injected here as a stub via BC_GH_CMD). MERGED → the
// worktree is released (only when clean), the card is archived (reason merged —
// the landed level-1 bell) and the owner gets a pr-merged QueueItem. CLOSED
// (unmerged) → state recorded, owner told, card stays.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const { startServerWithLieutenant, withOwner, sleep, LT } = require('./helper');

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

// A gh stub: `gh pr view <url> --json state,mergedAt` answered from a control
// map file the test rewrites (url -> state). Unknown URL = non-zero exit.
function makeGhStub(root) {
  const mapFile = path.join(root, 'gh-map.json');
  fs.writeFileSync(mapFile, '{}');
  const stub = path.join(root, 'gh-stub');
  fs.writeFileSync(stub, '#!/usr/bin/env node\n'
    + "const fs = require('fs');\n"
    + 'const url = process.argv[4]; // argv: node, stub, pr, view, <url>, --json, ...\n'
    + 'const map = JSON.parse(fs.readFileSync(' + JSON.stringify(mapFile) + ", 'utf8'));\n"
    + 'if (!map[url]) { console.error("no such pr"); process.exit(1); }\n'
    + 'console.log(JSON.stringify({ state: map[url], mergedAt: map[url] === "MERGED" ? new Date().toISOString() : null }));\n');
  fs.chmodSync(stub, 0o755);
  return { stub, setState: (url, state) => {
    const map = JSON.parse(fs.readFileSync(mapFile, 'utf8'));
    map[url] = state;
    fs.writeFileSync(mapFile, JSON.stringify(map));
  } };
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

async function boot() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'bc-prwatch-'));
  const repo = makeRepo(root);
  const gh = makeGhStub(root);
  const s = await startServerWithLieutenant({
    env: {
      BC_FAKE_STATE: path.join(root, 'fake'), BC_WORKTREE_TOOL: 'git',
      BC_SUPERVISE_INTERVAL_MS: '0', BC_PRWATCH_INTERVAL_MS: '200', BC_GH_CMD: gh.stub,
    },
  });
  await s.api('POST', '/api/projects', { source: repo, name: 'proj', mode: 'direct-PR' });
  const teardown = async () => { await s.stop(); fs.rmSync(root, { recursive: true, force: true }); };
  return { s, root, gh, teardown };
}

const PR = 'https://github.com/acme/proj/pull/42';

test('merged PR: worktree released, card archived (landed, level 1), owner queued', async () => {
  const { s, root, gh, teardown } = await boot();
  try {
    await s.api('POST', '/api/cards', withOwner({ title: 'Merge me', id: 'merge-me', attributes: { repo: 'proj' } }));
    const w = (await s.api('POST', '/api/cards/merge-me/start', { harness: 'fake' })).body.worker;
    gh.setState(PR, 'OPEN');
    await s.api('POST', '/api/cards/merge-me/worker/done', { outcome: 'PR open: ' + PR });

    // open PR: watched, untouched
    await sleep(700);
    let card = (await s.api('GET', '/api/cards/merge-me')).body;
    assert.deepStrictEqual(card.attributes.prs, [{ url: PR, state: 'open' }]);

    gh.setState(PR, 'MERGED');
    await until('card archived on merge', async () =>
      (await s.api('GET', '/api/cards/merge-me')).status === 404);

    // archive record: reason merged, note carries the PR URL
    const rec = (await s.api('GET', '/api/archive')).body.archive.find((r) => r.card.id === 'merge-me');
    assert.strictEqual(rec.reason, 'merged');
    assert.match(rec.note, /pull\/42/);
    assert.strictEqual(rec.card.attributes.prs[0].state, 'merged');

    // the landed level-1 bell on the board stream
    const b = (await s.api('GET', '/api/board')).body;
    const landed = b.events.find((e) => e.kind === 'landed' && e.card === 'merge-me');
    assert.ok(landed, 'landed event');
    assert.strictEqual(landed.level, 1);

    // worktree released (clean) + registry entry gone
    assert.ok(!fs.existsSync(w.worktree.path), 'worktree removed');
    assert.strictEqual((await s.api('GET', '/api/status')).body.workers, 0);

    // the lingering done-worker session was killed (harness.kill on archive):
    // in file-backed fake mode the kill removes the session marker
    await until('worker session killed', async () =>
      !fs.existsSync(path.join(root, 'fake', w.ref.session + '.json')));

    // the owner got the pr-merged QueueItem
    const items = (await s.api('GET', '/api/feed?lieutenant=' + LT)).body.items;
    const merged = items.find((i) => i.kind === 'pr-merged');
    assert.strictEqual(merged.card, 'merge-me');
    assert.strictEqual(merged.text, PR);
  } finally { await teardown(); }
});

test('closed-unmerged PR: state recorded, owner told, card stays', async () => {
  const { s, gh, teardown } = await boot();
  try {
    await s.api('POST', '/api/cards', withOwner({ title: 'Closed one', id: 'closed-one', attributes: { repo: 'proj' } }));
    await s.api('POST', '/api/cards/closed-one/start', { harness: 'fake' });
    const url = 'https://github.com/acme/proj/pull/9';
    gh.setState(url, 'CLOSED');
    await s.api('POST', '/api/cards/closed-one/worker/done', { outcome: 'PR: ' + url });

    await until('pr marked closed', async () => {
      const c = (await s.api('GET', '/api/cards/closed-one')).body;
      return c.attributes.prs[0].state === 'closed';
    });
    const card = (await s.api('GET', '/api/cards/closed-one')).body;
    assert.strictEqual(card.column, 'working', 'card stays — the owner decides');
    assert.ok(card.events.some((e) => /closed without merge/.test(e.text)));
    const items = (await s.api('GET', '/api/feed?lieutenant=' + LT)).body.items;
    assert.ok(items.some((i) => i.kind === 'pr-closed' && i.card === 'closed-one'));
    // no re-poll spam: state left `closed`, one event only
    await sleep(700);
    const again = (await s.api('GET', '/api/cards/closed-one')).body;
    assert.strictEqual(again.events.filter((e) => /closed without merge/.test(e.text)).length, 1);
  } finally { await teardown(); }
});

test('merged PR with a DIRTY worktree: card archived, worktree left in place (never discarded)', async () => {
  const { s, gh, teardown } = await boot();
  try {
    await s.api('POST', '/api/cards', withOwner({ title: 'Dirty', id: 'dirty', attributes: { repo: 'proj' } }));
    const w = (await s.api('POST', '/api/cards/dirty/start', { harness: 'fake' })).body.worker;
    fs.writeFileSync(path.join(w.worktree.path, 'uncommitted.txt'), 'precious\n');
    const url = 'https://github.com/acme/proj/pull/13';
    gh.setState(url, 'MERGED');
    await s.api('POST', '/api/cards/dirty/worker/done', { outcome: 'PR: ' + url });

    await until('card archived', async () => (await s.api('GET', '/api/cards/dirty')).status === 404);
    assert.ok(fs.existsSync(path.join(w.worktree.path, 'uncommitted.txt')), 'dirty worktree untouched');
    const rec = (await s.api('GET', '/api/archive')).body.archive.find((r) => r.card.id === 'dirty');
    assert.match(rec.note, /NOT released/);
  } finally { await teardown(); }
});

// ---------- stacks: a card tracking several PRs finishes only when none is open ----------

function shHook(ws, event, name, script) {
  const dir = path.join(ws, '.bridge-commander', 'hooks', event);
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, name);
  fs.writeFileSync(file, '#!/bin/sh\n' + script + '\n');
  fs.chmodSync(file, 0o755);
}

const PR_A = 'https://github.com/acme/proj/pull/101';
const PR_B = 'https://github.com/acme/proj/pull/102';

test('stack card: the first merge does NOT archive — card, worktree and hooks all stay put', async () => {
  const { s, root, gh, teardown } = await boot();
  try {
    const archived = path.join(root, 'archived.out');
    shHook(s.dir, 'card-archived', 'mark.sh', 'echo fired >> ' + JSON.stringify(archived));
    await s.api('POST', '/api/cards', withOwner({ title: 'Stack', id: 'stack', attributes: { repo: 'proj' } }));
    const w = (await s.api('POST', '/api/cards/stack/start', { harness: 'fake' })).body.worker;
    gh.setState(PR_A, 'OPEN'); gh.setState(PR_B, 'OPEN');
    await s.api('POST', '/api/cards/stack/worker/done', { outcome: 'PRs: ' + PR_A + ' and ' + PR_B });

    // --- the base PR lands; the tip is still open ---
    gh.setState(PR_A, 'MERGED');
    // the event lands at the end of the tick — poll it, not the mid-tick pr.state
    await until('pr-merged event for the base PR', async () => {
      const c = (await s.api('GET', '/api/cards/stack')).body;
      return c.events && c.events.some((e) => e.kind === 'pr-merged');
    });
    const card = (await s.api('GET', '/api/cards/stack')).body;
    assert.strictEqual(card.column, 'working', 'card stays — a PR is still open');
    assert.strictEqual(card.attributes.prs[0].state, 'merged');
    assert.strictEqual(card.attributes.prs[1].state, 'open');
    const ev = card.events.filter((e) => e.kind === 'pr-merged');
    assert.strictEqual(ev.length, 1, 'one pr-merged event, for the PR that landed');
    assert.strictEqual(ev[0].level, 2);
    assert.match(ev[0].text, /pull\/101/);
    const items = (await s.api('GET', '/api/feed?lieutenant=' + LT)).body.items;
    assert.ok(items.some((i) => i.kind === 'pr-merged' && i.card === 'stack' && i.text === PR_A));
    assert.ok(fs.existsSync(w.worktree.path), 'worktree untouched on a partial merge');
    assert.strictEqual((await s.api('GET', '/api/status')).body.workers, 1);
    assert.ok(!fs.existsSync(archived), 'no card-archived hooks on a partial merge');

    // --- the tip lands too: nothing open left, so now it archives ---
    gh.setState(PR_B, 'MERGED');
    await until('card archived once the stack is fully merged', async () =>
      (await s.api('GET', '/api/cards/stack')).status === 404);
    const rec = (await s.api('GET', '/api/archive')).body.archive.find((r) => r.card.id === 'stack');
    assert.strictEqual(rec.reason, 'merged');
    assert.match(rec.note, /pull\/102/);
    assert.strictEqual(rec.card.events.filter((e) => e.kind === 'pr-merged').length, 2);
    const b = (await s.api('GET', '/api/board')).body;
    const landed = b.events.find((e) => e.kind === 'landed' && e.card === 'stack');
    assert.ok(landed, 'landed event');
    assert.strictEqual(landed.level, 1);
    assert.ok(!fs.existsSync(w.worktree.path), 'worktree released once nothing is open');
    await until('card-archived hooks fired', async () => fs.existsSync(archived));
  } finally { await teardown(); }
});

test('stack card: two PRs merging in the same tick — an event each, one archive', async () => {
  const { s, gh, teardown } = await boot();
  try {
    await s.api('POST', '/api/cards', withOwner({ title: 'Both', id: 'both', attributes: { repo: 'proj' } }));
    gh.setState(PR_A, 'OPEN'); gh.setState(PR_B, 'OPEN');
    await s.api('POST', '/api/cards/both/start', { harness: 'fake' });
    await s.api('POST', '/api/cards/both/worker/done', { outcome: 'PRs: ' + PR_A + ' ' + PR_B });
    // both flip between two polls
    gh.setState(PR_A, 'MERGED'); gh.setState(PR_B, 'MERGED');

    await until('card archived', async () => (await s.api('GET', '/api/cards/both')).status === 404);
    const rec = (await s.api('GET', '/api/archive')).body.archive.find((r) => r.card.id === 'both');
    assert.strictEqual(rec.reason, 'merged');
    const ev = rec.card.events.filter((e) => e.kind === 'pr-merged');
    assert.deepStrictEqual(ev.map((e) => e.text.replace(/^PR merged: /, '')), [PR_A, PR_B]);
    const items = (await s.api('GET', '/api/feed?lieutenant=' + LT)).body.items;
    assert.deepStrictEqual(
      items.filter((i) => i.kind === 'pr-merged' && i.card === 'both').map((i) => i.text).sort(),
      [PR_A, PR_B]);
    const b = (await s.api('GET', '/api/board')).body;
    assert.strictEqual(b.events.filter((e) => e.kind === 'landed' && e.card === 'both').length, 1);
  } finally { await teardown(); }
});

test('gh failure leaves state untouched (no archive, still open)', async () => {
  const { s, teardown } = await boot();
  try {
    await s.api('POST', '/api/cards', withOwner({ title: 'Flaky', id: 'flaky', attributes: { repo: 'proj' } }));
    await s.api('POST', '/api/cards/flaky/start', { harness: 'fake' });
    // URL never registered in the stub map -> gh exits non-zero every poll
    await s.api('POST', '/api/cards/flaky/worker/done', { outcome: 'PR: https://github.com/acme/proj/pull/99' });
    await sleep(900);
    const card = (await s.api('GET', '/api/cards/flaky')).body;
    assert.strictEqual(card.attributes.prs[0].state, 'open');
    assert.strictEqual(card.column, 'working');
  } finally { await teardown(); }
});
