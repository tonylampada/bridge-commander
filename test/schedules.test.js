'use strict';
// The board's own clock.
//
// A schedule is a board object like a card — a name, an owner, a life in
// board.json, a visible last fire and next fire — and it fires A HOOK and
// nothing else. The clock gets no private door: every firing goes through the
// same `hook run` the CLI and the board's ▶ use, and leaves the same trace line
// with `trigger: schedule:<name>`.
//
// The timing model is the thing to hold onto: a schedule's cursor is
// `lastWindow`, the DUE TIME of the last window it handled — never "when it
// last ran". Windows are a function of that cursor and the clock, so a restart
// sees exactly the windows that came due while nobody was looking, and neither
// loses one nor fires one twice.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { parseWhen, nextAfter, dueWindows, pickWindows, describeWhen, cronMatches,
  normalizeSchedules } = require('../server/schedules.js');
const { startServer, startServerWithLieutenant, runCli, sleep, LT } = require('./helper');

const MIN = 60000;
function at(s) { return Date.parse(s); }
function iso(ms) { return new Date(ms).toISOString(); }

// ---------- when: a cron expression or an interval ----------

test('an interval and a cron expression both parse, and a bad one is refused NAMING the text', () => {
  assert.deepStrictEqual(
    ['30s', '5m', '2h', '1d'].map((s) => parseWhen(s).ms),
    [30000, 300000, 7200000, 86400000]);
  const cron = parseWhen('*/15 9-17 * * mon-fri');
  assert.strictEqual(cron.kind, 'cron');
  assert.deepStrictEqual(cron.min, [0, 15, 30, 45]);
  assert.deepStrictEqual(cron.hour, [9, 10, 11, 12, 13, 14, 15, 16, 17]);
  assert.deepStrictEqual(cron.dow, [1, 2, 3, 4, 5]);

  for (const [text, why] of [
    ['', /it is empty/],
    ['*/5 * * *', /has 4/],                     // the typo everyone makes
    ['0ms', /5 fields/],
    ['99 * * * *', /"99" is outside 0-59/],
    ['* * * * funday', /"funday" is not a number/],
    ['0 0 * * *,', /empty item/],
    ['0 5-2 * * *', /runs backwards/],
    ['*/0 * * * *', /bad step/],
    ['0s', /at least 1s/],
  ]) {
    assert.throws(() => parseWhen(text), (e) => {
      assert.strictEqual(e.code, 'EBADWHEN');
      assert.ok(e.message.includes('"' + text + '"'), 'the offending text is named: ' + e.message);
      assert.match(e.message, why);
      return true;
    }, 'expected "' + text + '" to be refused');
  }
});

test('cron matches minute/hour/month, and ORs the two day fields the way cron does', () => {
  const w = parseWhen('30 4 * * *');
  assert.ok(cronMatches(w, at('2026-03-05T04:30:00')));
  assert.ok(!cronMatches(w, at('2026-03-05T04:31:00')));

  // both day fields restricted -> the 13th OR any Friday
  const friday13 = parseWhen('0 0 13 * fri');
  assert.ok(cronMatches(friday13, at('2026-01-13T00:00:00')), 'the 13th, a Tuesday');
  assert.ok(cronMatches(friday13, at('2026-01-16T00:00:00')), 'a Friday, not the 13th');
  assert.ok(!cronMatches(friday13, at('2026-01-14T00:00:00')));

  // one of them a * -> the other decides
  const weekdays = parseWhen('0 9 * * mon-fri');
  assert.ok(cronMatches(weekdays, at('2026-01-14T09:00:00')), 'a Wednesday');
  assert.ok(!cronMatches(weekdays, at('2026-01-17T09:00:00')), 'a Saturday');
  // sunday spells both ways
  assert.ok(cronMatches(parseWhen('0 9 * * 7'), at('2026-01-18T09:00:00')));
  assert.ok(cronMatches(parseWhen('0 9 * * 0'), at('2026-01-18T09:00:00')));
  // a month by name
  assert.ok(cronMatches(parseWhen('0 0 1 jan *'), at('2026-01-01T00:00:00')));
  assert.ok(!cronMatches(parseWhen('0 0 1 jan *'), at('2026-02-01T00:00:00')));
});

test('an interval fires on a FIXED GRID off its creation — deferring a window never drifts it', () => {
  const w = parseWhen('5m');
  const anchor = at('2026-05-01T10:00:00Z');
  assert.strictEqual(nextAfter(w, anchor + 1, anchor), anchor + 5 * MIN);
  // the cursor pulled back a millisecond (a queued overlap) re-offers the SAME
  // window, at the same instant — not one interval after the pullback
  assert.deepStrictEqual(dueWindows(w, anchor + 5 * MIN - 1, anchor + 6 * MIN, anchor).windows,
    [anchor + 5 * MIN]);
  assert.strictEqual(describeWhen(w), 'every 5m');
  assert.strictEqual(describeWhen(parseWhen('0 8 * * *')), 'cron 0 8 * * *');
});

test('a cron expression that never comes has no next fire, rather than a wrong one', () => {
  assert.strictEqual(nextAfter(parseWhen('0 0 31 feb *'), at('2026-01-01T00:00:00')), null);
});

