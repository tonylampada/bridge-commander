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
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const { execFile } = require('node:child_process');
const t = require('./tmux.js');
const s = require('./tmux-session.js');
const { claudeStatus, SLASH_COMMANDS, helpText, formatStatus } = require('./agent-status.js');

const HOOK_SCRIPT = path.join(__dirname, 'turnend-hook.js');
const TRUST_RE = /Yes, I trust this folder|Quick safety check/;

// RESUME_RE — the picker `claude --resume` shows when the transcript is big
// enough to be worth warning about:
//
//     Resuming the full session will consume a substantial portion of
//     your usage limits. We recommend resuming from a summary.
//     ❯ 1. Resume from summary (recommended)
//       2. Resume full session as-is
//
// It cost three lieutenants a morning. Supervision found them dead, called
// resume, hit this screen, waited 45s for a UI that was never coming, and gave
// up after three tries — and the ones it hit were exactly the ones worth saving,
// because the picker only appears when there is a lot to lose.
//
// Enter takes option 1, the preselected one, and summary is the right default
// for an UNATTENDED revival: option 2 is spending a substantial slice of the
// captain's usage limit, and nothing should do that while nobody is watching.
// He can always resume one by hand and choose otherwise.
const RESUME_RE = /Resume from summary|Resume full session as-is/;

// UI_READY_RE matches signatures only the main UI renders (composer prompt,
// busy footer, permission-mode footer) and the trust screen does not.
//
// ⚠ It is nearly wrong on the resume picker, which draws its own `❯` — and is
// saved only by `\n❯` demanding column zero while the picker indents. Do not
// relax that anchor: the picker would then read as READY and every unattended
// revival would leave a lieutenant sitting on an unanswered menu forever.
const UI_READY_RE = /bypass permissions|esc (to )?interrupt|\n❯/i;

// FATAL_RE — what a pane shows when this launch is never going to come up, so
// waiting the remaining 44 seconds only delays a wrong guess:
//
//   root       claude refuses --dangerously-skip-permissions as uid 0 (unless
//              IS_SANDBOX=1 / bubblewrap) and exits — verified in the binary.
//   first run  a claude nobody has ever run parks on its own setup wizard
//              (theme picker) BEFORE it asks about credentials. Enter is NOT
//              sent at it: answering a stranger's setup wizard blind is how you
//              pick their theme, their login method and their telemetry answer
//              for them.
//   missing    the shell answering "command not found" — no binary at all.
//   bypass     the one-time "WARNING: Claude Code running in Bypass Permissions
//              mode" consent modal, raised BY --dangerously-skip-permissions.
//              Its preselected option is `1. No, exit`, so it is emphatically
//              not one to answer with a blind Enter, and it is not ours to
//              accept on anyone's behalf: it is a person saying yes to an agent
//              that skips permission prompts on their machine.
const FATAL_RE = /cannot be used with root\/sudo privileges|Choose the text style|To change this later, run \/theme|claude: command not found|command not found: claude|Bypass Permissions mode|Yes, I accept/;
const SETTLE = { trustRe: TRUST_RE, resumeRe: RESUME_RE, readyRe: UI_READY_RE, fatalRe: FATAL_RE, label: 'claude' };

// mergeLocalSettings(cwd, mutate) — the read-modify-write of
// <cwd>/.claude/settings.local.json, in ONE place.
//
// Two writers own this file: installHooks (the Stop hook every turn boundary on
// the board rides on) and writeOutputStyle. Neither may clobber the other, so
// both read first and write the whole object back — and every decision about
// HOW that is done has to be the same on both sides. Kept apart, the second
// copy is free to drift: a different indent, or a corrupt file that one hand
// recovers from and the other throws on, and the drift shows up as a lieutenant
// that stopped reporting turn ends.
//
// A file that is missing, unparseable, or not a JSON object is replaced by {}:
// there is nothing to preserve in bytes nothing can read, and refusing to write
// would leave the caller with no hook and no style either.
function mergeLocalSettings(cwd, mutate) {
  const dir = path.join(cwd, '.claude');
  const file = path.join(dir, 'settings.local.json');
  fs.mkdirSync(dir, { recursive: true });
  let settings;
  try {
    settings = JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    settings = null;
  }
  if (!settings || typeof settings !== 'object' || Array.isArray(settings)) settings = {};
  mutate(settings);
  fs.writeFileSync(file, JSON.stringify(settings, null, 2) + '\n');
  return file;
}

