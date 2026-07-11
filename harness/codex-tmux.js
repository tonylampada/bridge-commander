'use strict';
// codex-tmux — the OpenAI Codex CLI implementation of the harness port, over tmux.
//
// HarnessRef: { harness: 'codex', session: 'bc-<id>', window?, cwd, resumeId? }
//   session/window — same tmux addressing as every tmux adapter (tmux-session.js):
//              session-granular refs own a whole `bc-*` session, window-granular
//              refs live as a named window inside a shared one (workers inside
//              their lieutenant's session).
//   resumeId — the codex THREAD-ID (a uuid). Unlike claude there is no
//              --session-id flag: codex assigns the id itself, so the ref is
//              born WITHOUT resumeId and adopts it from the first turn-end
//              (the notify relay records it to <stateDir>/<key>.session-id and
//              POSTs it to the server, which writes it back into the ref).
//              `codex resume <thread-id>` continues the SAME thread (verified
//              0.144.1 — see smoke-codex.js), so refs survive death/resume.
//
// Session/window/pane plumbing is shared with the other tmux adapters — see
// tmux-session.js. This module owns only what is codex-specific: launch line,
// screen signatures, the notify relay wiring, and resume.
//
// Verified launch template (codex 0.144.1):
//   codex --dangerously-bypass-approvals-and-sandbox --dangerously-bypass-hook-trust \
//     -c notify='["node","<relay>","<stateDir>","<key>","<url>"]' "$(cat <promptfile>)"
//   - --dangerously-bypass-approvals-and-sandbox is codex's analog of claude's
//     --dangerously-skip-permissions (YOLO mode: no sandbox, no approval
//     prompts — port rule #4, full autonomy at launch).
//   - --dangerously-bypass-hook-trust suppresses the "Hooks need review"
//     picker that a global ~/.codex/hooks.json otherwise raises at launch —
//     without it spawn hangs on that screen.
//   - -c notify=[...] wires the turn-end relay (codex-notify.js): codex runs
//     it at every turn boundary with the payload JSON appended as the LAST
//     argv. One mechanism gives BOTH turn-end detection AND the thread-id for
//     resume — nothing is written into the worktree (port rule #5 for free).
//   - the prompt rides in a file, expanded by the pane's shell — no quoting
//     hazards, no tmux argv length limits (same trick as claude).
//   - a fresh cwd shows codex's directory-trust prompt even with the bypass
//     flags ("Do you trust the contents of this directory?", "Yes, continue"
//     preselected — Enter accepts); launch-settle auto-accepts it, exactly
//     like claude's folder trust.
//
// Turn boundaries: the notify relay appends the SAME event shape the claude
// Stop hook emits to <stateDir>/<key>.turnend.jsonl, so onTurnEnd() is the
// shared tail and the server's /api/turn-end needs nothing codex-specific.

const fs = require('node:fs');
const path = require('node:path');
const t = require('./tmux.js');
const s = require('./tmux-session.js');

const NOTIFY_SCRIPT = path.join(__dirname, 'codex-notify.js');
const TRUST_RE = /Do you trust the contents of this directory|Yes, continue/;
const FAILURE_DETECTORS = [
  {
    re: /(?:^|\n)\s*(?:bash|zsh|sh|fish|dash|ksh)?:?\s*codex: command not found\b|(?:^|\n)\s*codex: not found\b/i,
    message: 'codex CLI is not installed or not on PATH; install the OpenAI Codex CLI and retry',
  },
  {
    re: /(?:^|\n).*(?:codex login|sign in to openai|openai codex login|login required|authenticate to openai)/i,
    message: 'codex CLI is waiting for interactive sign-in; run `codex login` in a normal terminal and retry',
  },
];