// ---------- catch-up: the laptop that slept over the weekend ----------

test('each catch-up policy does what it says with the windows a downtime missed', () => {
  const w = parseWhen('1h');
  const anchor = at('2026-05-01T00:00:00Z');
  const boot = anchor + 20 * 3600000;               // the server came back at hour 20
  const now = boot + 60000;
  const due = dueWindows(w, anchor + 4 * 3600000, now, anchor); // 16 windows missed
  assert.strictEqual(due.windows.length, 16);
  assert.strictEqual(due.truncated, 0, 'sixteen is well under the cap — nothing was thrown away');

  const latest = pickWindows(due, 'latest', boot);
  assert.deepStrictEqual(latest.fire, [due.windows[15]], 'latest fires ONCE — that is the whole point');
  assert.strictEqual(latest.dropped, 15);

  const all = pickWindows(due, 'all', boot);
  assert.deepStrictEqual(all.fire, due.windows, 'all fires every one');
  assert.strictEqual(all.dropped, 0);

  const none = pickWindows(due, 'none', boot);
  assert.deepStrictEqual(none.fire, [], 'none fires nothing that came due while we were down');
  assert.strictEqual(none.dropped, 16);

  // …but `none` is about DOWNTIME, not about firing: a window that comes due
  // while the scheduler is watching still fires.
  const live = pickWindows({ windows: [boot + 30000], truncated: 0 }, 'none', boot);
  assert.deepStrictEqual(live.fire, [boot + 30000]);
});

test('a board that was off for a year does not enumerate a year of windows — and says how many it lost', () => {
  const w = parseWhen('1m');
  const now = at('2026-05-01T00:00:00Z');
  const t0 = Date.now();
  const due = dueWindows(w, now - 400 * 24 * 3600000, now, 0);
  assert.ok(due.windows.length <= 52, 'the enumeration is bounded: ' + due.windows.length);
  assert.ok(Date.now() - t0 < 2000, 'and it is fast');

  // The count a catch-up log prints is the windows really missed, not the fifty
  // that survived the cap — "1 due window not fired" for a year of downtime is
  // the reassuring lie this number exists to refuse.
  const missed = 400 * 24 * 60;
  const latest = pickWindows(due, 'latest', 0);
  assert.strictEqual(latest.fire.length, 1);
  assert.strictEqual(latest.dropped, missed - 1);
  assert.strictEqual(pickWindows(due, 'all', 0).dropped, missed - 50);
});

test('a hand-edited schedule with an unparseable `when` is KEPT, never silently dropped', () => {
  const kept = normalizeSchedules([
    { name: 'good', hook: 'h', when: '5m', owner: 'ada' },
    { name: 'broken', hook: 'h', when: 'every wednesday-ish', owner: 'ada' },
    { name: '../evil', hook: 'h', when: '5m', owner: 'ada' },
    { name: 'good', hook: 'h', when: '5m', owner: 'ada' },
    'not an object',
  ]);
  assert.deepStrictEqual(kept.map((s) => s.name), ['good', 'broken'],
    'a traversal name and a duplicate go; a bad expression stays and says so');
  assert.deepStrictEqual([kept[0].overlap, kept[0].catchup], ['skip', 'latest'], 'the defaults');
});

// ---------- the board object ----------

// A workspace seeded on disk: one lieutenant, one named hook, and whatever
// schedules the test wants ALREADY carrying a cursor — which is how a restart
// across a due window is exercised without waiting for one.
function seedWorkspace(dir, opts) {
  const state = path.join(dir, '.bridge-commander');
  fs.mkdirSync(path.join(state, 'hooks'), { recursive: true });
  const hook = path.join(state, 'hooks', opts.hookName || 'tick');
  fs.writeFileSync(hook, '#!/bin/sh\n' + (opts.script || 'echo fired') + '\n');
  fs.chmodSync(hook, 0o755);
  fs.writeFileSync(path.join(state, 'board.json'), JSON.stringify({
    title: 'test', seq: 0,
    lieutenants: [{ id: LT, name: 'Ada', color: '#58b6ff', ref: null }],
    cards: [], events: [], labels: [], projects: [], workers: [],
    schedules: opts.schedules || [],
  }, null, 2));
}
function counted(dir, file) {
  try { return fs.readFileSync(path.join(dir, file), 'utf8').split('\n').filter(Boolean).length; }
  catch (e) { return 0; }
}
function runsOf(dir, name) {
  let lines = [];
  try {
    lines = fs.readFileSync(path.join(dir, '.bridge-commander', 'hookruns.jsonl'), 'utf8')
      .split('\n').filter(Boolean).map((l) => JSON.parse(l));
  } catch (e) {}
  return lines.filter((r) => r.trigger === 'schedule:' + name);
}
// A schedule whose windows are all in the PAST: `created` anchors the grid, and
// `lastWindow` is the cursor, so `back` minutes of 1-minute windows are already
// due the instant the server boots.
function overdue(name, back, extra) {
  const anchor = Date.now() - back * MIN;
  return Object.assign({
    name, hook: 'tick', when: '1m', owner: LT, overlap: 'skip', catchup: 'latest',
    paused: false, created: iso(anchor), lastWindow: iso(anchor), problem: '',
  }, extra || {});
}
const FAST = { BC_SCHEDULE_INTERVAL_MS: '60' };