// excludeLocalSettings(cwd) — hide .claude/settings.local.json from git
// (info/exclude) when cwd is a repo, so a file we wrote never dirties someone's
// worktree. Sits next to mergeLocalSettings for the same reason: every writer of
// that file has to make the same decisions about it, and a writer that skipped
// this step left the untracked file this step exists to prevent. Best-effort —
// not a repo, no permission, nothing to exclude, and the write still stands.
async function excludeLocalSettings(cwd) {
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

// installHooks — write/merge the Stop hook into <cwd>/.claude/settings.local.json.
// Idempotent; preserves any existing settings/hooks. Also hides the file from
// git (info/exclude) when cwd is a repo, so it never dirties a worktree.
async function installHooks(cwd, session, stateDir, callbackUrl) {
  const command = ['node', s.shellQuote(HOOK_SCRIPT), s.shellQuote(stateDir), s.shellQuote(session)]
    .concat(callbackUrl ? [s.shellQuote(callbackUrl)] : [])
    .join(' ');
  mergeLocalSettings(cwd, (settings) => {
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
  });
  await excludeLocalSettings(cwd);
}

// sandboxPrefix(allowRoot) — claude refuses --dangerously-skip-permissions as
// uid 0 and exits, so as root there is no session to have unless the caller has
// said, in as many words, that this box is a throwaway. IS_SANDBOX=1 is the
// escape claude itself checks; it is never set on our own initiative. Off root
// the consent is inert, so spawn and resume both ask here rather than each
// deciding for themselves.
function sandboxPrefix(allowRoot) {
  const asRoot = allowRoot && typeof process.getuid === 'function' && process.getuid() === 0;
  return asRoot ? 'IS_SANDBOX=1 ' : '';
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
  // Recorded so resume() can replay them — a worker pinned to a model by its
  // playbook must not come back on the default one (tmux-session.js).
  s.recordSpawnArgs(stateDir, key, opts);

  await s.createPane(session, window, cwdAbs);
  try {
    const extra = (opts.extraArgs || []).map(s.shellQuote).join(' ');
    const launchCmd = sandboxPrefix(opts.allowRoot)
      + 'CLAUDE_CODE_ENABLE_PROMPT_SUGGESTION=false '
      + `claude --dangerously-skip-permissions --session-id ${resumeId}`
      + (extra ? ' ' + extra : '');
    await s.launchAndSettle(s.paneTarget(session, window), launchCmd, SETTLE);
    await deliverPrompt(s.paneTarget(session, window), prompt);
    // Returning is a claim that there is a session here. Check it, once, against
    // the pane — a settle that matched a modal's own wording is exactly how a
    // spawn came to report success over a consent screen nobody had answered.
    await s.verifyLive(s.paneTarget(session, window), SETTLE);
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
  if (verdict === 'pending' || verdict === 'send-failed') {
    // The pane rides on THIS failure too. A launch that settles and then will
    // not take the brief is the interesting case — the screen underneath is
    // usually a login prompt or a trust dialog wearing a composer's clothes —
    // and without the tail the caller is left with nothing to diagnose from.
    throw new Error((verdict === 'pending'
      ? 'brief not submitted at spawn (Enter swallowed; text left in composer)'
      : 'brief not sent at spawn (tmux send failed)') + '; pane tail:\n' + (await paneTailSafe(target)));
  }
}
async function paneTailSafe(target) {
  try { return (await t.capture(target, 20)) || ''; } catch (e) { return ''; }
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
  // STRICT: this answer is what the board drops worker records on, so a tmux it
  // could not read must throw rather than pass for "the pane is gone".
  if (!(await s.paneExists(ref.session, ref.window, { strict: true }))) return false;
  const cmd = await s.paneCommand(s.paneTarget(ref.session, ref.window), { strict: true });
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
    // The spawn's launch facts are replayed, not rebuilt: --model/--effort came
    // from the card's playbook and a resume that drops them is a worker quietly
    // moved to another model, and a root session that comes back without
    // IS_SANDBOX=1 does not come back at all. opts, when given, wins over the
    // record. A missing or corrupt record is no flags and no prefix, never a throw.
    const rec = s.recordedSpawnArgs(stateDir, key);
    const extra = (opts.extraArgs || rec.args).map(String);
    const parts = ['claude', '--dangerously-skip-permissions'];
    if (resumeId) parts.push('--resume', resumeId);
    for (const a of extra) parts.push(s.shellQuote(a));
    const launchCmd = sandboxPrefix(opts.allowRoot || rec.allowRoot)
      + 'CLAUDE_CODE_ENABLE_PROMPT_SUGGESTION=false ' + parts.join(' ');
    await s.launchAndSettle(s.paneTarget(ref.session, ref.window), launchCmd, SETTLE);
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

// ---------- /output-style (claude only, and NOT a pass-through) ----------
// claude USED to answer `/output-style`; it does not any more. Verified against
// the 2.1.239 binary in a live pane: the composer answers "No commands match
// /output-style" and submitting the line comes back "Unknown command:
// /output-style". The binary's own migration table says it outright — "/output-
// style | Open /config → Output style. Output styles still exist as a feature;
// only the dedicated command was removed". /config is an INTERACTIVE dialog, so
// a pass-through here would park a worker on exactly the menu this command
// exists to keep it off.
//
// So the board does what claude itself does with the setting: it WRITES it, and
// says when it lands. outputStyle goes into <ref.cwd>/.claude/settings.local.json
// — the session's OWN cwd (a worker's worktree, a lieutenant's workspace), never
// ~/.claude/settings.json, which would repaint every claude on the machine.
//
// The setting is read when a session STARTS, so the running conversation keeps
// the style it was born with and the reply says WHEN the new one lands, without
// naming a command to get there. It cannot: /reset is a board command that only
// exists for lieutenant targets, so on a card thread the same reply would send
// the captain at a command the worker session refuses as unknown — a reply that
// teaches the board is broken is worse than one that says nothing. (Appending
// the hint server-side, where the target kind IS known, was considered and
// rejected: it would park knowledge of one harness command in the server
// forever to decorate one parenthetical.) The board does not restart a session
// on the captain's behalf — a kill takes that session's background work with it.
const OUTPUT_STYLE = '/output-style';

// The built-ins, pinned against the 2.1.239 binary's own style table (name and
// description lifted verbatim) rather than against memory — an earlier list
// that "everyone knows" was already wrong by two entries. `default` is the
// no-style entry; the other four are claude's built-in styles.
const BUILTIN_OUTPUT_STYLES = [
  { value: 'default', description: 'Claude completes coding tasks efficiently and provides concise responses' },
  { value: 'Proactive', description: 'Claude executes immediately, minimizes interruptions, and prefers action over planning' },
  { value: 'Concise', description: 'Claude responds tersely, leading with results and skipping preamble and narration' },
  { value: 'Explanatory', description: 'Claude explains its implementation choices and codebase patterns' },
  { value: 'Learning', description: 'Claude pauses and asks you to write small pieces of code for hands-on practice' },
];

// The `name:`/`description:` front matter of a style file. Deliberately a
// couple of lines and not a YAML dependency: these two scalars are the whole
// contract, and a file that does not have them still has a basename.
function frontMatter(text) {
  const m = /^---\r?\n([\s\S]*?)\r?\n---/.exec(text);
  if (!m) return {};
  const out = {};
  for (const line of m[1].split(/\r?\n/)) {
    const kv = /^([A-Za-z][A-Za-z0-9_-]*)[ \t]*:[ \t]*(.*)$/.exec(line);
    if (kv) out[kv[1].toLowerCase()] = kv[2].trim().replace(/^["']|["']$/g, '');
  }
  return out;
}

// outputStyles(opts?) -> [{ value, description }] — what `/output-style` accepts
// HERE: the built-ins, plus every *.md under the SESSION's own
// <cwd>/.claude/output-styles/ (opts.cwd), plus every *.md under the user's
// ~/.claude/output-styles/. A style is named by its front-matter `name:` (the
// string the setting takes), and falls back to its basename when the file has
// none. An unreadable directory or file is not an error — it just means there
// are fewer custom styles to offer, and the command still works for the rest.
//
// The project directory is scanned because we WRITE the setting into that very
// .claude/ — a style file sitting next to the settings file we are editing, and
// being told it is unknown, was our own inconsistency and not a missing feature.
// Verified in a live pane: a style present only in <cwd>/.claude/output-styles/
// is honoured by the binary (the session reported `# Output Style: ProjOnly`).
//
// PRECEDENCE, also verified against the binary rather than inferred — the same
// `name:` in both directories with different bodies, and the session emitted the
// PROJECT one. So the project entry shadows the user entry, and the project
// directory is scanned first (first name in wins). Built-ins are seeded into
// `taken` before either, so no custom file can shadow a built-in name — the
// existing rule, unchanged.
function outputStyles(opts = {}) {
  const out = BUILTIN_OUTPUT_STYLES.map((st) => ({ ...st }));
  const userDir = opts.stylesDir || process.env.BC_CLAUDE_OUTPUT_STYLES_DIR
    || path.join(os.homedir(), '.claude', 'output-styles');
  const dirs = [];
  if (opts.cwd) dirs.push(path.join(opts.cwd, '.claude', 'output-styles'));
  dirs.push(userDir);
  const taken = new Set(out.map((st) => st.value.toLowerCase()));
  for (const dir of dirs) {
    let files;
    try {
      files = fs.readdirSync(dir).filter((f) => f.endsWith('.md')).sort();
    } catch {
      continue; // no directory, no permission — never a throw, just fewer styles
    }
    for (const f of files) {
      let fm;
      try {
        fm = frontMatter(fs.readFileSync(path.join(dir, f), 'utf8'));
      } catch {
        continue; // unreadable file — skip it, the rest of the list still stands
      }
      const value = fm.name || path.basename(f, '.md');
      if (!value || taken.has(value.toLowerCase())) continue;
      taken.add(value.toLowerCase());
      out.push({ value, description: fm.description || 'custom output style (' + f + ')' });
    }
  }
  return out;
}

// writeOutputStyle — one key, through the shared merge, because installHooks
// writes its Stop hook into this very file and must survive the write.
async function writeOutputStyle(cwd, style) {
  mergeLocalSettings(cwd, (settings) => { settings.outputStyle = style; });
  await excludeLocalSettings(cwd);
}

// commands(ref?) — the ref is what makes the style list this SESSION's list: a
// style installed in the worker's own worktree is offered to that worker and to
// nobody else. Without a ref (a bare /help, a caller with no session in hand)
// only the user-level directory is scanned, as before.
function commands(ref) {
  return SLASH_COMMANDS.map((c) => ({ ...c })).concat([
    { name: '/autocompact', description: 'set how full the context gets before auto-compaction' },
    {
      name: OUTPUT_STYLE,
      description: 'set this session\'s output style (applies on its next conversation)',
      args: outputStyles({ cwd: ref && ref.cwd }),
    },
  ]);
}
async function status(ref) {
  return claudeStatus(ref);
}
async function runCommand(ref, command, opts = {}) {
  const line = String(command || '').trim();
  const name = line.split(/\s+/)[0];
  const key = s.stateKey(ref.session, ref.window);
  if (name === '/help') return helpText(commands(ref));
  if (name === '/status') {
    const st = await status(ref);
    if (!st) throw new Error('no status for ' + key + ' — session transcript not found');
    return formatStatus(st);
  }
  if (name === OUTPUT_STYLE) {
    // Everything after the command name is ONE style name — a style file may
    // carry spaces in its `name:`, so the argument is not tokenized.
    const want = line.slice(name.length).trim();
    const styles = outputStyles({ stylesDir: opts.stylesDir, cwd: ref.cwd });
    const available = styles.map((st) => st.value).join(', ');
    // The bare form is refused rather than typed: claude has no /output-style
    // to answer it, and the whole point is that nobody has to remember the list.
    if (!want) throw new Error(OUTPUT_STYLE + ' needs a style name — available: ' + available);
    const hit = styles.find((st) => st.value.toLowerCase() === want.toLowerCase());
    // Refused before anything is written: a bad name must not silently sit in
    // the settings file waiting to surprise the next conversation.
    if (!hit) throw new Error('unknown output style "' + want + '" — available: ' + available);
    await writeOutputStyle(ref.cwd, hit.value);
    return 'output style set to ' + hit.value
      + ' — it applies the next time this session starts';
  }
  if (PASSTHROUGH.has(name)) {
    await send(ref, line); // verified submit; claude's own command runs in-session
    return '"' + line + '" submitted to ' + key + ' — the session runs it in-place';
  }
  throw new Error('unknown command ' + name + ' (see /help)');
}

// onTurnEnd / openPane / paneSnapshot / paneInput / adoptWindow — the shared
// implementations verbatim (tmux-session.js): the Stop-hook relay writes the
// same turnend.jsonl shape every tmux adapter tails, pane viewing is pure
// capture-pane, pane input is pure send-keys, and adoption is pure
// rename-window.
const { onTurnEnd, openPane, paneSnapshot, paneInput, adoptWindow } = s;

// installHooks is exported beyond the seven port verbs so `bc-axi init` can
// install the workspace-level Stop hook (session-agnostic; the server dedupes
// turn-end POSTs by session_id). openPane/paneSnapshot/paneInput and
// commands/runCommand/status are OPTIONAL capability verbs (port.js).
module.exports = { spawn, send, alive, resumable, resume, kill, onTurnEnd, installHooks,
  openPane, paneSnapshot, paneInput, commands, runCommand, status, adoptWindow,
  // Exported for the tests that pin the style list against a temp directory and
  // the built-ins against the binary.
  outputStyles, BUILTIN_OUTPUT_STYLES,
  // Exported for the test that pins them against REAL captured screens. These
  // regexes decide whether an unattended revival works or sits on a menu until
  // it is given up on, and that is not a judgement to make by reading them.
  SETTLE };
