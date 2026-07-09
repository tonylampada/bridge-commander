'use strict';
// claude-tmux — the claude implementation of the harness port, over tmux.
//
// HarnessRef: { harness: 'claude', session: 'bc-<id>', window?, cwd, resumeId? }
//   session  — tmux session name (predictable `bc-*`, the captain's attach escape hatch)
//   window   — when present, the agent lives in a named WINDOW of that session
//              instead of owning the whole session (papercut #8: workers as
//              windows inside their lieutenant's session). Window names must
//              start with a letter — a numeric name would be parsed by tmux as
//              a window INDEX — and every tmux call addresses the pane with the
//              exact-match `=session:=window` form. Lifecycle coupling is
//              accepted design: the session dying takes its windows with it.
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
const { execFile } = require('node:child_process');
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

// stateKey — the per-agent key for prompt/turnend/session-id state files and
// the Stop-hook `session` argument. Window-granular agents share their tmux
// session name with the lieutenant (and sibling workers), so the bare session
// would collide; the `session:window` form is unique — tmux session names can
// never contain ':'.
function stateKey(session, window) {
  return window ? `${session}:${window}` : session;
}

// paneTarget — exact-match tmux target for an agent's pane.
// Session-granular: the bare `=name` exact-match form resolves for
// session-level commands but NOT for pane-level ones (verified tmux 3.4:
// `send-keys -t =name` fails with "can't find pane"); the trailing colon
// (`=name:`) resolves for both. Window-granular: `=session:=window`, exact on
// both halves, so tmux never pattern-matches or reads the window as an index.
function paneTarget(session, window) {
  return window ? `=${session}:=${window}` : `=${session}:`;
}

async function paneCommand(target) {
  const out = await t.tryTmux('display-message', '-p', '-t', target, '#{pane_current_command}');
  return out === null ? null : out.trim();
}

async function hasSession(session) {
  return (await t.tryTmux('has-session', '-t', `=${session}:`)) !== null;
}

// hasWindow — strict window existence. `display-message -t =ses:=missing`
// does NOT error — tmux silently falls back to another pane (verified tmux
// 3.4) — so existence is checked against the session's actual window list.
async function hasWindow(session, window) {
  const out = await t.tryTmux('list-windows', '-t', `=${session}:`, '-F', '#{window_name}');
  return out !== null && out.split('\n').includes(window);
}

function paneExists(session, window) {
  return window ? hasWindow(session, window) : hasSession(session);
}

// createPane — bring the agent's pane into existence. Session-granular: a
// fresh detached session. Window-granular: a new window appended to the
// session, created with -d so a worker spawn never steals the lieutenant's
// focus; when the session is not up yet it is created with this window as its
// first (the accepted lifecycle coupling — no separate fleet session).
async function createPane(session, window, cwd) {
  if (!window) {
    await t.tmux('new-session', '-d', '-s', session, '-c', cwd);
  } else if (await hasSession(session)) {
    await t.tmux('new-window', '-d', '-t', `=${session}:`, '-n', window, '-c', cwd);
  } else {
    await t.tmux('new-session', '-d', '-s', session, '-n', window, '-c', cwd);
  }
}

// killPane — session-granular kills the session; window-granular kills ONLY
// the window (the lieutenant and sibling workers cohabit the session).
// Killing a session's last window ends the session — tmux's own semantics.
async function killPane(session, window) {
  if (window) {
    if (await hasWindow(session, window)) await t.tryTmux('kill-window', '-t', paneTarget(session, window));
  } else if (await hasSession(session)) {
    await t.tryTmux('kill-session', '-t', paneTarget(session));
  }
}

