'use strict';
// sysload — on-demand machine + per-agent load sampling. Node built-ins only.
//
// Zero cost when closed: nothing here runs until the FIRST subscriber arrives
// (createSampler().subscribe), and the loop stops dead when the LAST one
// leaves. The server wires this behind a dedicated SSE endpoint
// (GET /api/sysload/stream) — never the board push.
//
// One sample =
//   { ts, machine: { cpuPct, cores, memUsedBytes, memTotalBytes,
//                    diskUsedBytes, diskTotalBytes },
//     entities: [{ kind: 'worker'|'lieutenant', id, label, cpuPct, rssBytes, pids }],
//     containers: number|null }
//
// Machine numbers come straight from /proc/stat + /proc/meminfo + statfs on
// the workspace volume — Linux-first; anywhere that surface is missing the
// numbers read as graceful zeros. Entity rows are the headline: for every
// live worker and lieutenant session the server tracks, the sampler asks tmux
// for the pane pids (`list-panes -s`), walks the /proc ppid tree to collect
// each pane's descendants, and sums CPU%+RSS per entity, heaviest first.
// CPU% is delta-based (two reads of the same counters), so the first sample
// of a fresh loop reads 0% and truth arrives one interval later.
//
// Everything environmental is injectable (procRoot, statfs, execFile impl,
// targets, interval) so tests run on fixture /proc trees and stubbed tmux —
// see test/sysload.test.js.

const fs = require('node:fs');
const path = require('node:path');
const { execFile } = require('node:child_process');

const USER_HZ = 100; // /proc tick unit (USER_HZ); 100 on every mainstream Linux
const DEFAULT_INTERVAL_MS = 2000;
const EXEC_TIMEOUT_MS = 5000;

// ---------- /proc parsing (pure; every reader takes a procRoot) ----------

// Aggregate cpu line of /proc/stat -> { totalTicks, idleTicks, cores }.
// idle counts idle+iowait; total is the sum of every column (steal included).
function parseCpuTotals(text) {
  const out = { totalTicks: 0, idleTicks: 0, cores: 0 };
  for (const line of String(text || '').split('\n')) {
    if (/^cpu\d+ /.test(line)) { out.cores++; continue; }
    if (!/^cpu /.test(line)) continue;
    const n = line.trim().split(/\s+/).slice(1).map((v) => parseInt(v, 10) || 0);
    out.totalTicks = n.reduce((a, b) => a + b, 0);
    out.idleTicks = (n[3] || 0) + (n[4] || 0);
  }
  return out;
}
function readCpuTotals(procRoot) {
  try { return parseCpuTotals(fs.readFileSync(path.join(procRoot, 'stat'), 'utf8')); }
  catch (e) { return { totalTicks: 0, idleTicks: 0, cores: 0 }; }
}

// /proc/meminfo -> { memTotalBytes, memAvailBytes } (kB lines; zeros when absent).
function parseMeminfo(text) {
  const grab = (key) => {
    const m = new RegExp('^' + key + ':\\s+(\\d+)\\s*kB', 'm').exec(String(text || ''));
    return m ? parseInt(m[1], 10) * 1024 : 0;
  };
  return { memTotalBytes: grab('MemTotal'), memAvailBytes: grab('MemAvailable') };
}
function readMeminfo(procRoot) {
  try { return parseMeminfo(fs.readFileSync(path.join(procRoot, 'meminfo'), 'utf8')); }
  catch (e) { return { memTotalBytes: 0, memAvailBytes: 0 }; }
}

// /proc/<pid>/stat -> { ppid, ticks } (utime+stime). The comm field may hold
// spaces and parens, so fields are parsed AFTER the last ')'.
function parsePidStat(text) {
  const s = String(text || '');
  const i = s.lastIndexOf(')');
  if (i < 0) return null;
  const f = s.slice(i + 1).trim().split(/\s+/);
  // after comm: [0]=state [1]=ppid ... [11]=utime [12]=stime
  const ppid = parseInt(f[1], 10);
  const ticks = (parseInt(f[11], 10) || 0) + (parseInt(f[12], 10) || 0);
  if (!Number.isInteger(ppid)) return null;
  return { ppid, ticks };
}

