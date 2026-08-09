'use strict';
// gh-watch — the first schedule, and the reason the clock is worth having.
//
// We open pull requests and then stop watching them. This hook asks `gh` about
// the checks on the `bc/` branch of every live card and wakes that card's OWNER
// when one is red, with the check name and the link. Green is silent, and one
// red check is ONE wake however many times the poll sees it — `bc-axi event
// --key` does that half, which is why the hook keeps no state of its own.
//
// It is a hook like any other: bash, `bc-axi` on its PATH, no API. So this test
// runs it the way the clock does — through `hook run` — with a fake `gh`.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { seedHooks } = require('../server/hooks.js');
const { startServer, runCli, LT } = require('./helper');

// A `gh` that answers whatever the test last wrote into checks.json, ignoring
// its arguments — the hook's contract with gh is `pr checks --json`, and what
// this pins is what the hook does with the ANSWER.
function fakeGh(dir, out) {
  const bin = path.join(dir, 'fake-gh');
  fs.writeFileSync(bin, '#!/bin/sh\ncat ' + JSON.stringify(out) + '\n');
  fs.chmodSync(bin, 0o755);
  return bin;
}

function seedBoard(dir, repo) {
  const state = path.join(dir, '.bridge-commander');
  fs.mkdirSync(state, { recursive: true });
  fs.writeFileSync(path.join(state, 'board.json'), JSON.stringify({
    title: 'test', seq: 0,
    lieutenants: [{ id: LT, name: 'Ada', color: '#58b6ff', ref: null }],
    projects: [{ name: 'proj', path: repo, source: repo }],
    cards: [{
      id: 'MNC-1', title: 'Watched', type: 'implementation', column: 'working', owner: LT,
      playbook: 'default', body: '', labels: [], events: [], thread: [],
      attributes: { repo: 'proj', branch: 'bc/MNC-1' },
    }, {
      id: 'MNC-2', title: 'Unstarted', type: 'implementation', column: 'backlog', owner: LT,
      playbook: 'default', body: '', labels: [], events: [], thread: [],
      attributes: {},
    }],
    events: [], labels: [], workers: [], schedules: [],
  }, null, 2));
}

async function watchRun(s, dir) {
  return runCli(['hook', 'run', 'gh-watch', '--trigger', 'schedule:gh-watch',
    '--workspace', dir, '--port', String(s.port)]);
}
async function cardEvents(s) {
  return ((await s.api('GET', '/api/cards/MNC-1')).body.events || []).filter((e) => e.kind === 'ci-failed');
}

test('gh-watch wakes the owner on a red check — once per failure — and stays silent on green', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bc-ghwatch-'));
  const repo = fs.mkdtempSync(path.join(os.tmpdir(), 'bc-ghrepo-'));
  const checks = path.join(dir, 'checks.json');
  seedBoard(dir, repo);
  // the PACKAGED hook, installed the way a fresh workspace gets it
  assert.ok(seedHooks(dir).includes('gh-watch'), 'the packaged hook seeds into the workspace');

  fs.writeFileSync(checks, JSON.stringify([
    { name: 'build', bucket: 'pass', link: 'https://github.com/o/r/runs/1' },
    { name: 'test (3.12)', bucket: 'pass', link: 'https://github.com/o/r/runs/2' },
  ]));
  const s = await startServer({ dir, env: { BC_GH_CMD: fakeGh(dir, checks), BC_SCHEDULE_INTERVAL_MS: '0' } });
  try {
    let r = await watchRun(s, dir);
    assert.strictEqual(r.code, 0, r.stderr);
    assert.match(r.stdout, /1 branch\(es\) watched, 0 red check\(s\)/,
      'the backlog card has no branch — only live bc/ branches are watched');
    assert.deepStrictEqual(await cardEvents(s), [], 'green is silent');
    assert.deepStrictEqual((await s.api('GET', '/api/feed?lieutenant=' + LT)).body.items, []);

    // …and then a check goes red
    fs.writeFileSync(checks, JSON.stringify([
      { name: 'build', bucket: 'pass', link: 'https://github.com/o/r/runs/1' },
      { name: 'test (3.12)', bucket: 'fail', link: 'https://github.com/o/r/runs/7' },
    ]));
    r = await watchRun(s, dir);
    assert.strictEqual(r.code, 0, r.stderr);
    assert.match(r.stdout, /1 red check\(s\)/);

    let evs = await cardEvents(s);
    assert.strictEqual(evs.length, 1);
    assert.strictEqual(evs[0].level, 1, 'a red check is the captain’s bell');
    assert.match(evs[0].text, /test \(3\.12\)/, 'the check name');
    assert.match(evs[0].text, /runs\/7/, 'and the link');

    const items = (await s.api('GET', '/api/feed?lieutenant=' + LT)).body.items;
    assert.strictEqual(items.length, 1, 'the OWNER was woken');
    assert.strictEqual(items[0].source, 'gh-watch', 'a drain at 2am says who woke you');

    // the same failure, seen twelve more times an hour: ONE wake, not sixty
    for (let i = 0; i < 3; i++) {
      const again = await watchRun(s, dir);
      assert.match(again.stdout, /duplicate key/, 'the poll says it deduped');
    }
    assert.strictEqual((await cardEvents(s)).length, 1);
    assert.strictEqual((await s.api('GET', '/api/feed?lieutenant=' + LT)).body.items.length, 1);

    // a NEW failure of the same check (a re-run, a new link) is a new thing
    fs.writeFileSync(checks, JSON.stringify([
      { name: 'test (3.12)', bucket: 'fail', link: 'https://github.com/o/r/runs/8' },
    ]));
    await watchRun(s, dir);
    evs = await cardEvents(s);
    assert.strictEqual(evs.length, 2);
    assert.match(evs[1].text, /runs\/8/);
  } finally {
    await s.stop();
    fs.rmSync(dir, { recursive: true, force: true });
    fs.rmSync(repo, { recursive: true, force: true });
  }
});