// installHooks — write/merge the Stop hook into <cwd>/.claude/settings.local.json.
// Idempotent; preserves any existing settings/hooks. Also hides the file from
// git (info/exclude) when cwd is a repo, so it never dirties a worktree.
async function installHooks(cwd, session, stateDir, callbackUrl) {
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
    const gitDir = (await new Promise((resolve, reject) => {
      execFile('git', ['-C', cwd, 'rev-parse', '--git-path', 'info/exclude'],
        { encoding: 'utf8' }, (err, stdout) => (err ? reject(err) : resolve(stdout)));
    })).trim();
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

async function launchAndSettle(target, launchCmd) {
  await t.sendLiteral(target, launchCmd);
  await t.sleep(300);
  await t.sendKey(target, 'Enter');

  const deadline = Date.now() + 45000;
  while (Date.now() < deadline) {
    await t.sleep(500);
    const cmd = await paneCommand(target);
    if (cmd === null) throw new Error(`tmux pane ${target} vanished during launch`);
    if (SHELLS.has(cmd)) continue; // claude not up yet (or it already exited — captured by timeout)
    const pane = await t.capture(target, 40);
    if (TRUST_RE.test(pane)) {
      await t.sendKey(target, 'Enter');
      await t.sleep(1000);
      continue;
    }
    if (UI_READY_RE.test(pane)) return;
  }
  const tail = await t.capture(target, 20);
  throw new Error(`claude did not start at ${target} within 45s; pane tail:\n${tail}`);
}

// spawn(cwd, prompt, opts?) -> HarnessRef
// opts: { session?, window?, stateDir?, callbackUrl?, extraArgs?: string[], installHooks?: boolean }
// window: birth the agent as a named window inside `session` (which must then
// be given too) instead of owning a whole session; the session is created on
// demand when it is not up yet.
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
  const window = opts.window === undefined || opts.window === null ? undefined : String(opts.window);
  if (window !== undefined && !/^[A-Za-z][A-Za-z0-9_-]*$/.test(window)) {
    throw new Error(`invalid window name "${window}" (must start with a letter — tmux parses numeric names as window indexes)`);
  }
  if (window) {
    if (await hasWindow(session, window)) throw new Error(`tmux window ${session}:${window} already exists`);
  } else if (await hasSession(session)) {
    throw new Error(`tmux session ${session} already exists`);
  }
  const stateDir = stateDirOf(opts);
  const resumeId = crypto.randomUUID();
  const key = stateKey(session, window);

  if (opts.installHooks !== false) {
    await installHooks(cwdAbs, key, stateDir, opts.callbackUrl || process.env.BC_TURNEND_URL || '');
  }

  const promptFile = path.join(stateDir, `${key}.prompt`);
  fs.writeFileSync(promptFile, prompt);

  await createPane(session, window, cwdAbs);
  try {
    const extra = (opts.extraArgs || []).map(shellQuote).join(' ');
    const launchCmd = 'CLAUDE_CODE_ENABLE_PROMPT_SUGGESTION=false '
      + `claude --dangerously-skip-permissions --session-id ${resumeId} `
      + (extra ? extra + ' ' : '')
      + `"$(cat ${shellQuote(promptFile)})"`;
    await launchAndSettle(paneTarget(session, window), launchCmd);
  } catch (err) {
    await killPane(session, window);
    try { fs.unlinkSync(promptFile); } catch { /* best-effort */ }
    throw err;
  }

  const ref = { harness: 'claude', session, cwd: cwdAbs, resumeId };
  if (window) ref.window = window;
  return ref;
}

// send(ref, text) — type into the session with verified submission.
// Enter is retried, never the text. Throws when the submit provably failed.
async function send(ref, text) {
  const name = stateKey(ref.session, ref.window);
  if (!(await alive(ref))) throw new Error(`session ${name} is not alive`);
  const verdict = await t.submit(paneTarget(ref.session, ref.window), text, {
    retries: Number(process.env.BC_SEND_RETRIES || 3),
    enterSleep: Number(process.env.BC_SEND_SLEEP_MS || 400),
  });
  if (verdict === 'pending') {
    throw new Error(`text not submitted to ${name} (Enter swallowed; text left in composer)`);
  }
  if (verdict === 'send-failed') {
    throw new Error(`text not sent to ${name} (tmux send failed)`);
  }
  // 'empty' = confirmed; 'unknown' = pane unreadable, assume sent (lenient —
  // an unreadable pane must not turn a normal send into a false error).
  await t.sleep(1000); // let the turn spin up so an immediate capture sees it working
}

// alive(ref) — the ref's session (and window, for window-granular refs) exists
// AND its pane is still running the agent (a pane sitting back at a bare shell
// means claude exited).
async function alive(ref) {
  if (!(await paneExists(ref.session, ref.window))) return false;
  const cmd = await paneCommand(paneTarget(ref.session, ref.window));
  return cmd !== null && !SHELLS.has(cmd);
}

