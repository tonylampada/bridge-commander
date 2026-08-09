'use strict';
// hooks — deterministic per-workspace hook scripts. Node built-ins only.
//
// The workspace owns its hooks, and the namespace says which kind one is:
//
//   hooks/<event>/<name>   a LIFECYCLE hook. Runs on that lifecycle event,
//                          alphabetical order, sequentially.
//   hooks/<name>           a NAMED hook — an executable file directly in
//                          hooks/. Nothing fires it; a caller does, through
//                          `bc-axi hook run <name>`.
//
// DIRECTORY MEANS EVENT, FILE MEANS NAME — that is the whole rule, and it is
// why the two can share one directory without colliding: listHooks() reads only
// hooks/<event>/, and namedHookFile() reads only files sitting directly in
// hooks/.
//
// Both kinds are the same thing to run: an executable spawned directly with
// BC_* in its env, cwd = the workspace root, a timeout that kills the whole
// process tree, output captured. A missing dir or an empty one is a no-op; a
// non-executable file is skipped silently. Scripts carry their own shebang —
// they are spawned directly, not through a shell.
//
// There is no hook API and there must not be one: a hook is bash with `bc-axi`
// on its PATH (this module puts it there), so the board's whole vocabulary —
// including `bc-axi event <card> --wake-owner`, which is how a hook wakes a
// lieutenant — is already reachable from a shell script.
//
// EVERY run, of either kind, appends one line to
// <workspace>/.bridge-commander/hookruns.jsonl — the trace. It is written by
// the runner, so a lifecycle hook that nobody asked about still leaves a
// record. Append-only, the same shape as archive.jsonl and the queues, and read
// back from the TAIL (readRuns) so a long-lived board never pays for its own
// history.
//
// Fire-and-forget semantics live at the CALL SITE (server.js fireHooks): a
// hook never blocks or fails the lifecycle outcome it observes. This module's
// only job is to run the scripts and report what happened — it never throws
// for a hook's sake (a broken interpreter, a non-zero exit, a timeout are all
// RESULTS, not errors).
//
// Context reaches the script via env (empty string when not applicable):
//   BC_EVENT     the event name (worker-done | worker-died | card-archived | teardown)
//   BC_CARD      card id
//   BC_REPO      project repo path (the registered clone)
//   BC_WORKTREE  absolute worker worktree path (empty once it was released)
//   BC_BRANCH    worker branch
//
// Per-hook timeout (default ~120s) then SIGKILL; stdout+stderr are captured
// together, capped at a few KB.
//
// A playbook's `teardown` command (runTeardown) is the same kind of thing one
// layer over: a user-owned command the board runs on a lifecycle moment, best
// effort, reported not thrown. It shares this module's runner, its env and its
// kill-the-whole-tree timeout — it differs only in being a shell command string
// declared per playbook rather than a file the workspace drops in a directory.

const fs = require('node:fs');
const path = require('node:path');
const { spawn } = require('node:child_process');

const STATE_DIRNAME = '.bridge-commander';
const HOOKS_DIRNAME = 'hooks'; // under <workspace>/.bridge-commander/
const RUNS_FILENAME = 'hookruns.jsonl'; // the trace, under <workspace>/.bridge-commander/
// Where `bc-axi` lives, prepended to every hook's PATH. A hook's whole API is
// that CLI, so "it is on your PATH" has to be true no matter what shell the
// board's server was started from.
const CLI_DIR = path.join(__dirname, '..', 'cli');
// A hook name, and an event directory name: the id shape the rest of the
// board uses (playbook ids, lieutenant ids). Keeps `../` and an empty name out
// of every path this module builds.
const NAME_RE = /^[\w][\w.-]*$/;
const DEFAULT_TIMEOUT_MS = 120000;
// A teardown stops what a whole card's run started (a devcontainer, a compose
// stack): minutes, not the seconds a hook script takes.
const TEARDOWN_TIMEOUT_MS = 300000;
const OUTPUT_CAP = 4096; // combined stdout+stderr bytes kept per run

// hooksDir(workspace) — the one directory this module builds every path from.
function hooksDir(workspace) { return path.join(workspace, STATE_DIRNAME, HOOKS_DIRNAME); }
// runsFile(workspace) — the trace.
function runsFile(workspace) { return path.join(workspace, STATE_DIRNAME, RUNS_FILENAME); }