test('add refuses a bad expression, a hook that is not there, an unknown owner and a duplicate', async () => {
  const s = await startServerWithLieutenant();
  try {
    const ws = ['--workspace', s.dir, '--port', String(s.port)];
    const hooks = path.join(s.dir, '.bridge-commander', 'hooks');
    fs.mkdirSync(hooks, { recursive: true });
    fs.writeFileSync(path.join(hooks, 'tick'), '#!/bin/sh\nexit 0\n');
    fs.chmodSync(path.join(hooks, 'tick'), 0o755);

    const bad = await runCli(['schedule', 'add', 'a', '--hook', 'tick', '--when', '*/5 * * *', '--owner', LT, ...ws]);
    assert.strictEqual(bad.code, 1);
    assert.match(bad.stderr, /\*\/5 \* \* \*/, 'the offending text is named');

    const ghost = await runCli(['schedule', 'add', 'a', '--hook', 'nope', '--when', '5m', '--owner', LT, ...ws]);
    assert.strictEqual(ghost.code, 1);
    assert.match(ghost.stderr, /no hook "nope"/);
    assert.ok(ghost.stderr.includes(hooks), 'and the directory it would have lived in');

    const orphan = await runCli(['schedule', 'add', 'a', '--hook', 'tick', '--when', '5m', '--owner', 'ghost', ...ws]);
    assert.strictEqual(orphan.code, 1);
    assert.match(orphan.stderr, /unknown lieutenant "ghost"/);

    const bogusPolicy = await runCli(['schedule', 'add', 'a', '--hook', 'tick', '--when', '5m',
      '--owner', LT, '--overlap', 'whenever', ...ws]);
    assert.strictEqual(bogusPolicy.code, 1);
    assert.match(bogusPolicy.stderr, /overlap must be one of: skip, queue, restart/);

    const ok = await runCli(['schedule', 'add', 'a', '--hook', 'tick', '--when', '5m', '--owner', LT, ...ws]);
    assert.strictEqual(ok.code, 0, ok.stderr);
    const dup = await runCli(['schedule', 'add', 'a', '--hook', 'tick', '--when', '5m', '--owner', LT, ...ws]);
    assert.strictEqual(dup.code, 1);
    assert.match(dup.stderr, /already exists/);
    assert.strictEqual((await s.api('GET', '/api/schedules')).body.schedules.length, 1);
  } finally { await s.stop(); }
});

test('a firing goes through hook run and nowhere else — the trace names the SCHEDULE', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bc-sched-'));
  const s = await startServer({ dir, env: FAST, seed: (d) => seedWorkspace(d, {
    script: 'echo ran >> ' + JSON.stringify(path.join(dir, 'fired')),
    schedules: [overdue('watcher', 3)],
  }) });
  try {
    for (let i = 0; i < 60 && counted(dir, 'fired') < 1; i++) await sleep(50);
    assert.strictEqual(counted(dir, 'fired'), 1);
    const runs = runsOf(dir, 'watcher');
    assert.strictEqual(runs.length, 1);
    assert.deepStrictEqual([runs[0].hook, runs[0].ok, runs[0].code], ['tick', true, 0]);

    // and `list`/`show` say last fire, next fire and last outcome — a schedule
    // you cannot see is one you will not trust
    const list = await runCli(['schedule', 'list', '--workspace', dir, '--port', String(s.port)]);
    assert.match(list.stdout, /watcher\ttick\tevery 1m\tada\tnext (in|due)/);
    assert.match(list.stdout, /fired \d+s ago · exit 0/);
    const show = await runCli(['schedule', 'show', 'watcher', '--workspace', dir, '--port', String(s.port)]);
    assert.match(show.stdout, /last fire: fired/);
    assert.match(show.stdout, /next fire: in/);
    assert.match(show.stdout, /--- firings ---/);
  } finally { await s.stop(); fs.rmSync(dir, { recursive: true, force: true }); }
});

// ---------- catch-up, over a real restart ----------

test('catch-up latest fires ONCE for a weekend of missed windows; all fires each; none fires none', async () => {
  for (const [catchup, want] of [['latest', 1], ['all', 10], ['none', 0]]) {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bc-catchup-'));
    const s = await startServer({ dir, env: FAST, seed: (d) => seedWorkspace(d, {
      script: 'echo ran >> ' + JSON.stringify(path.join(dir, 'fired')),
      schedules: [overdue('sleepy', 10, { catchup })],
    }) });
    try {
      // ten 1-minute windows came due while the server was down
      for (let i = 0; i < 60 && counted(dir, 'fired') < want; i++) await sleep(50);
      await sleep(300); // and nothing more arrives after
      assert.strictEqual(counted(dir, 'fired'), want, 'catch-up ' + catchup);
      const sched = (await s.api('GET', '/api/schedules')).body.schedules[0];
      assert.ok(Date.parse(sched.lastWindow) > Date.now() - 90000,
        'every policy still advances the cursor past what it dropped (' + catchup + ')');
    } finally { await s.stop(); fs.rmSync(dir, { recursive: true, force: true }); }
  }
});