// UI_READY_RE matches signatures only the codex main UI renders: the intro
// box (">_ OpenAI Codex (vX.Y.Z)"), the YOLO-mode permissions line, or the
// composer prompt glyph '›' at a line start. The directory-trust screen shows
// none of these as a line of its own — and trustRe is checked first anyway.
const UI_READY_RE = /OpenAI Codex \(v|YOLO mode|\n›/;
const SETTLE = { trustRe: TRUST_RE, readyRe: UI_READY_RE, label: 'codex', failureDetectors: FAILURE_DETECTORS };

// The bypass + notify flags every codex launch (spawn AND resume) carries.
function launchFlags(stateDir, key, callbackUrl) {
  const notify = ['node', NOTIFY_SCRIPT, stateDir, key].concat(callbackUrl ? [callbackUrl] : []);
  return '--dangerously-bypass-approvals-and-sandbox --dangerously-bypass-hook-trust '
    + `-c ${s.shellQuote('notify=' + JSON.stringify(notify))}`;
}

// spawn(cwd, prompt, opts?) -> HarnessRef
// opts: { session?, window?, stateDir?, callbackUrl?, extraArgs?: string[], installHooks?: boolean }
// Same opts contract as claude-tmux.js. installHooks is accepted and ignored:
// codex has no settings-file hook — the notify relay rides the launch line, so
// there is nothing to install (or clobber) in any cwd.
// The returned ref carries NO resumeId: codex assigns the thread-id itself and
// the first notify delivers it (the server adopts it from that turn-end).
async function spawn(cwd, prompt, opts = {}) {
  const cwdAbs = path.resolve(cwd);
  if (!fs.existsSync(cwdAbs)) throw new Error(`spawn cwd does not exist: ${cwdAbs}`);
  const { session, window } = await s.claimPaneNames(opts);
  const stateDir = s.stateDirOf(opts);
  const key = s.stateKey(session, window);

  const promptFile = path.join(stateDir, `${key}.prompt`);
  fs.writeFileSync(promptFile, prompt);

  await s.createPane(session, window, cwdAbs);
  try {
    const extra = (opts.extraArgs || []).map(s.shellQuote).join(' ');
    const launchCmd = 'codex '
      + launchFlags(stateDir, key, opts.callbackUrl || process.env.BC_TURNEND_URL || '') + ' '
      + (extra ? extra + ' ' : '')
      + `"$(cat ${s.shellQuote(promptFile)})"`;
    await s.launchAndSettle(s.paneTarget(session, window), launchCmd, SETTLE);
  } catch (err) {
    await s.killPane(session, window);
    try { fs.unlinkSync(promptFile); } catch { /* best-effort */ }
    throw err;
  }

  const ref = { harness: 'codex', session, cwd: cwdAbs };
  if (window) ref.window = window;
  return ref;
}

// send(ref, text) — type into the session with verified submission.
// Enter is retried, never the text. Throws when the submit provably failed.
// (The '›' composer glyph is in tmux.js PROMPT_GLYPHS so a cleared codex
// composer reads 'empty' — the positive ack that the submit landed.)
async function send(ref, text) {
  const name = s.stateKey(ref.session, ref.window);
  if (!(await alive(ref))) throw new Error(`session ${name} is not alive`);
  const verdict = await t.submit(s.paneTarget(ref.session, ref.window), text, {
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
// AND its pane is still running the agent — same rule as claude: a pane
// sitting back at a bare shell means codex exited (pane_current_command reads
// 'codex' while it runs, verified 0.144.1).
async function alive(ref) {
  if (!(await s.paneExists(ref.session, ref.window))) return false;
  const cmd = await s.paneCommand(s.paneTarget(ref.session, ref.window));
  return cmd !== null && !s.SHELLS.has(cmd);
}

// resumable(ref, opts?) -> bool — would resume(ref) restore memory? True when
// a thread-id is recoverable: ref.resumeId, or the relay-recorded session-id
// file in the state dir. Introspection only — the server uses it to pick
// resume vs relaunch-with-charter.
async function resumable(ref, opts = {}) {
  if (ref.resumeId) return true;
  try {
    return !!fs.readFileSync(path.join(s.stateDirOf(opts), `${s.stateKey(ref.session, ref.window)}.session-id`), 'utf8').trim();
  } catch {
    return false;
  }
}

// resume(ref) -> HarnessRef — reincarnate a dead session with memory when possible.
// Prefers the relay-recorded thread-id (ground truth, refreshed every turn)
// over ref.resumeId, kills any leftover dead pane, relaunches
// `codex resume <thread-id>` with the same bypass + notify flags in a fresh
// pane under the same name. Resuming continues the SAME thread-id (verified),
// so the ref stays valid across death/resume cycles — and were codex ever to
// fork, the next notify would deliver the new id and the server would adopt
// it. Without any id: fresh `codex` launch (memory lost).
async function resume(ref, opts = {}) {
  if (await alive(ref)) return { ...ref };
  const stateDir = s.stateDirOf(opts);
  const key = s.stateKey(ref.session, ref.window);
  let resumeId = ref.resumeId;
  try {
    const rec = fs.readFileSync(path.join(stateDir, `${key}.session-id`), 'utf8').trim();
    if (rec) resumeId = rec;
  } catch {
    // no recorded id — fall back to the ref's
  }
  await s.killPane(ref.session, ref.window); // clear any dead pane still holding the name

  await s.createPane(ref.session, ref.window, ref.cwd);
  try {
    const launchCmd = (resumeId ? `codex resume ${resumeId} ` : 'codex ')
      + launchFlags(stateDir, key, opts.callbackUrl || process.env.BC_TURNEND_URL || '');
    await s.launchAndSettle(s.paneTarget(ref.session, ref.window), launchCmd, SETTLE);
  } catch (err) {
    await s.killPane(ref.session, ref.window);
    throw err;
  }
  const out = { harness: 'codex', session: ref.session, cwd: ref.cwd };
  if (resumeId) out.resumeId = resumeId;
  if (ref.window) out.window = ref.window;
  return out;
}

// kill(ref) — end the agent's pane for good. Idempotent: killing a dead or
// missing one is a no-op. Session-granular refs take the whole session;
// window-granular refs take ONLY their window. Harness state files are left
// behind on purpose — the thread-id and turn-end log are cheap, and a later
// resume(ref) can still reincarnate the conversation if the kill turns out
// premature.
async function kill(ref) {
  await s.killPane(ref.session, ref.window);
}

// onTurnEnd / openPane / paneSnapshot — the shared implementations verbatim
// (tmux-session.js): codex-notify.js writes the same turnend.jsonl shape the
// claude Stop hook does, and pane viewing is pure capture-pane.
const { onTurnEnd, openPane, paneSnapshot } = s;

module.exports = { spawn, send, alive, resumable, resume, kill, onTurnEnd, openPane, paneSnapshot };
