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
//   BC_EVENT     the event name (worker-done | worker-died | card-archived)
//   BC_CARD      card id
//   BC_REPO      project repo path (the registered clone)
//   BC_WORKTREE  absolute worker worktree path
//   BC_BRANCH    worker branch
//
// Per-hook timeout (default ~120s) then SIGKILL; stdout+stderr are captured
// together, capped at a few KB.

const fs = require('node:fs');
const path = require('node:path');
const { spawn } = require('node:child_process');

const HOOKS_DIRNAME = 'hooks'; // under <workspace>/.bridge-commander/
const DEFAULT_TIMEOUT_MS = 120000;
const OUTPUT_CAP = 4096; // combined stdout+stderr bytes kept per hook

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

// Run one hook script -> result (never rejects).
//   { hook, ok, code, signal, timedOut, error?, output, truncated }
// ok ⇔ exited 0 within the timeout. A spawn/interpreter failure ('error'
// event: broken shebang, EACCES...) is ok:false with `error` set.
function runOne(file, env, cwd, timeoutMs) {
  return new Promise((resolve) => {
    const hook = path.basename(file);
    let output = '';
    let truncated = false;
    let timedOut = false;
    let settled = false;
    const done = (res) => { if (!settled) { settled = true; resolve(res); } };
    let child;
    try {
      // detached: the hook gets its own process group, so the timeout kill
      // reaches the whole tree (a shebang shell's children inherit the stdio
      // pipes — killing only the direct child would leave them running AND
      // holding our pipes open).
      child = spawn(file, [], { cwd, env, stdio: ['ignore', 'pipe', 'pipe'], detached: true });
    } catch (e) {
      return done({ hook, ok: false, code: null, signal: null, timedOut: false,
        error: String((e && e.message) || e), output: '', truncated: false });
    }
    const collect = (chunk) => {
      if (output.length >= OUTPUT_CAP) { truncated = true; return; }
      output += chunk.toString('utf8');
      if (output.length > OUTPUT_CAP) { output = output.slice(0, OUTPUT_CAP); truncated = true; }
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
  const env = Object.assign({}, process.env, {
    BC_EVENT: String(event || ''),
    BC_CARD: String((ctx && ctx.card) || ''),
    BC_REPO: String((ctx && ctx.repo) || ''),
    BC_WORKTREE: String((ctx && ctx.worktree) || ''),
    BC_BRANCH: String((ctx && ctx.branch) || ''),
  });
  const results = [];
  for (const file of listHooks(workspace, event)) {
    results.push(await runOne(file, env, workspace, timeoutMs));
  }
  return results;
}

module.exports = { runHooks, listHooks, DEFAULT_TIMEOUT_MS };