test('a restart neither loses a due window nor double-fires one', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bc-restart-'));
  const seed = (d) => seedWorkspace(d, {
    script: 'echo ran >> ' + JSON.stringify(path.join(dir, 'fired')),
    schedules: [overdue('once', 2)],
  });
  const first = await startServer({ dir, env: FAST, seed });
  try {
    for (let i = 0; i < 60 && counted(dir, 'fired') < 1; i++) await sleep(50);
    assert.strictEqual(counted(dir, 'fired'), 1, 'the window that came due while it was down FIRED');
  } finally { await first.stop(); }

  const again = await startServer({ dir, env: FAST });
  try {
    await sleep(500);
    assert.strictEqual(counted(dir, 'fired'), 1, 'and the restart did not fire it a second time');
    assert.strictEqual(runsOf(dir, 'once').length, 1);
  } finally { await again.stop(); fs.rmSync(dir, { recursive: true, force: true }); }
});

// ---------- overlap: the policy over hook run's refusal ----------

// The situation `overlap` is for: a five-minute poll that takes six minutes.
// A window comes due while the PREVIOUS firing is still running — which needs a
// hook that outlives its own interval, not a catch-up backlog (a backlog drains
// one at a time, in order, and is never an overlap).
function slowTicker(name, extra) {
  const anchor = Date.now() - 1000;
  return Object.assign({
    name, hook: 'tick', when: '1s', owner: LT, overlap: 'skip', catchup: 'latest',
    paused: false, created: iso(anchor), lastWindow: iso(anchor), problem: '',
  }, extra || {});
}

test('overlap skip does not run — and RECORDS the skip rather than swallowing it', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bc-skip-'));
  const s = await startServer({ dir, env: FAST, seed: (d) => seedWorkspace(d, {
    script: 'echo ran >> ' + JSON.stringify(path.join(dir, 'fired')) + '\nsleep 3',
    schedules: [slowTicker('slow')],
  }) });
  try {
    // one window fires and holds the hook for three seconds; the windows that
    // come due each second while it runs are refused, and every one is recorded
    for (let i = 0; i < 80 && runsOf(dir, 'slow').length < 2; i++) await sleep(50);
    const runs = runsOf(dir, 'slow');
    assert.strictEqual(counted(dir, 'fired'), 1, 'only one actually ran');
    assert.ok(runs.length >= 2, 'and the skips are on the trace: ' + JSON.stringify(runs));
    assert.ok(runs.every((r) => r.skipped), 'every line so far is a skip — the run is still going');
    assert.match(runs[0].output, /previous firing/, 'a skip says what it lost to');

    const show = await runCli(['schedule', 'show', 'slow', '--workspace', dir, '--port', String(s.port)]);
    assert.match(show.stdout, /skipped/, 'and a skip reads as a firing, because it is one');
  } finally { await s.stop(); fs.rmSync(dir, { recursive: true, force: true }); }
});

// The test above stops as soon as two trace lines exist — while the run is
// still going, which is precisely where the interesting failure ISN'T. The
// cursor regression only appears when a long run ENDS: if it wrote back the
// cursor it started with, every window the skips already accounted for would
// come due a second time, `skip` would degenerate into back-to-back firing, and
// hookruns.jsonl would hold skips for windows that then ran.
test('a firing that outlives its own windows never pulls the cursor back over the skips', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bc-skipcursor-'));
  // A slow tick on purpose: it is read far more often than it fires, so a
  // cursor that went backwards is still there to be seen rather than papered
  // over by the next pass a few milliseconds later.
  const s = await startServer({ dir, env: { BC_SCHEDULE_INTERVAL_MS: '300' }, seed: (d) => seedWorkspace(d, {
    script: 'echo ran >> ' + JSON.stringify(path.join(dir, 'fired')) + '\nsleep 3',
    schedules: [slowTicker('marathon')],
  }) });
  try {
    // watched all the way through the three-second run and well past its end
    let high = 0;
    let after = 0;
    let settled = null;
    for (let i = 0; i < 400 && after < 20; i++) {
      await sleep(20);
      const sched = (await s.api('GET', '/api/schedules')).body.schedules[0];
      const cursor = Date.parse(sched.lastWindow);
      assert.ok(cursor >= high, 'the cursor of a `skip` schedule only ever moves forward: '
        + iso(high) + ' -> ' + sched.lastWindow);
      high = cursor;
      // read a poll LATER than the one that saw the run land, so the pass has
      // certainly written what it reached
      if (settled === null && after > 0) settled = cursor;
      if (runsOf(dir, 'marathon').some((r) => r.ok)) after++;
    }
    assert.ok(after >= 20, 'the long run finished and was watched past its end');

    // …and forward is not enough on its own: the pass has to land on the claim
    // its skips moved, not on the window it started with. Only the skips that
    // belong to the FINISHED pass are asserted — a later pass is still holding
    // its own, which is the whole point of the cursor lagging.
    const runs = runsOf(dir, 'marathon');
    const done = runs.find((r) => r.ok);
    const end = Date.parse(done.started) + done.ms;
    const mine = runs.filter((r) => r.skipped && Date.parse(r.started) < end)
      .map((r) => Date.parse((/window ([^)]+)\)/.exec(r.output) || [])[1]))
      .filter((t) => !Number.isNaN(t));
    assert.ok(mine.length >= 1, 'the windows it ran through were skipped, and recorded: '
      + JSON.stringify(runs));
    assert.ok(settled >= Math.max(...mine),
      'the finished pass wrote the claim its skips reached (' + iso(Math.max(...mine))
      + '), not the window it started with (' + iso(settled) + ')');
  } finally { await s.stop(); fs.rmSync(dir, { recursive: true, force: true }); }
});