// One pass over <procRoot>: pid -> { ppid, ticks }. RSS is read lazily later —
// only pids that land in some entity's tree pay for the second file read.
function readProcTable(procRoot) {
  const table = new Map();
  let names;
  try { names = fs.readdirSync(procRoot); } catch (e) { return table; }
  for (const name of names) {
    if (!/^\d+$/.test(name)) continue;
    let st;
    try { st = parsePidStat(fs.readFileSync(path.join(procRoot, name, 'stat'), 'utf8')); }
    catch (e) { continue; } // the process exited mid-scan
    if (st) table.set(parseInt(name, 10), st);
  }
  return table;
}

// VmRSS of one pid in bytes (0 when gone/unreadable) — /proc/<pid>/status is
// page-size independent, unlike stat's rss-in-pages.
function readPidRss(procRoot, pid) {
  try {
    const m = /^VmRSS:\s+(\d+)\s*kB/m.exec(fs.readFileSync(path.join(procRoot, pid + '/status'), 'utf8'));
    return m ? parseInt(m[1], 10) * 1024 : 0;
  } catch (e) { return 0; }
}

// rootPids + the full pid table -> the transitive descendant set (roots included).
function descendants(table, rootPids) {
  const children = new Map(); // ppid -> [pid]
  for (const [pid, st] of table) {
    if (!children.has(st.ppid)) children.set(st.ppid, []);
    children.get(st.ppid).push(pid);
  }
  const out = new Set();
  const stack = rootPids.filter((p) => table.has(p));
  while (stack.length) {
    const pid = stack.pop();
    if (out.has(pid)) continue;
    out.add(pid);
    for (const kid of children.get(pid) || []) stack.push(kid);
  }
  return out;
}

