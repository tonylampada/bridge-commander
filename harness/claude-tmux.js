'use strict';
// claude-tmux — the claude implementation of the harness port, over tmux.
//
// HarnessRef: { harness: 'claude', session: 'bc-<id>', cwd, resumeId? }
//   session  — tmux session name (predictable `bc-*`, the captain's attach escape hatch)
//   resumeId — the claude session uuid. Set deterministically at spawn via
//              `--session-id <uuid>` (verified claude 2.1.202), refreshed from
//              Stop-hook payloads. `claude --resume <resumeId>` keeps the SAME
//              id (no fork by default), so the ref survives any number of
//              death/resume cycles.
//
// Verified launch template (mined from firstmate's fm-spawn.sh):
//   CLAUDE_CODE_ENABLE_PROMPT_SUGGESTION=false claude --dangerously-skip-permissions \
//     --session-id <uuid> "$(cat <promptfile>)"
//   - CLAUDE_CODE_ENABLE_PROMPT_SUGGESTION=false kills the dim "ghost text"
//     prompt suggestion that otherwise reads as pending composer input.
//   - the prompt rides in a file, expanded by the pane's shell — no quoting
//     hazards, no tmux argv length limits.
//   - a fresh cwd triggers claude's folder-trust dialog even with
//     --dangerously-skip-permissions (verified); spawn auto-accepts it.
//
// Turn boundaries: spawn installs a Stop hook in <cwd>/.claude/settings.local.json
// running harness/turnend-hook.js, which appends to <stateDir>/<session>.turnend.jsonl
// (and optionally POSTs to a callback URL). onTurnEnd() tails that file.

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const { execFileSync } = require('node:child_process');
const t = require('./tmux.js');

const HOOK_SCRIPT = path.join(__dirname, 'turnend-hook.js');
const SHELLS = new Set(['bash', 'zsh', 'sh', 'fish', 'dash', 'ksh']);
const TRUST_RE = /Yes, I trust this folder|Quick safety check/;

