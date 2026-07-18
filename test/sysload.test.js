'use strict';
// sysload module (server/sysload.js): /proc parsing on fixture trees, process-
// tree attribution + summing, sampler refcount, docker-absent grace. No real
// /proc, tmux, or docker anywhere — every environmental read is injected.
const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const {
  createSampler, parseCpuTotals, parseMeminfo, parsePidStat, readProcTable, descendants,
} = require('../server/sysload.js');

// ---------- fixture /proc builder ----------
// procFixture(dir, { cpu: [total ticks split], pids: {pid: {ppid, ticks, rssKb}} })
// writes stat, meminfo and per-pid stat/status files the module's readers parse.
function writeProc(dir, opts) {
  const busy = opts.busyTicks != null ? opts.busyTicks : 1000;
  const idle = opts.idleTicks != null ? opts.idleTicks : 9000;
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'stat'),
    'cpu  ' + busy + ' 0 0 ' + idle + ' 0 0 0 0 0 0\n'
    + 'cpu0 0 0 0 0 0 0 0 0 0 0\ncpu1 0 0 0 0 0 0 0 0 0 0\n'
    + 'intr 0\nctxt 0\n');
  fs.writeFileSync(path.join(dir, 'meminfo'),
    'MemTotal:       16384000 kB\nMemFree:         2000000 kB\nMemAvailable:    8192000 kB\n');
  for (const [pid, p] of Object.entries(opts.pids || {})) {
    const d = path.join(dir, pid);
    fs.mkdirSync(d, { recursive: true });
    // field layout: pid (comm) state ppid pgrp session tty tpgid flags min cmin maj cmaj utime stime ...
    fs.writeFileSync(path.join(d, 'stat'),
      pid + ' (proc with) spaces) S ' + p.ppid + ' 1 1 0 -1 0 0 0 0 0 '
      + p.ticks + ' 0 0 0 20 0 1 0 100 1000000 500 0\n');
    fs.writeFileSync(path.join(d, 'status'),
      'Name:\tx\nPid:\t' + pid + '\nPPid:\t' + p.ppid + '\nVmRSS:\t' + (p.rssKb || 0) + ' kB\n');
  }
}

const STATFS = () => ({ bsize: 4096, blocks: 1000000, bfree: 250000, bavail: 250000 });

function tmpProc() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'bc-sysload-'));
}

// ---------- pure parsers ----------

test('parseCpuTotals: aggregate line + core count', () => {
  const t = parseCpuTotals('cpu  100 5 50 800 20 0 5 10 0 0\ncpu0 1 2 3 4 5 6 7 8 0 0\ncpu1 1 2 3 4 5 6 7 8 0 0\n');
  assert.equal(t.totalTicks, 990);
  assert.equal(t.idleTicks, 820); // idle + iowait
  assert.equal(t.cores, 2);
});

test('parseMeminfo: kB lines to bytes; missing keys read zero', () => {
  const m = parseMeminfo('MemTotal:       1000 kB\nMemAvailable:    400 kB\n');
  assert.equal(m.memTotalBytes, 1000 * 1024);
  assert.equal(m.memAvailBytes, 400 * 1024);
  assert.deepEqual(parseMeminfo(''), { memTotalBytes: 0, memAvailBytes: 0 });
});

test('parsePidStat: survives spaces and parens in comm', () => {
  const st = parsePidStat('42 (tmux: server) (x)) R 7 1 1 0 -1 0 0 0 0 0 30 12 0 0 20 0 1 0 100 1 1 0');
  assert.equal(st.ppid, 7);
  assert.equal(st.ticks, 42);
  assert.equal(parsePidStat('garbage'), null);
});