// Executable regular files in the event's hook dir, alphabetical. Anything
// else (subdirs, non-executables, unreadables) is skipped silently.
function listHooks(workspace, event) {
  const dir = path.join(hooksDir(workspace), event);
  let names;
  try { names = fs.readdirSync(dir); } catch (e) { return []; }
  const out = [];
  for (const name of names.sort()) {
    // A dotfile is never a hook — which is also what keeps the artifact write's
    // `.<name>.bc-<pid>.tmp` from being spawned in the instant before its rename.
    if (name.startsWith('.')) continue;
    const file = path.join(dir, name);
    try {
      if (!fs.statSync(file).isFile()) continue;
      fs.accessSync(file, fs.constants.X_OK);
    } catch (e) { continue; }
    out.push(file);
  }
  return out;
}

// Run one command -> result (never rejects).
//   { hook, ok, code, signal, timedOut, error?, output, truncated, ms, startedAt }
// `hook` is the label the caller reports it by (a hook's filename, a teardown's
// command line). ok ⇔ exited 0 within the timeout. A spawn/interpreter failure
// ('error' event: broken shebang, EACCES...) is ok:false with `error` set.
// opts.tail keeps the LAST OUTPUT_CAP bytes instead of the first — what a
// caller wants when the interesting part is where the command gave up.
function runOne(hook, cmd, args, env, cwd, timeoutMs, opts) {
  const tail = !!(opts && opts.tail);
  const startedAt = Date.now();
  const startedIso = new Date(startedAt).toISOString();
  return new Promise((resolve) => {
    let output = '';
    let truncated = false;
    let timedOut = false;
    let settled = false;
    const done = (res) => {
      if (!settled) { settled = true; resolve(Object.assign(res, { ms: Date.now() - startedAt, startedAt: startedIso })); }
    };
    let child;
    try {
      // detached: the command gets its own process group, so the timeout kill
      // reaches the whole tree (a shebang shell's children inherit the stdio
      // pipes — killing only the direct child would leave them running AND
      // holding our pipes open).
      child = spawn(cmd, args, { cwd, env, stdio: ['ignore', 'pipe', 'pipe'], detached: true });
    } catch (e) {
      return done({ hook, ok: false, code: null, signal: null, timedOut: false,
        error: String((e && e.message) || e), output: '', truncated: false });
    }
    const collect = (chunk) => {
      if (!tail && output.length >= OUTPUT_CAP) { truncated = true; return; }
      output += chunk.toString('utf8');
      if (output.length > OUTPUT_CAP) {
        output = tail ? output.slice(-OUTPUT_CAP) : output.slice(0, OUTPUT_CAP);
        truncated = true;
      }
    };
    child.stdout.on('data', collect);
    child.stderr.on('data', collect);
    const killTree = () => {
      try { process.kill(-child.pid, 'SIGKILL'); } // the whole group
      catch (e) { try { child.kill('SIGKILL'); } catch (e2) {} }
    };
    const timer = setTimeout(() => { timedOut = true; killTree(); }, timeoutMs);
    let graceTimer = null;
    const finish = (code, signal) => {
      clearTimeout(timer);
      clearTimeout(graceTimer);
      done({ hook, ok: code === 0 && !timedOut, code, signal, timedOut,
        output: output.trim(), truncated });
    };
    child.on('error', (e) => {
      clearTimeout(timer);
      clearTimeout(graceTimer);
      done({ hook, ok: false, code: null, signal: null, timedOut,
        error: String((e && e.message) || e), output: output.trim(), truncated });
    });
    // 'close' (exit + stdio drained) is the normal end. But a process the hook
    // leaked can inherit our pipes and hold 'close' hostage long after the hook
    // itself exited — so 'exit' arms a short grace, after which the streams are
    // destroyed and the result reported with whatever output arrived.
    child.on('exit', (code, signal) => {
      graceTimer = setTimeout(() => {
        try { child.stdout.destroy(); child.stderr.destroy(); } catch (e) {}
        finish(code, signal);
      }, 2000);
    });
    child.on('close', finish);
  });
}

