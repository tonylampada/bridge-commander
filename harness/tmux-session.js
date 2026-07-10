'use strict';
// tmux-session — session/window/pane plumbing SHARED by the tmux-TUI harness
// adapters (claude-tmux.js, codex-tmux.js). Everything here is harness-agnostic:
// pane lifecycle, naming/validation, state-dir resolution, the launch-and-settle
// skeleton (the adapter supplies its trust-prompt and UI-ready signatures), the
// turn-end file tail, and the optional pane-viewing verbs. An adapter differs
// only in its launch line, screen signatures, resume semantics, and turn-end
// relay wiring.
//
// Extracted verbatim from claude-tmux.js (the reference implementation) — the
// comments below carry that provenance where behavior was learned the hard way.

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const t = require('./tmux.js');

// A pane sitting back at a bare shell means the agent process exited.
const SHELLS = new Set(['bash', 'zsh', 'sh', 'fish', 'dash', 'ksh']);

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
// the turn-end relay's `session` argument. Window-granular agents share their
// tmux session name with the lieutenant (and sibling workers), so the bare
// session would collide; the `session:window` form is unique — tmux session
// names can never contain ':'.
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

// claimPaneNames — resolve + validate the session/window names for a spawn and
// refuse names already in use. Window names must start with a letter — a
// numeric name would be parsed by tmux as a window INDEX (papercut #8).
async function claimPaneNames(opts = {}) {
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
  return { session, window };
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

// launchAndSettle — send the launch command into the pane, wait for the agent
// process and its main UI, auto-accepting the harness's trust dialog if it
// appears (a fresh cwd shows one even in bypass mode; the accept option is
// preselected, so Enter accepts). The adapter supplies:
//   sig.trustRe — matches the trust screen (checked FIRST: a trust screen may
//                 contain composer-like glyphs, so it must win over readyRe)
//   sig.readyRe — matches signatures only the main UI renders
//   sig.label   — the agent name for error messages ('claude', 'codex')
//
// Both signatures are tested against the TAIL of the pane — the current
// interaction always sits at the bottom. Matching the whole capture broke on
// inline-scrolling TUIs (codex renders in the primary screen, not the
// alternate one): the ACCEPTED trust prompt lingers in scrollback, so a
// full-capture trustRe kept re-matching forever and starved readyRe. claude's
// alternate-screen dialogs keep their signatures bottom-anchored anyway
// (composer + footer are the screen's last rows), so the tail is behavior-
// preserving there.
const SETTLE_TAIL_LINES = 15;

function paneTail(pane) {
  return pane.replace(/\s+$/, '').split('\n').slice(-SETTLE_TAIL_LINES).join('\n');
}

async function launchAndSettle(target, launchCmd, sig) {
  await t.sendLiteral(target, launchCmd);
  await t.sleep(300);
  await t.sendKey(target, 'Enter');

  const deadline = Date.now() + 45000;
  while (Date.now() < deadline) {
    await t.sleep(500);
    const cmd = await paneCommand(target);
    if (cmd === null) throw new Error(`tmux pane ${target} vanished during launch`);
    if (SHELLS.has(cmd)) continue; // agent not up yet (or it already exited — captured by timeout)
    const tail = paneTail(await t.capture(target, 40));
    if (sig.trustRe.test(tail)) {
      await t.sendKey(target, 'Enter');
      await t.sleep(1000);
      continue;
    }
    if (sig.readyRe.test(tail)) return;
  }
  const tail = await t.capture(target, 20);
  throw new Error(`${sig.label} did not start at ${target} within 45s; pane tail:\n${tail}`);
}

// onTurnEnd(ref, hook) -> unsubscribe()
// hook(event, ref) fires once per turn boundary; event is the JSON line the
// harness's relay appended ({ ts, session, event, session_id, cwd }). Only
// events appended AFTER registration are delivered. fs.watch push with a
// polling backstop, so no boundary is missed on filesystems with flaky watch.
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
// the target is a full-screen TUI that repaints in place, so raw pty bytes
// would need a client-side terminal emulator (xterm.js — a dependency we
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

module.exports = {
  SHELLS,
  stateDirOf,
  shellQuote,
  newSessionName,
  stateKey,
  paneTarget,
  paneCommand,
  hasSession,
  hasWindow,
  paneExists,
  claimPaneNames,
  createPane,
  killPane,
  launchAndSettle,
  onTurnEnd,
  openPane,
  paneSnapshot,
};