test('readProcTable + descendants: fabricated tree walks transitively', () => {
  const dir = tmpProc();
  try {
    writeProc(dir, { pids: {
      100: { ppid: 1, ticks: 10 },
      101: { ppid: 100, ticks: 20 },
      102: { ppid: 101, ticks: 30 },
      200: { ppid: 1, ticks: 40 },
    } });
    const table = readProcTable(dir);
    assert.equal(table.size, 4);
    const tree = descendants(table, [100]);
    assert.deepEqual([...tree].sort((a, b) => a - b), [100, 101, 102]); // 200 is unrelated
    assert.deepEqual([...descendants(table, [999])], []); // dead root: empty, no throw
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

// ---------- sampler ----------

// exec stub: tmux answers with the given pane lines; docker answers (or rejects).
function execStub({ panes = {}, docker = null } = {}) {
  const calls = [];
  const fn = (cmd, args) => {
    calls.push([cmd, ...args]);
    if (cmd === 'tmux') {
      const session = args[args.indexOf('-t') + 1];
      if (panes[session]) return Promise.resolve(panes[session]);
      return Promise.reject(new Error('no server running'));
    }
    if (cmd === 'docker') {
      if (docker === null) return Promise.reject(new Error('docker: not found'));
      return Promise.resolve(docker);
    }
    return Promise.reject(new Error('unexpected ' + cmd));
  };
  fn.calls = calls;
  return fn;
}

function collectSamples(sampler, n) {
  return new Promise((resolve) => {
    const got = [];
    const unsub = sampler.subscribe((s) => {
      got.push(s);
      if (got.length >= n) { unsub(); resolve(got); }
    });
  });
}

test('sampler: machine + per-entity CPU/RSS from two samples, heaviest first', async () => {
  const dir = tmpProc();
  try {
    // session bc-x-lt-ada: window main (lieutenant, pid 200), window w-c1
    // (worker, pid 100 with children 101,102)
    writeProc(dir, { busyTicks: 1000, idleTicks: 9000, pids: {
      100: { ppid: 1, ticks: 100, rssKb: 1000 },
      101: { ppid: 100, ticks: 100, rssKb: 2000 },
      102: { ppid: 101, ticks: 100, rssKb: 3000 },
      200: { ppid: 1, ticks: 100, rssKb: 500 },
    } });
    const exec = execStub({
      panes: { 'bc-x-lt-ada': 'main\t200\nw-c1\t100\n' },
      docker: 'abc\ndef\n',
    });
    const sampler = createSampler({
      procRoot: dir, diskPath: '/', statfs: STATFS, execFileImpl: exec, intervalMs: 40,
      targets: () => [
        { kind: 'worker', id: 'c1', label: 'Card One', session: 'bc-x-lt-ada', window: 'w-c1' },
        { kind: 'lieutenant', id: 'ada', label: 'Ada', session: 'bc-x-lt-ada', window: null },
      ],
    });

    // between sample 1 and 2: worker tree burns 100 ticks (1 CPU-second),
    // lieutenant 10; machine busy +100 of +1000 total
    const first = new Promise((r) => setTimeout(() => {
      writeProc(dir, { busyTicks: 1100, idleTicks: 9900, pids: {
        100: { ppid: 1, ticks: 120, rssKb: 1000 },
        101: { ppid: 100, ticks: 130, rssKb: 2000 },
        102: { ppid: 101, ticks: 150, rssKb: 3000 },
        200: { ppid: 1, ticks: 110, rssKb: 500 },
      } });
      r();
    }, 10));
    const [s1, s2] = await collectSamples(sampler, 2);
    await first;

    // sample 1: baseline — everything 0% but structure complete
    assert.equal(s1.machine.cpuPct, 0);
    assert.equal(s1.machine.cores, 2);
    assert.equal(s1.machine.memTotalBytes, 16384000 * 1024);
    assert.equal(s1.machine.memUsedBytes, (16384000 - 8192000) * 1024);
    assert.equal(s1.machine.diskTotalBytes, 1000000 * 4096);
    assert.equal(s1.machine.diskUsedBytes, 750000 * 4096);
    assert.equal(s1.containers, 2);
    assert.equal(s1.entities.length, 2);

    // sample 2: real deltas — machine 100 busy / 1000 total = 10%
    assert.equal(s2.machine.cpuPct, 10);
    const worker = s2.entities.find((e) => e.kind === 'worker');
    const lt = s2.entities.find((e) => e.kind === 'lieutenant');
    assert.equal(worker.id, 'c1');
    assert.equal(worker.label, 'Card One');
    assert.equal(worker.pids, 3); // 100 + descendants 101, 102
    assert.equal(worker.rssBytes, (1000 + 2000 + 3000) * 1024);
    assert.ok(worker.cpuPct > 0, 'worker burned ticks: ' + worker.cpuPct);
    assert.equal(lt.pids, 1);
    assert.equal(lt.rssBytes, 500 * 1024);
    assert.ok(worker.cpuPct > lt.cpuPct, 'heaviest first');
    assert.equal(s2.entities[0].kind, 'worker'); // sorted heaviest-first
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('sampler: docker absent → containers null; tmux gone → no entities, no crash', async () => {
  const dir = tmpProc();
  try {
    writeProc(dir, { pids: {} });
    const sampler = createSampler({
      procRoot: dir, statfs: STATFS, intervalMs: 40,
      execFileImpl: execStub({ panes: {}, docker: null }),
      targets: () => [{ kind: 'lieutenant', id: 'ada', label: 'Ada', session: 'bc-gone', window: null }],
    });
    const [s] = await collectSamples(sampler, 1);
    assert.equal(s.containers, null);
    assert.deepEqual(s.entities, []);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('sampler refcount: starts on first subscriber, stops at zero', async () => {
  const dir = tmpProc();
  try {
    writeProc(dir, { pids: {} });
    const sampler = createSampler({
      procRoot: dir, statfs: STATFS, intervalMs: 20,
      execFileImpl: execStub({ docker: '' }), targets: () => [],
    });
    assert.deepEqual(sampler.stats(), { subscribers: 0, sampling: false });

    let n1 = 0;
    const unsub1 = sampler.subscribe(() => n1++);
    assert.equal(sampler.stats().subscribers, 1);
    assert.equal(sampler.stats().sampling, true);
    await new Promise((r) => setTimeout(r, 80));
    assert.ok(n1 >= 2, 'loop is sampling: ' + n1);

    // a second subscriber gets the last sample replayed immediately
    let n2 = 0;
    const unsub2 = sampler.subscribe(() => n2++);
    assert.ok(n2 >= 1, 'late joiner painted from the last sample');
    assert.equal(sampler.stats().subscribers, 2);

    unsub1();
    assert.equal(sampler.stats().sampling, true); // one viewer left — keep going
    unsub2();
    assert.deepEqual(sampler.stats(), { subscribers: 0, sampling: false });
    const after = n1 + n2;
    await new Promise((r) => setTimeout(r, 60));
    assert.equal(n1 + n2, after, 'no samples after the last unsubscribe');
    unsub1(); // double-unsubscribe is a harmless no-op
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});