// runHooks(event, ctx, opts?) -> Promise<results[]> — run every hook for the
// event, sequentially in alphabetical order. ctx = { workspace, card, repo,
// worktree, branch } (all but workspace optional — empty string when N/A).
// opts.timeoutMs overrides the per-hook timeout (tests). Never rejects for a
// hook's outcome; only a truly broken call (no workspace) throws.
//
// Every result is traced with `trigger` = the event, which is what makes the
// hooks a workspace already had stop being invisible.
async function runHooks(event, ctx, opts) {
  const workspace = ctx && ctx.workspace;
  if (!workspace) throw new Error('runHooks: ctx.workspace required');
  const timeoutMs = (opts && opts.timeoutMs > 0) ? opts.timeoutMs : DEFAULT_TIMEOUT_MS;
  const env = bcEnv(event, ctx);
  const results = [];
  for (const file of listHooks(workspace, event)) {
    const r = await runOne(path.basename(file), file, [], env, workspace, timeoutMs);
    traceRun(workspace, event, ctx && ctx.card, r);
    results.push(r);
  }
  return results;
}

// The BC_* context every user-owned command this module runs is handed. BC_EVENT
// is the lifecycle event for a lifecycle hook and the hook's OWN NAME for a
// named one — either way, "what am I running as".
function bcEnv(event, ctx) {
  return Object.assign({}, process.env, {
    PATH: CLI_DIR + path.delimiter + (process.env.PATH || ''),
    BC_EVENT: String(event || ''),
    BC_CARD: String((ctx && ctx.card) || ''),
    BC_REPO: String((ctx && ctx.repo) || ''),
    BC_WORKTREE: String((ctx && ctx.worktree) || ''),
    BC_BRANCH: String((ctx && ctx.branch) || ''),
  });
}

// ---------- named hooks ----------
//
// namedHookFile(workspace, name) -> the executable file DIRECTLY in hooks/, or
// ''. The path is built here from the workspace and a name that has to look
// like an id, so `hook run ../../rm-rf` never becomes a path.
function namedHookFile(workspace, name) {
  const s = String(name || '');
  if (!NAME_RE.test(s)) return '';
  const file = path.join(hooksDir(workspace), s);
  try {
    if (!fs.statSync(file).isFile()) return '';
    fs.accessSync(file, fs.constants.X_OK);
  } catch (e) { return ''; }
  return file;
}

// listAllHooks(workspace) -> [{name, event, file}] for every hook the workspace
// has, named ones (event '') and lifecycle ones (event = the directory), sorted
// the way readdir sorts. What `hook list` and the board's hooks tab both read.
function listAllHooks(workspace) {
  let names;
  try { names = fs.readdirSync(hooksDir(workspace)); } catch (e) { return []; }
  const out = [];
  for (const name of names.sort()) {
    if (!NAME_RE.test(name)) continue;
    const p = path.join(hooksDir(workspace), name);
    let st;
    try { st = fs.statSync(p); } catch (e) { continue; }
    if (st.isFile()) {
      const file = namedHookFile(workspace, name);
      if (file) out.push({ name, event: '', file });
    } else if (st.isDirectory()) {
      for (const f of listHooks(workspace, name)) {
        // The listing is what offers a hook a ✎, and the artifact gate behind
        // that pencil matches the same id shape — so a name the gate would
        // refuse is not offered here rather than offered broken. listHooks()
        // stays as it is: it is the RUNNER, and it keeps running whatever the
        // workspace already installed.
        const base = path.basename(f);
        if (!NAME_RE.test(base)) continue;
        out.push({ name: base, event: name, file: f });
      }
    }
  }
  return out;
}

// eventDirs(workspace, hooks?) -> the set of names that are event DIRECTORIES.
// The one thing that tells a lifecycle trace line from a named one when a
// workspace happens to hold both under the same name: a lifecycle hook's
// trigger IS its event directory.
//
// A caller holding a listing reads the answer straight off it — the hooks tab
// asks once per paint, and scanning every hook and every event dir a second
// time to learn what the first scan already said is a readdir + stat per hook
// for nothing.
function eventDirs(workspace, hooks) {
  const out = new Set();
  for (const h of (hooks || listAllHooks(workspace))) if (h.event) out.add(h.event);
  return out;
}

// One run per hook NAME at a time, board-wide. A five-minute poll and an
// impatient ▶ must not overlap, so the second caller is REFUSED (with what is
// already running) rather than queued behind a run it cannot see.
const inFlight = new Map(); // workspace \0 name -> the run record