// resumable(ref, opts?) -> bool — would resume(ref) restore memory? True when a
// resume id is recoverable: ref.resumeId, or the hook-recorded session-id file
// in the state dir. Introspection only, no side effects beyond ensuring the
// state dir exists — the server uses it to pick resume vs relaunch-with-charter.
async function resumable(ref, opts = {}) {
  if (ref.resumeId) return true;
  try {
    return !!fs.readFileSync(path.join(stateDirOf(opts), `${stateKey(ref.session, ref.window)}.session-id`), 'utf8').trim();
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
  const key = stateKey(ref.session, ref.window);
  let resumeId = ref.resumeId;
  try {
    const rec = fs.readFileSync(path.join(stateDir, `${key}.session-id`), 'utf8').trim();
    if (rec) resumeId = rec;
  } catch {
    // no recorded id — fall back to the ref's
  }
  await killPane(ref.session, ref.window); // clear any dead pane still holding the name

  if (opts.installHooks !== false) {
    await installHooks(ref.cwd, key, stateDir, opts.callbackUrl || process.env.BC_TURNEND_URL || '');
  }
  await createPane(ref.session, ref.window, ref.cwd);
  try {
    const launchCmd = 'CLAUDE_CODE_ENABLE_PROMPT_SUGGESTION=false '
      + 'claude --dangerously-skip-permissions '
      + (resumeId ? `--resume ${resumeId}` : '');
    await launchAndSettle(paneTarget(ref.session, ref.window), launchCmd.trim());
  } catch (err) {
    await killPane(ref.session, ref.window);
    throw err;
  }
  const out = { harness: 'claude', session: ref.session, cwd: ref.cwd, resumeId };
  if (ref.window) out.window = ref.window;
  return out;
}

// kill(ref) — end the agent's pane for good. Idempotent: killing a dead or
// missing one is a no-op. Session-granular refs take the whole session;
// window-granular refs take ONLY their window (the lieutenant and sibling
// workers cohabit the session). Harness state files are left behind on
// purpose — resumeId and the turn-end log are cheap, and a later resume(ref)
// can still reincarnate the conversation if the kill turns out premature.
async function kill(ref) {
  await killPane(ref.session, ref.window);
}

// onTurnEnd(ref, hook) -> unsubscribe()
// hook(event, ref) fires once per turn boundary; event is the JSON line the
// Stop hook appended ({ ts, session, event, session_id, cwd }). Only events
// appended AFTER registration are delivered. fs.watch push with a polling
// backstop, so no boundary is missed on filesystems with flaky watch.
function onTurnEnd(ref, hook, opts = {}) {
  const stateDir = stateDirOf(opts);
  const file = path.join(stateDir, `${stateKey(ref.session, ref.window)}.turnend.jsonl`);
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

// ---------- pane viewing (OPTIONAL capability verbs — see port.js) ----------
// openPane(ref, { onFrame, intervalMs?, lines? }) -> { close() }
// Streams the pane's CURRENT RENDERED SCREEN as successive frames: every
// intervalMs the pane is captured with ANSI styling and scrollback, and
// onFrame(frame) fires only when the content changed since the last frame.
// close() stops delivery and releases the interval.
//
// Deliberately rendered frames via capture-pane, NOT a pipe-pane byte stream:
// the target (claude) is a full-screen TUI that repaints in place, so raw pty
// bytes would need a client-side terminal emulator (xterm.js — a dependency we
// will not add). capture-pane returns the already-composed screen, works for
// any TUI, and keeps the client a plain <pre>.
function openPane(ref, opts = {}) {
  const onFrame = typeof opts.onFrame === 'function' ? opts.onFrame : () => {};
  const intervalMs = opts.intervalMs > 0 ? opts.intervalMs : 1000;
  const lines = opts.lines > 0 ? opts.lines : 200;
  const target = paneTarget(ref.session, ref.window);
  let last = null;
  let closed = false;
  let busy = false; // never overlap captures — a slow tmux must not stack children

  async function tick() {
    if (closed || busy) return;
    busy = true;
    try {
      if (!(await paneExists(ref.session, ref.window))) {
        close();
        try { onFrame('\n[pane gone]'); } catch { /* subscriber's problem */ }
        return;
      }
      const frame = await t.captureStyled(target, lines);
      if (closed || frame === null || frame === last) return;
      last = frame;
      try { onFrame(frame); } catch { /* a throwing subscriber must not kill the feed */ }
    } finally {
      busy = false;
    }
  }

  const timer = setInterval(tick, intervalMs);
  timer.unref?.();
  tick(); // immediate first frame — the subscriber paints without waiting a tick
  function close() { closed = true; clearInterval(timer); }
  return { close };
}

// paneSnapshot(ref, { lines? }) -> Promise<string> — one-shot styled capture
// (initial paint / non-streaming fallback). Empty string when unreadable.
async function paneSnapshot(ref, opts = {}) {
  const lines = opts.lines > 0 ? opts.lines : 200;
  const out = await t.captureStyled(paneTarget(ref.session, ref.window), lines);
  return out === null ? '' : out;
}

// installHooks is exported beyond the seven port verbs so `bc-axi init` can
// install the workspace-level Stop hook (session-agnostic; the server dedupes
// turn-end POSTs by session_id). openPane/paneSnapshot are OPTIONAL capability
// verbs (port.js) — pane viewing; every tmux specific of the feature lives here.
module.exports = { spawn, send, alive, resumable, resume, kill, onTurnEnd, installHooks, openPane, paneSnapshot };