// The other half of the same guarantee, and the reason the stored cursor lags
// the claim: a window that was in flight when the machine went away has to come
// back. At-most-once would lose the firing outright, with nothing anywhere
// saying a window ever came due.
test('a window in flight when the process is killed is offered again after a restart', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bc-atleastonce-'));
  const seed = (d) => seedWorkspace(d, {
    script: 'echo ran >> ' + JSON.stringify(path.join(dir, 'fired')) + '\nsleep 10',
    schedules: [overdue('unfinished', 2)],
  });
  const first = await startServer({ dir, env: FAST, seed });
  try {
    for (let i = 0; i < 100 && counted(dir, 'fired') < 1; i++) await sleep(50);
    assert.strictEqual(counted(dir, 'fired'), 1, 'the due window fired and the hook is still running');
    const sched = (await first.api('GET', '/api/schedules')).body.schedules[0];
    assert.ok(Date.parse(sched.lastWindow) < Date.now() - 60000,
      'and board.json still names the window BEFORE it: ' + sched.lastWindow);
  } finally {
    first.child.kill('SIGKILL'); // the machine going away, mid-hook
    await sleep(200);
  }

  const again = await startServer({ dir, env: FAST });
  try {
    for (let i = 0; i < 100 && counted(dir, 'fired') < 2; i++) await sleep(50);
    assert.strictEqual(counted(dir, 'fired'), 2,
      'the interrupted window came due again — at-least-once, not silently lost');
  } finally { await again.stop(); fs.rmSync(dir, { recursive: true, force: true }); }
});

test('overlap queue holds the window back and runs it once the firing in flight finishes', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bc-queue-'));
  const s = await startServer({ dir, env: FAST, seed: (d) => seedWorkspace(d, {
    script: 'echo ran >> ' + JSON.stringify(path.join(dir, 'fired')) + '\nsleep 1',
    schedules: [slowTicker('lined-up', { overlap: 'queue' })],
  }) });
  try {
    // the trace line lands when a run FINISHES, so waiting on it is waiting for
    // three windows to have gone all the way through, one after another
    for (let i = 0; i < 200 && runsOf(dir, 'lined-up').filter((r) => r.ok).length < 3; i++) await sleep(50);
    const runs = runsOf(dir, 'lined-up');
    assert.ok(runs.filter((r) => r.ok).length >= 3, 'the held-back windows ran, one after the other');
    assert.strictEqual(runs.filter((r) => r.skipped).length, 0, 'a queued window is never a skip');
  } finally { await s.stop(); fs.rmSync(dir, { recursive: true, force: true }); }
});

test('overlap restart kills the firing in flight, takes the name, and leaves a record of both', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bc-restartpol-'));
  const s = await startServer({ dir, env: FAST, seed: (d) => seedWorkspace(d, {
    script: 'echo ran >> ' + JSON.stringify(path.join(dir, 'fired')) + '\nsleep 30\n'
      + 'echo finished >> ' + JSON.stringify(path.join(dir, 'finished')),
    schedules: [slowTicker('impatient', { overlap: 'restart' })],
  }) });
  try {
    for (let i = 0; i < 160 && counted(dir, 'fired') < 3; i++) await sleep(50);
    assert.ok(counted(dir, 'fired') >= 3, 'each window took the name from the one before it');
    assert.strictEqual(counted(dir, 'finished'), 0, 'and none of the killed runs ever finished');
    const killed = runsOf(dir, 'impatient').filter((r) => r.canceled);
    assert.ok(killed.length >= 2, 'the interrupted runs are on the trace, marked: '
      + JSON.stringify(runsOf(dir, 'impatient')));
    assert.ok(killed.every((r) => !r.ok));
  } finally { await s.stop(); fs.rmSync(dir, { recursive: true, force: true }); }
});

// ---------- a firing that fails lands on its owner ----------

test('a failing firing wakes the OWNER with the hook’s output — never only a log line', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bc-schedfail-'));
  const s = await startServer({ dir, env: FAST, seed: (d) => seedWorkspace(d, {
    script: 'echo the gh call blew up >&2\nexit 3',
    schedules: [overdue('broken', 2)],
  }) });
  try {
    let items = [];
    for (let i = 0; i < 60 && !items.length; i++) {
      await sleep(50);
      items = (await s.api('GET', '/api/feed?lieutenant=' + LT)).body.items || [];
    }
    const it = items.find((x) => x.kind === 'schedule-failed');
    assert.ok(it, 'the owner was woken: ' + JSON.stringify(items));
    assert.strictEqual(it.schedule, 'broken');
    assert.match(it.text, /exit 3/);
    assert.match(it.text, /the gh call blew up/, 'carrying the hook’s output');

    const drain = await runCli(['drain', '--lieutenant', LT, '--workspace', dir, '--port', String(s.port)]);
    assert.match(drain.stdout, /SCHEDULE broken/);
    assert.match(drain.stdout, /bc-axi schedule show broken/, 'the drain says what to do about it');

    const board = (await s.api('GET', '/api/board')).body;
    assert.ok(board.events.some((e) => e.kind === 'schedule-failed' && e.level === 1));
  } finally { await s.stop(); fs.rmSync(dir, { recursive: true, force: true }); }
});