function runningHook(workspace, name) { return inFlight.get(workspace + '\0' + name) || null; }

// runNamedHook(workspace, name, ctx, opts) -> Promise<trace record>.
// Throws — and only ever throws — for the two things that are the CALLER's
// mistake: a name that is not an executable file in hooks/ (err.code ENOHOOK,
// message naming the directory) and a run already in flight (err.code EBUSY,
// err.running = what is running). The hook's own outcome is a result, never an
// error: a non-zero exit and a timeout are trace lines, and the caller lives.
async function runNamedHook(workspace, name, ctx, opts) {
  if (!workspace) throw new Error('runNamedHook: workspace required');
  const file = namedHookFile(workspace, name);
  if (!file) {
    const e = new Error('no hook "' + name + '" — a named hook is an executable file in '
      + hooksDir(workspace) + ' (a directory there is a lifecycle event, not a name)');
    e.code = 'ENOHOOK';
    throw e;
  }
  const key = workspace + '\0' + name;
  const running = inFlight.get(key);
  if (running) {
    const e = new Error('hook ' + name + ' is already running (started ' + running.started
      + ', trigger ' + running.trigger + (running.card ? ', card ' + running.card : '') + ')');
    e.code = 'EBUSY';
    e.running = running;
    throw e;
  }
  const trigger = String((opts && opts.trigger) || 'cli');
  const card = String((ctx && ctx.card) || '');
  const timeoutMs = (opts && opts.timeoutMs > 0) ? opts.timeoutMs : DEFAULT_TIMEOUT_MS;
  inFlight.set(key, { hook: name, trigger, card, started: new Date().toISOString() });
  try {
    // BC_EVENT carries the hook's own name; the card fields stay empty unless a
    // caller supplied a card. Output keeps the TAIL — a hook that gave up says
    // so at the end.
    const env = bcEnv(name, ctx);
    const r = await runOne(name, file, [], env, workspace, timeoutMs, { tail: true });
    return traceRun(workspace, trigger, card, r);
  } finally { inFlight.delete(key); }
}

// ---------- the trace ----------
//
// traceRun -> the record it appended (which is also what a caller reports).
// Never throws: an unwritable state dir must not turn a hook that ran fine into
// a failure.
function traceRun(workspace, trigger, card, r) {
  const rec = {
    hook: r.hook,
    trigger: String(trigger || ''),
    card: String(card || ''),
    started: r.startedAt,
    ms: r.ms,
    code: r.code === undefined ? null : r.code,
    ok: !!r.ok,
    timedOut: !!r.timedOut,
    output: r.output || '',
  };
  if (r.error) rec.error = String(r.error).slice(0, 500);
  try { fs.appendFileSync(runsFile(workspace), JSON.stringify(rec) + '\n'); } catch (e) {}
  return rec;
}

// scanBack(file, visit, maxBytes) — walk the jsonl BACKWARDS, newest line
// first, calling visit(rec) until it returns true or the budget runs out. The
// whole point of the trace being append-only is that answering "what happened
// lately" costs the tail, not the file: `hook runs` on a board with a year of
// history reads 64KB.
//
// A torn line (a crash mid-append) is skipped, the way readChatLog skips one —
// append-only means the file is never rewritten to repair itself.
const SCAN_CHUNK = 65536;
const SCAN_BUDGET = 4 * 1024 * 1024;

function scanBack(file, visit, maxBytes) {
  let fd;
  try { fd = fs.openSync(file, 'r'); } catch (e) { return; }
  try {
    let pos = fs.fstatSync(fd).size;
    const floor = Math.max(0, pos - (maxBytes > 0 ? maxBytes : SCAN_BUDGET));
    let tail = Buffer.alloc(0); // bytes before the first newline of what we read
    const take = (line) => {
      const s = line.trim();
      if (!s) return false;
      let rec;
      try { rec = JSON.parse(s); } catch (e) { return false; }
      return rec && typeof rec === 'object' ? !!visit(rec) : false;
    };
    while (pos > floor) {
      const len = Math.min(SCAN_CHUNK, pos - floor);
      pos -= len;
      const buf = Buffer.alloc(len);
      fs.readSync(fd, buf, 0, len, pos);
      const all = Buffer.concat([buf, tail]);
      const nl = all.indexOf(0x0a);
      if (nl === -1) { tail = all; continue; } // no complete line in hand yet
      tail = all.subarray(0, nl);
      const lines = all.subarray(nl + 1).toString('utf8').split('\n');
      for (let i = lines.length - 1; i >= 0; i--) if (take(lines[i])) return;
    }
    // pos === floor: `tail` is the first line of the window. Only a real line
    // when the window reached the start of the file — otherwise it is a
    // fragment the budget cut in half.
    if (pos === 0) take(tail.toString('utf8'));
  } finally { fs.closeSync(fd); }
}