// State dir resolution: opts.stateDir (the server/CLI always pass the
// workspace's .bridge-command/harness), then BC_HARNESS_STATE, then a global
// last-resort for bare embedders only — shared across workspaces, so never
// rely on it from workspace-aware callers.
function stateDirOf(opts = {}) {
  const dir = opts.stateDir || process.env.BC_HARNESS_STATE
    || path.join(os.homedir(), '.bridge-command', 'harness');
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

function shellQuote(s) {
  return `'` + String(s).replace(/'/g, `'\\''`) + `'`;
}

function newSessionName() {
  return 'bc-' + crypto.randomBytes(3).toString('hex');
}

// paneTarget — exact-match tmux target for a session's active pane.
// The bare `=name` exact-match form resolves for session-level commands but
// NOT for pane-level ones (verified tmux 3.4: `send-keys -t =name` fails with
// "can't find pane"); the trailing colon (`=name:`) resolves for both.
function paneTarget(session) {
  return `=${session}:`;
}

function paneCommand(session) {
  const out = t.tryTmux('display-message', '-p', '-t', paneTarget(session), '#{pane_current_command}');
  return out === null ? null : out.trim();
}

function hasSession(session) {
  return t.tryTmux('has-session', '-t', paneTarget(session)) !== null;
}

// installHooks — write/merge the Stop hook into <cwd>/.claude/settings.local.json.
// Idempotent; preserves any existing settings/hooks. Also hides the file from
// git (info/exclude) when cwd is a repo, so it never dirties a worktree.
function installHooks(cwd, session, stateDir, callbackUrl) {
  const dir = path.join(cwd, '.claude');
  const file = path.join(dir, 'settings.local.json');
  fs.mkdirSync(dir, { recursive: true });
  let settings = {};
  try {
    settings = JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    settings = {};
  }
  const command = ['node', shellQuote(HOOK_SCRIPT), shellQuote(stateDir), shellQuote(session)]
    .concat(callbackUrl ? [shellQuote(callbackUrl)] : [])
    .join(' ');
  if (!settings.hooks || typeof settings.hooks !== 'object') settings.hooks = {};
  if (!Array.isArray(settings.hooks.Stop)) settings.hooks.Stop = [];
  const ours = settings.hooks.Stop.some((m) =>
    Array.isArray(m.hooks) && m.hooks.some((h) => h.command === command));
  if (!ours) {
    // Drop stale bc hook entries (e.g. a previous session in this cwd) first.
    settings.hooks.Stop = settings.hooks.Stop.filter((m) =>
      !(Array.isArray(m.hooks) && m.hooks.some((h) =>
        typeof h.command === 'string' && h.command.includes(HOOK_SCRIPT))));
    settings.hooks.Stop.push({ hooks: [{ type: 'command', command }] });
  }
  fs.writeFileSync(file, JSON.stringify(settings, null, 2) + '\n');
  try {
    const gitDir = execFileSync('git', ['-C', cwd, 'rev-parse', '--git-path', 'info/exclude'],
      { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();
    const excl = path.isAbsolute(gitDir) ? gitDir : path.join(cwd, gitDir);
    fs.mkdirSync(path.dirname(excl), { recursive: true });
    const cur = fs.existsSync(excl) ? fs.readFileSync(excl, 'utf8') : '';
    if (!cur.split('\n').includes('.claude/settings.local.json')) {
      fs.appendFileSync(excl, '.claude/settings.local.json\n');
    }
  } catch {
    // not a git repo — nothing to exclude
  }
}

// launchAndSettle — send the launch command into the pane, wait for the claude
// process and its main UI, auto-accepting the folder-trust dialog if it appears
// (a fresh cwd shows it even with --dangerously-skip-permissions; option
// "1. Yes, I trust this folder" is preselected, so Enter accepts).
// UI_READY_RE matches signatures only the main UI renders (composer prompt,
// busy footer, permission-mode footer) and the trust screen does not.
const UI_READY_RE = /bypass permissions|esc (to )?interrupt|\n❯/i;

async function launchAndSettle(session, launchCmd) {
  t.sendLiteral(paneTarget(session), launchCmd);
  await t.sleep(300);
  t.sendKey(paneTarget(session), 'Enter');

  const deadline = Date.now() + 45000;
  while (Date.now() < deadline) {
    await t.sleep(500);
    const cmd = paneCommand(session);
    if (cmd === null) throw new Error(`tmux session ${session} vanished during launch`);
    if (SHELLS.has(cmd)) continue; // claude not up yet (or it already exited — captured by timeout)
    const pane = t.capture(paneTarget(session), 40);
    if (TRUST_RE.test(pane)) {
      t.sendKey(paneTarget(session), 'Enter');
      await t.sleep(1000);
      continue;
    }
    if (UI_READY_RE.test(pane)) return;
  }
  const tail = t.capture(paneTarget(session), 20);
  throw new Error(`claude did not start in session ${session} within 45s; pane tail:\n${tail}`);
}

// spawn(cwd, prompt, opts?) -> HarnessRef
// opts: { session?, stateDir?, callbackUrl?, extraArgs?: string[], installHooks?: boolean }
// installHooks: false skips the per-spawn Stop-hook install — for sessions born
// into a cwd that already carries a workspace-level hook (installing another
// would clobber it: installHooks keeps ONE bc entry per settings file).
async function spawn(cwd, prompt, opts = {}) {
  const cwdAbs = path.resolve(cwd);
  if (!fs.existsSync(cwdAbs)) throw new Error(`spawn cwd does not exist: ${cwdAbs}`);
  const session = opts.session || newSessionName();
  if (!/^bc-[A-Za-z0-9_-]+$/.test(session)) {
    throw new Error(`invalid session name "${session}" (must match bc-<id>)`);
  }
  if (hasSession(session)) throw new Error(`tmux session ${session} already exists`);
  const stateDir = stateDirOf(opts);
  const resumeId = crypto.randomUUID();

  if (opts.installHooks !== false) {
    installHooks(cwdAbs, session, stateDir, opts.callbackUrl || process.env.BC_TURNEND_URL || '');
  }

  const promptFile = path.join(stateDir, `${session}.prompt`);
  fs.writeFileSync(promptFile, prompt);

  t.tmux('new-session', '-d', '-s', session, '-c', cwdAbs);
  try {
    const extra = (opts.extraArgs || []).map(shellQuote).join(' ');
    const launchCmd = 'CLAUDE_CODE_ENABLE_PROMPT_SUGGESTION=false '
      + `claude --dangerously-skip-permissions --session-id ${resumeId} `
      + (extra ? extra + ' ' : '')
      + `"$(cat ${shellQuote(promptFile)})"`;
    await launchAndSettle(session, launchCmd);
  } catch (err) {
    t.tryTmux('kill-session', '-t', paneTarget(session));
    try { fs.unlinkSync(promptFile); } catch { /* best-effort */ }
    throw err;
  }

  return { harness: 'claude', session, cwd: cwdAbs, resumeId };
}

// send(ref, text) — type into the session with verified submission.
// Enter is retried, never the text. Throws when the submit provably failed.
async function send(ref, text) {
  if (!(await alive(ref))) throw new Error(`session ${ref.session} is not alive`);
  const verdict = await t.submit(paneTarget(ref.session), text, {
    retries: Number(process.env.BC_SEND_RETRIES || 3),
    enterSleep: Number(process.env.BC_SEND_SLEEP_MS || 400),
  });
  if (verdict === 'pending') {
    throw new Error(`text not submitted to ${ref.session} (Enter swallowed; text left in composer)`);
  }
  if (verdict === 'send-failed') {
    throw new Error(`text not sent to ${ref.session} (tmux send failed)`);
  }
  // 'empty' = confirmed; 'unknown' = pane unreadable, assume sent (lenient —
  // an unreadable pane must not turn a normal send into a false error).
  await t.sleep(1000); // let the turn spin up so an immediate capture sees it working
}

// alive(ref) — tmux session exists AND its pane is still running the agent
// (a pane sitting back at a bare shell means claude exited).
async function alive(ref) {
  if (!hasSession(ref.session)) return false;
  const cmd = paneCommand(ref.session);
  return cmd !== null && !SHELLS.has(cmd);
}

// resumable(ref, opts?) -> bool — would resume(ref) restore memory? True when a
// resume id is recoverable: ref.resumeId, or the hook-recorded session-id file
// in the state dir. Introspection only, no side effects beyond ensuring the
// state dir exists — the server uses it to pick resume vs relaunch-with-charter.
async function resumable(ref, opts = {}) {
  if (ref.resumeId) return true;
  try {
    return !!fs.readFileSync(path.join(stateDirOf(opts), `${ref.session}.session-id`), 'utf8').trim();
  } catch {
    return false;
  }
}

// resume(ref) -> HarnessRef — reincarnate a dead session with memory when possible.
// Prefers the hook-recorded session id (ground truth) over ref.resumeId, kills
// any leftover dead tmux session, relaunches `claude --resume <id>` in a fresh
// session under the same name. Without any resume id, launches fresh (memory lost).
async function resume(ref, opts = {}) {
  if (await alive(ref)) return { ...ref };
  const stateDir = stateDirOf(opts);
  let resumeId = ref.resumeId;
  try {
    const rec = fs.readFileSync(path.join(stateDir, `${ref.session}.session-id`), 'utf8').trim();
    if (rec) resumeId = rec;
  } catch {
    // no recorded id — fall back to the ref's
  }
  if (hasSession(ref.session)) t.tryTmux('kill-session', '-t', paneTarget(ref.session));

  if (opts.installHooks !== false) {
    installHooks(ref.cwd, ref.session, stateDir, opts.callbackUrl || process.env.BC_TURNEND_URL || '');
  }
  t.tmux('new-session', '-d', '-s', ref.session, '-c', ref.cwd);
  try {
    const launchCmd = 'CLAUDE_CODE_ENABLE_PROMPT_SUGGESTION=false '
      + 'claude --dangerously-skip-permissions '
      + (resumeId ? `--resume ${resumeId}` : '');
    await launchAndSettle(ref.session, launchCmd.trim());
  } catch (err) {
    t.tryTmux('kill-session', '-t', paneTarget(ref.session));
    throw err;
  }
  return { harness: 'claude', session: ref.session, cwd: ref.cwd, resumeId };
}

// kill(ref) — end the session for good. Idempotent: killing a dead or missing
// session is a no-op. The tmux session goes away (claude inside dies with its
// pane); harness state files are left behind on purpose — resumeId and the
// turn-end log are cheap, and a later resume(ref) can still reincarnate the
// conversation if the kill turns out to have been premature.
async function kill(ref) {
  if (hasSession(ref.session)) t.tryTmux('kill-session', '-t', paneTarget(ref.session));
}

// onTurnEnd(ref, hook) -> unsubscribe()
// hook(event, ref) fires once per turn boundary; event is the JSON line the
// Stop hook appended ({ ts, session, event, session_id, cwd }). Only events
// appended AFTER registration are delivered. fs.watch push with a polling
// backstop, so no boundary is missed on filesystems with flaky watch.
function onTurnEnd(ref, hook, opts = {}) {
  const stateDir = stateDirOf(opts);
  const file = path.join(stateDir, `${ref.session}.turnend.jsonl`);
  let offset = 0;
  try {
    offset = fs.statSync(file).size;
  } catch {
    offset = 0;
  }
  let closed = false;

  function drain() {
    if (closed) return;
    let size;
    try {
      size = fs.statSync(file).size;
    } catch {
      return;
    }
    if (size < offset) offset = 0; // truncated/rotated
    if (size === offset) return;
    const fd = fs.openSync(file, 'r');
    try {
      const buf = Buffer.alloc(size - offset);
      fs.readSync(fd, buf, 0, buf.length, offset);
      offset = size;
      for (const line of buf.toString('utf8').split('\n')) {
        if (!line.trim()) continue;
        let event;
        try {
          event = JSON.parse(line);
        } catch {
          continue;
        }
        try {
          hook(event, ref);
        } catch {
          // a throwing hook must not kill the watcher
        }
      }
    } finally {
      fs.closeSync(fd);
    }
  }

  let watcher = null;
  try {
    watcher = fs.watch(stateDir, (_type, name) => {
      if (name === path.basename(file)) drain();
    });
  } catch {
    watcher = null;
  }
  const poll = setInterval(drain, 1000);
  poll.unref?.();

  return function unsubscribe() {
    closed = true;
    clearInterval(poll);
    watcher?.close();
  };
}

// installHooks is exported beyond the seven port verbs so `bc-axi init` can
// install the workspace-level Stop hook (session-agnostic; the server dedupes
// turn-end POSTs by session_id).
module.exports = { spawn, send, alive, resumable, resume, kill, onTurnEnd, installHooks };
