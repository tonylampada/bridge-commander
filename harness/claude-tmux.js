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
// Session/window/pane plumbing is shared with the other tmux adapters —
// see tmux-session.js. This module owns only what is claude-specific:
// launch line, screen signatures, the Stop-hook install, and resume.
//
// Verified launch template (mined from firstmate's fm-spawn.sh):
//   CLAUDE_CODE_ENABLE_PROMPT_SUGGESTION=false claude --dangerously-skip-permissions \
//     --session-id <uuid>
//   - CLAUDE_CODE_ENABLE_PROMPT_SUGGESTION=false kills the dim "ghost text"
//     prompt suggestion that otherwise reads as pending composer input.
//   - the prompt is NEVER passed on the command line — claude launches bare,
//     and once launch-settle confirms the composer is up, the prompt is typed
//     into it via the same verified-submit machinery send() uses (t.submit).
//     A prompt riding in argv would sit in that process's command line for
//     the life of the session — visible to `ps`/`pgrep -f`, and a broad
//     pattern-kill run BY that very agent (matching its own argv) could
//     freeze or kill itself. The prompt file in stateDir stays the source of
//     truth; only the delivery mechanism changed.
//   - a fresh cwd triggers claude's folder-trust dialog even with
//     --dangerously-skip-permissions (verified); spawn auto-accepts it.
//
// Turn boundaries: spawn installs a Stop hook in <cwd>/.claude/settings.local.json
// running harness/turnend-hook.js, which appends to <stateDir>/<session>.turnend.jsonl
// (and optionally POSTs to a callback URL). onTurnEnd() tails that file.

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { execFile } = require('node:child_process');
const t = require('./tmux.js');
const s = require('./tmux-session.js');
const { claudeStatus, SLASH_COMMANDS, helpText, formatStatus } = require('./agent-status.js');

const HOOK_SCRIPT = path.join(__dirname, 'turnend-hook.js');
const TRUST_RE = /Yes, I trust this folder|Quick safety check/;

// UI_READY_RE matches signatures only the main UI renders (composer prompt,
// busy footer, permission-mode footer) and the trust screen does not.
const UI_READY_RE = /bypass permissions|esc (to )?interrupt|\n❯/i;
const SETTLE = { trustRe: TRUST_RE, readyRe: UI_READY_RE, label: 'claude' };

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
  const command = ['node', s.shellQuote(HOOK_SCRIPT), s.shellQuote(stateDir), s.shellQuote(session)]
    .concat(callbackUrl ? [s.shellQuote(callbackUrl)] : [])
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
  const { session, window } = await s.claimPaneNames(opts);
  const stateDir = s.stateDirOf(opts);
  const resumeId = crypto.randomUUID();
  const key = s.stateKey(session, window);

  if (opts.installHooks !== false) {
    await installHooks(cwdAbs, key, stateDir, opts.callbackUrl || process.env.BC_TURNEND_URL || '');
  }

  const promptFile = path.join(stateDir, `${key}.prompt`);
  fs.writeFileSync(promptFile, prompt);

  await s.createPane(session, window, cwdAbs);
  try {
    const extra = (opts.extraArgs || []).map(s.shellQuote).join(' ');
    const launchCmd = 'CLAUDE_CODE_ENABLE_PROMPT_SUGGESTION=false '
      + `claude --dangerously-skip-permissions --session-id ${resumeId}`
      + (extra ? ' ' + extra : '');
    await s.launchAndSettle(s.paneTarget(session, window), launchCmd, SETTLE);
    await deliverPrompt(s.paneTarget(session, window), prompt);
  } catch (err) {
    await s.killPane(session, window);
    try { fs.unlinkSync(promptFile); } catch { /* best-effort */ }
    throw err;
  }

  const ref = { harness: 'claude', session, cwd: cwdAbs, resumeId };
  if (window) ref.window = window;
  return ref;
}

// deliverPrompt(target, prompt) — type the brief into the just-settled
// composer with verified submission (t.submit — same mechanism send() uses:
// type once, retry only Enter, never retype). Runs once, right after
// launchAndSettle confirms the main UI is up, so the brief never rides in
// argv (see the file-header note on why that matters).
async function deliverPrompt(target, prompt) {
  const verdict = await t.submit(target, prompt, {
    retries: Number(process.env.BC_SEND_RETRIES || 3),
    enterSleep: Number(process.env.BC_SEND_SLEEP_MS || 400),
  });
  if (verdict === 'pending') {
    throw new Error('brief not submitted at spawn (Enter swallowed; text left in composer)');
  }
  if (verdict === 'send-failed') {
    throw new Error('brief not sent at spawn (tmux send failed)');
  }
}

