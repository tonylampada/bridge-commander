'use strict';
// hooks — deterministic per-workspace lifecycle hook scripts. Node built-ins only.
//
// The workspace owns its hooks: every EXECUTABLE file in
// <workspace>/.bridge-commander/hooks/<event>/ runs on that lifecycle event,
// alphabetical order, sequentially, cwd = the workspace root. A missing dir or
// an empty one is a no-op; a non-executable file is skipped silently. Scripts
// carry their own shebang — they are spawned directly, not through a shell.
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

const HOOKS_DIRNAME = 'hooks'; // under <workspace>/.bridge-commander/
const DEFAULT_TIMEOUT_MS = 120000;
// A teardown stops what a whole card's run started (a devcontainer, a compose
// stack): minutes, not the seconds a hook script takes.
const TEARDOWN_TIMEOUT_MS = 300000;
const OUTPUT_CAP = 4096; // combined stdout+stderr bytes kept per run

// Executable regular files in the event's hook dir, alphabetical. Anything
// else (subdirs, non-executables, unreadables) is skipped silently.
function listHooks(workspace, event) {
  const dir = path.join(workspace, '.bridge-commander', HOOKS_DIRNAME, event);
  let names;
  try { names = fs.readdirSync(dir); } catch (e) { return []; }
  const out = [];
  for (const name of names.sort()) {
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
//   { hook, ok, code, signal, timedOut, error?, output, truncated, ms }
// `hook` is the label the caller reports it by (a hook's filename, a teardown's
// command line). ok ⇔ exited 0 within the timeout. A spawn/interpreter failure
// ('error' event: broken shebang, EACCES...) is ok:false with `error` set.
// opts.tail keeps the LAST OUTPUT_CAP bytes instead of the first — what a
// caller wants when the interesting part is where the command gave up.
function runOne(hook, cmd, args, env, cwd, timeoutMs, opts) {
  const tail = !!(opts && opts.tail);
  const startedAt = Date.now();
  return new Promise((resolve) => {
    let output = '';
    let truncated = false;
    let timedOut = false;
    let settled = false;
    const done = (res) => {
      if (!settled) { settled = true; resolve(Object.assign(res, { ms: Date.now() - startedAt })); }
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
async function runHooks(event, ctx, opts) {
  const workspace = ctx && ctx.workspace;
  if (!workspace) throw new Error('runHooks: ctx.workspace required');
  const timeoutMs = (opts && opts.timeoutMs > 0) ? opts.timeoutMs : DEFAULT_TIMEOUT_MS;
  const env = bcEnv(event, ctx);
  const results = [];
  for (const file of listHooks(workspace, event)) {
    results.push(await runOne(path.basename(file), file, [], env, workspace, timeoutMs));
  }
  return results;
}

// The BC_* context every user-owned command this module runs is handed.
function bcEnv(event, ctx) {
  return Object.assign({}, process.env, {
    BC_EVENT: String(event || ''),
    BC_CARD: String((ctx && ctx.card) || ''),
    BC_REPO: String((ctx && ctx.repo) || ''),
    BC_WORKTREE: String((ctx && ctx.worktree) || ''),
    BC_BRANCH: String((ctx && ctx.branch) || ''),
  });
}

// runTeardown(command, ctx, opts?) -> Promise<result> — a playbook's `teardown`,
// run through a shell (it is a command line the user wrote, not a file we found)
// with the WORKTREE as cwd: the thing being torn down was started in there, and
// the command that stops it is a relative path in the same checkout.
//
// One result, never a rejection — the caller lands it on the timeline and
// carries on either way. Output keeps the TAIL: a teardown that failed says so
// at the end, and the head is the noise of a container coming down.
function runTeardown(command, ctx, opts) {
  const cmd = String(command || '').trim();
  if (!cmd) throw new Error('runTeardown: command required');
  const cwd = (ctx && ctx.worktree) || (ctx && ctx.workspace);
  if (!cwd) throw new Error('runTeardown: ctx.worktree or ctx.workspace required');
  const timeoutMs = (opts && opts.timeoutMs > 0) ? opts.timeoutMs : TEARDOWN_TIMEOUT_MS;
  return runOne(cmd, '/bin/sh', ['-c', cmd], bcEnv('teardown', ctx), cwd, timeoutMs, { tail: true });
}

module.exports = { runHooks, runTeardown, listHooks, DEFAULT_TIMEOUT_MS, TEARDOWN_TIMEOUT_MS };