// The seed is a one-time act, not a state `init` re-asserts. A captain who
// removed gh-watch has made a decision, and the next upgrade — `init` is
// re-enterable, that is how a workspace is upgraded — must not overwrite it.
// Pausing and repointing already survived, because both leave a schedule of
// that name behind; a removal leaves nothing, so the seed is remembered
// separately, in the state dir.
test('init seeds gh-watch ONCE: a fresh workspace gets it, a removed one stays removed', async () => {
  const s = await startServer();
  const bin = path.join(s.dir, 'bin');
  fs.mkdirSync(bin, { recursive: true });
  fs.writeFileSync(path.join(bin, 'tmux'), '#!/bin/sh\necho bc-ada\n');
  fs.chmodSync(path.join(bin, 'tmux'), 0o755);
  const env = { TMUX: '/tmp/stub,1,0', PATH: bin + ':' + process.env.PATH };
  const ws = ['--workspace', s.dir, '--port', String(s.port)];
  const init = () => runCli(['init', '--name', 'Ada', '--id', LT, ...ws], env);
  const names = async () => ((await s.api('GET', '/api/schedules')).body.schedules || []).map((x) => x.name);
  try {
    let r = await init();
    assert.strictEqual(r.code, 0, r.stderr);
    assert.match(r.stdout, /schedule gh-watch registered/, 'a workspace that never had it gets it');
    assert.deepStrictEqual(await names(), ['gh-watch']);

    r = await init();                                   // an upgrade over a live one
    assert.strictEqual(r.code, 0, r.stderr);
    assert.doesNotMatch(r.stdout, /gh-watch registered/, 're-running init is a no-op');
    assert.deepStrictEqual(await names(), ['gh-watch']);

    // the captain drops the schedule and KEEPS the hook — the seed must not
    // read the hook file and call that a missing seed
    r = await runCli(['schedule', 'remove', 'gh-watch', ...ws]);
    assert.strictEqual(r.code, 0, r.stderr);
    assert.deepStrictEqual(await names(), []);
    assert.ok(fs.existsSync(path.join(s.dir, '.bridge-commander', 'hooks', 'gh-watch')),
      'the hook is untouched by the removal');

    r = await init();
    assert.strictEqual(r.code, 0, r.stderr);
    assert.doesNotMatch(r.stdout, /gh-watch registered/, 'an upgrade does not overwrite a removal');
    assert.deepStrictEqual(await names(), [], 'removed stays removed');
  } finally { await s.stop(); fs.rmSync(s.dir, { recursive: true, force: true }); }
});

test('gh-watch is quiet and successful when there is nothing to watch, or no gh at all', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bc-ghwatch-idle-'));
  fs.mkdirSync(path.join(dir, '.bridge-commander'), { recursive: true });
  seedHooks(dir);
  const s = await startServer({ dir, env: { BC_GH_CMD: 'definitely-not-installed-gh', BC_SCHEDULE_INTERVAL_MS: '0' } });
  try {
    const r = await watchRun(s, dir);
    assert.strictEqual(r.code, 0, 'a machine without gh is not a failing schedule');
    assert.match(r.stdout, /gh is not installed/);
  } finally { await s.stop(); fs.rmSync(dir, { recursive: true, force: true }); }
});