// A hook whose exit code the test can change between windows. The key a wake is
// spent against is built from the failure SIGNATURE, so "the same failure
// again" and "a different failure" have to be tellable apart from outside.
function flaky(dir, name) {
  const codeFile = path.join(dir, 'code');
  fs.writeFileSync(codeFile, '3\n');
  return {
    codeFile,
    seed: (d) => seedWorkspace(d, {
      script: 'echo the gh call blew up >&2\nexit "$(cat ' + JSON.stringify(codeFile) + ')"',
      schedules: [slowTicker(name)],
    }),
  };
}
async function wakes(s) {
  const items = (await s.api('GET', '/api/feed?lieutenant=' + LT)).body.items || [];
  return items.filter((x) => x.kind === 'schedule-failed');
}

test('a hook failing the SAME way every window wakes the owner once — and still says so every time', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bc-schedrepeat-'));
  const s = await startServer({ dir, env: FAST, seed: flaky(dir, 'flaky').seed });
  try {
    for (let i = 0; i < 200 && runsOf(dir, 'flaky').filter((r) => !r.ok && !r.skipped).length < 3; i++) {
      await sleep(50);
    }
    const bad = runsOf(dir, 'flaky').filter((r) => !r.ok && !r.skipped);
    assert.ok(bad.length >= 3, 'the hook failed several windows running: ' + bad.length);

    assert.strictEqual((await wakes(s)).length, 1, 'the owner heard it once, not once per window');
    const evs = (await s.api('GET', '/api/board')).body.events.filter((e) => e.kind === 'schedule-failed');
    assert.ok(evs.length >= 3, 'every failing firing is still on the timeline: ' + evs.length);
    assert.strictEqual(evs.filter((e) => e.level === 1).length, 1,
      'and exactly one of them rang the bell');
  } finally { await s.stop(); fs.rmSync(dir, { recursive: true, force: true }); }
});

test('a hook that starts failing DIFFERENTLY is a new failure, and is heard', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bc-schedchanged-'));
  const f = flaky(dir, 'flaky');
  const s = await startServer({ dir, env: FAST, seed: f.seed });
  try {
    for (let i = 0; i < 200 && (await wakes(s)).length < 1; i++) await sleep(50);
    assert.strictEqual((await wakes(s)).length, 1);
    await sleep(2000);
    assert.strictEqual((await wakes(s)).length, 1, 'the same failure repeating is not a second wake');

    fs.writeFileSync(f.codeFile, '4\n');
    let woke = [];
    for (let i = 0; i < 200 && woke.length < 2; i++) { await sleep(50); woke = await wakes(s); }
    assert.strictEqual(woke.length, 2, 'a different exit code is a different failure');
    assert.ok(woke.some((x) => /exit 4/.test(x.text)), 'and it carries what changed: '
      + JSON.stringify(woke.map((x) => x.text)));
  } finally { await s.stop(); fs.rmSync(dir, { recursive: true, force: true }); }
});

test('a green firing after a failing one says so, and re-arms the next wake', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bc-schedheal-'));
  const f = flaky(dir, 'flaky');
  const s = await startServer({ dir, env: FAST, seed: f.seed });
  try {
    for (let i = 0; i < 200 && (await wakes(s)).length < 1; i++) await sleep(50);

    fs.writeFileSync(f.codeFile, '0\n');
    let green = null;
    for (let i = 0; i < 200 && !green; i++) {
      await sleep(50);
      green = (await s.api('GET', '/api/board')).body.events.find((e) => /green again/.test(e.text));
    }
    assert.ok(green, 'the recovery is on the timeline — silence must not mean both fixed and broken');
    assert.strictEqual(green.level, 2, 'a recovery is not a bell');

    // and because the key was forgotten, the SAME failure is a new one again
    fs.writeFileSync(f.codeFile, '3\n');
    let woke = [];
    for (let i = 0; i < 200 && woke.length < 2; i++) { await sleep(50); woke = await wakes(s); }
    assert.strictEqual(woke.length, 2, 'the next failure after a recovery wakes the owner again');
  } finally { await s.stop(); fs.rmSync(dir, { recursive: true, force: true }); }
});