// readRuns(workspace, opts?) -> the newest runs first.
//   opts.hook   only this hook's runs
//   opts.limit  how many (default 20)
function readRuns(workspace, opts) {
  const limit = (opts && opts.limit > 0) ? Math.floor(opts.limit) : 20;
  const hook = (opts && opts.hook) || '';
  const out = [];
  scanBack(runsFile(workspace), (rec) => {
    if (hook && rec.hook !== hook) return false;
    out.push(rec);
    return out.length >= limit;
  }, opts && opts.maxBytes);
  return out;
}

// lastRuns(workspace, hooks) -> Map keyed the way listAllHooks names a hook
// (`<event>/<name>` or bare `<name>`), holding its most recent trace record.
// ONE backward walk for the whole list — the hooks tab asks this once per
// paint, so it must not be one scan per row.
function hookKey(h) { return (h.event ? h.event + '/' : '') + h.name; }

function lastRuns(workspace, hooks) {
  const want = hooks || listAllHooks(workspace);
  const events = eventDirs(workspace, hooks && want);
  const out = new Map();
  if (!want.length) return out;
  scanBack(runsFile(workspace), (rec) => {
    for (const h of want) {
      const k = hookKey(h);
      if (out.has(k) || rec.hook !== h.name) continue;
      // A lifecycle hook's trigger IS its event; a named hook's never is.
      if (h.event ? rec.trigger === h.event : !events.has(rec.trigger)) out.set(k, rec);
    }
    return out.size >= want.length;
  }, (want.length ? SCAN_BUDGET : 0));
  return out;
}

// runTeardown(command, ctx, opts?) -> Promise<result> — a playbook's `teardown`,
// run through a shell (it is a command line the user wrote, not a file we found)
// with the WORKTREE as cwd: the thing being torn down was started in there, and
// the command that stops it is a relative path in the same checkout.
//
// One result, never a rejection — the caller lands it on the timeline and
// carries on either way. Output keeps the TAIL: a teardown that failed says so
// at the end, and the head is the noise of a container coming down.
//
// KNOWN AND ACCEPTED: `command` reaches here from a playbook file, and a
// WORKSPACE playbook is writable over the unauthenticated artifact API
// (PUT /api/artifact) — so anything that can reach the board's port can put a
// shell command in this spawn. That is not a new capability the teardown opens:
// the same write puts arbitrary text in the BRIEF, and the next card start
// hands that to an agent running with bypass permissions on a real checkout.
// The board binds to loopback and its threat model is already "reaching this
// port means starting workers". Anyone WIDENING that gate — binding to a
// non-loopback address, proxying the API, accepting playbooks from elsewhere —
// is widening this too, and owes it an auth boundary.
function runTeardown(command, ctx, opts) {
  const cmd = String(command || '').trim();
  if (!cmd) throw new Error('runTeardown: command required');
  const cwd = (ctx && ctx.worktree) || (ctx && ctx.workspace);
  if (!cwd) throw new Error('runTeardown: ctx.worktree or ctx.workspace required');
  const timeoutMs = (opts && opts.timeoutMs > 0) ? opts.timeoutMs : TEARDOWN_TIMEOUT_MS;
  return runOne(cmd, '/bin/sh', ['-c', cmd], bcEnv('teardown', ctx), cwd, timeoutMs, { tail: true });
}

module.exports = {
  runHooks, runTeardown, listHooks, listAllHooks, namedHookFile, runNamedHook, runningHook,
  readRuns, lastRuns, hookKey, hooksDir, runsFile, HOOK_NAME_RE: NAME_RE,
  DEFAULT_TIMEOUT_MS, TEARDOWN_TIMEOUT_MS,
};
