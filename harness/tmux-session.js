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
const { validatePaneInput } = require('./port.js');

// A pane sitting back at a bare shell means the agent process exited.
const SHELLS = new Set(['bash', 'zsh', 'sh', 'fish', 'dash', 'ksh']);

// State dir resolution: opts.stateDir (the server/CLI always pass the
// workspace's .bridge-commander/harness), then BC_HARNESS_STATE, then a global
// last-resort for bare embedders only — shared across workspaces, so never
// rely on it from workspace-aware callers.
function stateDirOf(opts = {}) {
  const dir = opts.stateDir || process.env.BC_HARNESS_STATE
    || path.join(os.homedir(), '.bridge-commander', 'harness');
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

// The extra launch flags a spawn was given, kept next to the other per-agent
// state files (<key>.prompt, <key>.session-id, <key>.turnend.jsonl) so a RESUME
// can replay them.
//
// Those flags are not decoration. The server pins a worker's --model/--effort
// from its playbook at spawn, and every resume path built its own launch line
// without them — so a worker pinned to a model came back on the default one,
// silently, with nobody told. The oldest of those paths is `card start --resume`
// after a death, which is exactly the moment the pinning matters most.
//
// Recorded here rather than in each adapter because both tmux adapters take the
// same `extraArgs` and both rebuild a launch line on resume; one copy of the
// decision is one place for it to stay true.
//
// A missing, unreadable or corrupt record reads as "no extra flags" — today's
// behaviour — and never throws: a resume that cannot read a hint must still
// resume. A spawn with no extra flags REMOVES any stale record, so a card
// restarted onto a different model does not inherit the last run's.
function spawnArgsFile(stateDir, key) {
  return path.join(stateDir, `${key}.spawn-args`);
}
function recordSpawnArgs(stateDir, key, extraArgs) {
  const file = spawnArgsFile(stateDir, key);
  try {
    const args = (extraArgs || []).map(String);
    if (args.length) fs.writeFileSync(file, JSON.stringify(args) + '\n');
    else fs.rmSync(file, { force: true });
  } catch {
    // best-effort: the record is an optimisation, never a precondition
  }
}
function recordedSpawnArgs(stateDir, key) {
  try {
    const v = JSON.parse(fs.readFileSync(spawnArgsFile(stateDir, key), 'utf8'));
    return Array.isArray(v) ? v.filter((a) => typeof a === 'string') : [];
  } catch {
    return [];
  }
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

// adoptWindow(ref, window, taken?) -> ref | null — migrate a SESSION-granular
// ref to window granularity without restarting the agent it addresses. Born
// session-granular, an agent that cohabits its session (a lieutenant with its
// worker windows) is addressed as `=session:`, which resolves to whatever
// window has FOCUS: killPane takes the whole session and paneCommand reads a
// sibling's pane. Pinning the ref to the agent's own window fixes both.
//
// The agent's window is the session's FIRST (lowest-index) one — it was born
// with the session, every sibling was appended after it. `taken` names windows
// that provably belong to someone else (the caller's worker windows), so a
// session whose original window is gone is never mis-adopted.
//
// rename-window also turns tmux's automatic-rename off for that window, so the
// name sticks. Nothing live to rename (session gone) still returns the
// window-granular ref — the next spawn/resume creates the window. null means
// "cannot tell which window is the agent's": the ref is left alone.
async function adoptWindow(ref, window, taken = []) {
  if (ref.window) return ref;
  if (!(await hasSession(ref.session))) return { ...ref, window };
  if (await hasWindow(ref.session, window)) return { ...ref, window };
  const out = await t.tryTmux('list-windows', '-t', `=${ref.session}:`, '-F', '#{window_index}\t#{window_name}');
  const first = out === null ? null : out.split('\n').find((l) => l.trim());
  if (!first) return null;
  const [index, name] = first.trim().split('\t');
  if (!index || taken.includes(name)) return null;
  if (await t.tryTmux('rename-window', '-t', `=${ref.session}:${index}`, window) === null) return null;
  return { ...ref, window };
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

  // Screens that stand between the launch and the UI, each one a menu whose
  // PRESELECTED option is the one we want, so Enter answers all of them. They
  // are checked before readyRe because a dialog can carry composer-like glyphs
  // and would otherwise be mistaken for the main UI.
  const menus = [sig.trustRe, sig.resumeRe].filter(Boolean);

  const deadline = Date.now() + 45000;
  while (Date.now() < deadline) {
    await t.sleep(500);
    const cmd = await paneCommand(target);
    if (cmd === null) throw new Error(`tmux pane ${target} vanished during launch`);
    const tail = paneTail(await t.capture(target, 40));
    // sig.fatalRe — screens and exits that will NEVER become a running agent
    // (a launch line the CLI refuses outright, a first-run setup wizard, a
    // missing binary). Waiting the full 45s for one of those buys nothing and
    // hands the caller a timeout to misdiagnose; the pane tail says what
    // happened, so it is thrown immediately with the tail attached.
    //
    // Checked BEFORE the shell skip on purpose: the interesting failures print
    // their line and exit, which puts the pane back on a shell prompt.
    if (sig.fatalRe && sig.fatalRe.test(tail)) {
      throw new Error(`${sig.label} could not start at ${target}; pane tail:\n${tail}`);
    }
    if (SHELLS.has(cmd)) continue; // agent not up yet (or it already exited — captured by timeout)
    if (menus.some((re) => re.test(tail))) {
      await t.sendKey(target, 'Enter');
      await t.sleep(1000);
      continue;
    }
    if (sig.readyRe.test(tail)) return;
  }
  const tail = await t.capture(target, 20);
  throw new Error(`${sig.label} did not start at ${target} within 45s; pane tail:\n${tail}`);
}

// verifyLive — the last look before a spawn is allowed to say it worked.
//
// launchAndSettle answers "did a UI appear?", which is not the same question as
// "is there a session here now". A signature can match a screen that merely
// CONTAINS the words (the bypass-permissions consent modal literally says
// "Bypass Permissions mode", which the ready signature matched for months), and
// the brief then goes into a menu while the caller is told the session started.
//
// A caller reporting success it did not check is worse than any honest failure,
// because it is the one line nobody re-reads. So: after the brief is delivered,
// look again — a fatal screen fails immediately, and a pane that does not look
// like a running agent within `ms` fails with what it did look like.
async function verifyLive(target, sig, ms = 6000) {
  const deadline = Date.now() + ms;
  let tail = '';
  for (;;) {
    tail = paneTail(await t.capture(target, 40));
    if (sig.fatalRe && sig.fatalRe.test(tail)) {
      throw new Error(`${sig.label} is not running at ${target} — it is on a screen that needs a person; pane tail:\n${tail}`);
    }
    if (sig.readyRe.test(tail)) return;
    if (Date.now() >= deadline) break;
    await t.sleep(500);
  }
  throw new Error(`${sig.label} did not settle into a running session at ${target}; pane tail:\n${tail}`);
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
// Feeds opened by openPane, keyed by tmux target — the ONLY place a burst can
// be registered, so a burst can never outlive the feed it speeds up (see
// paneInput below). One entry per open feed; the entry is the feed's own
// object, so a close only ever removes ITS OWN entry (the server's pane hub
// refcounts N viewers onto ONE feed per target, but identity beats assuming it).
const feeds = new Map(); // tmux target -> { until: ms deadline for fast polling }
const PANE_BURST_MS = 120; // fast poll while a burst is live
const PANE_BURST_WINDOW_MS = 1500; // how long one keystroke keeps the feed fast

// openPane(ref, { onFrame, intervalMs?, lines?, burstMs?, burstWindowMs? }) -> { close() }
// Streams the pane's CURRENT RENDERED SCREEN as successive frames: every
// intervalMs the pane is captured with ANSI styling and scrollback, and
// onFrame(frame) fires only when the content changed since the last frame.
// close() stops delivery and releases the timer.
//
// Deliberately rendered frames via capture-pane, NOT a pipe-pane byte stream:
// the target is a full-screen TUI that repaints in place, so raw pty bytes
// would need a client-side terminal emulator (xterm.js — a dependency we
// will not add). capture-pane returns the already-composed screen, works for
// any TUI, and keeps the client a plain <pre>.
//
// The timer is a self-rescheduling setTimeout, not a setInterval: the next
// capture is scheduled only after the current one finished (so a slow tmux can
// never stack children — no busy flag needed) and each hop re-reads the delay,
// which is what lets paneInput burst a live feed down to burstMs for a moment
// so typing does not feel dead behind the 1s baseline.
function openPane(ref, opts = {}) {
  const onFrame = typeof opts.onFrame === 'function' ? opts.onFrame : () => {};
  const intervalMs = opts.intervalMs > 0 ? opts.intervalMs : 1000;
  const lines = opts.lines > 0 ? opts.lines : 200;
  const burstMs = opts.burstMs > 0 ? opts.burstMs : PANE_BURST_MS;
  const burstWindowMs = opts.burstWindowMs > 0 ? opts.burstWindowMs : PANE_BURST_WINDOW_MS;
  const target = paneTarget(ref.session, ref.window);
  let last = null;
  let closed = false;
  let ticking = false;
  let timer = null;
  // bump() — a keystroke just landed: go fast for burstWindowMs. Rescheduling
  // NOW matters as much as the deadline: the next hop was already pending at
  // the 1s baseline, and leaving it alone would make the FIRST key of a burst
  // (the one the typist is actually watching for) the slowest of all. Mid-tick
  // is the one case to leave alone — loop() schedules the moment it returns and
  // reads the fresh deadline then; racing it here would leave two live timers.
  const feed = {
    until: 0,
    bump() {
      feed.until = Date.now() + burstWindowMs;
      if (closed || ticking) return;
      clearTimeout(timer);
      schedule();
    },
  };
  feeds.set(target, feed); // this pane now has a feed a keystroke can burst

  async function tick() {
    if (closed) return;
    if (!(await paneExists(ref.session, ref.window))) {
      close();
      try { onFrame('\n[pane gone]'); } catch { /* subscriber's problem */ }
      return;
    }
    const frame = await t.captureStyled(target, lines);
    if (closed || frame === null || frame === last) return;
    last = frame;
    try { onFrame(frame); } catch { /* a throwing subscriber must not kill the feed */ }
  }

  // schedule(spentMs) — the next hop, measured from when the LAST one STARTED.
  // Subtracting the time the capture already burned keeps the period at
  // max(interval, capture) instead of interval + capture; without it a 60ms
  // tmux would turn the advertised 120ms burst into 180ms and the 1s baseline
  // into 1.06s. Still strictly sequential, so captures cannot overlap.
  function schedule(spentMs = 0) {
    if (closed) return;
    const base = feed.until > Date.now() ? Math.min(burstMs, intervalMs) : intervalMs;
    timer = setTimeout(loop, Math.max(0, base - spentMs));
    timer.unref?.();
  }
  async function loop() {
    const started = Date.now();
    ticking = true;
    try { await tick(); } finally { ticking = false; }
    schedule(Date.now() - started);
  }

  function close() {
    closed = true;
    clearTimeout(timer);
    if (feeds.get(target) === feed) feeds.delete(target); // burst dies with the feed
  }

  // immediate first frame — the subscriber paints without waiting a tick
  loop();
  return { close };
}

// paneSnapshot(ref, { lines? }) -> Promise<string> — one-shot styled capture
// (initial paint / non-streaming fallback). Empty string when unreadable.
async function paneSnapshot(ref, opts = {}) {
  const lines = opts.lines > 0 ? opts.lines : 200;
  const out = await t.captureStyled(paneTarget(ref.session, ref.window), lines);
  return out === null ? '' : out;
}

// ---------- pane input (OPTIONAL capability verb — see port.js) ----------
// paneInput(ref, { text? | key? }) -> Promise<void>
// Forward RAW input to the pane: `text` is typed literally (sendLiteral, which
// switches to a bracketed paste when it spans lines), `key` is one tmux key
// name ('Enter', 'BSpace', 'Up', 'BTab', 'C-c', …).
//
// Deliberately NOT the agent `send` verb: send() types, settles, presses Enter
// and retries until the composer verifies empty. That is right for delivering
// a brief and wrong for a keystroke — an arrow key has no composer state to
// verify and a retried Enter would submit twice. Raw passthrough bypasses all
// of it: one keystroke in, one keystroke out.
//
// The payload contract (key XOR text, the key grammar, the size cap) lives in
// port.js so the fake enforces the SAME rules — two copies of a validation
// regex are two regexes that drift. Text needs no pattern of its own: tmux.js's
// sendLiteral passes `--` so a flag-shaped payload can never be read as flags,
// which is the guarantee every caller of that primitive now gets.
async function paneInput(ref, input = {}) {
  const { key, text } = validatePaneInput(input);
  if (!(await paneExists(ref.session, ref.window))) {
    throw new Error(`pane ${stateKey(ref.session, ref.window)} is gone`);
  }
  const target = paneTarget(ref.session, ref.window);
  if (key) await t.sendKey(target, key);
  else await t.sendLiteral(target, text);
  // Burst the WATCHING feed so the echo lands in ~a frame instead of ~a second.
  // No feed open (nobody watching) → nothing to record, nothing to leak.
  const feed = feeds.get(target);
  if (feed) feed.bump();
}

// openFeedCount() — how many pane feeds are registered right now. A test hook,
// not a port verb: the "a burst cannot outlive its feed" claim rests on the map
// being emptied on close, and without a way to look at the map that claim is
// untestable — deleting the delete kept every other assertion green.
function openFeedCount() { return feeds.size; }

module.exports = {
  SHELLS,
  stateDirOf,
  recordSpawnArgs,
  recordedSpawnArgs,
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
  adoptWindow,
  launchAndSettle,
  verifyLive,
  onTurnEnd,
  openPane,
  paneSnapshot,
  paneInput,
  openFeedCount,
};