test('a hook deleted under a live schedule makes the schedule SAY SO, once, instead of dying quietly', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bc-schedgone-'));
  const s = await startServer({ dir, env: FAST, seed: (d) => seedWorkspace(d, {
    schedules: [{ name: 'orphan', hook: 'tick', when: '1m', owner: LT, overlap: 'skip',
      catchup: 'latest', paused: false, created: iso(Date.now()), lastWindow: iso(Date.now()), problem: '' }],
  }) });
  try {
    fs.rmSync(path.join(dir, '.bridge-commander', 'hooks', 'tick'));
    let sched = null;
    for (let i = 0; i < 60 && !(sched && sched.problem); i++) {
      await sleep(50);
      sched = (await s.api('GET', '/api/schedules')).body.schedules[0];
    }
    assert.match(sched.problem, /hook "tick" is gone/);
    assert.match(sched.problem, /fires nothing/);
    const show = await runCli(['schedule', 'show', 'orphan', '--workspace', dir, '--port', String(s.port)]);
    assert.match(show.stdout, /PROBLEM:/);

    // once, not once per window
    await sleep(400);
    const items = (await s.api('GET', '/api/feed?lieutenant=' + LT)).body.items || [];
    assert.strictEqual(items.filter((x) => x.kind === 'schedule-failed').length, 1,
      'the owner hears about it once, not every tick');

    // and it heals: the hook comes back, the schedule says so and fires again
    const hook = path.join(dir, '.bridge-commander', 'hooks', 'tick');
    fs.writeFileSync(hook, '#!/bin/sh\nexit 0\n');
    fs.chmodSync(hook, 0o755);
    for (let i = 0; i < 60 && sched.problem; i++) {
      await sleep(50);
      sched = (await s.api('GET', '/api/schedules')).body.schedules[0];
    }
    assert.strictEqual(sched.problem, '');

    // …and the heal reaches the owner as a RECOVERY. The drain dispatches on
    // the item's kind, so this is what decides whether a schedule that just
    // came back tells its owner to go and fix the hook.
    let healed = [];
    for (let i = 0; i < 60 && !healed.length; i++) {
      await sleep(50);
      healed = ((await s.api('GET', '/api/feed?lieutenant=' + LT)).body.items || [])
        .filter((x) => x.kind === 'schedule');
    }
    assert.strictEqual(healed.length, 1, 'the recovery landed on the owner queue');
    assert.match(healed[0].text, /healthy again/);
    const both = (await s.api('GET', '/api/feed?lieutenant=' + LT)).body.items || [];
    assert.strictEqual(both.filter((x) => x.kind === 'schedule-failed').length, 1,
      'and it did not arrive as a second failure');

    // read it the way its owner will, with the failure already handled
    const ws = ['--lieutenant', LT, '--workspace', dir, '--port', String(s.port)];
    const failed = both.find((x) => x.kind === 'schedule-failed');
    assert.strictEqual((await runCli(['ack', String(failed.seq), ...ws])).code, 0);
    const drain = await runCli(['drain', ...ws]);
    assert.match(drain.stdout, /SCHEDULE orphan — healthy again/);
    assert.doesNotMatch(drain.stdout, /a firing failed/, 'a recovery is not a failure');
    assert.doesNotMatch(drain.stdout, /Fix the hook, or pause the schedule/,
      'and a schedule that just healed is not told to go and fix its hook');
  } finally { await s.stop(); fs.rmSync(dir, { recursive: true, force: true }); }
});

// ---------- pause, resume, remove ----------

test('pause stops the clock for one schedule; resume re-arms it at NOW, not at the backlog', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bc-pause-'));
  const s = await startServer({ dir, env: FAST, seed: (d) => seedWorkspace(d, {
    script: 'echo ran >> ' + JSON.stringify(path.join(dir, 'fired')),
    schedules: [Object.assign(overdue('napping', 5, { catchup: 'all' }), { paused: true })],
  }) });
  const ws = ['--workspace', dir, '--port', String(s.port)];
  try {
    await sleep(400);
    assert.strictEqual(counted(dir, 'fired'), 0, 'a paused schedule fires nothing');
    const list = await runCli(['schedule', 'list', ...ws]);
    assert.match(list.stdout, /PAUSED/);

    const resumed = await runCli(['schedule', 'resume', 'napping', ...ws]);
    assert.strictEqual(resumed.code, 0, resumed.stderr);
    await sleep(400);
    assert.strictEqual(counted(dir, 'fired'), 0,
      'resume is not a catch-up: the five windows it slept through are gone, not queued');

    const paused = await runCli(['schedule', 'pause', 'napping', ...ws]);
    assert.match(paused.stdout, /paused/);
    const gone = await runCli(['schedule', 'remove', 'napping', ...ws]);
    assert.strictEqual(gone.code, 0, gone.stderr);
    assert.deepStrictEqual((await s.api('GET', '/api/schedules')).body.schedules, []);
    assert.ok(fs.existsSync(path.join(dir, '.bridge-commander', 'hooks', 'tick')), 'the hook is untouched');

    const missing = await runCli(['schedule', 'show', 'napping', ...ws]);
    assert.strictEqual(missing.code, 1);
    assert.match(missing.stderr, /unknown schedule/);
  } finally { await s.stop(); fs.rmSync(dir, { recursive: true, force: true }); }
});