// ---------- sampler ----------
// createSampler({ workspace, targets, intervalMs?, procRoot?, execFileImpl?, statfs? })
//   targets()  -> [{ kind, id, label, session, window|null }] — the server's
//                 live worker/lieutenant registry, re-read every sample so
//                 rows track the board.
//   subscribe(fn) -> unsubscribe(). First subscriber starts the loop (and gets
//                 a sample immediately); last unsubscribe stops it and drops
//                 all delta state, so a fresh viewer always re-baselines.
//   stats()    -> { subscribers, sampling } — the refcount probe
//                 (surfaced on /api/status; tests key off it).
function createSampler(opts) {
  const o = opts || {};
  const procRoot = o.procRoot || '/proc';
  const diskPath = o.diskPath || o.workspace || '/';
  const intervalMs = o.intervalMs > 0 ? o.intervalMs : DEFAULT_INTERVAL_MS;
  const targets = typeof o.targets === 'function' ? o.targets : () => [];
  const exec = o.execFileImpl || ((cmd, args) => new Promise((resolve, reject) => {
    execFile(cmd, args, { encoding: 'utf8', timeout: EXEC_TIMEOUT_MS }, (err, stdout) => {
      if (err) reject(err); else resolve(stdout);
    });
  }));
  const statfs = o.statfs || ((p) => fs.statfsSync(p));

  const subs = new Set();
  let timer = null;
  let running = false; // one sampleOnce in flight at a time
  let last = null;     // latest sample, replayed to late joiners
  let prev = null;     // { ts, cpu: {totalTicks, idleTicks}, pidTicks: Map }

  function machineSample(cpu) {
    const mem = readMeminfo(procRoot);
    let disk = { used: 0, total: 0 };
    try {
      const st = statfs(diskPath);
      disk = { used: (st.blocks - st.bfree) * st.bsize, total: st.blocks * st.bsize };
    } catch (e) { /* graceful zeros off-Linux / odd mounts */ }
    let cpuPct = 0;
    if (prev && cpu.totalTicks > prev.cpu.totalTicks) {
      const total = cpu.totalTicks - prev.cpu.totalTicks;
      const idle = cpu.idleTicks - prev.cpu.idleTicks;
      cpuPct = Math.max(0, Math.min(100, ((total - idle) / total) * 100));
    }
    return {
      cpuPct: Math.round(cpuPct * 10) / 10, cores: cpu.cores,
      memUsedBytes: Math.max(0, mem.memTotalBytes - mem.memAvailBytes),
      memTotalBytes: mem.memTotalBytes,
      diskUsedBytes: disk.used, diskTotalBytes: disk.total,
    };
  }

  // tmux pane pids for one session: [{ window, pid }] ([] when tmux/session is gone).
  async function panePids(session) {
    let out;
    try {
      out = await exec('tmux', ['list-panes', '-s', '-t', session, '-F', '#{window_name}\t#{pane_pid}']);
    } catch (e) { return []; }
    const panes = [];
    for (const line of String(out || '').split('\n')) {
      const m = /^(.*)\t(\d+)$/.exec(line.trim());
      if (m) panes.push({ window: m[1], pid: parseInt(m[2], 10) });
    }
    return panes;
  }

  async function containerCount() {
    try {
      const out = await exec('docker', ['ps', '-q']);
      return String(out || '').split('\n').filter(Boolean).length;
    } catch (e) { return null; } // docker absent/broken -> the row hides
  }

  // Attribute each session's panes to its entities: a window-granular worker
  // claims its own window's panes; every unclaimed pane falls to the session's
  // window-less target (the lieutenant — or a legacy whole-session worker).
  async function entitySamples(table, elapsedSec) {
    const list = targets();
    const bySession = new Map();
    for (const t of list) {
      if (!t || !t.session) continue;
      if (!bySession.has(t.session)) bySession.set(t.session, []);
      bySession.get(t.session).push(t);
    }
    const rootsByTarget = new Map(); // target -> [panePid]
    for (const [session, ts] of bySession) {
      const panes = await panePids(session);
      for (const pane of panes) {
        const owner = ts.find((t) => t.window && t.window === pane.window)
          || ts.find((t) => !t.window);
        if (!owner) continue;
        if (!rootsByTarget.has(owner)) rootsByTarget.set(owner, []);
        rootsByTarget.get(owner).push(pane.pid);
      }
    }
    const pidTicks = new Map(); // pid -> ticks now (kept as the next sample's prev)
    const rows = [];
    for (const [t, roots] of rootsByTarget) {
      const pids = descendants(table, roots);
      // delta only over pids seen in BOTH samples — a pid new to this sample
      // would otherwise dump its whole-lifetime ticks into one interval
      let deltaTicks = 0;
      let rssBytes = 0;
      for (const pid of pids) {
        const st = table.get(pid);
        pidTicks.set(pid, st.ticks);
        if (prev && prev.pidTicks.has(pid)) deltaTicks += st.ticks - prev.pidTicks.get(pid);
        rssBytes += readPidRss(procRoot, pid);
      }
      let cpuPct = 0;
      if (prev && elapsedSec > 0 && deltaTicks > 0) {
        cpuPct = (deltaTicks / USER_HZ / elapsedSec) * 100;
      }
      rows.push({
        kind: t.kind, id: t.id, label: t.label,
        cpuPct: Math.round(cpuPct * 10) / 10, rssBytes, pids: pids.size,
      });
    }
    rows.sort((a, b) => (b.cpuPct - a.cpuPct) || (b.rssBytes - a.rssBytes));
    return { rows, pidTicks };
  }

  async function sampleOnce() {
    const ts = Date.now();
    const cpu = readCpuTotals(procRoot);
    const table = readProcTable(procRoot);
    const elapsedSec = prev ? (ts - prev.ts) / 1000 : 0;
    const machine = machineSample(cpu);
    const [ents, containers] = await Promise.all([
      entitySamples(table, elapsedSec),
      containerCount(),
    ]);
    prev = { ts, cpu, pidTicks: ents.pidTicks };
    return {
      ts: new Date(ts).toISOString(),
      machine, entities: ents.rows, containers,
    };
  }

  function emit(sample) {
    last = sample;
    for (const fn of subs) {
      try { fn(sample); } catch (e) { /* one bad subscriber never stalls the rest */ }
    }
  }

  function tick() {
    if (running || !subs.size) return;
    running = true;
    sampleOnce()
      .then((s) => { if (subs.size) emit(s); })
      .catch(() => { /* a torn-down /proc read mid-sample — skip this beat */ })
      .finally(() => {
        running = false;
        if (subs.size) timer = setTimeout(tick, intervalMs);
      });
  }

  function subscribe(fn) {
    subs.add(fn);
    if (subs.size === 1) tick(); // first viewer: sample NOW, then every interval
    else if (last) { try { fn(last); } catch (e) { /* subscriber's problem */ } }
    return function unsubscribe() {
      if (!subs.delete(fn) || subs.size) return;
      // last viewer gone: stop dead and forget the deltas — zero cost when closed
      if (timer) { clearTimeout(timer); timer = null; }
      prev = null;
      last = null;
    };
  }

  function stats() { return { subscribers: subs.size, sampling: !!(subs.size && (timer || running)) }; }

  return { subscribe, stats };
}

module.exports = {
  createSampler,
  // pure pieces, exported for tests
  parseCpuTotals, parseMeminfo, parsePidStat, readProcTable, readPidRss, descendants,
};