// send(ref, text) — type into the session with verified submission.
// Enter is retried, never the text. Throws when the submit provably failed.
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
// AND its pane is still running the agent (a pane sitting back at a bare shell
// means claude exited).
async function alive(ref) {
  if (!(await s.paneExists(ref.session, ref.window))) return false;
  const cmd = await s.paneCommand(s.paneTarget(ref.session, ref.window));
  return cmd !== null && !s.SHELLS.has(cmd);
}

// resumable(ref, opts?) -> bool — would resume(ref) restore memory? True when a
// resume id is recoverable: ref.resumeId, or the hook-recorded session-id file
// in the state dir. Introspection only, no side effects beyond ensuring the
// state dir exists — the server uses it to pick resume vs relaunch-with-charter.
async function resumable(ref, opts = {}) {
  if (ref.resumeId) return true;
  try {
    return !!fs.readFileSync(path.join(s.stateDirOf(opts), `${s.stateKey(ref.session, ref.window)}.session-id`), 'utf8').trim();
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

  if (opts.installHooks !== false) {
    await installHooks(ref.cwd, key, stateDir, opts.callbackUrl || process.env.BC_TURNEND_URL || '');
  }
  await s.createPane(ref.session, ref.window, ref.cwd);
  try {
    const launchCmd = 'CLAUDE_CODE_ENABLE_PROMPT_SUGGESTION=false '
      + 'claude --dangerously-skip-permissions '
      + (resumeId ? `--resume ${resumeId}` : '');
    await s.launchAndSettle(s.paneTarget(ref.session, ref.window), launchCmd.trim(), SETTLE);
  } catch (err) {
    await s.killPane(ref.session, ref.window);
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
  await s.killPane(ref.session, ref.window);
}

// ---------- slash commands + status (OPTIONAL capability verbs — port.js) ----------
// status(ref) reads the session transcript claude already writes
// (~/.claude/projects/<slug(cwd)>/<resumeId>.jsonl — agent-status.js); no
// resumeId yet or no transcript → null, never a throw.
// /autocompact is claude-specific (verified against the 2.1.207 binary — the
// public docs lag behind); like /compact it is a PASS-THROUGH: the literal
// command line (args included) is typed into the session via verified submit
// and claude's own implementation runs in-place.
const PASSTHROUGH = new Set(['/compact', '/autocompact']);
function commands() {
  return SLASH_COMMANDS.map((c) => ({ ...c })).concat([
    { name: '/autocompact', description: 'set how full the context gets before auto-compaction' },
  ]);
}
async function status(ref) {
  return claudeStatus(ref);
}
async function runCommand(ref, command) {
  const line = String(command || '').trim();
  const name = line.split(/\s+/)[0];
  const key = s.stateKey(ref.session, ref.window);
  if (name === '/help') return helpText(commands());
  if (name === '/status') {
    const st = await status(ref);
    if (!st) throw new Error('no status for ' + key + ' — session transcript not found');
    return formatStatus(st);
  }
  if (PASSTHROUGH.has(name)) {
    await send(ref, line); // verified submit; claude's own command runs in-session
    return '"' + line + '" submitted to ' + key + ' — the session runs it in-place';
  }
  throw new Error('unknown command ' + name + ' (see /help)');
}

// onTurnEnd / openPane / paneSnapshot — the shared implementations verbatim
// (tmux-session.js): the Stop-hook relay writes the same turnend.jsonl shape
// every tmux adapter tails, and pane viewing is pure capture-pane.
const { onTurnEnd, openPane, paneSnapshot } = s;

// installHooks is exported beyond the seven port verbs so `bc-axi init` can
// install the workspace-level Stop hook (session-agnostic; the server dedupes
// turn-end POSTs by session_id). openPane/paneSnapshot and
// commands/runCommand/status are OPTIONAL capability verbs (port.js).
module.exports = { spawn, send, alive, resumable, resume, kill, onTurnEnd, installHooks,
  openPane, paneSnapshot, commands, runCommand, status };