// A pause that lands mid-hook is the case the instant-hook test above cannot
// reach: the pass is still holding a claim from before the pause, and resume
// has already re-armed the cursor at now. The pass finishing must not drag the
// cursor back over the resume — a pause is not a queue, so the interval it slept
// through is gone, not owed.
//
// `queue` on purpose: it is the one policy that leaves the claim exactly where
// the pass took it, so what the finishing pass writes is visible. Under `skip`
// the overlap policy keeps moving the claim forward after the resume, which
// hides the rewind rather than preventing it.
test('a pause and resume across a long firing never drags the cursor back over the resume', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bc-pausemid-'));
  const s = await startServer({ dir, env: FAST, seed: (d) => seedWorkspace(d, {
    script: 'echo ran >> ' + JSON.stringify(path.join(dir, 'fired')) + '\nsleep 3',
    schedules: [slowTicker('interrupted', { overlap: 'queue' })],
  }) });
  const ws = ['--workspace', dir, '--port', String(s.port)];
  try {
    for (let i = 0; i < 100 && counted(dir, 'fired') < 1; i++) await sleep(50);
    assert.strictEqual(counted(dir, 'fired'), 1, 'a window is firing, and the hook holds it for 3s');

    assert.strictEqual((await runCli(['schedule', 'pause', 'interrupted', ...ws])).code, 0);
    await sleep(1200); // a window or two goes by while it is paused
    assert.strictEqual(counted(dir, 'fired'), 1, 'a paused schedule fires nothing, even mid-hook');
    assert.strictEqual((await runCli(['schedule', 'resume', 'interrupted', ...ws])).code, 0);
    const resumedAt = Date.parse((await s.api('GET', '/api/schedules')).body.schedules[0].lastWindow);

    // let the pass that started BEFORE the pause finish, and then some
    for (let i = 0; i < 200 && !runsOf(dir, 'interrupted').some((r) => r.ok); i++) await sleep(50);
    await sleep(300);
    const after = Date.parse((await s.api('GET', '/api/schedules')).body.schedules[0].lastWindow);
    assert.ok(after >= resumedAt, 'the finished pass left the cursor at or after the resume ('
      + iso(after) + ' vs ' + iso(resumedAt) + ') — the paused interval never became due');
  } finally { await s.stop(); fs.rmSync(dir, { recursive: true, force: true }); }
});

test('a cursor that is not a date SAYS SO, instead of being a healthy-looking clock that never fires', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bc-badcursor-'));
  const s = await startServer({ dir, env: FAST, seed: (d) => seedWorkspace(d, {
    script: 'echo ran >> ' + JSON.stringify(path.join(dir, 'fired')),
    schedules: [overdue('corrupt', 5, { lastWindow: '2026-13-45T99:00' })],
  }) });
  const ws = ['--workspace', dir, '--port', String(s.port)];
  try {
    let sched = null;
    for (let i = 0; i < 100 && !(sched && sched.problem); i++) {
      await sleep(50);
      sched = (await s.api('GET', '/api/schedules')).body.schedules[0];
    }
    assert.match(sched.problem, /cursor "2026-13-45T99:00" is not a date/);
    assert.strictEqual(sched.next, null, 'and it does not print a plausible next fire for a dead clock');
    assert.strictEqual(counted(dir, 'fired'), 0, 'nothing fired, which is exactly why it has to say so');

    const show = await runCli(['schedule', 'show', 'corrupt', ...ws]);
    assert.match(show.stdout, /PROBLEM:/);
    assert.match(show.stdout, /next fire: never/, 'never, not a number it cannot honour');
    const items = (await s.api('GET', '/api/feed?lieutenant=' + LT)).body.items || [];
    assert.strictEqual(items.filter((x) => x.kind === 'schedule-failed').length, 1,
      'the owner heard it once, the way every other problem is announced');

    // and the way out the problem names actually works
    await runCli(['schedule', 'pause', 'corrupt', ...ws]);
    await runCli(['schedule', 'resume', 'corrupt', ...ws]);
    for (let i = 0; i < 100 && sched.problem; i++) {
      await sleep(50);
      sched = (await s.api('GET', '/api/schedules')).body.schedules[0];
    }
    assert.strictEqual(sched.problem, '', 'pause/resume re-armed the cursor and the clock is alive again');
    assert.ok(sched.next, 'and it has a next fire once more');
  } finally { await s.stop(); fs.rmSync(dir, { recursive: true, force: true }); }
});

test('schedules ride board.json — a clone of the workspace carries them', async () => {
  const s = await startServerWithLieutenant();
  try {
    const hooks = path.join(s.dir, '.bridge-commander', 'hooks');
    fs.mkdirSync(hooks, { recursive: true });
    fs.writeFileSync(path.join(hooks, 'nightly'), '#!/bin/sh\nexit 0\n');
    fs.chmodSync(path.join(hooks, 'nightly'), 0o755);
    const add = await runCli(['schedule', 'add', 'nightly', '--hook', 'nightly', '--when', '0 3 * * *',
      '--owner', LT, '--catch-up', 'none', '--workspace', s.dir, '--port', String(s.port)]);
    assert.strictEqual(add.code, 0, add.stderr);
    const stored = JSON.parse(fs.readFileSync(path.join(s.dir, '.bridge-commander', 'board.json'), 'utf8'));
    assert.deepStrictEqual(stored.schedules.map((x) => [x.name, x.hook, x.when, x.owner, x.catchup]),
      [['nightly', 'nightly', '0 3 * * *', LT, 'none']]);
  } finally { await s.stop(); }
});
