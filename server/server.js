#!/usr/bin/env node
// bridge-commander server — the harness control surface. Node built-ins only, zero deps.
// Usage: node server/server.js [workspace] [--workspace DIR] [--port N] [--host H]
// One workspace = one board. All state lives in <workspace>/.bridge-commander/:
//   board.json     the board (canonical state of the world)
//   archive.jsonl  append-only frozen card snapshots (reason: merged|killed)
//   hookruns.jsonl append-only trace of every hook run (lifecycle and named), read from the tail
//   eventkeys.json at-most-once keys for `event --key`, per card, pruned at 7 days
//   chat/<lieutenant>.jsonl  append-only lieutenant main chat (the truth; board.json holds none)
//   config.json    { port, host?, voices?, tts? } — port default 4780, written on first boot
//   queue/<lieutenant>.jsonl  durable per-lieutenant delivery queue (global seq)
//   queue/<lieutenant>.ack    committed ack cursor (at-least-once; only ack removes)
//   server.pid     single server instance per workspace
//
// Data model (docs/api/overview.md is the DNA):
//   board = { title, subtitle, updated, seq,
//             columns: fixed frame (backlog | working | review | peer),
//             lieutenants: [{id, name, color, prefix, cardSeq, avatar?: 0-63, voice?, created,
//                            — the charter is NOT here: it is lieutenants/<id>/README.md in the workspace,
//                            chat: [{author,text,ts}]  — NOT stored: the newest CHAT_TAIL of chat/<id>.jsonl, served only,
//                            ref: null|HarnessRef {harness, session, cwd, resumeId?},
//                            lastTurnEnd?, turns?}],
//             projects: [{name, path, mode, source?, added}],   // registered repos (F6)
//             workers:  [{card, ref, worktree: {path, tool}, branch?, project,
//                         spawnedAt, done?, outcome?, flagged?, paused?, lastTurnEnd?, lastTurnEndText?,
//                         lastSignalAt?, lastSignalText?, turns?,
//                         stopNotified?, staleNotified?, staleNotifiedAt?, staleHits?}],
//             cards:   [{id, title, type, owner, column, labels[], attributes{}, body,
//                        created, updated, threadStart, pendingOrder,
//                        status: {worker: null|{id, state, expires}},  // lease; only status.set writes it
//                        events: [{seq, ts, level, kind, text, actor}],
//                        thread: [{author, text, ts}] }],
//             events:  [{seq, ts, level, kind?, text, actor, card?, cardTitle?}], // board-level
//             labels:  [{name, color}],                     // user-owned registry
//             kinds:   {<kind>: {emoji, level}},            // registered kinds map (overrides built-ins)
//             line:    null|<lieutenant-id>,                 // who holds the captain's voice channel
//             reads:   { <user>: { notifSeq, notifSeqs[], threads: {<target>: ts} } } }
//
// Every card belongs to exactly one lieutenant (`owner`); card `type` is
// plan | implementation | investigation. A card id is minted by its owner as
// <prefix>-<cardSeq>, e.g. MON-14 — cards created before that keep their
// hand-written slug ids, and no verb tells the two apart. Chat targets are `lieutenant:<id>`
// (a lieutenant's main chat) and `card:<id>` (a card thread, whose interlocutor
// is the owning lieutenant).
//
// Captain drag semantics (side effects, per the DNA): backlog → working and
// review → backlog do NOT move the card; they append a start-order / rework-order
// QueueItem to the owning lieutenant (the card carries `pendingOrder` until it
// actually moves). Every other captain drag applies normally. Lieutenant moves
// are allowed only → review (the handoff).
//
// Events are append-only and carry a global monotonic seq. The unified stream =
// board.events + every card's events, ordered by seq. Notifications are the
// level-1 slice of that stream UNION unseen lieutenant-authored card-thread
// replies (per-user read state persists in board.reads, server-side).
// Kill = archive; restore = resurrection with frozen state and a loud level-1
// event; the archive log stays append-only — the board is truth for liveness.
'use strict';

const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
// The harness port — the ONLY seam the server speaks to agent sessions through
// (docs/api/overview.md, "harness port"). Lazy builtins: requiring port.js
// drags in no tmux/claude machinery until a ref is actually dispatched.
const { isHarnessRef, harnessFor, getHarness } = require(path.join(__dirname, '..', 'harness', 'port.js'));
const { createWorktree, releaseWorktree, worktreeToolFor } = require(path.join(__dirname, 'worktrees.js'));
const { runHooks, runTeardown, listAllHooks, runNamedHook, runningHook, readRuns, lastRuns, hookKey,
  hooksDir, namedHookFile, cancelNamedHook, traceSkip, lastRunsFor,
  TEARDOWN_TIMEOUT_MS: TEARDOWN_DEFAULT_MS, HOOK_NAME_RE, LIFECYCLE_EVENTS } = require(path.join(__dirname, 'hooks.js'));
const { parseWhen, nextAfter, dueWindows, pickWindows, describeWhen, normalizeSchedules,
  NAME_RE: SCHEDULE_NAME_RE, OVERLAP, CATCHUP } = require(path.join(__dirname, 'schedules.js'));
const { createSampler } = require(path.join(__dirname, 'sysload.js'));
const { workerBrief, listPlaybooks, resolvePlaybook, playbooksDir, PACKAGED_PLAYBOOKS_DIR, parsePlaybook, attrVar, attrCardKey, PLACEHOLDERS, FRONTMATTER } = require(path.join(__dirname, 'playbooks.js'));
const names = require(path.join(__dirname, 'names.js'));
const { STATE_DIR_NAME, migrateStateDir, migrateHomeStateDir } = require(path.join(__dirname, 'statedir.js'));
const gitrev = require(path.join(__dirname, 'gitrev.js'));
const { charterPath, readCharter, writeCharter } = require(path.join(__dirname, 'charter.js'));
const { ONBOARDING_STEPS } = require(path.join(__dirname, 'firstrun.js'));
const { proxyTts } = require(path.join(__dirname, 'ttsproxy.js'));
const { proxyStt, proxySttUpgrade } = require(path.join(__dirname, 'sttproxy.js'));
const { execFile, execFileSync } = require('child_process');

// ---------- args ----------
function parseArgs(argv) {
  const o = { workspace: '', port: 0, host: '' };
  const pos = [];
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--port') o.port = parseInt(argv[++i], 10);
    else if (argv[i] === '--workspace') o.workspace = argv[++i];
    else if (argv[i] === '--host') o.host = argv[++i];
    else pos.push(argv[i]);
  }
  if (!o.workspace && pos.length) o.workspace = pos[0];
  if (o.port && (!Number.isInteger(o.port) || o.port <= 0)) { console.error('bad --port'); process.exit(1); }
  if (o.host && !/^[\w.:-]+$/.test(o.host)) { console.error('bad --host'); process.exit(1); }
  return o;
}
const opts = parseArgs(process.argv.slice(2));

// ---------- paths (workspace-scoped; no global state) ----------
// Resolved AND real: every path the board hands out is built from this one, and
// hookTarget() compares a hook's containing directory against realpathSync of
// itself. A workspace reached through a symlinked parent (/tmp on macOS,
// ~/work → /mnt/data/work anywhere) would fail that comparison for the board's
// OWN hooks, so the link is followed once here rather than at each call site.
// A workspace that is not on disk YET is the same question one level up: `--workspace
// ~/work/newboard` through a ~/work → /mnt/data/work link has a link to follow even
// though the board's own directory does not exist. So this resolves the deepest
// ancestor that IS there and re-joins the tail the mkdirs below will create.
// Worth the walk even though a restart would fix it: until then the whole life of
// that process answers 404 to every hook on the tab, and nobody would ever connect
// "the board came up before its directory did" to "the pencil stopped working".
function realWorkspace(dir) {
  const missing = [];
  for (let at = dir; ;) {
    try { return path.join(fs.realpathSync(at), ...missing); } catch (e) {}
    const up = path.dirname(at);
    if (up === at) return dir; // nothing on the way to the root resolved
    missing.unshift(path.basename(at));
    at = up;
  }
}
const WORKSPACE = realWorkspace(path.resolve(opts.workspace || process.cwd()));
// One-shot rename migrations (bridge-command → bridge-commander). Boot-time and
// idempotent: the server owns this workspace as it starts, so renaming the state
// dir before any path below is used is safe. Legacy installs survive the flag day.
const migratedState = migrateStateDir(WORKSPACE);
if (migratedState) console.log('[bridge-commander] migrated state dir → ' + migratedState);
const migratedHome = migrateHomeStateDir();
if (migratedHome) console.log('[bridge-commander] migrated home state dir → ' + migratedHome);
const STATE_DIR = path.join(WORKSPACE, STATE_DIR_NAME);
const BOARD_FILE = path.join(STATE_DIR, 'board.json');
const ARCHIVE_FILE = path.join(STATE_DIR, 'archive.jsonl');
const CONFIG_FILE = path.join(STATE_DIR, 'config.json');
const QUEUE_DIR = path.join(STATE_DIR, 'queue');
const CHAT_DIR = path.join(STATE_DIR, 'chat');
const PID_FILE = path.join(STATE_DIR, 'server.pid');
// Chat file uploads. Lives under the workspace .bridge-commander/ (already
// git-ignored). NOTE: this dir grows unbounded — an upload is never garbage
// collected here; a prune policy (age/size cap, orphan sweep) can come later.
// Each file is stored as <id>__<safeName> with a sidecar <id>.json holding its
// metadata (name/mime/size), so GET can serve the right Content-Type and the
// stored name can never be spoofed by the request path.
const UPLOADS_DIR = path.join(STATE_DIR, 'uploads');
const UI_DIR = path.join(__dirname, '..', 'ui');
// Harness working state (session ids, prompts, turn-end logs) lives in the
// WORKSPACE, never in the harness's global last-resort dir — two boards on one
// machine must never share it. BC_HARNESS_STATE stays an explicit override.
const HARNESS_STATE_DIR = process.env.BC_HARNESS_STATE || path.join(STATE_DIR, 'harness');
fs.mkdirSync(QUEUE_DIR, { recursive: true });
fs.mkdirSync(CHAT_DIR, { recursive: true });
fs.mkdirSync(HARNESS_STATE_DIR, { recursive: true });
fs.mkdirSync(UPLOADS_DIR, { recursive: true });

// Upload size cap (decoded bytes). Over-cap uploads are rejected 413.
const UPLOAD_MAX_BYTES = parseInt(process.env.BC_UPLOAD_MAX_BYTES, 10) > 0
  ? parseInt(process.env.BC_UPLOAD_MAX_BYTES, 10) : 10 * 1024 * 1024;
// Raw-artifact byte serve cap. Images/binaries are delivered as bytes to an
// <img>/download (not inlined as text), so this is far larger than the text
// preview cap; over-cap → 413.
const ARTIFACT_MAX_BYTES = parseInt(process.env.BC_ARTIFACT_MAX_BYTES, 10) > 0
  ? parseInt(process.env.BC_ARTIFACT_MAX_BYTES, 10) : 25 * 1024 * 1024;
// Extension → Content-Type for raw artifact byte serving. Images, video, and
// audio render inline in the viewer; pdf may render inline; everything else
// downloads.
const ARTIFACT_MIME = {
  '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.gif': 'image/gif',
  '.webp': 'image/webp', '.svg': 'image/svg+xml', '.bmp': 'image/bmp', '.avif': 'image/avif',
  '.pdf': 'application/pdf',
  '.mp4': 'video/mp4', '.m4v': 'video/mp4', '.mov': 'video/quicktime', '.webm': 'video/webm',
  '.mp3': 'audio/mpeg', '.m4a': 'audio/mp4', '.aac': 'audio/aac', '.wav': 'audio/wav',
  '.ogg': 'audio/ogg', '.oga': 'audio/ogg', '.opus': 'audio/ogg', '.flac': 'audio/flac',
  // A rendered page and the things it pulls in beside itself.
  '.html': 'text/html; charset=utf-8', '.htm': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8', '.js': 'text/javascript; charset=utf-8',
  '.json': 'application/json', '.txt': 'text/plain; charset=utf-8',
  '.woff2': 'font/woff2', '.woff': 'font/woff', '.ttf': 'font/ttf',
};

const DEFAULT_PORT = 4780;
// The one prefix the TTS engine is served under, both ends of it: what the
// browser is handed as its engine address, and what the proxy strips.
const TTS_PREFIX = '/api/tts';
// Same idea for the STT engine, http and websocket both. Nothing is handed to
// the UI under this one — ui/stt-test.html is the only page that speaks it.
const STT_PREFIX = '/api/stt';
// ---------- workspace config (.bridge-commander/config.json) ----------
function readConfig() {
  try {
    const c = JSON.parse(fs.readFileSync(CONFIG_FILE, 'utf8'));
    if (c && typeof c === 'object' && !Array.isArray(c)) return c;
  } catch (e) {}
  return {};
}
function userConfig() {
  const c = readConfig();
  const out = { voices: null };
  if (Array.isArray(c.voices)) {
    const voices = c.voices.filter((v) => typeof v === 'string' && v.trim()).map((v) => v.trim());
    if (voices.length) out.voices = voices;
  }
  // The browser is the engine's client, through us: it gets the defaults whole
  // and, for the address, the board's own proxy prefix. A relative base resolves
  // against whatever origin the page came from, so the phone off the tailnet and
  // the https page both reach the engine, and the real engine address stays the
  // server's business. No tts config => no tts key => the UI is byte-for-byte
  // what it was before this feature existed.
  const t = ttsConfig();
  if (t) out.tts = Object.assign({ enabled: true }, t, { url: TTS_PREFIX });
  return out;
}
// External TTS engine (voxbench API), optional: config.json
//   "tts": { "url": "http://127.0.0.1:8883", "voice": null, "lang": "pt", "params": {} }
// Anything malformed (or a missing url) reads as "not configured".
function ttsConfig() {
  const t = readConfig().tts;
  if (!t || typeof t !== 'object' || Array.isArray(t)) return null;
  const url = typeof t.url === 'string' ? t.url.trim().replace(/\/+$/, '') : '';
  if (!/^https?:\/\/\S+$/.test(url)) return null;
  const str = (v) => (typeof v === 'string' && v.trim() ? v.trim() : null);
  return {
    url,
    lang: str(t.lang),
    voice: str(t.voice),
    params: t.params && typeof t.params === 'object' && !Array.isArray(t.params) ? t.params : {},
  };
}
// External STT engine (whisper API), optional: config.json
//   "stt": { "url": "http://127.0.0.1:8878" }
// Anything malformed (or a missing url) reads as "not configured", and the
// /api/stt routes 404 like they were never there.
function sttConfig() {
  const t = readConfig().stt;
  if (!t || typeof t !== 'object' || Array.isArray(t)) return null;
  const url = typeof t.url === 'string' ? t.url.trim().replace(/\/+$/, '') : '';
  if (!/^https?:\/\/\S+$/.test(url)) return null;
  return { url };
}
// Port: --port flag > config.json "port" > 4780. The resolved port is written
// back into config.json when absent, so the CLI and UI can always find it.
const cfg = readConfig();
const PORT = opts.port || (Number.isInteger(cfg.port) && cfg.port > 0 ? cfg.port : DEFAULT_PORT);
if (!Number.isInteger(cfg.port) || cfg.port <= 0) {
  fs.writeFileSync(CONFIG_FILE, JSON.stringify(Object.assign({}, cfg, { port: PORT }), null, 2) + '\n');
}
// Bind host is machine-private config: --host flag > config.json "host" > 127.0.0.1.
function configHost() {
  const c = readConfig();
  if (typeof c.host === 'string' && /^[\w.:-]+$/.test(c.host.trim())) return c.host.trim();
  return '';
}
const LOOPBACKS = ['127.0.0.1', 'localhost', '::1'];
const BIND_HOST = opts.host || configHost() || '127.0.0.1';
// Turn-end hooks (workspace-level and per-worker-spawn) POST here.
const TURNEND_URL = 'http://127.0.0.1:' + PORT + '/api/turn-end';

// The commit this process is RUNNING, decided once here at boot and never
// re-read: a merge into the checkout below moves the files, not this record,
// and /api/status hands the difference to the CLI to announce. Boot is the only
// place a git subprocess is allowed — no request path ever pays for it.
// BC_CODE_ROOT is a test-only seam (tests point it at a fabricated checkout).
const CODE_ROOT = process.env.BC_CODE_ROOT || path.join(__dirname, '..');
const CODE = gitrev.bootRecord(CODE_ROOT);

// ---------- pidfile: single instance per workspace ----------
function pidAlive(pid) { try { process.kill(pid, 0); return true; } catch (e) { return e.code === 'EPERM'; } }
// A live pid alone isn't proof it's OUR server — pids get recycled by the OS,
// so an unrelated process can end up wearing a stale server.pid. Sanity-check
// via /proc/<pid>/cmdline (Linux only — cmdline is null/unreadable elsewhere,
// e.g. after the process exits mid-check or on a non-Linux OS) so a recycled
// pid doesn't block a real boot; null means "can't tell" and falls back to
// trusting pidAlive, same as before this check existed.
function looksLikeOurServer(pid) {
  try {
    const cmdline = fs.readFileSync('/proc/' + pid + '/cmdline', 'utf8');
    return cmdline.split('\0').some((a) => a && path.basename(a) === 'server.js');
  } catch (e) { return null; }
}
if (fs.existsSync(PID_FILE)) {
  const old = parseInt(fs.readFileSync(PID_FILE, 'utf8'), 10);
  if (old && pidAlive(old)) {
    const ours = looksLikeOurServer(old);
    if (ours !== false) process.exit(0); // live server already owns this workspace (or unverifiable — trust it)
    // else: pid is alive but is NOT a bridge-commander server — a recycled pid
    // wearing a stale pidfile. Fall through and boot normally.
  }
}
fs.writeFileSync(PID_FILE, String(process.pid));
function cleanup() {
  try { if (parseInt(fs.readFileSync(PID_FILE, 'utf8'), 10) === process.pid) fs.unlinkSync(PID_FILE); } catch (e) {}
}
process.on('exit', cleanup);
for (const sig of ['SIGINT', 'SIGTERM']) process.on(sig, () => { cleanup(); process.exit(0); });

// ---------- board state ----------
function now() { return new Date().toISOString(); }

// The fixed column frame. No Done: cards leave by archive (merged | killed).
const COLUMNS = [
  { id: 'backlog', title: '📋 Backlog' },
  { id: 'working', title: '🔨 Working' },
  { id: 'review', title: '👀 Your review' },
  { id: 'peer', title: '🤝 Peer review' },
];
const CARD_TYPES = ['plan', 'implementation', 'investigation'];

// Worker lease states. `absent` is never persisted: it is the derived state of a
// card with no worker linked (persisted lease = null).
const WORKER_STATES = ['absent', 'idle', 'working', 'needs-you'];
const WORKER_LEASE_STATES = ['idle', 'working', 'needs-you'];
const WORKER_TTL_SECS = parseFloat(process.env.BC_WORKER_TTL_SECS) || 600;

function defaultBoard() {
  return {
    title: path.basename(WORKSPACE), subtitle: '', updated: now(), seq: 0,
    columns: COLUMNS, lieutenants: [], cards: [], events: [], labels: [], reads: {}, kinds: {},
    projects: [], workers: [], schedules: [], line: null,
  };
}
function normalizeBoard(doc) {
  const b = Object.assign(defaultBoard(), doc);
  b.columns = COLUMNS; // the frame is fixed — never board data
  if (!Array.isArray(b.lieutenants)) b.lieutenants = [];
  if (!Array.isArray(b.cards)) b.cards = [];
  if (!Array.isArray(b.events)) b.events = [];
  if (!Array.isArray(b.labels)) b.labels = [];
  if (!b.reads || typeof b.reads !== 'object') b.reads = {};
  if (typeof b.line !== 'string' || !b.line) b.line = null; // resolved through lineHolder()
  b.kinds = sanitizeKinds(b.kinds);
  for (const lt of b.lieutenants) {
    if (!Array.isArray(lt.chat)) lt.chat = [];
    // ref: a persisted HarnessRef or null (odd shapes collapse to null).
    if (lt.ref !== undefined && !isHarnessRef(lt.ref)) lt.ref = null;
  }
  ensureMinting(b.lieutenants); // prefix + card counter (backfilled for the ones that predate them)
  // projects: the registered-repo registry; workers: the live worker-ref registry
  // (both survive restarts — board is truth). Odd shapes are dropped. A `mode`
  // left over from delivery modes is ignored and dropped on the next write:
  // the card's playbook chooses the delivery contract now.
  if (!Array.isArray(b.projects)) b.projects = [];
  b.projects = b.projects.filter((p) => p && typeof p === 'object'
    && typeof p.name === 'string' && p.name
    && typeof p.path === 'string' && p.path);
  for (const p of b.projects) delete p.mode;
  if (!Array.isArray(b.workers)) b.workers = [];
  b.workers = b.workers.filter((w) => w && typeof w === 'object' && w.card && isHarnessRef(w.ref));
  // schedules: the board's own clock. A schedule whose `when` no longer parses
  // is KEPT (it says so on the schedule, and the tick refuses to fire it) —
  // dropping it would be a clock that silently loses an entry, which is the
  // exact failure host cron already had.
  b.schedules = normalizeSchedules(b.schedules);
  for (const c of b.cards) {
    if (!Array.isArray(c.events)) c.events = [];
    if (!Array.isArray(c.thread)) c.thread = [];
    if (!Array.isArray(c.labels)) c.labels = [];
    if (!c.attributes || typeof c.attributes !== 'object') c.attributes = {};
    if (!CARD_TYPES.includes(c.type)) c.type = 'implementation';
    // playbook: the id of a file in playbooks/, or '' — cards that predate it
    // have none and cannot start until one is set (card patch --playbook <id>).
    if (typeof c.playbook !== 'string') c.playbook = '';
    if (!b.columns.some((k) => k.id === c.column)) c.column = 'backlog';
    if (c.pendingOrder && !(typeof c.pendingOrder === 'object' && c.pendingOrder.kind)) c.pendingOrder = null;
    // status: keep only a valid persisted worker lease; an absent status stays
    // absent (means "status.set never touched this card"), odd shapes collapse
    // to a cleared lease. Decay is derived on read, never persisted.
    if (c.status !== undefined) {
      const w = c.status && typeof c.status === 'object' ? c.status.worker : null;
      const ok = w && typeof w === 'object' && w.id && WORKER_LEASE_STATES.includes(w.state);
      c.status = { worker: ok ? { id: String(w.id), state: w.state, expires: w.expires || null } : null };
    }
  }
  // seq must top every stored event (defensive after hand edits)
  let max = b.seq || 0;
  for (const e of b.events) if (e.seq > max) max = e.seq;
  for (const c of b.cards) for (const e of c.events) if (e.seq > max) max = e.seq;
  b.seq = max;
  return b;
}
function loadBoard() {
  try { return normalizeBoard(JSON.parse(fs.readFileSync(BOARD_FILE, 'utf8'))); }
  catch (e) { return defaultBoard(); }
}
let board = loadBoard();
// What lands on disk: the board MINUS every lieutenant's chat. The main chat is
// an append-only log of its own (chat/<id>.jsonl, below) — keeping a second copy
// here is the drift bug, and it is what made every write rewrite megabytes of
// conversation nobody scrolls to.
function storedBoard() {
  return Object.assign({}, board, {
    lieutenants: board.lieutenants.map((l) => {
      const copy = Object.assign({}, l);
      delete copy.chat;
      return copy;
    }),
  });
}
function saveBoard() {
  board.updated = now();
  const tmp = BOARD_FILE + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(storedBoard(), null, 2));
  fs.renameSync(tmp, BOARD_FILE);
}

// One-time migration, at boot: the charter used to be a board field. Move what
// is still there into the lieutenant's memory file and drop the key. The write
// happens ONLY when no file exists yet — booting twice must not overwrite what
// the lieutenant has since written into its own memory — but the key goes
// either way, so this converges on the first boot and is a no-op on the second.
(function migrateCharters() {
  let moved = false;
  for (const lt of board.lieutenants) {
    if (!('charter' in lt)) continue;
    const text = String(lt.charter || '').trim();
    if (text && !fs.existsSync(charterPath(WORKSPACE, lt.id))) {
      // A workspace that cannot take the write keeps its key for the next boot
      // to retry: one stale field must never be what stops the board booting.
      try { writeCharter(WORKSPACE, lt.id, text); }
      catch (e) {
        console.error('charter migration failed for ' + lt.id + ': ' + String((e && e.message) || e));
        continue;
      }
    }
    delete lt.charter;
    moved = true;
  }
  if (moved) saveBoard();
})();

// ---------- events / kinds ----------
// A kind is an open token. The server ships structural defaults only for the
// kinds its OWN operations emit; a board may register its own kinds map
// (PUT /api/kinds) whose entries are merged OVER these built-ins. A kind in
// neither map is stored as-is (opaque token: no emoji, level falls back to 2).
const BUILTIN_KINDS = {
  created: { emoji: '🐣', level: 2 },
  moved: { emoji: '🔁', level: 2 },
  ordered: { emoji: '⏳', level: 2 },
  handoff: { emoji: '👀', level: 1 },
  landed: { emoji: '🏁', level: 1 },
  killed: { emoji: '🪦', level: 2 },
  resurrected: { emoji: '🧟', level: 1 },
  question: { emoji: '🙋', level: 1 },
  started: { emoji: '🚀', level: 2 },
  signal: { emoji: '📡', level: 2 },
  'worker-done': { emoji: '✅', level: 2 },
  'worker-died': { emoji: '💀', level: 2 },
  'hook-ran': { emoji: '🪝', level: 2 },
  'hook-failed': { emoji: '🧨', level: 1 },
  schedule: { emoji: '⏰', level: 2 },
  // What the packaged gh-watch hook puts on a card when a check goes red. A
  // kind is an open token, but the one hook this board ships with earns an
  // emoji: an unlabelled row on the timeline is the thing nobody reads.
  'ci-failed': { emoji: '🔴', level: 1 },
  'schedule-failed': { emoji: '🔔', level: 1 },
  'worker-stopped': { emoji: '⏸️', level: 2 },
  'worker-stalled': { emoji: '🐢', level: 1 },
  // A worker that would not die. The record is kept on purpose (a session
  // nothing points at is a leak), so this has to be loud enough that somebody
  // ends it: level 1, the captain's bell.
  'worker-kill-failed': { emoji: '🧟', level: 1 },
  // A start that could not put the worker on the tip it just fetched. It still
  // started — that is exactly why this is level 1: the work is running, on a
  // base nobody chose.
  'stale-base': { emoji: '🧊', level: 1 },
  'worker-paused': { emoji: '💤', level: 2 },
  parked: { emoji: '🅿️', level: 2 },
  respawned: { emoji: '♻️', level: 1 },
  'needs-captain': { emoji: '🚨', level: 1 },
  line: { emoji: '📞', level: 2 },
};
function validKindEntry(v) {
  return !!(v && typeof v === 'object' && typeof v.emoji === 'string' && v.emoji.trim() &&
    (v.level === 1 || v.level === 2));
}
// Defensive normalization for the persisted registered map (hand edits included).
function sanitizeKinds(doc) {
  const out = {};
  if (doc && typeof doc === 'object' && !Array.isArray(doc)) {
    for (const [k, v] of Object.entries(doc)) {
      if (k.trim() && validKindEntry(v)) out[k.trim().slice(0, 60)] = { emoji: v.emoji.trim(), level: v.level };
    }
  }
  return out;
}
function effectiveKinds() { return Object.assign({}, BUILTIN_KINDS, board.kinds); }
// Level resolution: explicit level wins; else the kind's level from the
// effective map (registered over built-ins); else the caller's default; else 2.
function mkEvent(body, defaults) {
  const kindRaw = body.kind == null ? '' : String(body.kind).trim();
  const kind = kindRaw ? kindRaw.slice(0, 60) : (defaults.kind || null);
  const known = kind ? effectiveKinds()[kind] : null;
  const level = body.level === 2 ? 2 : body.level === 1 ? 1
    : known ? known.level
    : (defaults.level === 1 || defaults.level === 2 ? defaults.level : 2);
  const ev = {
    seq: ++board.seq, ts: now(), level,
    text: String(body.text || '').slice(0, 2000),
    actor: String(body.actor || defaults.actor || 'agent').slice(0, 60),
  };
  if (kind) ev.kind = kind;
  return ev;
}

// ---------- label registry (user-owned; persisted in board json) ----------
const LABEL_PALETTE = ['#4cc2ff', '#2fbf71', '#e2b93b', '#c678dd', '#e2795b', '#56b6c2', '#98c379', '#e06c75'];
function validColor(c) { return typeof c === 'string' && /^#[0-9a-fA-F]{6}$/.test(c) ? c : null; }
// lieutenant avatar: index into the 64-head sprite sheet (ui/img/avatars.png,
// 8x8, row-major). Absent = colored-dot fallback everywhere (every existing
// lieutenant has no avatar).
function validAvatar(a) { return Number.isInteger(a) && a >= 0 && a <= 63; }
// lieutenant voice: an opaque TTS-engine voice id, whatever the engine calls its
// own. Absent = the board's voice speaks for this lieutenant (the default).
function validVoice(v) { return typeof v === 'string' && v.trim() ? v.trim().slice(0, 200) : null; }
function labelIndex(name) { return board.labels.findIndex((l) => l && l.name === name); }
function registerCardLabels() {
  for (const c of board.cards) {
    for (const n of c.labels || []) {
      if (typeof n === 'string' && n && labelIndex(n) < 0) {
        board.labels.push({ name: n, color: LABEL_PALETTE[board.labels.length % LABEL_PALETTE.length] });
      }
    }
  }
}

// ---------- lieutenants ----------
const LT_PALETTE = ['#58b6ff', '#3ecf8e', '#e6c04a', '#c678dd', '#e2795b', '#56b6c2', '#98c379', '#e06c75'];
function findLieutenant(id) { return board.lieutenants.find((l) => l.id === id); }

// Is this lieutenant's session actually up? Three answers, and the difference
// between the last two is why the config screen shows it at all — a dead
// lieutenant is indistinguishable from a live one on the board:
//   none — never spawned, so there is no session to be up (no ref)
//   live — the harness says its session is there
//   dead — it had one and it is gone (superviseTick is what brings it back)
async function sessionState(lt) {
  if (!isHarnessRef(lt.ref)) return 'none';
  try { return (await harnessFor(lt.ref).alive(lt.ref)) ? 'live' : 'dead'; }
  catch (e) { return 'dead'; } // an unknown harness cannot answer for it either
}

// ---------- card-id minting (prefix + counter, both the LIEUTENANT's) ----------
// A card id is <PREFIX>-<n>: the prefix names the lieutenant that created it,
// the number is that lieutenant's own counter — incremented at creation, never
// reissued. Nothing new lands on the card; the id is still just the id, so the
// branch (bc/<id>), the worktree and the artifact paths follow it unchanged.
// Cards born before this keep their hand-written slugs. There is no migration:
// every verb takes an id, and a slug is an id.
function validPrefix(p) {
  const s = String(p == null ? '' : p).toUpperCase().replace(/[^A-Z0-9]/g, '');
  return /^[A-Z][A-Z0-9]{0,7}$/.test(s) ? s : null;
}
// Default from the display name: its first three letters. Accents fold, emoji
// and punctuation drop (the same "never let non-ASCII reach a name" rule as
// slugBase); a name with no letters at all falls back to LT.
function prefixFrom(name) {
  const letters = String(name || '').normalize('NFD').replace(/[^A-Za-z]/g, '');
  return letters ? letters.slice(0, 3).toUpperCase() : 'LT';
}
// A prefix belongs to one lieutenant at a time — two lieutenants sharing one
// would mint each other's ids and collide on every create. The default is
// nudged aside when taken (MON → MO2); an EXPLICIT prefix is refused instead,
// so the captain always learns his pick was unavailable.
function uniquePrefixIn(lts, base, exceptId) {
  const taken = (p) => lts.some((l) => l.id !== exceptId && l.prefix === p);
  if (!taken(base)) return base;
  for (let i = 2; ; i++) {
    const n = String(i);
    const cand = base.slice(0, Math.max(1, 3 - n.length)) + n;
    if (!taken(cand)) return cand;
  }
}
const BAD_PREFIX = 'bad prefix (1-8 letters/digits starting with a letter — it heads every card id this lieutenant mints)';
function prefixOwner(p, exceptId) {
  return board.lieutenants.find((l) => l.id !== exceptId && l.prefix === p) || null;
}
function prefixTakenMsg(p, owner) {
  return 'prefix ' + p + ' already belongs to ' + owner.name + ' (' + owner.id + ') — pick another';
}
// Backfill on load: lieutenants registered before this feature get a prefix and
// a counter at zero. Their existing slug cards are not touched or counted —
// the counter numbers what this lieutenant mints from now on.
function ensureMinting(lts) {
  for (const lt of lts) {
    const p = validPrefix(lt.prefix);
    lt.prefix = p || uniquePrefixIn(lts, prefixFrom(lt.name), lt.id);
    if (!Number.isInteger(lt.cardSeq) || lt.cardSeq < 0) lt.cardSeq = 0;
  }
}

// ---------- the line (the captain's voice channel) ----------
// The captain talks to the board from his phone with the screen off, through a
// voice shortcut that has no chat picker: it posts `target: "line"` and names
// nobody. WHO that reaches is the SERVER's memory — the phone is not the only
// thing that talks to this board, so a client-side answer (localStorage and
// friends) would be a different answer per device.
//
// Two ways the line moves, and no third:
//   - it follows the conversation — whoever last spoke to the captain in a main
//     chat holds it, so nobody has to maintain it;
//   - `line.pass` hands it over deliberately, as a delivery to the receiver.
// A workspace that has never had a conversation still has to answer: the
// FOUNDING lieutenant (first registered — the teleport) holds it by default, so
// the shortcut works on day one with nothing seeded. Only a board with no
// lieutenant at all has nobody on the line.
function lineHolder() {
  const held = board.line ? findLieutenant(board.line) : null; // a retired holder falls back
  if (held) return { lieutenant: held, source: 'held' };
  const first = board.lieutenants[0];
  if (first) return { lieutenant: first, source: 'default' };
  return { lieutenant: null, source: 'none' };
}
// The line follows the voice the captain last heard. Silent no-op when it is
// already there, so an answering lieutenant never churns board state.
function lineFollow(id) {
  if (!id || board.line === id || !findLieutenant(id)) return false;
  board.line = id;
  return true;
}

function createLieutenant(body) {
  const name = String(body.name || '').trim();
  if (!name) return { error: 'name required' };
  const id = body.id ? String(body.id) : lieutenantIdFrom(name);
  if (!/^[\w][\w.-]*$/.test(id)) return { error: 'bad lieutenant id (use [A-Za-z0-9_.-])' };
  if (findLieutenant(id)) return { error: 'lieutenant exists: ' + id, code: 409 };
  if (body.avatar !== undefined && body.avatar !== null && !validAvatar(body.avatar)) {
    return { error: 'avatar must be an integer 0-63' };
  }
  let prefix;
  if (body.prefix === undefined || body.prefix === null || body.prefix === '') {
    prefix = uniquePrefixIn(board.lieutenants, prefixFrom(name), id);
  } else {
    prefix = validPrefix(body.prefix);
    if (!prefix) return { error: BAD_PREFIX };
    const clash = prefixOwner(prefix, id);
    if (clash) return { error: prefixTakenMsg(prefix, clash), code: 409 };
  }
  const color = validColor(body.color) || LT_PALETTE[board.lieutenants.length % LT_PALETTE.length];
  const lt = {
    id, name: name.slice(0, 60), color, prefix, cardSeq: 0,
    chat: [], created: now(),
  };
  if (validAvatar(body.avatar)) lt.avatar = body.avatar;
  if (validVoice(body.voice)) lt.voice = validVoice(body.voice);
  if (isHarnessRef(body.ref)) lt.ref = body.ref; // the live-session address, persisted with the board
  board.lieutenants.push(lt);
  const ev = mkEvent({ text: 'lieutenant ' + lt.name + ' joined the bridge', actor: body.actor || 'user', level: 2 }, {});
  board.events.push(ev);
  return { lieutenant: lt };
}

// lieutenant.create with spawn: birth a REAL session via the harness port in the
// workspace root, then register the lieutenant with the returned ref. Launch
// prompt = doctrine + charter + situating line. installHooks:false because the
// workspace-level Stop hook (installed by `bc-axi init`) already covers every
// claude in this cwd; the server dedupes its turn-end POSTs by session_id.
function doctrineText() {
  try { return fs.readFileSync(path.join(__dirname, '..', 'DOCTRINE.md'), 'utf8').trim(); }
  catch (e) { return ''; }
}
function lieutenantPrompt(name, id) {
  const cli = path.join(__dirname, '..', 'cli', 'bc-axi');
  const charter = readCharter(WORKSPACE, id);
  return [
    doctrineText(),
    '## Your charter\n\n' + (charter
      || 'Your memory file at ' + charterPath(WORKSPACE, id) + ' does not exist yet; write it.'),
    'You are lieutenant "' + name + '" (id: ' + id + ') in workspace ' + WORKSPACE + '.\n'
      + 'The board server runs at http://127.0.0.1:' + PORT + '/. The board CLI is `bc-axi`'
      + ' (at ' + cli + ' if not on your PATH).\n'
      + 'Your first act, now and at the start of every turn: run `bc-axi drain`. Ack what you handle.',
  ].filter(Boolean).join('\n\n');
}
// Relaunch prompt for a lieutenant whose dead session has no recoverable
// memory (harness.resumable said no): the same doctrine + charter launch
// prompt, plus a compact board digest — owned cards and pending queue count —
// so the fresh session reorients from truth instead of lost conversation.
function respawnPrompt(lt) {
  const owned = board.cards.filter((c) => c.owner === lt.id);
  const digest = owned.map((c) => '- ' + c.id + ' [' + c.column + '] ' + c.title).join('\n');
  return lieutenantPrompt(lt.name, lt.id) + '\n\n'
    + '## Respawned without memory\n\n'
    + 'Your previous session is gone; the board is truth — reorient from it.\n'
    + 'Your cards (' + owned.length + '):\n' + (digest || '(none)') + '\n'
    + 'Pending queue: ' + pendingItems(lt.id).length + ' item(s). Your first act: `bc-axi drain`.';
}

async function spawnLieutenant(body) {
  const name = String(body.name || '').trim();
  if (!name) return { error: 'name required' };
  const id = body.id ? String(body.id) : lieutenantIdFrom(name);
  if (!/^[\w][\w.-]*$/.test(id)) return { error: 'bad lieutenant id (use [A-Za-z0-9_.-])' };
  // revive:true is what makes `bc-axi init --onboard` re-runnable: the founding
  // lieutenant already exists, and the question is only whether her session is
  // still up. A live one is left strictly alone (spawning over a live session
  // is how you lose a conversation); a dead or never-spawned one gets a new
  // session on the same record, charter and chat history included.
  const existing = findLieutenant(id);
  if (existing && !body.revive) return { error: 'lieutenant exists: ' + id, code: 409 };
  if (existing && (await sessionState(existing)) === 'live') {
    return { lieutenant: existing, spawned: false };
  }
  const harnessName = String(body.harness || readConfig().harness || 'claude');
  let impl;
  try { impl = getHarness(harnessName); } catch (e) { return { error: String(e.message || e) }; }
  const session = names.lieutenantSession(WORKSPACE, id);
  let ref;
  try {
    ref = await impl.spawn(WORKSPACE, lieutenantPrompt(name, id), {
      session,
      window: names.LIEUTENANT_WINDOW, // its own window in its own session — see names.js
      stateDir: HARNESS_STATE_DIR,
      callbackUrl: TURNEND_URL,
      installHooks: false,
      // Only the first run sends this, and only when the person said so out
      // loud: the harness decides what it means (for claude, IS_SANDBOX=1).
      allowRoot: !!body.allowRoot,
    });
  } catch (e) {
    return { error: 'spawn failed: ' + String((e && e.message) || e), code: 502 };
  }
  if (existing) {
    existing.ref = ref;
    return { lieutenant: existing, spawned: true };
  }
  return Object.assign({ spawned: true }, createLieutenant(Object.assign({}, body, { id, ref })));
}

// lieutenant.retire — explicit only (the DNA). Refuses while the lieutenant
// still owns non-archived cards (archive or finish them first); otherwise
// kills its live session via the harness port, removes the lieutenant (ref
// included) and its delivery queue, and lands a loud level-1 event.
async function retireLieutenant(id, body) {
  const lt = findLieutenant(id);
  if (!lt) return { error: 'unknown lieutenant: ' + id, code: 404 };
  const owned = board.cards.filter((c) => c.owner === id);
  if (owned.length) {
    return { error: 'lieutenant ' + id + ' still owns ' + owned.length + ' card(s): '
      + owned.map((c) => c.id).join(', ') + ' — archive or finish them first', code: 409 };
  }
  if (isHarnessRef(lt.ref)) {
    try { await harnessFor(lt.ref).kill(lt.ref); }
    catch (e) { console.error(now() + ' kill failed retiring ' + id + ': ' + String((e && e.message) || e)); }
  }
  board.lieutenants = board.lieutenants.filter((l) => l.id !== id);
  if (board.line === id) board.line = null; // the line falls back rather than pointing at a ghost
  respawnAttempts.delete(id);
  nudged.delete(id);
  // A retired lieutenant can never drain again: its queue files go too.
  try { fs.unlinkSync(queueFile(id)); } catch (e) { /* none */ }
  try { fs.unlinkSync(ackFile(id)); } catch (e) { /* none */ }
  try { fs.unlinkSync(drainedFile(id)); } catch (e) { /* none */ }
  // …and so does its conversation, which used to leave with the record itself:
  // a conversation belongs to the instance that had it. The memory file does
  // NOT leave — lieutenants/<id>/ belongs to the ROLE, hand-written by the
  // captain and versioned in git — so retire names the path it leaves behind
  // rather than deleting it, and a same-slug successor inherits it knowingly.
  try { fs.unlinkSync(chatFile(id)); } catch (e) { /* none */ }
  const memory = fs.existsSync(charterPath(WORKSPACE, id)) ? charterPath(WORKSPACE, id) : null;
  const ev = mkEvent({ text: 'lieutenant ' + lt.name + ' retired',
    actor: (body && body.actor) || 'user', level: 1 }, {});
  board.events.push(ev);
  return { ok: true, event: ev, memory };
}

// ---------- delivery queues (per-lieutenant durable jsonl, GLOBAL seq) ----------
// One QueueItem = one durable delivery to a lieutenant: captain message,
// drag-order, or (future) worker event. At-least-once: drain serves everything
// past the lieutenant's committed ack cursor and never advances it; only
// POST /api/feed/ack does. Unacked items re-offer forever (dedupe by seq).
// A second, delivery-neutral cursor rides alongside: <lt>.drained, the high-water
// seq a drain has SERVED this lieutenant — it feeds the UI's seen/unseen split
// and nothing else.
// The durable queue is the write-ahead ground truth; the wake half (one
// coalesced harness.send per append burst) rides behind it, below.
function queueFile(lt) { return path.join(QUEUE_DIR, lt + '.jsonl'); }
function ackFile(lt) { return path.join(QUEUE_DIR, lt + '.ack'); }
function drainedFile(lt) { return path.join(QUEUE_DIR, lt + '.drained'); }
function readQueue(lt) {
  try {
    return fs.readFileSync(queueFile(lt), 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l));
  } catch (e) { return []; }
}
function queueIds() {
  const ids = new Set(board.lieutenants.map((l) => l.id));
  try {
    for (const f of fs.readdirSync(QUEUE_DIR)) if (f.endsWith('.jsonl')) ids.add(f.slice(0, -6));
  } catch (e) {}
  return [...ids];
}
// The queue seq is global across every lieutenant's queue (QueueItems are
// seq-ordered board-wide). Recovered from the files at boot.
let qseq = 0;
for (const lt of queueIds()) for (const it of readQueue(lt)) if (it.seq > qseq) qseq = it.seq;
function readAck(lt) {
  try { return parseInt(fs.readFileSync(ackFile(lt), 'utf8'), 10) || 0; }
  catch (e) { return 0; }
}
// The drained cursor is a durable high-water mark of the highest seq ever SERVED
// to this lieutenant by a drain. It never gates delivery (only the ack cursor
// does — unacked items re-offer forever); it exists purely so the UI can tell
// "sitting unread in the queue" from "drained and being worked on": drain marks
// the turn START, ack marks the turn END, and without this file the whole
// drain→ack working window would still read as queued/unseen.
function readDrained(lt) {
  try { return parseInt(fs.readFileSync(drainedFile(lt), 'utf8'), 10) || 0; }
  catch (e) { return 0; }
}
function advanceDrained(lt, seq) {
  if (seq <= readDrained(lt)) return false;
  fs.writeFileSync(drainedFile(lt), String(seq));
  return true;
}
// The seen boundary: a seq at or below it has been drained OR acked. Acked
// implies seen even when the drained file lags (an ack written with no drain
// on record — e.g. cursors that predate the drained file).
function seenCursor(lt) { return Math.max(readDrained(lt), readAck(lt)); }
function queuePush(lt, rec) {
  const item = Object.assign({ seq: ++qseq, ts: now(), lieutenant: lt }, rec);
  fs.appendFileSync(queueFile(lt), JSON.stringify(item) + '\n');
  scheduleWake(lt); // the queue write landed first (write-ahead); now the wake half
  return item;
}
function pendingItems(lt) {
  const ack = readAck(lt);
  return readQueue(lt).filter((it) => it.seq > ack);
}
function drainItems(lt) {
  const lts = lt ? [lt] : queueIds();
  const out = [];
  for (const id of lts) out.push(...pendingItems(id));
  out.sort((a, b) => a.seq - b.seq);
  return out;
}
// ack <seq>: commit the cursor of the lieutenant whose queue holds that seq.
// Committing seq N acks every item <= N in that lieutenant's queue (items are
// seq-ascending per queue). Acking an already-acked seq is a harmless no-op.
// When ownerId is set (a session-identified caller), the seq MUST live in that
// lieutenant's own queue — refuse otherwise, so one lieutenant can never commit
// (and thereby silently discard) another lieutenant's pending items.
function commitAck(seq, ownerId) {
  for (const lt of queueIds()) {
    const items = readQueue(lt);
    if (!items.some((it) => it.seq === seq)) continue;
    if (ownerId && lt !== ownerId) {
      return { error: 'seq ' + seq + ' is not in your queue (belongs to ' + lt + ')', code: 409 };
    }
    const cur = readAck(lt);
    if (seq > cur) fs.writeFileSync(ackFile(lt), String(seq));
    return { ok: true, lieutenant: lt, ack: Math.max(cur, seq) };
  }
  return { error: 'unknown seq: ' + seq, code: 400 };
}

// ---------- lieutenant main chat (append-only files; the FILE is truth) ----------
// One jsonl per lieutenant, written exactly the way archive.jsonl and the
// delivery queues are: one message per line, appended, never rewritten. A
// message is durable the moment the line lands — a crash before the next
// saveBoard() loses nothing, because the board stores no chat at all.
// The server keeps the newest CHAT_TAIL per lieutenant in memory (lt.chat, read
// from the file at boot) and that is what GET /api/board ships; everything
// older is paged in over GET /api/chat. No index, no compaction: reading the
// whole file is a boot/paging cost, and the hot path (append) never reads it.
// Card threads are NOT here — they die with their card, so board.json is still
// the right home for them.
const CHAT_TAIL = 50;
function chatFile(lt) { return path.join(CHAT_DIR, lt + '.jsonl'); }
// A crash mid-append can leave one torn line behind. That line is skipped and
// the rest of the conversation is served — the file is never rewritten to
// repair it, because append-only means append-only.
function readChatLog(lt) {
  let raw;
  try { raw = fs.readFileSync(chatFile(lt), 'utf8'); } catch (e) { return []; }
  const out = [];
  for (const l of raw.split('\n')) {
    if (!l) continue;
    try { out.push(JSON.parse(l)); } catch (e) {}
  }
  return out;
}
// The one writer. Appends the line, then extends the in-memory tail — so the
// served board reflects the message without re-reading the file.
function chatAppend(ltId, msg) {
  fs.appendFileSync(chatFile(ltId), JSON.stringify(msg) + '\n');
  const lt = findLieutenant(ltId);
  if (lt) {
    if (!Array.isArray(lt.chat)) lt.chat = [];
    lt.chat.push(msg);
    if (lt.chat.length > CHAT_TAIL) lt.chat.splice(0, lt.chat.length - CHAT_TAIL);
  }
  return msg;
}
// A page of history, oldest-last (the order the pane renders). `before` is the
// ts of the oldest message the caller already has — strictly older messages are
// returned, so paging walks backwards; past the beginning the page is empty.
// limit <= 0 means the whole conversation (what `bc-axi thread` asks for).
function chatPage(ltId, before, limit) {
  let all = readChatLog(ltId);
  if (before) all = all.filter((m) => m && m.ts && m.ts < before);
  return limit > 0 ? all.slice(-limit) : all;
}
function chatTail(ltId, n) { return chatPage(ltId, '', n); }
// Boot migration, once: a lieutenant that still carries `chat` in board.json
// gets it appended to its file in order, and the key is dropped by the save
// (storedBoard strips it). The second boot reads a board with no chat key at
// all, so it appends nothing — normalizeBoard leaves an empty array behind.
{
  let migrated = 0, carried = false;
  for (const lt of board.lieutenants) {
    const stored = Array.isArray(lt.chat) ? lt.chat : [];
    if (stored.length) carried = true;
    // The file's existence IS the "already migrated" mark, and it appears whole
    // (write + rename) or not at all — so a crash anywhere in here can never
    // double his history on the next boot, and never truncate it either.
    if (stored.length && !fs.existsSync(chatFile(lt.id))) {
      const tmp = chatFile(lt.id) + '.tmp';
      fs.writeFileSync(tmp, stored.map((m) => JSON.stringify(m) + '\n').join(''));
      fs.renameSync(tmp, chatFile(lt.id));
      migrated += stored.length;
    }
    lt.chat = chatTail(lt.id, CHAT_TAIL);
  }
  if (migrated) console.log('[bridge-commander] moved ' + migrated + ' lieutenant chat message(s) out of board.json');
  if (carried) saveBoard(); // drops the key even when the file was already there
}

// ---------- wakes (the send half of delivery; the queue is truth) ----------
// Every queue append for a lieutenant with a live ref sends ONE compact wake
// line via harness.send. Coalesced: while items are pending-and-nudged, further
// appends do not stack identical wakes; a drain (or ack) clears the flag, so a
// new append after a drain nudges again. Wake failures are non-fatal — the
// durable queue is the ground truth and the turn-end backstop re-nudges — but
// they clear the flag so a later append can retry, and they are logged.
// The flag is in-memory by design: after a server restart the next append or
// turn-end simply re-nudges (at-least-once delivery tolerates a spare wake).
// Each entry carries the send timestamp: a nudge older than WAKE_TTL_MS no
// longer suppresses the next wake, because "sent" is not "delivered" — tmux
// send-keys can land in a busy pane and never become a turn. The supervision
// sweep re-runs scheduleWake for live lieutenants with pending items, so a
// lapsed nudge self-heals within one tick instead of hanging forever.
const WAKE_TTL_MS = process.env.BC_WAKE_TTL_MS !== undefined
  ? parseInt(process.env.BC_WAKE_TTL_MS, 10) : 90000;
const nudged = new Map(); // lieutenant id -> epoch-ms of the last wake sent since its last drain
function wakeLine(n) { return '[bridge-commander] ' + n + ' pending item(s) — run: bc-axi drain'; }
function scheduleWake(ltId) {
  const lt = findLieutenant(ltId);
  if (!lt || !isHarnessRef(lt.ref)) return;
  const n = pendingItems(ltId).length;
  if (!n) return;
  const ts = nudged.get(ltId);
  if (ts !== undefined && Date.now() - ts <= WAKE_TTL_MS) return;
  nudged.set(ltId, Date.now());
  Promise.resolve()
    .then(() => harnessFor(lt.ref).send(lt.ref, wakeLine(n)))
    .catch((e) => {
      nudged.delete(ltId);
      console.error(now() + ' wake failed for ' + ltId + ' (' + lt.ref.harness + ':' + lt.ref.session + '): '
        + String((e && e.message) || e));
    });
}

// ---------- card status (the ONE work signal; derived on read) ----------
// card.status.worker is the only writable signal, set exclusively by status.set
// (POST /api/cards/:id/status) as a lease with expiry: the persisted record is
// {id, state, expires}; when the lease expires, working/needs-you decays to
// idle AT READ TIME (no timers, so decay survives a restart). No worker → absent.
// `owed` and `unread` are server-derived from persisted thread/event/read state,
// so they too survive restarts; nobody writes them.
function derivedWorker(card) {
  const w = card.status && card.status.worker;
  if (!w || !w.id) return { id: null, state: 'absent' };
  let state = w.state;
  if ((state === 'working' || state === 'needs-you') && w.expires && Date.parse(w.expires) <= Date.now()) state = 'idle';
  return { id: w.id, state, expires: w.expires };
}
function lastThreadReadMs(target, user) {
  const r = board.reads[String(user || 'user').slice(0, 60)];
  const ts = r && r.threads && r.threads[target];
  return ts ? Date.parse(ts) : 0;
}
// owed is QUEUE truth, not thread order: the latest captain message delivered
// to this target has not been ACKED (consumed) by its lieutenant. Thread order
// lies under interleaving — a captain message sent mid-turn gets buried when
// the lieutenant replies to an EARLIER batch, and "last thread message is the
// captain's" would read not-owed while the message sits genuinely unhandled.
// Only the ack clears owed; a reply alone does not (in the normal reply-then-ack
// turn the two coincide, so the simple case still clears promptly).
// owed splits into a tri-state, because "unanswered" hides two very different
// situations: the captain's message may still sit UNDRAINED in the owner's queue
// (the lieutenant never saw it), or the lieutenant drained it — its turn started —
// and simply hasn't replied yet. The boundary is the drained cursor, NOT the ack
// cursor: a lieutenant drains at the START of a turn and acks at the END, so
// keying off ack would leave the whole working phase reading as queued/unseen.
// owedState says which side of the drain the latest captain message is on:
//   'queued' = owed AND its delivery seq is past the seen cursor (unseen)
//   'seen'   = owed and drained (turn underway; the reply is owed for real)
//   null     = not owed
// `msgSeqs` is the precomputed target -> latest-message-delivery map (one queue
// scan per serialization); absent, it is derived on the spot.
function latestMessageSeqs() {
  const map = new Map(); // target -> {seq, lt} of the latest kind:'message' delivery
  for (const lt of queueIds()) {
    for (const it of readQueue(lt)) {
      if (it.kind !== 'message' || !it.target) continue;
      const cur = map.get(it.target);
      if (!cur || it.seq > cur.seq) map.set(it.target, { seq: it.seq, lt });
    }
  }
  return map;
}
// Queued = the latest captain message delivered to this target has not crossed
// its lieutenant's seen cursor. No delivery on record → not queued (a thread
// message that never became a QueueItem has nothing to sit unseen in).
function targetQueued(target, msgSeqs) {
  const m = msgSeqs.get(target);
  return !!(m && m.seq > seenCursor(m.lt));
}
// Owed = the latest captain message delivered to this target is still unacked
// (not yet consumed). No delivery on record → not owed.
function targetOwed(target, msgSeqs) {
  const m = msgSeqs.get(target);
  return !!(m && m.seq > readAck(m.lt));
}
function cardStatus(card, user, msgSeqs) {
  const thread = card.thread || [];
  const msgs = msgSeqs || latestMessageSeqs();
  const owed = targetOwed('card:' + card.id, msgs);
  let owedState = null;
  if (owed) {
    owedState = targetQueued('card:' + card.id, msgs) ? 'queued' : 'seen';
  }
  const readMs = lastThreadReadMs('card:' + card.id, user);
  let unread = false;
  for (const m of thread) if (m.author !== 'user' && Date.parse(m.ts) > readMs) { unread = true; break; }
  if (!unread) for (const e of card.events || []) if (e.level === 1 && Date.parse(e.ts) > readMs) { unread = true; break; }
  return { worker: derivedWorker(card), owed, owedState, unread };
}
// Last REAL activity on a card, derived (never persisted). A card's mutable
// `updated` is bumped by incidental/system writes too — a status-lease refresh or
// decay (status.set) and any attribute patch — so it reads "now" for cards nothing
// meaningful happened to. Real activity always lands as an event or a thread
// message, so the max of those timestamps (floored at `created`) reflects genuine
// activity and ignores the bookkeeping writes. The UI shows and sorts on this.
function cardActivity(card) {
  let ts = card.created || card.updated || '';
  for (const e of card.events || []) if (e.ts && e.ts > ts) ts = e.ts;
  for (const m of card.thread || []) if (m.ts && m.ts > ts) ts = m.ts;
  return ts;
}
// Serialization view: cards go out with the derived `status` and `activity`
// attached; the stored board keeps only the raw lease.
function publicCard(card, user, msgSeqs) {
  return Object.assign({}, card, { status: cardStatus(card, user, msgSeqs), activity: cardActivity(card) });
}
// The served board carries the EFFECTIVE kinds map (built-ins merged under the
// registered entries); the stored board keeps only the registered map.
// `boot` identifies this server instance: a client seeing it change knows the
// server restarted and any SSE events in between are gone — refetch, don't trust
// the old stream.
const BOOT_ID = process.pid + '-' + Date.now();
function publicBoard(user) {
  const msgSeqs = latestMessageSeqs(); // one queue scan for the whole payload
  const holder = lineHolder().lieutenant;
  return Object.assign({}, board, {
    boot: BOOT_ID,
    kinds: effectiveKinds(),
    // The RESOLVED holder, never the raw stored id: a board that never had a
    // conversation still names whoever a `target: "line"` post would reach.
    line: holder ? holder.id : null,
    cards: board.cards.map((c) => publicCard(c, user, msgSeqs)),
    workers: board.workers.map(withStatusAge),
    // chatOwed/chatQueued mirror status.owed/owedState:'queued' for a
    // lieutenant's MAIN chat — both queue-derived, same rules as cards.
    lieutenants: board.lieutenants.map((l) => Object.assign({}, withStatusAge(l), {
      chatOwed: targetOwed('lieutenant:' + l.id, msgSeqs),
      chatQueued: targetQueued('lieutenant:' + l.id, msgSeqs),
    })),
  });
}

// status.set — the ONLY writer of card.status.worker.
function setStatus(card, body) {
  if (!body || !('worker' in body)) return { error: 'worker required: {id, state} (or null / state "absent" to clear)' };
  const w = body.worker;
  if (w === null || (w && typeof w === 'object' && w.state === 'absent')) {
    card.status = { worker: null };
  } else {
    if (!w || typeof w !== 'object') return { error: 'worker must be {id, state} or null' };
    if (!WORKER_STATES.includes(w.state)) return { error: 'bad worker.state (use ' + WORKER_STATES.join('|') + ')' };
    const id = String(w.id || '').trim();
    if (!id) return { error: 'worker.id required for state ' + w.state };
    let ttl = WORKER_TTL_SECS;
    if (body.ttl !== undefined) {
      ttl = Number(body.ttl);
      if (!Number.isFinite(ttl) || ttl <= 0) return { error: 'bad ttl (seconds > 0)' };
    }
    card.status = { worker: { id: id.slice(0, 120), state: w.state, expires: new Date(Date.now() + ttl * 1000).toISOString() } };
  }
  card.updated = now();
  return { ok: true };
}

// ---------- SSE clients ----------
const sseClients = new Set();
function sseSend(event, data) {
  const payload = 'event: ' + event + '\ndata: ' + JSON.stringify(data) + '\n\n';
  for (const res of sseClients) res.write(payload);
}
function broadcast() { sseSend('board', publicBoard('user')); }
// A file an editor may have open changed on disk (through PUT /api/artifact —
// the one door). Tiny event on the SAME stream, not a channel of its own: which
// uri, which version now, and `by` = the writer's own client tag (a random
// per-page string the browser sends, absent for a CLI write) so the tab that
// just saved recognizes its echo instead of flashing at itself. The screen
// fetches the content itself if it cares.
function broadcastArtifact(uri, version, by) { sseSend('artifact', { uri, version, by: by || '' }); }

// ---------- pane hub (👁 peek: live pane frames over a per-target SSE) ----------
// The harness port's OPTIONAL openPane capability, ref-counted per pane key:
// the FIRST subscriber for a key opens ONE harness pane feed, every frame fans
// out to that key's SSE clients, and the LAST disconnect closes the feed. A
// dedicated per-target stream, never /api/events — per-card frames must not
// spam every board client. The server owns ref resolution (card → its worker's
// ref, lieutenant → its ref); the harness owns how a pane is actually watched.
// Guards are clean SSE events then close (never a 500, never a hang):
//   unsupported — the ref's harness exposes no openPane
//   no-pane     — nothing to watch (unknown target, card not Working, no worker,
//                 no live session, or the open itself failed)
//   busy        — the concurrent-pane cap (bounds child-process load) is hit
const PANE_MAX = parseInt(process.env.BC_PANE_MAX, 10) > 0 ? parseInt(process.env.BC_PANE_MAX, 10) : 8;
// resolvePaneRef(kind, id) -> { ref, reason } — which harness ref does a pane
// target address? Shared by BOTH pane routes (the read stream and the write
// input) so they can never disagree about what `/api/cards/x/pane/*` means.
// ref null + a human reason is the "nothing to watch / nothing to type into"
// answer; each route renders it in its own dialect (SSE event vs 404).
// paneWindows(card) -> the windows a card offers, in order, first is default.
// `pane` is one name or a list of them; anything malformed is simply not
// offered. A worker that opens sibling windows (an orchestrator running its
// agents beside itself) is otherwise unwatchable — the board shows the window
// it bound at `card.start`, which sits silent while the work happens one window
// over.
//
// Only WINDOW names live here, never sessions: the pane always rides the
// worker's own session, so this can never address a session the card does not
// already own. The charset excludes `:` deliberately — the value becomes a
// `session:window` tmux target and a colon would retarget another session.
const PANE_WINDOW = /^[A-Za-z0-9_.-]{1,80}$/;
function paneWindows(card) {
  const v = card && card.attributes && card.attributes.pane;
  const list = Array.isArray(v) ? v : (typeof v === 'string' ? v.split(',') : []);
  const out = [];
  for (const w of list) {
    const name = String(w).trim();
    if (PANE_WINDOW.test(name) && !out.includes(name)) out.push(name);
  }
  return out;
}
function resolvePaneRef(kind, id, want) {
  if (kind === 'cards') {
    const card = findCard(id);
    const w = card && findWorker(card.id);
    if (!card) return { ref: null, reason: 'unknown card: ' + id };
    if (card.column !== 'working') return { ref: null, reason: 'card is not Working' };
    if (!w) return { ref: null, reason: 'no worker bound to ' + id };
    // `want` is the caller asking for one of the offered windows by name —
    // honoured only if the CARD listed it, so a request can never name a window
    // of its own. Unlisted or absent falls back to the card's first offer, then
    // to the worker's own window.
    const offered = paneWindows(card);
    const win = want && offered.includes(want) ? want : offered[0];
    if (win) return { ref: Object.assign({}, w.ref, { window: win }), reason: '' };
    return { ref: w.ref, reason: '' };
  }
  const lt = findLieutenant(id);
  if (!lt) return { ref: null, reason: 'unknown lieutenant: ' + id };
  if (!isHarnessRef(lt.ref)) return { ref: null, reason: 'lieutenant has no live session' };
  return { ref: lt.ref, reason: '' };
}
const panes = new Map(); // paneKey -> { clients: Set<res>, handle, last }
function paneKey(ref) { return ref.harness + '/' + ref.session + (ref.window ? ':' + ref.window : ''); }
function paneWrite(res, event, data) {
  res.write('event: ' + event + '\ndata: ' + JSON.stringify(data === undefined ? {} : data) + '\n\n');
}
function paneStream(req, res, ref, reason) {
  res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', Connection: 'keep-alive' });
  if (!ref) { paneWrite(res, 'no-pane', { reason }); return res.end(); }
  let impl;
  try { impl = harnessFor(ref); }
  catch (e) { paneWrite(res, 'no-pane', { reason: String((e && e.message) || e) }); return res.end(); }
  if (typeof impl.openPane !== 'function') {
    paneWrite(res, 'unsupported', { harness: ref.harness });
    return res.end();
  }
  const key = paneKey(ref);
  let hub = panes.get(key);
  if (!hub) {
    if (panes.size >= PANE_MAX) { paneWrite(res, 'busy', { max: PANE_MAX }); return res.end(); }
    hub = { clients: new Set(), handle: null, last: null };
    panes.set(key, hub);
    // openPane may be async (the port's verbs all may be); frames can only
    // start after it resolves, so subscribers added meanwhile just wait. If
    // everyone left before it resolved, close the freshly opened feed.
    Promise.resolve()
      .then(() => impl.openPane(ref, {
        onFrame: (frame) => {
          hub.last = String(frame);
          for (const c of hub.clients) paneWrite(c, 'frame', hub.last);
        },
      }))
      .then((handle) => {
        if (panes.get(key) === hub) { hub.handle = handle; return; }
        try { handle && typeof handle.close === 'function' && handle.close(); } catch (e) { /* already gone */ }
      })
      .catch((e) => {
        if (panes.get(key) !== hub) return;
        panes.delete(key);
        for (const c of hub.clients) {
          paneWrite(c, 'no-pane', { reason: 'open failed: ' + String((e && e.message) || e) });
          c.end();
        }
      });
  }
  hub.clients.add(res);
  // Immediate paint: late joiners get the hub's last frame; the first
  // subscriber gets a one-shot snapshot when the harness offers one and the
  // live feed hasn't delivered yet (a real frame arriving first wins).
  if (hub.last != null) paneWrite(res, 'frame', hub.last);
  else if (typeof impl.paneSnapshot === 'function') {
    Promise.resolve()
      .then(() => impl.paneSnapshot(ref))
      .then((snap) => {
        if (hub.last == null && hub.clients.has(res) && typeof snap === 'string') paneWrite(res, 'frame', snap);
      })
      .catch(() => { /* the interval frame will paint instead */ });
  }
  req.on('close', () => {
    hub.clients.delete(res);
    if (hub.clients.size) return;
    panes.delete(key); // last subscriber gone: release the harness feed
    try { hub.handle && typeof hub.handle.close === 'function' && hub.handle.close(); }
    catch (e) { /* closing a dead pane is a no-op */ }
  });
}

// ---------- sysload (⚙️ → monitoring: on-demand machine/agent load) ----------
// Zero cost when closed: the sampler loop (server/sysload.js) exists only
// while /api/sysload/stream has subscribers — first EventSource starts it,
// last disconnect stops it. Never rides the board push: samples are per-viewer
// telemetry, not board state. targets() re-reads the live registries every
// sample, so rows appear/disappear with workers and lieutenants.
const SYSLOAD_MS = parseInt(process.env.BC_SYSLOAD_MS, 10) > 0
  ? parseInt(process.env.BC_SYSLOAD_MS, 10) : 2000;
function sysloadTargets() {
  const out = [];
  for (const w of board.workers) {
    if (w.done || !isHarnessRef(w.ref)) continue;
    const card = findCard(w.card);
    out.push({ kind: 'worker', id: w.card, label: (card && card.title) || w.card,
      session: w.ref.session, window: w.ref.window || null });
  }
  for (const lt of board.lieutenants) {
    if (!isHarnessRef(lt.ref)) continue;
    out.push({ kind: 'lieutenant', id: lt.id, label: lt.name,
      session: lt.ref.session, window: lt.ref.window || null });
  }
  return out;
}
const sysload = createSampler({ workspace: WORKSPACE, targets: sysloadTargets, intervalMs: SYSLOAD_MS });

// Named ping (not an SSE comment): comments are invisible to EventSource, so
// the client's staleness watchdog couldn't see the stream is alive. Pane
// streams piggyback on the same ping so proxies don't drop them either.
setInterval(() => {
  for (const res of sseClients) res.write('event: ping\ndata: {}\n\n');
  for (const hub of panes.values()) for (const res of hub.clients) res.write('event: ping\ndata: {}\n\n');
}, 25000).unref();

// ---------- helpers ----------
// Byte serve shared by the raw artifact and attachment routes. Honors a single
// `Range: bytes=` header (206 + Content-Range) because iOS Safari refuses to
// play <video> from a server that answers Range requests with a plain 200;
// anything unparseable falls back to the full 200, unsatisfiable → 416.
function sendBytes(req, res, data, headers) {
  const m = /^bytes=(\d*)-(\d*)$/.exec(req.headers.range || '');
  const base = { ...headers, 'Accept-Ranges': 'bytes' };
  if (m && (m[1] || m[2])) {
    const start = m[1] ? parseInt(m[1], 10) : data.length - parseInt(m[2], 10);
    const end = m[1] && m[2] ? Math.min(parseInt(m[2], 10), data.length - 1) : data.length - 1;
    if (start < 0 || start > end || start >= data.length) {
      res.writeHead(416, { 'Content-Range': 'bytes */' + data.length });
      return res.end();
    }
    const chunk = data.subarray(start, end + 1);
    res.writeHead(206, { ...base, 'Content-Length': chunk.length, 'Content-Range': 'bytes ' + start + '-' + end + '/' + data.length });
    return res.end(chunk);
  }
  res.writeHead(200, { ...base, 'Content-Length': data.length });
  res.end(data);
}
// Content-derived version for a file the UI may edit: the GET hands it out,
// the PUT demands it back, and a mismatch is a 409 instead of a lost edit.
const sha256 = (buf) => crypto.createHash('sha256').update(buf).digest('hex');
function sendJson(res, code, obj) {
  const body = JSON.stringify(obj);
  res.writeHead(code, { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) });
  res.end(body);
}
function readBody(req) {
  return new Promise((resolve, reject) => {
    let data = '';
    req.on('data', (c) => { data += c; if (data.length > 8e6) { reject(new Error('body too large')); req.destroy(); } });
    req.on('end', () => resolve(data));
    req.on('error', reject);
  });
}
// Larger-capped body reader for the base64 upload transport: the 10 MB decoded
// cap becomes ~13.4 MB of base64 + JSON overhead, well past readBody's 8 MB
// guard. Rejects with .code 413 past the cap so the caller can answer correctly.
function readBodyUpto(req, max) {
  return new Promise((resolve, reject) => {
    let len = 0; const chunks = [];
    req.on('data', (c) => {
      len += c.length;
      if (len > max) { const e = new Error('body too large'); e.code = 413; reject(e); req.destroy(); return; }
      chunks.push(c);
    });
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}

// ---------- chat attachments (uploads) ----------
// Filename sanitization: keep a readable tail but strip anything that could
// escape the uploads dir or confuse a shell/browser — path separators, control
// chars, leading dots. The <id> prefix guarantees uniqueness, so a collapsed or
// empty name is harmless (falls back to "file").
function safeUploadName(name) {
  const base = String(name || '').split(/[\\/]/).pop() || '';
  const cleaned = base.replace(/[\x00-\x1f\x7f]/g, '').replace(/[^A-Za-z0-9._-]/g, '_')
    .replace(/^\.+/, '').slice(0, 120);
  return cleaned || 'file';
}
function newAttachmentId() {
  for (;;) {
    const id = crypto.randomBytes(8).toString('hex');
    if (!fs.existsSync(path.join(UPLOADS_DIR, id + '.json'))) return id;
  }
}
function attachmentSidecar(id) { return path.join(UPLOADS_DIR, id + '.json'); }
// Read the stored metadata for an id, or null. The id must be a bare token —
// path traversal (slashes, dots) can never reach the filesystem.
function readAttachmentMeta(id) {
  if (!/^[a-f0-9]{8,}$/.test(String(id || ''))) return null;
  try {
    const meta = JSON.parse(fs.readFileSync(attachmentSidecar(id), 'utf8'));
    if (!meta || typeof meta !== 'object' || meta.id !== id || typeof meta.stored !== 'string') return null;
    // The absolute on-disk path, resolved strictly within the uploads dir.
    const file = path.join(UPLOADS_DIR, meta.stored);
    if (path.dirname(path.resolve(file)) !== path.resolve(UPLOADS_DIR)) return null;
    meta.path = file;
    return meta;
  } catch (e) { return null; }
}
// Persist an uploaded file + sidecar; returns the public meta. `data` is the
// decoded Buffer (size already enforced by the caller).
function storeAttachment(name, mime, data) {
  const id = newAttachmentId();
  const safe = safeUploadName(name);
  const stored = id + '__' + safe;
  fs.writeFileSync(path.join(UPLOADS_DIR, stored), data);
  const meta = {
    id, name: safe, mime: String(mime || 'application/octet-stream').slice(0, 200),
    size: data.length, stored, created: now(),
  };
  fs.writeFileSync(attachmentSidecar(id), JSON.stringify(meta));
  return meta;
}
// Resolve a client-supplied attachment list to AUTHORITATIVE metas by id: the
// client only names ids, the server reads name/mime/size/path from its own
// sidecar so a message can never inject an arbitrary path or spoofed metadata.
// Unknown ids are dropped. The stored form carries the absolute `path` so the
// agent (drain/thread) and the UI (id → /api/attachments/:id) both resolve it.
function resolveAttachments(list) {
  if (!Array.isArray(list)) return [];
  const out = [];
  for (const a of list.slice(0, 20)) {
    const id = a && (typeof a === 'string' ? a : a.id);
    const meta = readAttachmentMeta(id);
    if (meta) out.push({ id: meta.id, name: meta.name, mime: meta.mime, size: meta.size, path: meta.path });
  }
  return out;
}
function findCard(id) { return board.cards.find((c) => c.id === id); }
// Chat targets: lieutenant:<id> (main chat) | card:<id> (card thread).
// What a target's thread READS as. A card thread is the stored array itself; a
// lieutenant's is the in-memory tail of its log — a view, never something to
// push() to. Everything that adds a message goes through appendMessage below.
function threadFor(target) {
  let m = /^lieutenant:(.+)$/.exec(target || '');
  if (m) {
    const lt = findLieutenant(m[1]);
    if (lt) return (lt.chat = lt.chat || []);
    return null;
  }
  m = /^card:(.+)$/.exec(target || '');
  if (m) {
    const card = findCard(m[1]);
    if (card) return (card.thread = card.thread || []);
  }
  return null;
}
// The one door a chat message goes in by: a lieutenant main chat appends to its
// own append-only log, a card thread pushes to the card. Returns the message,
// or null when the target does not exist.
function appendMessage(target, msg) {
  let m = /^lieutenant:(.+)$/.exec(target || '');
  if (m) {
    const lt = findLieutenant(m[1]);
    return lt ? chatAppend(lt.id, msg) : null;
  }
  m = /^card:(.+)$/.exec(target || '');
  if (m) {
    const card = findCard(m[1]);
    if (!card) return null;
    (card.thread = card.thread || []).push(msg);
    return msg;
  }
  return null;
}
// The lieutenant a target's deliveries route to: the lieutenant itself, or the
// card's owner (a card thread's interlocutor is always the owning lieutenant).
function targetLieutenant(target) {
  let m = /^lieutenant:(.+)$/.exec(target || '');
  if (m) return findLieutenant(m[1]);
  m = /^card:(.+)$/.exec(target || '');
  if (m) {
    const card = findCard(m[1]);
    if (card) return findLieutenant(card.owner);
  }
  return null;
}
// ---------- slash commands (the harness port's OPTIONAL commands/runCommand/status) ----------
// The session a chat target's slash commands (and /api/commands) address: a
// lieutenant target is the lieutenant's OWN session; a card target is the
// card's WORKER session (the card thread's slash surface talks to the worker,
// unlike say — whose interlocutor is the owning lieutenant).
// → { ref } | { ref: null, why } (valid target, no live session to address)
//   | { error, code } (bad/unknown target)
function commandTargetRef(target) {
  let m = /^lieutenant:(.+)$/.exec(target || '');
  if (m) {
    const lt = findLieutenant(m[1]);
    if (!lt) return { error: 'unknown target: ' + target, code: 404 };
    if (!isHarnessRef(lt.ref)) return { ref: null, why: 'lieutenant ' + lt.id + ' has no live session' };
    return { ref: lt.ref };
  }
  m = /^card:(.+)$/.exec(target || '');
  if (m) {
    const card = findCard(m[1]);
    if (!card) return { error: 'unknown target: ' + target, code: 404 };
    const w = findWorker(card.id);
    if (!w || !isHarnessRef(w.ref)) {
      return { ref: null, why: 'no worker on card ' + card.id + ' — slash commands address the worker session (card start ' + card.id + ' first)' };
    }
    return { ref: w.ref };
  }
  return { error: 'bad target (use lieutenant:<id> or card:<id>)', code: 400 };
}
function harnessCommands(ref) {
  let impl;
  try { impl = getHarness(ref.harness); } catch { return []; }
  return typeof impl.commands === 'function' ? impl.commands(ref) : [];
}

// Commands the BOARD answers, not the harness — because the harness does not
// know what a lieutenant is. /reset needs the charter and the board digest,
// which live here.
//
// Lieutenants only. A worker's session belongs to its card and to whatever
// started it; resetting one would hand it a lieutenant's doctrine and no idea
// what it was building.
const BOARD_COMMANDS = [
  { name: '/reset', description: 'start this lieutenant over: same identity, no memory of the conversation' },
];
function boardCommands(target) {  // MUTATION-TEST ME
  return /^lieutenant:/.test(target || '') ? BOARD_COMMANDS : [];
}

// /reset — kill the session and bring it back on the launch prompt: doctrine,
// its charter, and the digest of what it owns. Deliberately the SAME path
// supervision takes for a lieutenant whose memory could not be recovered, so
// there is one way a lieutenant comes back from nothing, not two.
//
// The conversation is gone and cannot be undone from here. It is not destroyed:
// the transcript stays on disk under ~/.claude/projects, so a human can still
// read it. The agent cannot.
async function resetLieutenant(id) {
  const lt = findLieutenant(id);
  if (!lt) return { error: 'unknown lieutenant: ' + id };
  if (!isHarnessRef(lt.ref)) return { error: 'lieutenant ' + id + ' has no session to reset' };
  let impl;
  try { impl = getHarness(lt.ref.harness); } catch (e) { return { error: String((e && e.message) || e) }; }
  const session = /^bc-[A-Za-z0-9_-]+$/.test(lt.ref.session)
    ? lt.ref.session : names.lieutenantSession(WORKSPACE, id);
  const window = lt.ref.window || names.LIEUTENANT_WINDOW;
  const opts = { stateDir: HARNESS_STATE_DIR, callbackUrl: TURNEND_URL, installHooks: false };
  try {
    await impl.kill({ ...lt.ref, window });
    lt.ref = await impl.spawn(lt.ref.cwd, respawnPrompt(lt), Object.assign({ session, window }, opts));
  } catch (e) {
    return { error: 'reset failed: ' + String((e && e.message) || e) };
  }
  respawnAttempts.delete(id);
  nudged.delete(id); // the new session owes a drain — the queue is truth, its memory was a cache
  board.events.push(mkEvent({
    text: 'lieutenant ' + lt.name + ' was reset by the captain — new session on the launch prompt',
    actor: 'user',
  }, { kind: 'reset', level: 1 }));
  saveBoard();
  broadcast();
  if (pendingItems(id).length) scheduleWake(id);
  return { ok: true, session: lt.ref.session };
}
// /reset kills a lieutenant's session and spawns it fresh on its launch prompt
// — a whole spawn, with a brief to deliver. Supervision has one rule about a
// lieutenant that is down: it died, so respawn it, which mid-reset means a
// second spawn racing this one for the same pane and a captain told his
// lieutenant crashed when he is the one who restarted it.
//
// pauseWorker sets w.paused before its own kill for exactly this reason ("the
// death must never look like a crash"); a lieutenant has no such field, so the
// mark lives here, wrapped around the call for the whole of it.
//
// Cleared in a `finally`, including when the reset throws: a marker left behind
// would silence supervision for that lieutenant permanently, which is a worse
// failure than the one this is preventing.
const cyclingLieutenants = new Set(); // ids being restarted by /reset right now
async function withCycleGuard(id, fn) {
  cyclingLieutenants.add(id);
  try {
    return await fn();
  } finally {
    cyclingLieutenants.delete(id);
  }
}

// A captain chat message starting with "/" routes HERE instead of becoming a
// say: the command runs against the target session's harness and both the
// command and its reply land in the thread — nothing rides the delivery queue
// (no wake, no owed). Unknown commands and missing sessions answer in-thread
// too (a composer conversation, not an HTTP failure).
async function runChatCommand(target, text) {
  // command messages carry `cmd` metadata the UI keys off for its console-style
  // rendering: the request (cmd.name only) and its reply (cmd.reply true). The
  // /status reply additionally carries the structured `status` payload so the UI
  // renders a real progress bar instead of regex-parsing the formatted prose.
  const stamp = (author, t, cmd, extra) => {
    const msg = Object.assign({ author, text: t, ts: now(), cmd }, extra || {});
    appendMessage(target, msg);
    const m = /^card:(.+)$/.exec(target);
    if (m) {
      const card = findCard(m[1]);
      if (card) { card.updated = now(); if (!card.threadStart) card.threadStart = msg.ts; }
    }
  };
  const name = text.split(/\s+/)[0];
  const reply = (author, t, extra) => stamp(author, t, { name, reply: true }, extra);
  stamp('user', text, { name });
  const r = commandTargetRef(target);
  if (r.error) return r; // unknown target — the normal 404, same as a say
  // Board commands are answered here, and BEFORE the live-session check: the
  // harness has no idea what a lieutenant is, and /reset is at its most useful
  // on one whose session has died — bringing it back is the whole point.
  if (boardCommands(target).some((c) => c.name === name)) {
    const id = /^lieutenant:(.+)$/.exec(target)[1];
    const out = await withCycleGuard(id, () => resetLieutenant(id));
    if (out.error) reply('bridge', '⚠ ' + name + ' — ' + out.error);
    else reply('bridge', 'reset — ' + id + ' is a new session on the launch prompt (doctrine, charter, and what it owns). The conversation before this one is gone.');
    return { ok: true, command: name };
  }
  if (!r.ref) {
    reply('bridge', '⚠ ' + name + ' — ' + r.why);
    return { ok: true, command: name };
  }
  const cmds = harnessCommands(r.ref).concat(boardCommands(target));
  if (!cmds.length) {
    reply('bridge', '⚠ ' + name + ' — the ' + r.ref.harness + ' harness has no slash commands');
    return { ok: true, command: name };
  }
  if (!cmds.some((c) => c && c.name === name)) {
    reply('bridge', '⚠ unknown command ' + name + ' — available: ' + cmds.map((c) => c.name).join(', '));
    return { ok: true, command: name };
  }
  try {
    // the FULL line goes to the harness — pass-through commands (/compact,
    // claude's /autocompact) may carry arguments; `name` only did the match
    const impl = getHarness(r.ref.harness);
    const result = await impl.runCommand(r.ref, text, { stateDir: HARNESS_STATE_DIR });
    // /status also fetches the structured status (a cheap transcript read) so the
    // reply carries both the formatted text (fallback) and the payload the UI
    // renders as model + context bar + rate lines — never parsing the prose.
    let extra;
    if (name === '/status' && typeof impl.status === 'function') {
      try { const st = await impl.status(r.ref, { stateDir: HARNESS_STATE_DIR }); if (st && typeof st === 'object') extra = { status: st }; } catch {}
    }
    reply(r.ref.harness, String(result == null ? name + ' done' : result), extra);
  } catch (e) {
    reply('bridge', '⚠ ' + name + ' failed: ' + String((e && e.message) || e));
  }
  return { ok: true, command: name };
}
// agentStatus — the port's OPTIONAL status() surfaced on the board payload
// (model, context used/window, rate limits) for lieutenants and workers.
// Refreshed at turn-end (the turn boundary the server already tracks — no
// polling loops). Best-effort: no capability, no session, unreadable files →
// the recorded status simply stays as it was. Returns true when it changed.
async function refreshAgentStatus(rec) {
  if (!rec || !isHarnessRef(rec.ref)) return false;
  let impl;
  try { impl = getHarness(rec.ref.harness); } catch { return false; }
  if (typeof impl.status !== 'function') return false;
  try {
    const st = await impl.status(rec.ref, { stateDir: HARNESS_STATE_DIR });
    if (!st || typeof st !== 'object') return false;
    rec.agentStatus = Object.assign({}, st, { ts: now() });
    return true;
  } catch {
    return false;
  }
}
// AGENT_STATUS_STALE_MS — how old a reading may be before the board stops
// presenting it as current. Status refreshes at turn-end and nowhere else, so
// a reading older than this means either the session has been quiet that long
// or its status read is failing (a rollout/transcript the harness can no
// longer resolve) — either way the numbers are a memory, not a measurement.
// Ten minutes: longer than any one turn, short enough that a frozen bar is
// marked within a single idle stretch.
const AGENT_STATUS_STALE_MS = 10 * 60 * 1000;
// Derived at serialization, never stored: the same untouched record reads
// fresh and later stale with no writer involved. The flag is all the server
// says — how (or whether) to show an old reading is the UI's call.
function withStatusAge(rec) {
  const st = rec && rec.agentStatus;
  const at = st && st.ts ? Date.parse(st.ts) : NaN;
  if (!Number.isFinite(at) || Date.now() - at <= AGENT_STATUS_STALE_MS) return rec;
  return Object.assign({}, rec, { agentStatus: Object.assign({}, st, { stale: true }) });
}
function columnTitle(id) {
  const c = board.columns.find((k) => k.id === id);
  return c ? c.title : id;
}
// ASCII slug: emoji, ZWJ sequences, and any other non-ASCII are stripped, so
// derived ids (and the session names built from them) never reach tmux.
function slugBase(s) {
  return String(s).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 40);
}
// Lieutenant id from a display name. A name with no ASCII at all (pure emoji)
// falls back to 'lt', made unique so a second such lieutenant can still be
// born; a real slug collision stays a 409 in createLieutenant (same-name
// duplicates are a caller mistake, not a naming gap).
function lieutenantIdFrom(name) {
  const base = slugBase(name);
  if (base) return base;
  if (!findLieutenant('lt')) return 'lt';
  for (let i = 2; ; i++) if (!findLieutenant('lt-' + i)) return 'lt-' + i;
}
function userReads(user) {
  const u = String(user || 'user').slice(0, 60);
  if (!board.reads[u]) board.reads[u] = { notifSeq: 0, notifSeqs: [], threads: {} };
  const r = board.reads[u];
  if (!Array.isArray(r.notifSeqs)) r.notifSeqs = [];
  if (!r.threads || typeof r.threads !== 'object') r.threads = {};
  return r;
}
// The unified stream: board-level events + every card's events, by seq.
function allEvents() {
  const out = [];
  for (const e of board.events) out.push(e);
  for (const c of board.cards) for (const e of c.events) out.push(Object.assign({ card: c.id, cardTitle: c.title }, e));
  out.sort((a, b) => a.seq - b.seq);
  return out;
}

// The bell: everything the captain hasn't seen yet. Level-1 events (read state:
// notifSeq/notifSeqs) UNION lieutenant-authored card-thread replies (read state:
// the same per-user thread read marker that derives a card's `unread`, so opening
// the card clears them). Lieutenant main-chat messages already ride their level-1
// event, so those threads are excluded here — no double count. Level-2 events
// never notify. Reply items are shaped like event items minus the seq
// (ts/text/actor/card/cardTitle/read) plus kind "reply" to tell them apart.
function notificationItems(user) {
  const r = userReads(user);
  const items = allEvents().filter((e) => e.level === 1)
    .map((e) => Object.assign({}, e, { read: e.seq <= r.notifSeq || r.notifSeqs.includes(e.seq) }));
  for (const c of board.cards) {
    const readMs = lastThreadReadMs('card:' + c.id, user);
    for (const m of c.thread || []) {
      if (m.author === 'user') continue;
      items.push({ ts: m.ts, level: 1, kind: 'reply', text: m.text, actor: m.author,
        card: c.id, cardTitle: c.title, read: Date.parse(m.ts) <= readMs });
    }
  }
  return items.sort((a, b) => (Date.parse(b.ts) - Date.parse(a.ts)) || ((b.seq || 0) - (a.seq || 0)));
}

// ---------- card mutations ----------
// A card's `playbook` is the id of a markdown file under playbooks/ — a
// pointer, never text. Validated where it is SET so a typo is caught at the
// keyboard rather than at card.start; '' clears it (and a card with none never
// starts).
function playbooksHint() {
  const ids = listPlaybooks(STATE_DIR);
  return ids.length ? ids.join(', ') : '(none — seed them with bc-axi init)';
}
function checkPlaybook(raw) {
  const id = String(raw || '').trim();
  if (!id) return { playbook: '' };
  if (!resolvePlaybook(STATE_DIR, id)) {
    return { error: 'unknown playbook: ' + id + ' — playbooks in ' + path.join(STATE_DIR, 'playbooks')
      + ': ' + playbooksHint() };
  }
  return { playbook: id };
}
function createCard(body, actorDefault) {
  const title = String(body.title || '').trim();
  if (!title) return { error: 'title required' };
  const owner = String(body.owner || '').trim();
  if (!owner) return { error: 'owner required (every card belongs to exactly one lieutenant)' };
  const lt = findLieutenant(owner);
  if (!lt) return { error: 'unknown lieutenant: ' + owner };
  const type = body.type ? String(body.type) : 'implementation';
  if (!CARD_TYPES.includes(type)) return { error: 'bad type (use ' + CARD_TYPES.join('|') + ')' };
  const pb = checkPlaybook(body.playbook);
  if (pb.error) return { error: pb.error };
  // No id given: the owner mints the next one from its own counter. The counter
  // advances only when the card is actually born (below).
  const minted = body.id ? 0 : (Number.isInteger(lt.cardSeq) ? lt.cardSeq : 0) + 1;
  const id = body.id ? String(body.id) : lt.prefix + '-' + minted;
  if (!/^[\w][\w.:-]*$/.test(id)) return { error: 'bad card id (use [A-Za-z0-9_.:-])' };
  // A duplicate is an error, not a case to engineer around: no suffix, no retry,
  // no silently picking the next free number. It can happen when a prefix outlives
  // the lieutenant that used it (retire, recreate, counter back at 1) — rare, and
  // the captain settles it with the lieutenant. What must never happen is a
  // collision created SILENTLY.
  if (findCard(id)) {
    return { error: minted
      ? 'card exists: ' + id + ' — ' + lt.name + ' would mint that id next (counter at ' + (minted - 1)
        + '). Create it with an explicit free id, or give ' + lt.name + ' an unused prefix in its settings.'
      : 'card exists: ' + id, code: 409 };
  }
  const column = body.column ? String(body.column) : 'backlog';
  if (!board.columns.some((c) => c.id === column)) return { error: 'unknown column: ' + column };
  // Working is a fact, not a label: a card is in Working iff a live worker
  // exists for it, and only card.start creates one. Cards are never BORN there.
  if (column === 'working') return { error: 'cards cannot be created in Working — a card enters Working only through card.start (which spawns its worker)' };
  // Nor anywhere else: cards are born in Backlog ONLY (review is the handoff,
  // peer is the captain's shelf — both are earned, never a birthplace).
  if (column !== 'backlog') return { error: 'cards are born in Backlog only — create it there and move it after' };
  const actor = String(body.actor || actorDefault || 'agent').slice(0, 60);
  const card = {
    id, title: title.slice(0, 200), type, owner, column, playbook: pb.playbook,
    labels: Array.isArray(body.labels) ? body.labels.filter((l) => typeof l === 'string' && l) : [],
    attributes: (body.attributes && typeof body.attributes === 'object') ? body.attributes : {},
    body: typeof body.body === 'string' ? body.body : '',
    created: now(), updated: now(), threadStart: null, pendingOrder: null,
    events: [], thread: [],
  };
  card.events.push(mkEvent({ text: 'created in ' + columnTitle(column), actor }, { kind: 'created' }));
  if (minted) lt.cardSeq = minted; // never reissued, never rolled back
  board.cards.push(card);
  registerCardLabels();
  if (actor === 'user') queuePush(owner, { kind: 'card-created', card: id, text: card.title, column });
  return { card };
}

// card.move — who moves matters (the DNA's side-effects table):
//   captain (actor "user"):
//     any column → working = start-order: the card does NOT move; a QueueItem
//                          goes to the owner and the card carries pendingOrder
//                          (invariant 3: only card.start enters Working — a
//                          plain write would create a workerless Working card)
//     review → backlog   = rework-order: same, optionally carrying the captain's
//                          comment (body.text)
//     anything else      = applies normally (parking in peer, reordering, …)
//   lieutenant (any other actor): only → review (the handoff, a level-1 event);
//   → working is a 409 pointing at card.start.
// Any APPLIED move clears pendingOrder — the ordered move happening (or the
// captain rearranging) resolves the order marker.
function moveCard(card, body, actorDefault) {
  const column = String(body.column || '');
  if (!board.columns.some((c) => c.id === column)) return { error: 'unknown column: ' + column };
  const actor = String(body.actor || actorDefault || 'agent').slice(0, 60);
  if (column === card.column) return { ok: true, unchanged: true };
  const from = card.column;

  if (actor === 'user') {
    const order = column === 'working' ? 'start-order'
      : from === 'review' && column === 'backlog' ? 'rework-order' : null;
    if (order) {
      const item = queuePush(card.owner, Object.assign(
        { kind: order, card: card.id, from, to: column },
        String(body.text || '').trim() ? { text: String(body.text).slice(0, 2000) } : {}));
      card.pendingOrder = { kind: order, seq: item.seq, ts: item.ts };
      const ev = mkEvent({ actor, kind: 'ordered',
        text: (order === 'start-order' ? 'start ordered' : 'rework ordered') + ' (' + columnTitle(from) + ' → ' + columnTitle(column) + ')' }, {});
      card.events.push(ev);
      card.updated = now();
      return { ok: true, ordered: order, event: ev, seq: item.seq };
    }
  } else if (column === 'working') {
    return { error: 'only card.start moves a card into Working (it spawns the worker) — run: card start ' + card.id, code: 409 };
  } else if (column !== 'review') {
    return { error: 'lieutenants move cards only to review (the handoff)' };
  }

  card.column = column;
  card.pendingOrder = null;
  card.updated = now();
  if (from === 'working') {
    const w = findWorker(card.id);
    if (w) { delete w.stopNotified; clearStale(w); } // leaving Working ends the stop/stale-state
  }
  // A move is a deliberate act: it always lands on the timeline. Default kind:
  // a lieutenant move is a handoff (level 1 from the kinds map — rings the
  // captain); a captain move is `moved` (level 2). `kind` in the body overrides;
  // levels come from the effective kinds map unless an explicit level is given.
  const ev = mkEvent(
    { level: body.level, kind: body.kind, actor, text: columnTitle(from) + ' → ' + columnTitle(column) },
    { kind: actor === 'user' ? 'moved' : 'handoff' });
  card.events.push(ev);
  if (actor === 'user') queuePush(card.owner, { kind: 'card-moved', card: card.id, from, to: column });
  return { ok: true, event: ev };
}

function patchCard(card, body) {
  // Owner reassignment is allowed ONLY while no worker is bound to the card
  // (live or recorded): a worker's session/worktree belong to the owning
  // lieutenant's supervision, so mid-work handovers stay forbidden.
  if (body.owner !== undefined) {
    const newOwner = String(body.owner).replace(/^lieutenant:/, '');
    if (newOwner !== card.owner) {
      if (findWorker(card.id)) {
        return { error: 'owner change refused: card has a worker bound (session/worktree) — finish or archive first' };
      }
      if (!board.lieutenants.some((l) => l.id === newOwner)) {
        return { error: 'unknown lieutenant: ' + newOwner };
      }
      const prev = card.owner;
      card.owner = newOwner;
      card.events.push(mkEvent(
        { actor: body.actor, text: 'owner: ' + prev + ' → ' + newOwner }, { kind: 'moved' }));
    }
  }
  if (body.playbook !== undefined) {
    const pb = checkPlaybook(body.playbook);
    if (pb.error) return { error: pb.error };
    card.playbook = pb.playbook;
  }
  if (body.title !== undefined) card.title = String(body.title).slice(0, 200);
  if (body.body !== undefined) card.body = String(body.body);
  if (body.type !== undefined && CARD_TYPES.includes(body.type)) card.type = body.type;
  if (Array.isArray(body.labels)) card.labels = body.labels.filter((l) => typeof l === 'string' && l);
  if (body.attributes && typeof body.attributes === 'object') {
    for (const [k, v] of Object.entries(body.attributes)) {
      if (v === null) delete card.attributes[k];
      else card.attributes[k] = v;
    }
  }
  card.updated = now();
  registerCardLabels();
  return { ok: true };
}

// ---------- promote to artifact (the DELIBERATE tool — chat upload ≠ artifact) ----------
// Add/remove a curated deliverable on card.attributes.artifacts [{uri, label}].
// This is the ONLY path (besides the investigation auto-attach) that puts an
// entry there — a chat upload alone never does. Idempotent by uri, mirroring the
// investigation auto-attach shape. A bare filesystem path is normalized to a
// file:// absolute uri; attachment:// and http(s):// / file:// uris pass through.
function normalizeArtifactUri(raw) {
  const s = String(raw || '').trim();
  if (!s) return '';
  if (/^(attachment|https?|file):\/\//.test(s)) return s;
  return 'file://' + path.resolve(s);
}
function cardArtifactAdd(card, body) {
  const uri = normalizeArtifactUri(body && body.uri);
  if (!uri) return { error: 'uri required (attachment://id | file://path | path)' };
  if (!Array.isArray(card.attributes.artifacts)) card.attributes.artifacts = [];
  const label = String((body && body.label) || '').slice(0, 200);
  const existing = card.attributes.artifacts.find((a) => a && a.uri === uri);
  if (existing) {
    if (label && existing.label !== label) { existing.label = label; card.updated = now(); }
    return { ok: true, artifact: existing, unchanged: !label || existing.label === label };
  }
  // Default label: an attachment's stored name (nicer than its opaque id), else
  // the uri's basename.
  let defLabel = uriBasenameServer(uri);
  const am = /^attachment:\/\/(.+)$/.exec(uri);
  if (am) { const meta = readAttachmentMeta(am[1]); if (meta) defLabel = meta.name; }
  const art = label ? { uri, label } : { uri, label: defLabel };
  card.attributes.artifacts.push(art);
  card.events.push(mkEvent({ text: 'artifact added: ' + (art.label || uri), actor: (body && body.actor) || 'agent', level: 2 }, {}));
  card.updated = now();
  return { ok: true, artifact: art };
}
function cardArtifactRemove(card, body) {
  const uri = normalizeArtifactUri(body && body.uri);
  if (!uri) return { error: 'uri required' };
  const arts = Array.isArray(card.attributes.artifacts) ? card.attributes.artifacts : [];
  const next = arts.filter((a) => !(a && a.uri === uri));
  const removed = next.length !== arts.length;
  card.attributes.artifacts = next;
  if (removed) card.updated = now();
  return { ok: true, removed };
}
// Server-side twin of ui/js/util.js uriBasename — the artifact's display name.
function uriBasenameServer(uri) {
  const s = String(uri).replace(/[?#].*$/, '').replace(/\/+$/, '');
  const i = s.lastIndexOf('/');
  return i >= 0 ? s.slice(i + 1) : s;
}

function readArchive() {
  try {
    return fs.readFileSync(ARCHIVE_FILE, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l));
  } catch (e) { return []; }
}

function archiveCard(card, body, actorDefault) {
  const actor = String((body && body.actor) || actorDefault || 'agent').slice(0, 60);
  // Archive reason is the validated enum `merged | killed` (merged = landed,
  // killed = dismissed — the default when none is given). Free text belongs in
  // the optional `note`, preserved on the archive record.
  const reason = (body && body.reason) || 'killed';
  if (reason !== 'merged' && reason !== 'killed') {
    return { error: "reason must be 'merged' or 'killed' (free text goes in note)" };
  }
  const note = body && body.note ? String(body.note).slice(0, 500) : null;
  const rec = { ts: now(), actor, reason, card };
  if (note) rec.note = note;
  fs.appendFileSync(ARCHIVE_FILE, JSON.stringify(rec) + '\n');
  board.cards = board.cards.filter((c) => c.id !== card.id);
  // An archived card has no worker (invariant: Working ⇔ live worker), and by
  // now it usually has none left either — the handoff killed it. Any lingering
  // one is ended by the CALLER, through killCardWorker: the kill is awaited and
  // verified there, and the registry entry is dropped only once the pane is
  // provably gone. It used to be a fire-and-forget kill plus an unconditional
  // drop right here, which is exactly how a session ends up alive with nothing
  // on the board pointing at it.
  // The kill lands on the board-level stream (the card is gone) with a card
  // reference. Typed by reason: merged = landed (level 1 — worth a bell),
  // killed = killed (level 2 — the captain's own act, no bell). Levels come from
  // the effective kinds map.
  const ev = mkEvent(
    { level: body && body.level, kind: body && body.kind, actor, text: reason + ': ' + (note || card.title) },
    { kind: reason === 'merged' ? 'landed' : 'killed' });
  ev.card = card.id; ev.cardTitle = card.title; ev.archived = true;
  board.events.push(ev);
  return { ok: true, event: ev };
}

// card.restore — back from the archive with frozen state intact. The MOST RECENT
// archive record for the id wins (a card can be archived and restored repeatedly).
// The archive log stays append-only: the original record REMAINS, so an archive
// record can exist for a live card — the board is truth for liveness. The frozen
// snapshot is restored in full (body, events, thread, attributes, column); only
// the worker lease starts absent (nothing is working a resurrected card until
// status.set says so), and owed/unread re-derive from the restored thread/events
// against the per-user read state as on any card. The return is loud: a level-1
// event says the card was resurrected and by whom.
function restoreCard(id, body) {
  if (findCard(id)) return { error: 'card already on the board: ' + id, code: 409 };
  let rec = null;
  for (const r of readArchive()) if (r && r.card && r.card.id === id) rec = r; // last = most recent
  if (!rec) return { error: 'not in archive: ' + id, code: 404 };
  const card = JSON.parse(JSON.stringify(rec.card)); // the frozen snapshot, in full
  if (!Array.isArray(card.events)) card.events = [];
  if (!Array.isArray(card.thread)) card.thread = [];
  if (!Array.isArray(card.labels)) card.labels = [];
  if (!card.attributes || typeof card.attributes !== 'object') card.attributes = {};
  if (!CARD_TYPES.includes(card.type)) card.type = 'implementation';
  if (typeof card.playbook !== 'string') card.playbook = ''; // frozen before playbooks existed
  card.status = { worker: null }; // the lease starts absent until the next status.set
  card.pendingOrder = null;
  // Working ⇔ live worker: a frozen Working snapshot restores workerless, so
  // it lands in Backlog instead (card.start is the only way back into Working).
  const wasWorking = card.column === 'working';
  if (wasWorking) card.column = 'backlog';
  for (const e of card.events) if (e.seq > board.seq) board.seq = e.seq; // defensive: no seq reuse
  const ev = mkEvent({
    level: body && body.level, kind: body && body.kind, actor: body && body.actor,
    text: (String((body && body.text) || '').trim() || 'resurrected')
      + (wasWorking ? ' — restored to backlog (was working)' : ''),
  }, { kind: 'resurrected' });
  card.events.push(ev);
  card.updated = now();
  board.cards.push(card);
  registerCardLabels();
  return { ok: true, card, event: ev };
}

// ---------- projects (F6: the registered-repo registry) ----------
// workspace.addProject: clone the repo into <workspace>/projects/<name> and
// record {name, path}. A card's `repo` attribute must name a registered
// project for card.start to provision its worker a worktree. How finished work
// leaves the worktree is the CARD's playbook, not a property of the repo.
function findProject(name) { return board.projects.find((p) => p.name === name); }
const addingProjects = new Set(); // names with a clone in flight (async clone opens racing duplicate adds)
async function addProject(body) {
  const source = String((body && body.source) || '').trim();
  if (!source) return { error: 'source required (git URL or local path)' };
  const name = String((body && body.name) || path.basename(source.replace(/\/+$/, '')).replace(/\.git$/, '')).trim();
  if (!/^[\w][\w.-]*$/.test(name)) return { error: 'bad project name: ' + name + ' (use [A-Za-z0-9_.-], or pass --name)' };
  if (findProject(name)) return { error: 'project exists: ' + name, code: 409 };
  if (addingProjects.has(name)) return { error: 'project add already in progress: ' + name, code: 409 };
  const dest = path.join(WORKSPACE, 'projects', name);
  if (fs.existsSync(dest)) return { error: 'destination already exists: ' + dest, code: 409 };
  fs.mkdirSync(path.dirname(dest), { recursive: true });
  const src = fs.existsSync(source) ? path.resolve(source) : source;
  addingProjects.add(name);
  try {
    await new Promise((resolve, reject) => {
      execFile('git', ['clone', src, dest], { encoding: 'utf8', timeout: 300000 },
        (err, stdout, stderr) => (err ? reject(Object.assign(err, { stderr })) : resolve()));
    });
  } catch (e) {
    return { error: 'clone failed: ' + String((e && e.stderr) || (e && e.message) || e).trim(), code: 502 };
  } finally {
    addingProjects.delete(name);
  }
  const project = { name, path: dest, source: src, added: now() };
  board.projects.push(project);
  board.events.push(mkEvent({ text: 'project ' + name + ' registered',
    actor: (body && body.actor) || 'agent', level: 2 }, {}));
  return { project };
}

// What a registered clone says about itself: where it pushes, and the branch a
// fresh worktree starts detached from. Both are read from the checkout, never
// from the registry — `source` records what the clone was made from once and
// then goes stale, while these two follow the repo.
//
// A missing `.git` short-circuits: without it there is nothing to read, and
// `git -C` would happily answer for whatever repo the path happens to sit
// inside. Nothing here throws — a read that fails is a null field, so a row the
// server cannot describe still renders with what it has.
function projectGit(dir) {
  const out = { remote: null, branch: null, missing: !dir || !fs.existsSync(dir) };
  if (out.missing || !fs.existsSync(path.join(dir, '.git'))) return out;
  const read = (args) => {
    try {
      return execFileSync('git', ['-C', dir].concat(args),
        { encoding: 'utf8', timeout: 2000, stdio: ['ignore', 'pipe', 'ignore'] }).trim() || null;
    } catch (e) { return null; }
  };
  out.remote = read(['remote', 'get-url', 'origin']);
  const head = read(['symbolic-ref', '--short', 'refs/remotes/origin/HEAD']);
  out.branch = head ? head.replace(/^origin\//, '') : null;
  return out;
}

// ---------- workers (F5: card.start, worker.signal, worker done) ----------
// A worker lives as a tmux WINDOW inside its owning lieutenant's session
// (papercut #8): ref = { session: <lieutenant session>, window: 'w-<card-id>' }.
// The 'w-' prefix keeps tmux from ever parsing the window name as an index.
// Lifecycle coupling is accepted design — the lieutenant's session dying takes
// its worker windows with it (supervision then flags them as died). Refs are
// data, so workers recorded under the old one-session-per-worker scheme keep
// working via their session-only ref.
function ownerSession(card) {
  const lt = board.lieutenants.find((l) => l.id === card.owner);
  // Mirror the supervision respawn rule: a founder's foreign session name is
  // not spawnable — those workers get the workspace-scoped lieutenant name.
  return lt && isHarnessRef(lt.ref) && /^bc-[A-Za-z0-9_-]+$/.test(lt.ref.session)
    ? lt.ref.session
    : names.lieutenantSession(WORKSPACE, card.owner);
}
// workerName(ref) — the attach-facing address of a worker's pane:
// `session:window` for window-granular refs, the bare session for legacy ones.
// refKey — the harness state key an agent's turn-end hook posts as `session`:
// the bare tmux session for a session-granular ref, `session:window` for a
// window-granular one. Lieutenants are window-granular too (their own `lt`
// window — names.LIEUTENANT_WINDOW), so this is NOT worker-only.
function refKey(ref) { return ref.window ? ref.session + ':' + ref.window : ref.session; }
function workerName(ref) { return refKey(ref); }
function findWorker(cardId) { return board.workers.find((w) => w.card === cardId); }

// The worker lease (card.status.worker) is a WRITTEN signal — status.set is its
// only writer — so a worker that never writes one reads `absent` while its
// session is plainly alive, and its card reports an absent worker for the whole
// run while that same run is emitting milestones. On the SINGLE-card read
// (card show, status <card>) the truth is one call away, so ask for it: alive()
// on the card's registry entry, whatever harness it is. The board read stays
// lease-only and sync — one
// alive() per card there would be a scan, not a read.
// A written lease always wins; only `absent` is filled in, and only from a
// session that answers. Dead-or-gone stays absent, which is the honest word.
async function statusWithLiveness(card, status) {
  if (!status || !status.worker || status.worker.state !== 'absent') return status;
  const w = findWorker(card.id);
  if (!w) return status;
  let up = false;
  try { up = await harnessFor(w.ref).alive(w.ref); } catch (e) { up = false; }
  if (!up) return status;
  return Object.assign({}, status, {
    worker: {
      id: workerName(w.ref),
      // done or paused and still alive is a session holding the card without
      // working it — idle. Anything else alive is working.
      state: (w.done || w.paused) ? 'idle' : 'working',
      derived: true, // read off the session, not leased by a worker
    },
  });
}

// ---------- event dedupe keys (POST /api/cards/<id>/events `key`) ----------
//
// A hook that polls `gh` every five minutes sees the same red check sixty
// times. Without a key it wakes its lieutenant sixty times; with one, the
// second and later events carrying that key FOR THAT CARD are a no-op that
// answers 200 and says it was a duplicate — no timeline entry, no queue item.
// So every polling hook gets deduping free instead of keeping its own state
// file beside itself.
//
// Keys are scoped per card (the same key on a different card is a different
// thing that happened) and kept 7 days, pruned on every write. One small JSON
// file, not board state: it is a cache of what has already been said, and
// losing it costs one duplicate wake.
const EVENTKEYS_FILE = path.join(STATE_DIR, 'eventkeys.json');
const EVENTKEY_TTL_MS = 7 * 24 * 60 * 60 * 1000;

// The store is null-prototype all the way down, and that is load-bearing: a key
// is whatever string a hook chose, and `toString` or `constructor` on an
// ordinary object answers as if it had already been claimed — the very first
// event carrying one would be dropped as a duplicate, silently. `__proto__` is
// worse on the write side: assigning it sets a prototype instead of storing a
// key, so it never persists and never prunes.
function readEventKeys() {
  const out = Object.create(null);
  try {
    const doc = JSON.parse(fs.readFileSync(EVENTKEYS_FILE, 'utf8'));
    if (!doc || typeof doc !== 'object' || Array.isArray(doc)) return out;
    for (const [c, keys] of Object.entries(doc)) {
      if (!keys || typeof keys !== 'object' || Array.isArray(keys)) continue;
      out[c] = Object.assign(Object.create(null), keys);
    }
  } catch (e) {}
  return out;
}

// The pair is deliberately two functions, and the ORDER they are called in is
// the guarantee: ask (read-only), deliver, then claim. Claiming first would
// make a delivery that throws — an unwritable queue file, a full disk — a wake
// that is forever answered "duplicate" and never actually arrived. At-least-once
// beats a silently swallowed escalation, so a failed delivery leaves the key
// unclaimed and the next poll says the same thing again.

// seenEventKey(cardId, key) -> true when that card already claimed this key
// inside the window. Reads only; it never touches the file.
function seenEventKey(cardId, key) {
  const doc = readEventKeys();
  const ts = doc[cardId] && doc[cardId][key];
  return typeof ts === 'number' && ts > Date.now() - EVENTKEY_TTL_MS;
}

// claimEventKey(cardId, key) — the key is now spoken for. Prunes everything
// past the window while it holds the file, which is the only thing that ever
// expires a key.
function claimEventKey(cardId, key) {
  const doc = readEventKeys();
  const cutoff = Date.now() - EVENTKEY_TTL_MS;
  for (const [c, keys] of Object.entries(doc)) {
    for (const [k, ts] of Object.entries(keys)) if (!(typeof ts === 'number' && ts > cutoff)) delete keys[k];
    if (!Object.keys(keys).length) delete doc[c];
  }
  (doc[cardId] = doc[cardId] || Object.create(null))[key] = Date.now();
  try { fs.writeFileSync(EVENTKEYS_FILE, JSON.stringify(doc)); }
  catch (e) { console.error(now() + ' event key store unwritable: ' + String((e && e.message) || e)); }
}

// forgetEventKeys(id) -> true when it dropped one that was still live. The
// counterpart the pair needed once something could RECOVER: a failure that has
// been fixed must stop answering "duplicate", or the next one would never be
// heard and silence would mean both "healed" and "still broken". Prunes the
// window on the way through like the claim does, and writes nothing at all when
// there was nothing to forget — the green path is the common one.
function forgetEventKeys(id) {
  const doc = readEventKeys();
  const cutoff = Date.now() - EVENTKEY_TTL_MS;
  let dropped = false;
  for (const [c, keys] of Object.entries(doc)) {
    for (const [k, ts] of Object.entries(keys)) {
      const live = typeof ts === 'number' && ts > cutoff;
      if (!live) { delete keys[k]; continue; }
      if (c === id) { delete keys[k]; dropped = true; }
    }
    if (!Object.keys(keys).length) delete doc[c];
  }
  if (!dropped) return false;
  try { fs.writeFileSync(EVENTKEYS_FILE, JSON.stringify(doc)); }
  catch (e) { console.error(now() + ' event key store unwritable: ' + String((e && e.message) || e)); }
  return true;
}

// ---------- lifecycle hooks (workspace-owned scripts; server/hooks.js) ----------
// Events v1: worker-done, worker-died, card-archived. Fire-and-forget — a hook
// never blocks or fails the lifecycle outcome it observes. The ONE ordering
// guarantee: card-archived hooks are AWAITED before the worktree release (the
// PR-watch path), so a hook can still reach paths inside $BC_WORKTREE.
const HOOK_TIMEOUT_MS = parseInt(process.env.BC_HOOK_TIMEOUT_MS, 10) > 0
  ? parseInt(process.env.BC_HOOK_TIMEOUT_MS, 10) : 0; // 0 = the module default (~120s)

// Hook env context: prefer the live worker record, fall back to the card's
// own attributes (the worker registry entry may already be gone on archive).
//
// A RELEASED worktree is no longer a path: the registry entry keeps naming it
// (the recovery paths probe it to explain what happened), but a hook gets the
// empty string that documents N/A instead of a directory that is gone — the
// ordinary card-archived case, since the handoff released it long before a PR
// merged.
function hookContext(card, w) {
  const attrs = (card && card.attributes) || {};
  const project = findProject(String((w && w.project) || attrs.repo || ''));
  const wt = (w && w.worktree && !w.worktree.released && w.worktree.path) || '';
  return {
    workspace: WORKSPACE,
    card: card.id,
    repo: project ? project.path : '',
    worktree: wt || String(attrs.worktree || ''),
    branch: (w && w.branch) || String(attrs.branch || ''),
  };
}

// fireHooks(event, card, w, opts) — run the workspace's hooks for a lifecycle
// event and land each result as a timeline event: hook-ran (level 2, routine)
// per success, hook-failed (level 1 — the captain's bell) per failure, text =
// filename + exit detail + trimmed output. Failures also queuePush to the
// owner. Never throws (so every call site can stay fire-and-forget); the
// returned promise resolves after the events landed, which is what lets the
// card-archived call site await it BEFORE releasing the worktree.
//
// An ARCHIVED card can't take timeline events — it left the board and its
// archive.jsonl snapshot is already frozen — so when the card is gone (or the
// call site knows it is leaving: opts.boardLevel) the events land on the
// board-level stream with a card reference instead of being dropped.
async function fireHooks(event, card, w, opts) {
  try {
    const results = await runHooks(event, hookContext(card, w),
      HOOK_TIMEOUT_MS ? { timeoutMs: HOOK_TIMEOUT_MS } : undefined);
    if (!results.length) return;
    for (const r of results) {
      const detail = r.timedOut ? 'timed out'
        : r.error ? String(r.error)
        : 'exit ' + r.code;
      const text = event + ' hook ' + r.hook + (r.ok ? ' ok' : ' FAILED') + ' (' + detail + ')'
        + (r.output ? ': ' + r.output : '');
      landCardEvent(card, mkEvent({ text, actor: 'server' },
        { kind: r.ok ? 'hook-ran' : 'hook-failed' }), opts);
      if (!r.ok) queuePush(card.owner, { kind: 'hook-failed', card: card.id, text: text.slice(0, 2000) });
    }
    saveBoard(); broadcast();
  } catch (e) {
    console.error(now() + ' ' + event + ' hooks for ' + card.id + ' failed: ' + String((e && e.message) || e));
  }
}

// landCardEvent(card, ev, opts) — the card takes the event if it is still on
// the board; an ARCHIVED card cannot (it left, and its archive.jsonl snapshot
// is frozen), so the event goes to the board-level stream carrying a reference
// to the card instead of being dropped. opts.boardLevel takes the board stream
// without asking: the call site already knows the card is leaving.
function landCardEvent(card, ev, opts) {
  const live = (opts && opts.boardLevel) ? null : findCard(card.id);
  if (live) {
    live.events.push(ev);
    live.updated = now();
  } else {
    ev.card = card.id;
    ev.cardTitle = card.title;
    board.events.push(ev);
  }
  return ev;
}

// The playbook's `teardown` gets TWO budgets, named apart on purpose: the
// difference between them is who is waiting.
//
// At the handoff and at archive the command is fired UN-AWAITED — `card.move`
// answers immediately — so it can afford the full five minutes.
const TEARDOWN_TIMEOUT_MS = parseInt(process.env.BC_TEARDOWN_TIMEOUT_MS, 10) > 0
  ? parseInt(process.env.BC_TEARDOWN_TIMEOUT_MS, 10) : TEARDOWN_DEFAULT_MS;
// At the rework RESTART it is awaited inside the `card start` request, ahead of
// a fetch, a worktree add and a spawn, with a CLI holding the line — so it gets
// one minute. `compose down` is the use case and does not need more; a stack
// still wedged past that is exactly the case whose answer is "land the event,
// carry on, and let releaseWorktree make its own decision".
//
// BC_TEARDOWN_TIMEOUT_MS overrides BOTH: it is the test knob, and a test that
// pins one budget wants the other honest too.
const RESTART_TEARDOWN_TIMEOUT_MS = parseInt(process.env.BC_TEARDOWN_TIMEOUT_MS, 10) > 0
  ? parseInt(process.env.BC_TEARDOWN_TIMEOUT_MS, 10) : 60000;
const TEARDOWN_OUTPUT_TAIL = 1200; // of the event text, whose own cap is 2000

// In-flight teardowns, by worker record. Deliberately NOT on the worker (and so
// never persisted): a run interrupted by a server restart is not in flight, and
// a flag that survived one would block the command forever.
const teardownInFlight = new WeakSet();

// runCardTeardown(card, w, wtPath) — a container that outlives its worktree is
// the same bug as a worktree that outlives its work, one layer down, and the
// playbook that started the container is the thing that knows how to stop it.
// So the command runs HERE: at the handoff, in the worktree, the last thing
// before the release.
//
// BEST EFFORT, always. A non-zero exit or a timeout lands an event and the
// release goes ahead exactly as if no teardown had been configured — a user's
// broken script must never wedge a card, and nothing is lost by carrying on:
// if the container really is still holding the checkout, releaseWorktree
// refuses on its own and says why. EVERY run is an event, success included —
// otherwise the only way to know whether a card's container was ever stopped is
// to go looking for the container.
//
// Reported through the hook kinds because it IS one of those: a user-owned
// command the board runs on a lifecycle moment, whose failure rings the same
// bell. The text says `teardown`, so the timeline still tells them apart.
async function runCardTeardown(card, w, wtPath, timeoutMs) {
  const command = String((w && w.teardown) || '').trim();
  if (!command) return null;
  // Nothing left to tear down in a directory that is gone — nor in one that was
  // RELEASED, whether or not it is still on disk: under `tool: 'treehouse'` a
  // release is `treehouse return`, which hands the checkout back to a pool that
  // may have leased it to another card by now, and tearing down a stranger's
  // ground is worse than tearing down nothing. This is not the retry rule below
  // being clawed back: a released worktree has no next release point for THIS
  // card, so there is nothing left to retry against.
  if (!wtPath || !fs.existsSync(wtPath)) return null;
  if (w.worktree && w.worktree.released) return null;
  // A directory that is still THERE, on the other hand, is not a record that
  // this never ran. That record belongs on the worker, and it records a
  // SUCCESS: a teardown exists to be run at a release, not once per card, so a
  // failure or a timeout stays retryable at the next release point — which is
  // the whole reason the restart runs it.
  if (w.teardownRan || teardownInFlight.has(w)) return null;
  teardownInFlight.add(w);
  try {
    // The worktree is passed, never re-derived: hookContext() reports a
    // released worktree as '' and runTeardown would fall back to the workspace
    // root — the one directory a teardown must not run in.
    const ctx = Object.assign(hookContext(card, w), { worktree: wtPath });
    const r = await runTeardown(command, ctx, { timeoutMs });
    if (r.ok) w.teardownRan = true;
    const detail = r.timedOut ? 'timed out'
      : r.error ? String(r.error)
      : 'exit ' + r.code;
    const out = r.output.length > TEARDOWN_OUTPUT_TAIL
      ? '…' + r.output.slice(-TEARDOWN_OUTPUT_TAIL) : r.output;
    const text = 'teardown `' + command + '` ' + (r.ok ? 'ok' : 'FAILED')
      + ' (' + detail + ', ' + (r.ms / 1000).toFixed(1) + 's)' + (out ? ': ' + out : '');
    landCardEvent(card, mkEvent({ text, actor: 'server' },
      { kind: r.ok ? 'hook-ran' : 'hook-failed' }));
    if (!r.ok) {
      console.error(now() + ' teardown for ' + card.id + ' failed (' + detail + '): ' + command);
      queuePush(card.owner, { kind: 'hook-failed', card: card.id, text: text.slice(0, 2000) });
    }
    saveBoard(); broadcast(); // the release may sit behind the clone lock for minutes
    return r;
  } catch (e) {
    console.error(now() + ' teardown for ' + card.id + ' failed: ' + String((e && e.message) || e));
    return null;
  } finally {
    teardownInFlight.delete(w);
  }
}

// worktreeHolder(cardId, wtPath) — the OTHER card whose live worker record
// stands on this path, or null. A pointer is not ownership: git paths are
// per-card and cannot collide, but a treehouse POOL lease goes to whatever card
// asks next, and a frozen snapshot (archived after a refused release, then
// `card.restore`) can still name a lease that now belongs to somebody else. A
// worker RECORD is the ownership claim; the card attribute is only a pointer,
// so every path that releases against the attribute alone asks this first.
function worktreeHolder(cardId, wtPath) {
  return board.workers.find((x) => x.card !== cardId
    && x.worktree && x.worktree.path === wtPath && !x.worktree.released) || null;
}

// recordClaims(w) — whether this record is still the claim on its own path, the
// other half of the same rule: a record that has RELEASED its worktree gave the
// ground back, and a pool hands the slot to whoever asks next. So every path
// releasing on behalf of such a record asks worktreeHolder first, exactly as
// the ones holding nothing but a pointer do.
function recordClaims(w) {
  return !!(w && w.worktree && w.worktree.path && !w.worktree.released);
}

// releaseCardWorktree(card, w, opts) — the worktree goes when the card LEAVES
// WORKING, not whenever someone tidies up: a finished card held its checkout
// until archive, so fifteen finished cards held fifteen worktrees on disk.
//
// Leaving Working, not `worker done`, is the moment — `worker done` starts the
// LIEUTENANT's half, and verifying the work means reading the diff in that very
// worktree. The card leaves Working when the lieutenant has looked and handed
// off (`card.move`, opts.honorKeep — a playbook's `keep_worktree: true` never
// releases automatically), and archive stays the backstop it already was (never
// kept: the card is gone, there is nothing left to rework). `card.park` is NOT
// one of them: it shelves a card to be resumed in the same worktree.
//
// The archive call site runs its hooks FIRST, so a hook still reaches paths
// inside $BC_WORKTREE — and because that leaves the release trailing an
// unbounded wait, the card may have been restored and restarted by the time it
// fires: a worktree that now belongs to a NEWER worker is never touched.
//
// releaseWorktree refuses a worktree still holding work — uncommitted changes,
// or commits on a HEAD no ref reaches — and that refusal is the feature. It is
// NOT an error: the directory stays and the timeline says which path and why.
// Never throws — every call site observes a lifecycle outcome it must not fail.
async function releaseCardWorktree(card, w, opts = {}) {
  try {
    if (opts.honorKeep && w && w.keepWorktree) return null;
    const cur = findWorker(card.id);
    if (cur && cur !== w) return null; // a newer worker holds this card (and its path)
    const attrs = (card && card.attributes) || {};
    const fromRecord = !!(w && w.worktree && w.worktree.path);
    const wtRec = fromRecord ? w.worktree
      : (attrs.worktree
        ? { path: String(attrs.worktree), tool: worktreeToolFor(String(attrs.worktree), WORKSPACE) }
        : null);
    if (!wtRec) return null;
    const project = findProject(String((w && w.project) || attrs.repo || ''));
    if (!project) return null; // no clone to release against — leave the directory alone
    // The record IS the claim on its path; a bare pointer is not, and neither is
    // a record whose worktree is already marked RELEASED — that one gave the
    // ground back, and a pool hands the slot to whoever asks next. In both
    // cases a path some OTHER card's live worker stands on is refused before
    // anything touches it — the teardown included, since stopping what stands
    // on that ground would stop that worker's stack, not this card's. Refused
    // the way every refusal here works: the directory stays and the timeline
    // says whose it is.
    const holder = (fromRecord && recordClaims(w)) ? null : worktreeHolder(card.id, wtRec.path);
    let rel;
    if (holder) {
      rel = { released: false, reason: 'it belongs to card ' + holder.card + ', whose worker is live on it' };
    } else {
      // The playbook's teardown gets its turn first: the release is the moment
      // the ground goes, so stopping what stands on it happens immediately
      // before, never after. Never throws, and its outcome never steers what
      // follows.
      await runCardTeardown(card, w, wtRec.path, TEARDOWN_TIMEOUT_MS);
      // The teardown is an unbounded wait (minutes), so the guard above stopped
      // being atomic: a rework restart in the meantime re-provisions the SAME
      // deterministic path, and releasing now would delete a live worker's fresh
      // checkout. Whoever holds the card holds its path — ask again.
      const after = findWorker(card.id);
      if (after && after !== w) return null;
      rel = await releaseWorktree(wtRec, project.path);
    }
    const live = findCard(card.id); // archived in the meantime → the board stream carries it
    // the attribute is a pointer at a directory: a released one has to stop
    // pointing, or every reader downstream is sent to a path that is gone —
    // and `already gone` is the case where the directory is provably absent.
    // The registry entry keeps the path (worker.send and `card start --resume`
    // name it when they refuse) but is marked released, so hooks stop being
    // handed a $BC_WORKTREE that no longer exists.
    if (rel.released) {
      if (live && live.attributes) delete live.attributes.worktree;
      if (w && w.worktree) w.worktree.released = true;
    }
    if (!(rel.released && rel.reason === 'already gone')) { // nothing happened, nothing to say
      const text = rel.released
        ? 'worktree released: ' + wtRec.path
        : 'worktree kept (' + rel.reason + '): ' + wtRec.path;
      if (!rel.released) console.error(now() + ' worktree not released for ' + card.id + ': ' + rel.reason);
      landCardEvent(card, mkEvent({ text, actor: 'server' }, { level: 2 }));
    }
    saveBoard(); broadcast();
    return rel;
  } catch (e) {
    console.error(now() + ' worktree release for ' + card.id + ' failed: ' + String((e && e.message) || e));
    return null;
  }
}

// killCardWorker(card, w, opts) — the handoff is the worker's DEATH, not its
// retirement. Your review is the standing-room column: the captain is the
// bottleneck, so a card can sit there for a day, and every card sitting there
// used to pin one idle agent process for the whole wait. That process served
// almost nothing — rework after a handoff is a fresh start by the DNA's own
// rule, and the only thing it could still answer, a stray `worker.send`, had
// nowhere to write once the same handoff released its worktree.
//
// So it goes with the worktree, on the same trigger and with the SAME
// exceptions, for the same reason: a `keep_worktree: true` playbook reworks its
// card in place (the conversation is the other half of that checkout), and a
// worker that never reported done may hold the only copy of what it was doing.
// A worktree still holding work is NOT one of them — that refusal is about the
// ground, and a finished worker standing on ground nobody will take is still a
// finished worker.
//
// This verb only KILLS: dropping the record is dropWorkerRecord below, and the
// split is the point. The registry entry is the only handle anyone has on a
// live agent process, so it may be dropped ONLY by a path that watched the pane
// go: kill, then alive() again. A kill that throws, or a pane that answers
// alive afterwards, keeps the record and says so at level 1 — a leaked session
// that nothing on the board points at is worse than the idle one this whole
// change exists to end.
//
// The level-1 bell rings ONCE per record. `killFailed` is set the first time a
// kill cannot be verified and cleared the moment one is — the same shape the
// stall ladder uses — because the sweep retries at every boot, and a bell that
// rings for the same dead session on every restart of the board is noise the
// captain learns to ignore. The console still says so every time.
//
// Never throws: every call site observes a lifecycle outcome it must not fail.
async function killCardWorker(card, w, opts = {}) {
  try {
    if (!w) return null;
    if (opts.honorKeep && w.keepWorktree) return null;
    if (findWorker(w.card) !== w) return null; // already dropped, or a newer worker holds the card
    const name = workerName(w.ref);
    let alive = true;
    let err = null;
    let already = false;
    try {
      const impl = harnessFor(w.ref);
      // Asked BEFORE the kill, and it decides what to SAY, never what to do:
      // alive() is false the moment the agent process ends, while the window
      // it ran in is still standing there at a shell — and the kill is the one
      // thing that takes that window away. It is idempotent, so it runs on
      // every path; only the announcement below is gated on this.
      already = !(await impl.alive(w.ref));
      await impl.kill(w.ref);
      alive = await impl.alive(w.ref);
    } catch (e) { err = e; }
    if (alive || err) {
      const why = err ? String((err && err.message) || err) : 'the pane answered alive() after the kill';
      const text = 'worker ' + name + ' could NOT be killed (' + why + ') — its record is kept, '
        + 'so the session is still on the board rather than leaked; end it by hand '
        + '(tmux kill-window -t ' + name + ') and archive or restart the card';
      console.error(now() + ' worker kill for ' + card.id + ' failed: ' + why);
      if (!w.killFailed) {
        w.killFailed = why;
        landCardEvent(card, mkEvent({ text, actor: 'server' }, { kind: 'worker-kill-failed' }));
      }
      saveBoard(); broadcast();
      return { killed: false, reason: why };
    }
    const rang = !!w.killFailed;
    delete w.killFailed; // the harness came back — the next failure is news again
    // A pane that was already gone is killed by definition, and nothing
    // happened to say so — the same rule the release applies to ground that is
    // already given back. Only a kill that actually closed a live session earns
    // the line, or the sweep would re-announce the same closure at every boot
    // of the board for as long as the record it spares survives.
    if (already) {
      if (rang) { saveBoard(); broadcast(); }
      return { killed: true };
    }
    landCardEvent(card, mkEvent({
      text: 'worker ' + name + ' closed (' + (opts.reason || 'the card left Working') + ')',
      actor: 'server', level: 2,
    }, {}));
    saveBoard(); broadcast();
    return { killed: true };
  } catch (e) {
    console.error(now() + ' worker kill for ' + card.id + ' failed: ' + String((e && e.message) || e));
    return null;
  }
}

// stampWorkerAddress(card, w) — the card's own note of the run: `session` and
// `resumeId`, so the transcript stays readable long after the window is gone.
// The ONE writer of that pair, and every path that binds or unbinds a worker
// goes through it: the spawn, the resume, and dropWorkerRecord as the record
// goes (archive calls it directly — archiveCard freezes the card into the
// snapshot synchronously, well before a detached drop could get there, and by
// then there is no card left to stamp).
//
// `resumeId` is SET or DELETED, never left standing: the pair is one address,
// and a ref born without a resume id (codex) beside a session name from this
// run would otherwise send forensics to the previous run's conversation. Same
// shape the `branch` attribute already uses at the spawn, for the same reason.
function stampWorkerAddress(card, w) {
  if (!card || !card.attributes || !w) return;
  card.attributes.session = workerName(w.ref);
  if (w.ref && w.ref.resumeId) card.attributes.resumeId = w.ref.resumeId;
  else delete card.attributes.resumeId;
}

// dropWorkerRecord(card, w) — the registry entry goes, and the address it held
// outlives it on the card. Call it ONLY behind a verified kill.
//
// It is deliberately NOT the second half of that kill. A checkout that refused
// its release keeps its record, because that record is the last handle on the
// unfinished business standing on it — the path, and a `teardown` that has not
// run yet and gets another turn at archive. The window is dead either way; the
// entry is what the next release point reads.
//
// Guarded like its two siblings: a record already spliced, or a NEWER worker
// holding this card (a rework restart that raced the release's teardown wait),
// and this dead worker neither drops the live one's record nor stamps its own
// address over the live one's — the board would then send the lieutenant to a
// session that no longer exists.
function dropWorkerRecord(card, w) {
  if (!w) return null;
  if (findWorker(w.card) !== w) return null;
  stampWorkerAddress(findCard(w.card), w);
  board.workers = board.workers.filter((x) => x !== w);
  saveBoard(); broadcast();
  return w;
}

// sweepStaleWorkers() — one pass at boot over the registry, because a rule that
// only fires on the move leaves behind everything that was already there: a
// board upgrading to this carries records for cards long since handed off, and
// windows whose agent died months ago.
//
// A worker outlives neither its card's Working state nor a restart that forgot
// to notice. Off the board entirely (archived, killed) → it goes, no exceptions,
// exactly as archive would have done: no card will ever come back for it, so a
// record spared there is a leak with nothing on the other end. Still on the
// board but out of Working → the handoff's own rule, exceptions included, since
// a `keep_worktree` card parked in review is deliberately waiting for its
// worker.
//
// One more exception on the board, and it spares the RECORD only, never the
// process: a record whose worktree is STILL UNRELEASED is the last handle on
// the work standing there — `card.park` shelves a card to be resumed in that
// very checkout, and a release that REFUSED left an unspent `teardown` archive
// is contracted to retry. The entry is what the next release point reads; the
// window it names is not, and nothing legitimate wants that window alive.
// `card.park` is legal only when the worker is absent or dead, a refused
// release only ever follows a verified kill, and `card.start --resume` rides
// the record's resumeId rather than a live pane. So the kill runs anyway and
// only the drop is held back. A record with no worktree at all holds nothing.
//
// Runs once, after the listen: nothing here is on the critical path of a boot.
async function sweepStaleWorkers() {
  for (const w of [...board.workers]) {
    const card = findCard(w.card);
    if (card && card.column === 'working') continue;
    const stand = card || { id: w.card, title: w.card };
    let kill;
    let holdsGround = false;
    if (card) {
      if (w.keepWorktree || !w.done) continue;
      holdsGround = !!(w.worktree && w.worktree.path && !w.worktree.released);
      kill = await killCardWorker(stand, w,
        { reason: 'boot sweep: the card is in ' + columnTitle(card.column) + ', not Working' });
    } else {
      // Whether the board has already failed to end this one, read BEFORE the
      // attempt: the attempt itself sets the flag.
      const abandoned = !!w.killFailed;
      kill = await killCardWorker(stand, w, { reason: 'boot sweep: the card is no longer on the board' });
      // The terminal path out of an unverifiable kill. Keeping the record is
      // there to protect LIVE work — it is the only handle on a session
      // somebody may still come back for — and nobody is coming back for this
      // one: its card is off the board. So the record goes, having failed
      // twice, and the timeline says which session was left running rather
      // than letting the same bell ring at every boot forever.
      if (kill && !kill.killed && abandoned) {
        const name = workerName(w.ref);
        landCardEvent(stand, mkEvent({
          text: 'worker ' + name + ' ABANDONED (' + kill.reason + '): its card is off the board, so the '
            + 'record is dropped — nothing is left to come back for it. End the session by hand if it '
            + 'is still up (tmux kill-window -t ' + name + ')',
          actor: 'server', level: 2,
        }, {}));
        dropWorkerRecord(stand, w);
        continue;
      }
    }
    // The sweep is not a release point — it ends processes, it does not touch
    // ground. So the kill is unconditional and only the DROP waits on the
    // ground: a record still standing on an unreleased worktree survives its
    // own kill.
    if (kill && kill.killed && !holdsGround) dropWorkerRecord(stand, w);
  }
}

// The system move into Working — card.start is the ONE way in (invariant:
// Working ⇔ live worker). Clears any pendingOrder (a start-order just executed).
function enterWorking(card, text) {
  const from = card.column;
  card.column = 'working';
  card.pendingOrder = null;
  card.updated = now();
  const ev = mkEvent({
    text: text + (from !== 'working' ? ' (' + columnTitle(from) + ' → ' + columnTitle('working') + ')' : ''),
    actor: 'server',
  }, { kind: 'started' });
  card.events.push(ev);
  return ev;
}

// attachBriefArtifact(card, ref) — the worker's brief, auto-attached as a card
// artifact (label "brief") the moment a worker is bound to the card: fresh
// spawn AND resume both call it. Mirrors the investigation report auto-attach
// (workerDone): dedup by uri, gated on the file actually existing (a harness
// that doesn't persist a prompt file at this path simply gets no artifact —
// best-effort, never an error). The path is the SAME deterministic
// `<stateDir>/<key>.prompt` the harness port persists as the brief's source
// of truth (key = workerName(ref) = session or session:window), so a resume
// — which never regenerates a brief — still points at the original one and
// the uri-dedup keeps this idempotent across any number of resumes.
function attachBriefArtifact(card, ref) {
  const briefFile = path.join(HARNESS_STATE_DIR, workerName(ref) + '.prompt');
  if (!fs.existsSync(briefFile)) return;
  if (!Array.isArray(card.attributes.artifacts)) card.attributes.artifacts = [];
  const uri = 'file://' + briefFile;
  if (!card.attributes.artifacts.some((a) => a && a.uri === uri)) {
    // type: the brief is markdown in a `.prompt` file (the harness's resume
    // contract owns that name) — the hint lets the viewer render it as such
    card.attributes.artifacts.push({ uri, label: 'brief', type: 'markdown' });
  }
}

// card.start — ONE atomic op: provision an isolated worktree, spawn the worker
// session with the brief as launch prompt (per-spawn hook install is SAFE here
// precisely because the cwd is an isolated worktree — never the workspace root,
// whose hook a per-spawn install would clobber), bind {session, worktree,
// branch} into the card + the worker registry, move the card → Working.
// body.resume reincarnates a recorded (dead) worker in the same worktree instead.
//
// Provisioning + spawn are long async waits (a worktree add on a multi-GB
// repo, a real agent launch): the per-card in-flight guard keeps a second
// start of the SAME card from racing the first (different cards interleave
// freely — that's the point of going async), and the card is re-checked
// against the board after the spawn so a mid-start archive never leaves an
// orphan session behind. The response still reports the REAL spawn outcome —
// the await keeps startCard's success/failure contract synchronous-looking.
// The attributes the BOARD writes and a human never does: each holds a list of
// records the board appends to, and `--attr prs=<value>` overwrites that list
// with a string the next append then has to throw away. Named in a refusal,
// never offered as a recipe.
const BOARD_OWNED_ATTRS = new Set(['prs', 'artifacts']);
const startingCards = new Set(); // card ids with a start/resume in flight
async function startCard(card, body) {
  if (startingCards.has(card.id)) {
    return { error: 'card start already in progress: ' + card.id, code: 409 };
  }
  startingCards.add(card.id);
  try {
    return await doStartCard(card, body);
  } finally {
    startingCards.delete(card.id);
  }
}
async function doStartCard(card, body) {
  if (card.type === 'plan') return { error: 'plan cards never start (no worker is spawned for a plan)' };
  // The second way a card could start is GONE, not merely unsupported. A wire
  // caller that still asks for it gets told so — silently spawning an agent on
  // the playbook instead would be the opposite of what it asked for.
  if (body && body.command !== undefined) {
    return { error: '--command was removed: a card starts one way, from its playbook. '
      + 'Pick one with: bc-axi card patch ' + card.id + ' --playbook <id>', code: 400 };
  }

  const existing = findWorker(card.id);
  if (body && body.resume) {
    if (body.brief) {
      return { error: 'resume does not deliver briefs — the reincarnated worker keeps its own context '
        + 'and the brief would be silently dropped. To hand a live worker new instructions: '
        + 'bc-axi worker send ' + card.id + ' --text-file <f|->' };
    }
    if (!existing) {
      return { error: 'nothing to resume: card ' + card.id + ' has no recorded worker — a handoff '
        + 'ends the worker it hands off, so rework after one is a fresh start (card start ' + card.id
        + '), and a card that never started has nothing to reincarnate either' };
    }
    // A worker paused with --expect-exit is stopped ON PURPOSE and already told
    // the board the way back — and --resume is not it. Resuming spawns a SECOND
    // run against a path the first one still holds, and the new session dies on
    // arrival. Refuse, and quote the recorded reason: the caller reached for
    // this because it is the move the board teaches everywhere else, so name
    // the door instead of just the wall.
    if (existing.expectExit) {
      return { error: 'refusing to resume ' + card.id + ': its worker stopped with --expect-exit — resuming '
        + 'would start a second run over the one already in flight. '
        + 'The way back, as recorded at the pause: ' + (existing.pauseReason || '(no reason recorded)'), code: 409 };
    }
    // A resume reincarnates the session in the SAME worktree, so a released one
    // leaves nothing to reincarnate into. Say that, and name the way out: the
    // harness would otherwise fail on a missing cwd deep inside tmux.
    if (existing.worktree && existing.worktree.path && !fs.existsSync(existing.worktree.path)) {
      return { error: 'cannot resume ' + card.id + ': its worktree is gone (' + existing.worktree.path
        + ') — released when the card left Working. Start a fresh worker (card start ' + card.id
        + ' — it spawns over the finished session), or, for a playbook whose cards are reworked in '
        + 'place, set `keep_worktree: true` in its frontmatter', code: 409 };
    }
    let ref;
    try {
      ref = await harnessFor(existing.ref).resume(existing.ref, { stateDir: HARNESS_STATE_DIR, callbackUrl: TURNEND_URL });
    } catch (e) {
      return { error: 'worker resume failed: ' + String((e && e.message) || e), code: 502 };
    }
    if (!findCard(card.id)) { // archived while the resume was in flight
      Promise.resolve().then(() => harnessFor(ref).kill(ref)).catch(() => {});
      return { error: 'card left the board during resume: ' + card.id, code: 409 };
    }
    existing.ref = ref;
    stampWorkerAddress(card, existing);
    existing.done = false;
    delete existing.outcome;
    delete existing.flagged;
    delete existing.stopNotified;
    clearStale(existing);
    delete existing.lastTurnEndText;
    delete existing.lastSignalText;
    delete existing.paused; // a revived worker is watched again
    delete existing.killFailed; // reincarnated on a harness that answers
    attachBriefArtifact(card, ref);
    enterWorking(card, 'worker ' + workerName(ref) + ' resumed in ' + existing.worktree.path);
    return { worker: existing, resumed: true };
  }

  if (card.column === 'working') return { error: 'card is already Working', code: 409 };
  if (existing && !existing.done) {
    return { error: 'card already has a worker (' + workerName(existing.ref) + ') — resume it (card start --resume) or archive first', code: 409 };
  }
  const repoAttr = card.attributes && card.attributes.repo;
  if (!repoAttr) return { error: 'card has no repo attribute — set it first: card patch ' + card.id + ' --attr repo=<project>' };
  const project = findProject(String(repoAttr));
  if (!project) return { error: 'unregistered project: ' + repoAttr + ' (register it: bc-axi project add <url|path>)' };

  // The playbook is resolved and read HERE — at start, and only here, so the
  // worker gets the card as it stands and the playbook as it stands. Every
  // start reads it: there is no second way for a card to begin. No fallback
  // either — a card with no playbook does not start.
  // A playbook MAY open with frontmatter (server/playbooks.js) naming what runs
  // it: harness, model, the attributes it cannot work without, whether it gets
  // a branch. Parsed here, honored below.
  const playbookId = String(card.playbook || '').trim();
  if (!playbookId) {
    return { error: 'card ' + card.id + ' has no playbook — pick one before starting it: '
      + 'bc-axi card patch ' + card.id + ' --playbook <id>. Available: ' + playbooksHint() };
  }
  const playbookFile = resolvePlaybook(STATE_DIR, playbookId);
  if (!playbookFile) {
    return { error: 'card ' + card.id + ' points at playbook "' + playbookId + '", which no file '
      + 'matches. Available: ' + playbooksHint() };
  }
  let raw;
  try { raw = fs.readFileSync(playbookFile, 'utf8'); }
  catch (e) { return { error: 'playbook unreadable (' + playbookFile + '): ' + String((e && e.message) || e), code: 502 }; }
  let template = '';
  let meta = {};
  try { ({ meta, body: template } = parsePlaybook(raw)); }
  catch (e) { return { error: 'playbook ' + playbookFile + ': ' + String((e && e.message) || e) }; }
  // `requires` — the attributes this playbook cannot work without.
  // Refused HERE, before a worktree or a session exists: a review playbook with
  // no pr_url otherwise renders its unresolved placeholder literally — the
  // right call for a typo — and spawns a worker to discover that for itself.
  // Matched through playbooks.js's attrVar(), the same normalisation the
  // placeholder table uses, so a playbook asking for PR_URL is answered by
  // the card's pr_url — asking for a name the brief could not have read back
  // is not a requirement anyone means to write.
  //
  // The question here is whether the card CARRIES the thing, not whether it
  // has a text form to render — that second question is briefVars', and it
  // is why the two rules differ: a review playbook demanding "this card has PRs
  // recorded" is a real requirement even though the recorded list renders
  // into nothing. An empty list, though, carries nothing.
  const have = new Set();
  for (const [k, v] of Object.entries((card.attributes || {}))) {
    if (v === null || v === undefined) continue;
    const carried = typeof v === 'object'
      ? (Array.isArray(v) ? v.length > 0 : Object.keys(v).length > 0)
      : String(v).trim() !== '';
    if (carried) have.add(attrVar(k));
  }
  // Named back in the form the CARD carries: the uppercase form would earn
  // the user a second attribute resolving to the placeholder the first owns.
  const missing = [...new Set((meta.requires || [])
    .filter((k) => !have.has(attrVar(k)))
    .map((k) => attrCardKey(k)))];
  if (missing.length) {
    const ours = missing.filter((k) => BOARD_OWNED_ATTRS.has(k));
    const settable = missing.filter((k) => !BOARD_OWNED_ATTRS.has(k));
    let err = 'card ' + card.id + ' cannot start on playbook "' + playbookId + '": that playbook '
      + 'requires the attribute' + (missing.length > 1 ? 's ' : ' ') + missing.join(', ') + '.';
    if (settable.length) {
      err += ' Set ' + (settable.length > 1 ? 'them' : 'it') + ' first: bc-axi card patch '
        + card.id + ' ' + settable.map((k) => '--attr ' + k + '=<value>').join(' ') + '.';
    }
    if (ours.length) {
      err += ' ' + ours.join(' and ') + ' ' + (ours.length > 1 ? 'are' : 'is')
        + ' recorded by the board itself and never set by hand — the card has to earn '
        + (ours.length > 1 ? 'them' : 'it') + ' before this playbook can run.';
    }
    return { error: err };
  }
  // Harness precedence: explicit CLI --harness wins, then the playbook's
  // frontmatter, then config/default.
  const harnessFromPlaybook = !(body && body.harness) && !!meta.harness;
  const harnessName = String((body && body.harness)
    || meta.harness || readConfig().harness || 'claude');
  let impl;
  // A name the playbook asked for names the playbook back: otherwise a typo in
  // one of several playbooks sends whoever started the card hunting for it.
  try { impl = getHarness(harnessName); }
  catch (e) {
    return { error: String((e && e.message) || e)
      + (harnessFromPlaybook ? ' (from playbook ' + playbookFile + ')' : '') };
  }

  // A finished previous worker (rework restart): its session must be gone
  // (a live one is resumed/steered, not spawned over), then its worktree is
  // released first — only when clean, so committed-but-unmerged work is never
  // discarded.
  if (existing) {
    let up = false;
    let upErr = null;
    try { up = await harnessFor(existing.ref).alive(existing.ref); } catch (e) { upErr = e; }
    // The one live session that IS spawned over: done, and its worktree already
    // released at the handoff. There is nothing left to steer (a reopened turn
    // has nowhere to write) and nothing to resume, so refusing here would leave
    // a fresh start as the only move and refuse that too — a dead end. Kill it
    // and reprovision; every OTHER live session is still off limits.
    const groundGone = !!(existing.done && existing.worktree && existing.worktree.path
      && !fs.existsSync(existing.worktree.path));
    if (up && !groundGone) {
      const reopenHint = existing.done ? ' (or, since it reported done, reopen it in place with worker send)' : '';
      return { error: 'previous worker session ' + workerName(existing.ref) + ' is still alive — resume it (card start --resume) or steer it instead of spawning over it' + reopenHint, code: 409 };
    }
    // The same verify-then-drop invariant the handoff obeys: this path DROPS
    // the record at the end, so it may only do so having watched the pane go.
    // alive() answering false is that proof; alive() THROWING is not, so an
    // unreachable harness goes through the kill too and is refused on it.
    // Spawning a second worker over a live zombie nothing points at is worse
    // than a start that says no and names the session to end by hand.
    if (up || upErr) {
      const kill = await killCardWorker(card, existing, { reason: 'the card was restarted' });
      if (!kill || !kill.killed) {
        const why = (kill && kill.reason) || String((upErr && upErr.message) || upErr || 'unknown');
        return { error: 'previous worker session ' + workerName(existing.ref) + ' could not be ended ('
          + why + ') — end it by hand (tmux kill-window -t ' + workerName(existing.ref)
          + ') and start the card again', code: 409 };
      }
    }
    const prevProject = findProject(existing.project) || project;
    // A record that already released its worktree is no longer standing on it,
    // so this start may be looking at a lease the pool has since handed to
    // somebody else. Refused by name, on the same terms as the pointer branch
    // below, before the teardown — stopping what runs on that ground would
    // stop the card that owns it now.
    if (!recordClaims(existing) && existing.worktree && existing.worktree.path) {
      const held = worktreeHolder(card.id, existing.worktree.path);
      if (held) {
        return { error: 'the worktree ' + card.id + '\'s previous worker recorded (' + existing.worktree.path
          + ') belongs to card ' + held.card + ', whose worker is live on it — this record\'s claim on it '
          + 'is spent. Look at ' + held.card + ' first, then archive or restart ' + card.id, code: 409 };
      }
    }
    // A restart is not a handoff: it is the moment that checkout is actually
    // destroyed, so the teardown belongs here too — otherwise `keep_worktree`,
    // which skips it at the handoff precisely because the checkout is being
    // kept, is the one documented rework flow that deletes a worktree with its
    // container still up. The command run is the PREVIOUS worker's recorded
    // one, never the playbook being started: what must be stopped is what was
    // brought up. Best effort, exactly as at the handoff — the release below
    // makes its own decision, and still 409s if it refuses — on the shorter
    // budget, because this one is awaited with a caller on the line.
    await runCardTeardown(card, existing, existing.worktree && existing.worktree.path,
      RESTART_TEARDOWN_TIMEOUT_MS);
    const rel = await releaseWorktree(existing.worktree, prevProject.path);
    if (!rel.released) {
      return { error: 'previous worker worktree not releasable (' + rel.reason + '): ' + existing.worktree.path, code: 409 };
    }
    dropWorkerRecord(card, existing);
  } else if (card.attributes && card.attributes.worktree) {
    // No record, but the card still points at a checkout. That is what a
    // handoff leaves behind when its release did not finish — refused (a
    // worktree still holding work), or interrupted by a restart of the board —
    // and the pointer is now the only handle on it, the worker record having
    // died with the handoff. So the restart releases against the POINTER, on
    // exactly the terms the record would have got: refused means 409, never a
    // silent `git worktree add` onto a path that already exists.
    // The previous run's `teardown` is not recoverable here (it lived on the
    // record) — it had its turn at the handoff.
    const stalePath = String(card.attributes.worktree);
    // Releasing a lease somebody else's live worker stands on would take that
    // worker's ground out from under it: name the holder and refuse instead.
    const holder = worktreeHolder(card.id, stalePath);
    if (holder) {
      return { error: 'the worktree ' + card.id + ' still points at (' + stalePath + ') belongs to card '
        + holder.card + ', whose worker is live on it — this card\'s pointer is stale. Clear it '
        + '(bc-axi card patch ' + card.id + ' --attr worktree=) once you have looked at '
        + holder.card + ', then start again', code: 409 };
    }
    const stale = { path: stalePath, tool: worktreeToolFor(stalePath, WORKSPACE) };
    if (fs.existsSync(stale.path)) {
      const rel = await releaseWorktree(stale, project.path);
      if (!rel.released) {
        return { error: 'previous worker worktree not releasable (' + rel.reason + '): ' + stale.path, code: 409 };
      }
    }
    delete card.attributes.worktree;
  }

  let wt;
  try { wt = await createWorktree(project.path, card.id, WORKSPACE); }
  catch (e) { return { error: 'worktree provisioning failed: ' + String((e && e.message) || e), code: 502 }; }
  // A base that could not be refreshed is the card's business, not the server
  // log's: the worker is about to run on it either way.
  for (const w of (wt.warnings || [])) {
    card.events.push(mkEvent({ text: 'worktree base: ' + w, actor: 'server' }, { kind: 'stale-base' }));
    card.updated = now(); // a start that fails after this still flushes the event
  }
  delete wt.warnings; // said on the card; the persisted record is the checkout itself

  const session = ownerSession(card);
  const window = names.workerWindow(card.id);
  // Whether the work gets a branch is a DELIVERY contract, so the playbook owns
  // it: `branch: false` = detached HEAD, nothing to push. With no key, the card
  // type decides as it always has (an investigation delivers a report).
  const cuts = typeof meta.branch === 'boolean' ? meta.branch : card.type !== 'investigation';
  const branch = cuts ? 'bc/' + card.id : null;
  const prompt = workerBrief({
    template, card, task: body && body.brief, thread: card.thread || [],
    project, worktree: wt.path, branch: branch || '', workspace: WORKSPACE,
    stateDir: STATE_DIR, cli: path.join(__dirname, '..', 'cli', 'bc-axi'),
  });
  const spawnOpts = { session, window, stateDir: HARNESS_STATE_DIR, callbackUrl: TURNEND_URL };
  const extraArgs = [];
  // Model precedence mirrors harness: explicit --model wins, else the
  // playbook's frontmatter.
  const modelHint = (body && body.model) || meta.model;
  if (modelHint) extraArgs.push('--model', String(modelHint));
  if (body && body.effort) extraArgs.push('--effort', String(body.effort));
  if (extraArgs.length) spawnOpts.extraArgs = extraArgs;
  let ref;
  try {
    ref = await impl.spawn(wt.path, prompt, spawnOpts);
  } catch (e) {
    await releaseWorktree(wt, project.path).catch(() => {}); // best-effort: no spawnless lease left behind
    return { error: 'worker spawn failed: ' + String((e && e.message) || e), code: 502 };
  }
  if (!findCard(card.id)) { // archived while provisioning/spawn were in flight
    Promise.resolve().then(() => impl.kill(ref)).catch(() => {});
    await releaseWorktree(wt, project.path).catch(() => {});
    return { error: 'card left the board during start: ' + card.id, code: 409 };
  }

  card.attributes.worktree = wt.path;
  // Cleared when this run cuts none: a card restarted on a no-branch template
  // would otherwise keep the last run's value, and everything downstream —
  // lifecycle hooks, the rendered brief — would read a branch that is not there.
  if (branch) card.attributes.branch = branch;
  else delete card.attributes.branch;
  attachBriefArtifact(card, ref);
  const worker = { card: card.id, ref, worktree: wt, project: project.name, spawnedAt: now(), done: false };
  stampWorkerAddress(card, worker);
  if (branch) worker.branch = branch;
  // Recorded at start because the handoff is where they are read, and the
  // playbook is resolved HERE and only here.
  if (meta.keep_worktree) worker.keepWorktree = true;
  if (meta.teardown) worker.teardown = meta.teardown;
  board.workers.push(worker);
  enterWorking(card, 'worker ' + workerName(ref) + ' started in ' + wt.path);
  return { worker };
}

// The stale-state is over: signal, done, resume, pause, a turn-end or leaving
// Working all reset the escalation ladder, so the next stall starts quiet again.
function clearStale(w) {
  delete w.staleNotified;
  delete w.staleNotifiedAt;
  delete w.staleHits;
}

// The worker's most recent words: whichever of the turn-end text and the
// signal text carries the newer stamp, falling back to the one that exists.
function lastWordOf(w) {
  const turn = w.lastTurnEndText ? Date.parse(w.lastTurnEnd) : NaN;
  const sig = w.lastSignalText ? Date.parse(w.lastSignalAt) : NaN;
  if (!Number.isNaN(turn) && !Number.isNaN(sig)) return sig > turn ? w.lastSignalText : w.lastTurnEndText;
  return w.lastTurnEndText || w.lastSignalText || '';
}

// worker.signal — a real milestone from the worker: level-2 event on the card
// + a QueueItem to the owning lieutenant.
function workerSignal(card, body) {
  const text = String((body && body.text) || '').trim();
  if (!text) return { error: 'text required' };
  const w = findWorker(card.id);
  if (w) {
    delete w.stopNotified; // a fresh signal starts a fresh stop-state
    clearStale(w);
    w.lastSignalAt = now(); // a milestone is real activity: resets the stale clock
    w.lastSignalText = text.slice(0, 300); // what the stall alert quotes as the worker's last word
  }
  const ev = mkEvent({ text: text.slice(0, 2000), actor: (body && body.actor) || 'worker' }, { kind: 'signal' });
  card.events.push(ev);
  card.updated = now();
  queuePush(card.owner, { kind: 'worker-signal', card: card.id, text: text.slice(0, 2000) });
  return { ok: true, event: ev };
}

// worker done — the worker finished: event + QueueItem to the owner. The card
// does NOT move — the lieutenant verifies the work, rewrites the body, and
// hands off to review itself. PR URLs in the outcome auto-populate the card's
// `prs` attribute (state open — the PR watch takes it from there); an
// investigation's report file is auto-attached as a card artifact.
const PR_URL_RE = /https:\/\/github\.com\/[\w.-]+\/[\w.-]+\/pull\/\d+/g;
function workerDone(card, body) {
  const outcome = String((body && body.outcome) || '').trim();
  if (!outcome) return { error: 'outcome required' };
  const w = findWorker(card.id);
  if (w) {
    w.done = true; w.outcome = outcome.slice(0, 2000);
    delete w.flagged; delete w.stopNotified; clearStale(w);
    delete w.expectExit; delete w.pauseReason; // the gate it stopped at is behind it
  }
  const urls = outcome.match(PR_URL_RE) || [];
  if (urls.length) {
    if (!Array.isArray(card.attributes.prs)) card.attributes.prs = [];
    for (const url of urls) {
      if (!card.attributes.prs.some((p) => p && p.url === url)) card.attributes.prs.push({ url, state: 'open' });
    }
  }
  if (card.type === 'investigation') {
    const report = path.join(STATE_DIR, 'reports', card.id + '.md');
    if (fs.existsSync(report)) {
      if (!Array.isArray(card.attributes.artifacts)) card.attributes.artifacts = [];
      const uri = 'file://' + report;
      if (!card.attributes.artifacts.some((a) => a && a.uri === uri)) {
        card.attributes.artifacts.push({ uri, label: 'report' });
      }
    }
  }
  const ev = mkEvent({ text: 'worker done: ' + outcome.slice(0, 1900), actor: (body && body.actor) || 'worker' }, { kind: 'worker-done' });
  card.events.push(ev);
  card.updated = now();
  queuePush(card.owner, { kind: 'worker-done', card: card.id, text: outcome.slice(0, 2000) });
  return { ok: true, event: ev };
}

// worker.send — lieutenant -> live worker: deliver text into the worker's
// session through the harness typer (verified submission), the same send half
// captain-feedback delivery uses for its wake. Workers have no queue, so the
// pane IS the delivery — the send is awaited and its real outcome reported;
// a level-2 card event records what was handed over.
async function workerSend(card, body) {
  const text = String((body && body.text) || '').trim();
  if (!text) return { error: 'text required' };
  const w = findWorker(card.id);
  if (!w) {
    return { error: 'no worker bound to card ' + card.id + ' — start one first (card start ' + card.id + ')', code: 404 };
  }
  let up = false;
  try { up = await harnessFor(w.ref).alive(w.ref); } catch (e) { up = false; }
  if (w.done) {
    // The ground first: the handoff released the worktree this session sits in,
    // so neither way back — reopen here, or the resume the dead branch below
    // points at — has anywhere to write. Checked BEFORE liveness so the answer
    // comes in one hop instead of sending the caller to a resume that refuses.
    if (w.worktree && w.worktree.path && !fs.existsSync(w.worktree.path)) {
      return { error: 'worker for ' + card.id + ' reported done and its worktree was released at the handoff ('
        + w.worktree.path + ') — a reopened turn would have nowhere to write. Start a fresh worker '
        + '(card start ' + card.id + ' — it spawns over this finished session), or, for a playbook whose '
        + 'cards are reworked in place, set `keep_worktree: true` in its frontmatter', code: 409 };
    }
    // A done-but-DEAD worker is a genuine restart: point at the resume recipe.
    if (!up) {
      return { error: 'worker for ' + card.id + ' reported done and its session is gone — revive it first (card start ' + card.id + ' --resume), then send', code: 409 };
    }
    // Done but its session is still alive+idle: reopen the turn in place (the
    // reset mirrors the resume path) instead of 409-ing, so a send re-enters
    // Working without the undiscoverable two-step resume.
    w.done = false;
    delete w.outcome;
    delete w.flagged;
    delete w.stopNotified;
    clearStale(w);
    delete w.paused;
    delete w.killFailed; // alive and working again: the next failed kill is news
    delete w.expectExit; // the stop is over; --resume is a legal move again
    delete w.pauseReason;
    enterWorking(card, 'worker ' + workerName(w.ref) + ' reopened for a new turn');
  } else if (!up) {
    return { error: 'worker session ' + workerName(w.ref) + ' is not alive — resume it first (card start ' + card.id + ' --resume), then send', code: 409 };
  }
  try {
    await harnessFor(w.ref).send(w.ref, text);
  } catch (e) {
    return { error: 'delivery to ' + workerName(w.ref) + ' failed: ' + String((e && e.message) || e), code: 502 };
  }
  const ev = mkEvent({ text: 'sent to worker: ' + text.slice(0, 1900), actor: (body && body.actor) || 'agent' }, { kind: 'worker-send' });
  card.events.push(ev);
  card.updated = now();
  return { ok: true, event: ev, session: workerName(w.ref) };
}

// worker.pause — a DELIBERATE stop: kill the worker's session but record the
// stop as intentional, so supervision never reports it as a crash (the whole
// point — a `tmux kill-session` otherwise reads as WORKER DIED). The paused
// marker is set BEFORE the kill (the supervision tick re-checks it after its
// own alive() await, closing the mark/kill race) and the registry entry +
// worktree/branch stay intact, so `card start --resume` revives the worker
// exactly like a died one. body.park composes the park (Working → Backlog).
//
// body.expectExit — the OTHER kind of deliberate stop: the session is about to
// end BY ITSELF and the caller is inside it. A worker that stops at an approval
// gate and returns leaves nothing running, and without a word beforehand that
// reads as WORKER DIED. Killing here would kill the caller mid-sentence, so the
// marker is recorded and nothing is killed. body.reason replaces the resume
// hint, because how you revive one of those is not `card start --resume`.
//
// That replacement is not a nicety — `--resume` on an expect-exit worker is
// ACTIVELY WRONG (it spawns a second run over the one the first is still
// holding), so the stop is recorded on the registry entry as
// {expectExit, pauseReason} and `card start --resume` refuses it by name. A
// reason text alone only informs whoever reads it; the refusal is what stops
// the lieutenant who reached for the move the board teaches everywhere else.
async function pauseWorker(card, body) {
  const w = findWorker(card.id);
  if (!w) return { error: 'no worker recorded for card ' + card.id + ' — nothing to pause', code: 404 };
  if (w.done) {
    return { error: 'worker for ' + card.id + ' already reported done — nothing to pause (the lieutenant verifies and hands off)', code: 409 };
  }
  if (body && body.park && card.column !== 'working') {
    return { error: 'pause --park needs a Working card — ' + card.id + ' is in ' + columnTitle(card.column), code: 409 };
  }
  w.paused = now(); // BEFORE the kill: the death must never look like a crash
  delete w.stopNotified;
  clearStale(w);
  if (!(body && body.expectExit)) {
    try {
      await harnessFor(w.ref).kill(w.ref);
    } catch (e) {
      delete w.paused; // the session may still be alive — stay honest, let supervision judge
      return { error: 'pause failed killing session ' + workerName(w.ref) + ': ' + String((e && e.message) || e), code: 502 };
    }
  }
  const actor = String((body && body.actor) || 'agent').slice(0, 60);
  const reason = String((body && body.reason) || '').trim().slice(0, 500)
    || 'resume: card start ' + card.id + ' --resume';
  if (body && body.expectExit) {
    w.expectExit = true;
    w.pauseReason = reason; // the door back, quoted verbatim by the resume refusal
  } else {
    delete w.expectExit; // an ordinary pause is resumable, and says so
    delete w.pauseReason;
  }
  const ev = mkEvent({
    text: 'worker ' + workerName(w.ref) + ' paused (deliberate) — ' + reason,
    actor,
  }, { kind: 'worker-paused' });
  card.events.push(ev);
  card.updated = now();
  const out = { ok: true, event: ev, session: workerName(w.ref) };
  if (body && body.park) {
    const p = await parkCard(card, body);
    if (p.error) { out.parked = false; out.parkError = p.error; }
    else { out.parked = true; out.parkEvent = p.event; }
  }
  return out;
}

// card.park — the narrow lieutenant door out of Working: Backlog, legal ONLY
// when the recorded worker is absent or dead (liveness re-checked HERE, server
// side — the CLI's opinion is not trusted), so the Working ⇔ live-worker
// invariant is never weakened. A live worker refuses loudly: pausing is
// worker.pause's job. The dead worker's record stays for card start --resume.
async function parkCard(card, body) {
  if (card.column !== 'working') {
    return { error: 'park moves a Working card back to Backlog — ' + card.id + ' is in ' + columnTitle(card.column), code: 409 };
  }
  const w = findWorker(card.id);
  if (w) {
    let up = false;
    try { up = await harnessFor(w.ref).alive(w.ref); } catch (e) { up = false; }
    if (up) {
      return w.done
        ? { error: 'refusing to park ' + card.id + ': its worker reported done and session ' + workerName(w.ref)
            + ' is still alive — verify the work and hand off (card move ' + card.id + ' review), or archive', code: 409 }
        : { error: 'refusing to park ' + card.id + ': worker session ' + workerName(w.ref)
            + ' is ALIVE — pause it first (worker pause ' + card.id + ' [--park]) or let it finish', code: 409 };
    }
  }
  const from = card.column;
  card.column = 'backlog';
  card.pendingOrder = null;
  card.updated = now();
  if (w) { delete w.stopNotified; clearStale(w); } // leaving Working ends the stop/stale-state
  const ev = mkEvent({
    actor: (body && body.actor) || 'agent',
    text: 'parked (worker ' + (w ? workerName(w.ref) + (w.paused ? ', paused' : ', dead') : 'absent') + '): '
      + columnTitle(from) + ' → ' + columnTitle('backlog'),
  }, { kind: 'parked' });
  card.events.push(ev);
  return { ok: true, event: ev };
}

// ---------- supervision loop (invariant 8: supervision is infrastructure) ----------
// Every ~30s: harness.alive on every lieutenant + worker ref.
//   lieutenant dead  -> harness.resume when resumable (memory recoverable),
//                       else harness.spawn with charter + board digest (same
//                       session name either way), ref updated, level-1 event,
//                       nudge to drain; max 3 failed attempts then a level-1
//                       needs-captain flag (attempts reset when alive).
//   worker dead w/o done -> QueueItem to the owner + level-2 card event; the
//                       card STAYS Working but the registry entry is flagged —
//                       the owner decides (card start --resume, or move back).
//   worker done      -> nothing to watch (the done QueueItem already landed).
const SUPERVISE_MS = process.env.BC_SUPERVISE_INTERVAL_MS !== undefined
  ? parseInt(process.env.BC_SUPERVISE_INTERVAL_MS, 10) : 30000;
// The alive-but-hung gap: a worker stuck inside a single turn (e.g. an
// infinite tool loop) emits NONE of the three end-of-life signals — alive()
// stays true (no worker-died), the turn never ends (no worker-stopped), and
// done is never reached. Long silence on a Working card is the only tell.
// 30min default: the brief cadence is a milestone every 10–30min, so a
// healthy worker resets the clock well inside the window.
const BC_WORKER_STALE_SECS = process.env.BC_WORKER_STALE_SECS !== undefined
  ? parseInt(process.env.BC_WORKER_STALE_SECS, 10) : 1800;
const respawnAttempts = new Map(); // lieutenant id -> consecutive failed respawns
let supervising = false;
async function superviseTick() {
  if (supervising) return; // never overlap ticks
  supervising = true;
  try {
    let changed = false;
    for (const lt of board.lieutenants) {
      if (!isHarnessRef(lt.ref)) continue;
      let impl = null;
      try { impl = harnessFor(lt.ref); } catch (e) { impl = null; }
      // A lieutenant's session is shared with its worker windows, so its ref
      // must name its own window (names.LIEUTENANT_WINDOW) — a session-granular
      // one would kill every worker on revive and read liveness off whichever
      // window has focus. Refs registered before that (founders, older boards)
      // are migrated here, in place: the running lieutenant is renamed into its
      // window, never restarted. Best-effort — a tick on the old ref is fine.
      if (impl && !lt.ref.window && typeof impl.adoptWindow === 'function') {
        try {
          const taken = board.workers
            .filter((w) => w.ref.session === lt.ref.session && w.ref.window)
            .map((w) => w.ref.window);
          const ref = await impl.adoptWindow(lt.ref, names.LIEUTENANT_WINDOW, taken);
          if (ref) { lt.ref = ref; changed = true; }
        } catch (e) { /* keep the old ref; the next tick tries again */ }
      }
      // /reset is restarting this lieutenant right now: between its kill and
      // its spawn it is legitimately down, and respawning here would race that
      // spawn for the same pane.
      if (cyclingLieutenants.has(lt.id)) continue;
      let up = false;
      try { up = impl ? await impl.alive(lt.ref) : false; } catch (e) { up = false; }
      if (up) {
        respawnAttempts.delete(lt.id);
        // Alive but possibly deaf: a wake that landed in a busy pane never
        // became a turn, yet was recorded as sent. Re-run scheduleWake — it
        // no-ops while the last nudge is within WAKE_TTL_MS or nothing is
        // pending, so only a genuinely stuck wake re-fires.
        if (pendingItems(lt.id).length) scheduleWake(lt.id);
        continue;
      }
      // Asked again on the way out: the kill can land DURING the alive()
      // round-trip, so a tick that passed the check above still gets down=true
      // from a lieutenant /reset is legitimately restarting.
      if (cyclingLieutenants.has(lt.id)) continue;
      const n = (respawnAttempts.get(lt.id) || 0) + 1;
      if (n > 3) continue; // already flagged needs-captain; a manual revival resets via alive
      respawnAttempts.set(lt.id, n);
      try {
        // Resume when memory is recoverable; else relaunch a fresh session with
        // charter + owned cards + pending queue as the prompt (the DNA's
        // auto-respawn side effect) — a bare agent with no context helps nobody.
        const opts = { stateDir: HARNESS_STATE_DIR, callbackUrl: TURNEND_URL, installHooks: false };
        let ref;
        if (await impl.resumable(lt.ref, opts)) {
          ref = await impl.resume(lt.ref, opts);
        } else {
          // Keep the session name (an incarnation, not a new entity) when it is
          // spawnable; a founder's foreign name gets a workspace-scoped one.
          const session = /^bc-[A-Za-z0-9_-]+$/.test(lt.ref.session)
            ? lt.ref.session : names.lieutenantSession(WORKSPACE, lt.id);
          const window = lt.ref.window || names.LIEUTENANT_WINDOW;
          // Clear any dead pane still holding the name — the lieutenant's
          // WINDOW, never its session: the worker windows cohabiting it are
          // alive and did not ask to die (an unmigrated ref would take them all).
          await impl.kill({ ...lt.ref, window });
          ref = await impl.spawn(lt.ref.cwd, respawnPrompt(lt), Object.assign({ session, window }, opts));
        }
        lt.ref = ref;
        respawnAttempts.delete(lt.id);
        board.events.push(mkEvent({
          text: 'lieutenant ' + lt.name + ' session died — respawned as ' + ref.harness + ':' + ref.session,
          actor: 'server',
        }, { kind: 'respawned' }));
        changed = true;
        nudged.delete(lt.id); // the reincarnated session owes a drain: queue is truth, its memory is a cache
        if (pendingItems(lt.id).length) scheduleWake(lt.id);
        else {
          const target = lt.ref;
          Promise.resolve()
            .then(() => harnessFor(target).send(target, '[bridge-commander] session respawned — run: bc-axi drain'))
            .catch(() => {});
        }
      } catch (e) {
        console.error(now() + ' respawn failed for ' + lt.id + ' (attempt ' + n + '/3): ' + String((e && e.message) || e));
        if (n === 3) {
          board.events.push(mkEvent({
            text: 'lieutenant ' + lt.name + ' is down and 3 respawn attempts failed — needs the captain (session ' + lt.ref.session + ')',
            actor: 'server',
          }, { kind: 'needs-captain' }));
          respawnAttempts.set(lt.id, 4);
          changed = true;
        }
      }
    }
    for (const w of board.workers) {
      if (w.done || w.flagged || w.paused) continue;
      let up = false;
      try { up = await harnessFor(w.ref).alive(w.ref); } catch (e) { up = false; }
      // Staleness watchdog (alive-but-hung): checked BEFORE the alive
      // early-continue, only for a genuinely live, unpaused worker on a
      // Working card. It RINGS AGAIN: one worker-stalled per
      // BC_WORKER_STALE_SECS of continued silence, quiet (level 2) the first
      // time, level 1 from the second hit on — a worker nobody answered for
      // two windows is the captain's problem, and the text says what it last
      // said so he can judge from the feed. Any real activity — signal,
      // turn-end, resume — resets the ladder.
      if (up && !w.paused && BC_WORKER_STALE_SECS > 0) {
        const card = findCard(w.card);
        if (card && card.column === 'working') {
          const stamps = [w.spawnedAt, w.lastTurnEnd, w.lastSignalAt]
            .map((t) => (t ? Date.parse(t) : NaN)).filter((n) => !Number.isNaN(n));
          const lastActivity = stamps.length ? Math.max(...stamps) : 0;
          const notifiedAt = w.staleNotifiedAt ? Date.parse(w.staleNotifiedAt) : NaN;
          const sinceNotify = Number.isNaN(notifiedAt) ? Infinity : Date.now() - notifiedAt;
          const window = BC_WORKER_STALE_SECS * 1000;
          if (lastActivity && Date.now() - lastActivity > window && sinceNotify > window) {
            w.staleNotified = true;
            w.staleNotifiedAt = now();
            w.staleHits = (w.staleHits || 0) + 1;
            const mins = Math.round((Date.now() - lastActivity) / 60000);
            const lastWord = lastWordOf(w);
            let text = 'worker ' + workerName(w.ref) + ' alive but silent for '
              + mins + 'min (no signal/turn-end) — may be hung';
            if (w.staleHits >= 2) {
              text += ' — still silent, alert #' + w.staleHits
                + (lastWord ? '; last said: ' + JSON.stringify(lastWord.slice(0, 300)) : '');
            }
            const level = w.staleHits >= 2 ? 1 : 2;
            card.events.push(mkEvent({ text, actor: 'server', level }, { kind: 'worker-stalled' }));
            card.updated = now();
            queuePush(card.owner, { kind: 'worker-stalled', card: card.id, text });
            changed = true;
          }
        }
      }
      // paused re-checked after the await: a pause landing mid-tick (marked,
      // then killed while alive() was in flight) must not read as a crash.
      if (up || w.paused) continue;
      w.flagged = true;
      changed = true;
      const card = findCard(w.card);
      if (card) {
        card.events.push(mkEvent({
          text: 'worker session ' + workerName(w.ref) + ' died without reporting done',
          actor: 'server',
        }, { kind: 'worker-died' }));
        card.updated = now();
        queuePush(card.owner, {
          kind: 'worker-died', card: card.id,
          text: 'worker session ' + workerName(w.ref) + ' died without reporting done',
        });
        fireHooks('worker-died', card, w); // fire-and-forget
      }
    }
    if (changed) { saveBoard(); broadcast(); }
  } finally {
    supervising = false;
  }
}
if (Number.isInteger(SUPERVISE_MS) && SUPERVISE_MS > 0) setInterval(superviseTick, SUPERVISE_MS).unref();

// ---------- PR watch (F6: merged PR ⇒ archive + release, no agent turn) ----------
// Every ~2min: for every card whose `prs` attribute holds an open URL, ask gh.
// MERGED -> a pr-merged event + owner item per PR that landed; then, ONLY when
// no PR of the card is left open (a stack merges one at a time), release the
// worktree (only when clean — uncommitted work is never discarded) and archive
// the card (reason merged: the landed level-1 event). CLOSED (unmerged) -> mark
// the state and tell the owner; the card stays. gh failures leave state untouched.
const PRWATCH_MS = process.env.BC_PRWATCH_INTERVAL_MS !== undefined
  ? parseInt(process.env.BC_PRWATCH_INTERVAL_MS, 10) : 120000;
const GH_CMD = process.env.BC_GH_CMD || 'gh'; // injectable for tests
function ghPrState(url) {
  return new Promise((resolve) => {
    execFile(GH_CMD, ['pr', 'view', url, '--json', 'state,mergedAt'], { timeout: 30000 }, (err, stdout) => {
      if (err) return resolve(null);
      try { resolve(JSON.parse(stdout)); } catch (e) { resolve(null); }
    });
  });
}
let prWatching = false;
async function prWatchTick() {
  if (prWatching) return;
  prWatching = true;
  try {
    for (const card of [...board.cards]) {
      const prs = card.attributes && card.attributes.prs;
      if (!Array.isArray(prs) || !prs.some((p) => p && p.state === 'open' && p.url)) continue;
      const merged = []; // every PR of this card that landed in THIS tick
      let changed = false;
      for (const pr of prs) {
        if (!pr || pr.state !== 'open' || !pr.url) continue;
        const st = await ghPrState(pr.url);
        if (!st || !st.state) continue;
        if (st.state === 'MERGED') { pr.state = 'merged'; merged.push(pr); changed = true; }
        else if (st.state === 'CLOSED') {
          pr.state = 'closed';
          changed = true;
          card.events.push(mkEvent({ text: 'PR closed without merge: ' + pr.url, actor: 'server', level: 2 }, {}));
          queuePush(card.owner, { kind: 'pr-closed', card: card.id, text: pr.url });
        }
      }
      if (!changed) continue;
      // one signal per PR that landed — a stack can flip several between polls
      for (const pr of merged) {
        card.events.push(mkEvent({ text: 'PR merged: ' + pr.url, actor: 'server' }, { kind: 'pr-merged' }));
        queuePush(card.owner, { kind: 'pr-merged', card: card.id, text: pr.url });
      }
      // a stack card only finishes when nothing is left open: a partial merge
      // keeps the card on the board, the worktree alive and the hooks unfired.
      const anyOpenLeft = prs.some((p) => p && p.state === 'open');
      if (merged.length && !anyOpenLeft) {
        const w = findWorker(card.id);
        let note = merged.map((p) => p.url).join(' ');
        // Same order as the archive endpoint: the worker dies first (awaited
        // and verified — usually a no-op, the handoff having killed it), then
        // the card-archived hooks run — and finish or time out — BEFORE the
        // worktree release, since a hook may need paths inside $BC_WORKTREE.
        const kill = await killCardWorker(card, w, { reason: 'the PR merged' });
        await fireHooks('card-archived', card, w, { boardLevel: true });
        // the archive record is the only place a merged card's refusal is
        // readable afterwards, so the reason rides the note as well as the
        // timeline event the release lands
        const rel = await releaseCardWorktree(card, w);
        if (rel && !rel.released) note += ' (worktree NOT released: ' + rel.reason + ')';
        if (kill && kill.killed) dropWorkerRecord(card, w);
        // The address goes on the card BEFORE the snapshot freezes, exactly as
        // the archive endpoint does it: the drop above is what usually stamps
        // it, and the drop is skipped whenever the kill could not be verified —
        // the one case where somebody most needs to go find that transcript.
        // Only ever this run's own address, though: the hooks and the release
        // above are awaited on budgets measured in minutes, and a rework
        // restart inside that window binds a NEW worker to a card still on the
        // board. Writing the dead run's session over the live one's would send
        // the lieutenant to a session that no longer exists.
        if (findWorker(card.id) === w) stampWorkerAddress(card, w);
        archiveCard(card, { reason: 'merged', note, actor: 'server' }); // landed — the level-1 bell
      }
      saveBoard(); broadcast();
    }
  } finally {
    prWatching = false;
  }
}
if (Number.isInteger(PRWATCH_MS) && PRWATCH_MS > 0) setInterval(prWatchTick, PRWATCH_MS).unref();

// ---------- the clock (schedules; server/schedules.js holds the timing) ----------
//
// A schedule fires A HOOK, through `hook run` and nothing else — the clock gets
// no private door. Everything a firing needs to decide (which card, whether to
// wake anybody, what to say) is the hook's business, because a hook is bash
// with `bc-axi` on its PATH.
//
// The cursor is `lastWindow`: the DUE TIME of the last window this schedule
// handled. Windows are a function of that cursor and the clock, so a restart
// neither loses a due window nor fires one twice — the tick after the boot sees
// exactly the windows that came due while nobody was looking, and the catch-up
// policy says what to do with them.
const SCHEDULE_MS = process.env.BC_SCHEDULE_INTERVAL_MS !== undefined
  ? parseInt(process.env.BC_SCHEDULE_INTERVAL_MS, 10) : 15000;
// The line between "missed while the server was down" and "came due while we
// were watching" — the whole meaning of catch-up `none`.
const SCHEDULER_BOOT = Date.now();

function findSchedule(name) { return board.schedules.find((s) => s.name === name); }
// The trace's `trigger` for a firing. It names the SCHEDULE, not just "a
// schedule": two schedules on one hook each read their own last fire out of
// hookruns.jsonl, and nobody keeps a second copy of what already happened.
function scheduleTrigger(s) { return 'schedule:' + s.name; }

// scheduleProblem(s) -> '' or why this schedule cannot fire right now. Checked
// on EVERY tick, not just at `add`: a hook deleted out from under a live
// schedule has to make that schedule say so, rather than failing silently every
// window forever.
function scheduleProblem(s) {
  try { parseWhen(s.when); } catch (e) { return e.message; }
  // A cursor that is not a date is a DEAD window: every due-window question is
  // asked from it, and all of them answer nothing, forever. board.json is
  // git-tracked, so a bad merge or a hand edit is how this arrives — and a
  // clock that quietly stops is the exact failure this card replaces. Said out
  // loud here for the same reason an unparseable `when` is, and healed the same
  // way any cursor is: pause and resume re-arms it at now.
  if (s.lastWindow && Number.isNaN(Date.parse(s.lastWindow))) {
    return 'cursor "' + s.lastWindow + '" is not a date — this schedule cannot work out what is due'
      + ' (bc-axi schedule pause ' + s.name + ' && bc-axi schedule resume ' + s.name + ' re-arms it at now)';
  }
  if (!namedHookFile(WORKSPACE, s.hook)) {
    return 'hook "' + s.hook + '" is gone from ' + hooksDir(WORKSPACE) + ' — this schedule fires nothing';
  }
  if (!findLieutenant(s.owner)) {
    return 'owner "' + s.owner + '" is not a registered lieutenant — a failure here would land nowhere';
  }
  return '';
}

// A problem is announced ONCE, when it appears, and once when it clears. The
// board's bell is level 1 because a schedule that stopped firing is exactly the
// silent failure this card exists to end; a level-2 line marks the recovery.
// An unregistered owner cannot be woken, so the board stream is all there is.
// The kind travels onto the QUEUE ITEM as well as the timeline entry, and the
// two must be the same one: the drain dispatches on the item's kind alone, so a
// recovery labelled `schedule-failed` reaches its owner headlined "a firing
// failed" and advised to fix the hook and pause the schedule — advice that is
// exactly backwards for the schedule that just told them it is working again.
function announceScheduleProblem(s, problem) {
  const text = problem
    ? 'schedule ' + s.name + ' cannot fire: ' + problem
    : 'schedule ' + s.name + ' is healthy again';
  const kind = problem ? 'schedule-failed' : 'schedule';
  board.events.push(mkEvent({ text, actor: 'server', level: problem ? 1 : 2 }, { kind }));
  if (findLieutenant(s.owner)) {
    queuePush(s.owner, { kind, schedule: s.name, text, source: 'schedule ' + s.name });
  }
}

// A schedule is not a card, so it gets its own scope in the key store rather
// than a parallel store of its own. The `@` is what keeps the two apart for
// good: a card id has to start with a word character, so no card can ever be
// spelled like this.
function scheduleKeyScope(s) { return '@schedule:' + s.name; }

// The SIGNATURE of a failure: how it went wrong, plus the tail of what it said.
// Two windows that failed the same way are the same failure and are worth one
// wake between them; a hook that starts exiting 4 instead of 3, or says
// something new, is a different failure and is worth hearing about.
function failureKey(run) {
  const how = run.timedOut ? 'timeout' : run.error ? 'spawn' : 'exit:' + run.code;
  const tail = String(run.output || '').slice(-500);
  return how + ':' + crypto.createHash('sha1').update(tail).digest('hex').slice(0, 12);
}

// A firing that fails lands on its OWNER, carrying the hook's output — never
// only in a log. The trace already holds the run detail; this is the wake.
//
// Announced ONCE, the way announceScheduleProblem announces a problem once, and
// through the key store MNC-24 already built for this shape. A 5m schedule
// whose hook is permanently broken fails 288 times a day, and a drain holding
// 288 identical items is quieter than one holding a single item, because its
// owner stops reading it. A repeat still lands on the timeline at level 2 — the
// record stays whole; the bell and the queue item are the only things the key
// spends.
function landScheduleFailure(s, run) {
  const how = run.timedOut ? 'timed out' : run.error ? String(run.error)
    : run.code === null ? 'killed' : 'exit ' + run.code;
  const text = ('schedule ' + s.name + ' — hook ' + s.hook + ' FAILED (' + how + ')'
    + (run.output ? ':\n' + run.output : '')).slice(0, 2000);
  // ask -> deliver -> claim, the order the pair documents: claiming first would
  // make a delivery that throws a wake forever answered "duplicate".
  const scope = scheduleKeyScope(s);
  const key = failureKey(run);
  const fresh = !seenEventKey(scope, key);
  board.events.push(mkEvent({ text, actor: 'server', level: fresh ? 1 : 2 },
    { kind: 'schedule-failed' }));
  if (fresh && findLieutenant(s.owner)) {
    queuePush(s.owner, { kind: 'schedule-failed', schedule: s.name, text,
      source: 'schedule ' + s.name });
  }
  saveBoard(); broadcast();
  if (fresh) claimEventKey(scope, key);
}

// The other half of announcing once: silence has to mean one thing. The first
// green firing after a failing one says so on the timeline and forgets the key,
// so the next failure is heard as new rather than swallowed as a repeat of one
// that is already fixed.
function landScheduleRecovery(s) {
  if (!forgetEventKeys(scheduleKeyScope(s))) return;
  board.events.push(mkEvent({ text: 'schedule ' + s.name + ' — hook ' + s.hook + ' is green again',
    actor: 'server', level: 2 }, { kind: 'schedule' }));
  saveBoard(); broadcast();
}

// recordSkip(s, why) — a firing that did NOT run is still a firing. `skip` that
// swallows its windows makes a schedule which never runs look exactly like one
// that is working, so every skipped window gets a line in the same trace the
// runs land in.
function recordSkip(s, why) {
  traceSkip(WORKSPACE, { hook: s.hook, trigger: scheduleTrigger(s), reason: 'skipped: ' + why });
}

// The run this schedule's hook is holding, named the way the EBUSY refusal
// names it — an operator reading a skip afterwards has to be able to find the
// firing that displaced the window, and `started` + `trigger` is what identifies
// it on the trace. A pass between windows holds no run: say so rather than
// invent one.
function inFlightFiring(s) {
  const run = runningHook(WORKSPACE, s.hook);
  if (!run) return 'the firing in flight is still running';
  return 'the firing in flight (trigger ' + run.trigger + ', started ' + run.started
    + (run.card ? ', card ' + run.card : '') + ') is still running';
}

// fireSchedule(s) -> 'ran' | 'skipped' | 'queued' — one window, awaited to the
// end. The EBUSY here is the OTHER overlap: not this schedule's own previous
// firing (the tick handles that, below) but somebody else's run of the same
// hook — the board's ▶, a lieutenant at the CLI, a second schedule. Same
// policy, because from the window's point of view it is the same situation.
async function fireSchedule(s) {
  const trigger = scheduleTrigger(s);
  for (let attempt = 0; ; attempt++) {
    try {
      const run = await runNamedHook(WORKSPACE, s.hook, {}, {
        trigger, timeoutMs: HOOK_TIMEOUT_MS || 0,
      });
      // A run cancelled to make room for another already answered its own
      // caller; only a genuine failure wakes the owner, and only a genuine
      // success closes a failure that is still open.
      if (!run.ok && !run.canceled) landScheduleFailure(s, run);
      else if (run.ok) landScheduleRecovery(s);
      return 'ran';
    } catch (e) {
      if (e && e.code === 'ENOHOOK') return 'skipped'; // scheduleProblem says it on the next tick
      if (!e || e.code !== 'EBUSY') throw e;
      if (s.overlap === 'queue') return 'queued';
      if (s.overlap === 'restart' && attempt === 0) {
        await cancelNamedHook(WORKSPACE, s.hook);
        continue; // and if someone took the name in that instant, skip below
      }
      recordSkip(s, e.message);
      return 'skipped';
    }
  }
}

// runSchedule(s, windows) — one schedule's due windows, oldest first, ONE AT A
// TIME. A catch-up backlog is not an overlap: `all` over a weekend means fire
// each of those windows, in order, and the next one starts when the last one is
// done. Runs outside the tick, which decides and never waits.
//
// Two cursors, deliberately, and the difference between them is the whole
// durability story:
//
//   the CLAIM   in memory, keyed by the schedule OBJECT, alive for exactly as
//               long as a pass is. The windows a pass took stop being due the
//               moment it takes them, so the ticks that go by while a
//               six-minute hook runs see the overlap policy and not the same
//               backlog again. Keyed by the object and not by the name because
//               a name can be removed and given to a new schedule while a pass
//               is still running, and that new schedule is not the one firing.
//   lastWindow  on disk, and it lags the claim on purpose. board.json still
//               names the pre-pass window for the whole run, so a machine
//               powered off mid-hook comes back and offers that window again.
//               At-least-once is the promise a clock can keep; at-most-once
//               would lose the firing outright, with nothing anywhere to say a
//               window had ever come due.
//
// A pass writes the claim it REACHED — which the overlap policy's skips have
// been moving all along — never the cursor it started with, or `skip` would
// turn into back-to-back firing and the trace would hold skips for windows that
// then ran. `queue` is the one outcome that lands somewhere earlier: the window
// it could not take is re-offered on the next tick.
const claimed = new Map();
async function runSchedule(s, windows) {
  let requeue = null;
  try {
    for (const w of windows) {
      const outcome = await fireSchedule(s);
      if (outcome === 'queued') { requeue = w - 1; break; } // re-offered next tick
    }
  } catch (e) {
    console.error(now() + ' schedule ' + s.name + ' failed to fire: ' + String((e && e.message) || e));
  } finally {
    // Nothing above this line is awaited by anybody, so a board write that fails
    // here is an unhandled rejection — which is to say the whole server, killed
    // by a full disk while a hook was running. It is contained like every other
    // background loop's failure.
    try {
      const reached = requeue !== null ? requeue : claimed.get(s);
      // FORWARD only, and only onto the schedule this pass actually owns. Both
      // halves are load-bearing. A `resume` that landed while the hook ran has
      // already re-armed the cursor at now — a pause is not a queue — and
      // stamping an older claim over it would make the whole paused interval
      // due. And a schedule removed and re-added under the same name is a
      // different schedule: it must not start life owing a dead pass's backlog.
      // The `queue` pull-back is not a rewind, so it survives this: `w - 1` is
      // never earlier than the cursor the pass started from.
      const owned = findSchedule(s.name) === s;
      if (owned && reached !== undefined && reached > (Date.parse(s.lastWindow) || 0)) {
        s.lastWindow = new Date(reached).toISOString();
        saveBoard(); broadcast();
      }
    } catch (e) {
      console.error(now() + ' schedule ' + s.name + ': the board would not save after a firing: '
        + String((e && e.message) || e));
    }
  }
}

// The overlap POLICY: a window came due while this schedule's PREVIOUS firing
// is still running. It is a policy over `hook run`'s refusal, not a second
// opinion about what is running — the five-minute poll that takes six minutes
// is the case, and all three answers are defensible depending on the hook.
//
//   skip     don't run — and record every window it dropped
//   queue    leave the cursor where it is; the window is re-offered when the
//            firing in flight finishes. It survives a restart because the
//            cursor is board state, not a list in memory
//   restart  kill what is running (the whole process group, traced as canceled)
//            and let the next tick start the window that displaced it
function overlapPolicy(s, due) {
  if (s.overlap === 'queue') return;
  if (s.overlap === 'restart') {
    cancelNamedHook(WORKSPACE, s.hook).catch(() => {});
    return;
  }
  // Two different firings in one line, and keeping them apart is the whole
  // point of writing it: the window being DROPPED, and the firing it lost to.
  // The run in flight is read off `hook run`'s own registry (started, trigger)
  // rather than guessed from the windows here, which are the dropped ones.
  const lost = inFlightFiring(s);
  for (const w of due) recordSkip(s, 'window ' + new Date(w).toISOString() + ' — ' + lost);
  // Against the CLAIM, because a skip belongs to the pass in flight: it reaches
  // board.json when that pass finishes, and a crash before then leaves the
  // window due again — which is the honest answer, since nothing ran.
  claimed.set(s, due[due.length - 1]);
}

let scheduleTicking = false;
async function scheduleTick() {
  if (scheduleTicking) return;
  scheduleTicking = true;
  try {
    let changed = false;
    const nowMs = Date.now();
    for (const s of [...board.schedules]) {
      const problem = scheduleProblem(s);
      if (problem !== s.problem) {
        // A paused schedule still reports a problem it has — you pause a clock,
        // you do not stop wanting to know its hook was deleted — but announcing
        // it would be a wake nobody asked for.
        if (!s.paused) announceScheduleProblem(s, problem);
        s.problem = problem;
        changed = true;
      }
      if (problem || s.paused) continue;
      const when = parseWhen(s.when);
      const anchor = Date.parse(s.created) || 0;
      // A schedule that has never fired starts its cursor HERE: `add` is not a
      // firing, and a fresh 5m schedule that fired the instant it was created
      // would make every `add` a surprise.
      if (!s.lastWindow) { s.lastWindow = new Date(nowMs).toISOString(); changed = true; continue; }
      // The claim, when a pass holds one, is ahead of the stored cursor — see
      // runSchedule. Reading past both is what stops a pass being offered the
      // windows it already took.
      const from = Math.max(Date.parse(s.lastWindow), claimed.get(s) || 0);
      const due = dueWindows(when, from, nowMs, anchor);
      if (!due.windows.length) continue;
      // Its own previous firing is still running: that is what `overlap` is for.
      if (claimed.has(s)) { overlapPolicy(s, due.windows); continue; }
      const { fire, dropped } = pickWindows(due, s.catchup, SCHEDULER_BOOT);
      if (dropped) {
        // No silent caps: a policy that drops windows says how many, so `all`
        // hitting its ceiling is never mistaken for full coverage.
        console.error(now() + ' schedule ' + s.name + ': ' + dropped + ' due window(s) not fired (catch-up '
          + s.catchup + ')');
      }
      // The claim is taken HERE, before anything is awaited, so no second pass
      // can ever be handed these windows. It reaches board.json when the pass
      // ends, and it reaches it even for a firing that threw — at-least-once
      // belongs to delivery, and a schedule that retries a broken hook every
      // tick forever is a wake storm, not a recovery. The trace and the owner's
      // drain hold what happened.
      claimed.set(s, due.windows[due.windows.length - 1]);
      // Deliberately not awaited: the tick's job is to decide, not to wait out
      // a hook. Every window still fires in order, one at a time, per schedule.
      // The claim is dropped out here rather than inside, so a pass that somehow
      // dies on the way out cannot wedge the schedule shut forever.
      runSchedule(s, fire)
        .finally(() => claimed.delete(s))
        .catch((e) => console.error(now() + ' schedule ' + s.name + ': '
          + String((e && e.message) || e)));
    }
    if (changed) { saveBoard(); broadcast(); }
  } catch (e) {
    console.error(now() + ' schedule tick failed: ' + String((e && e.message) || e));
  } finally {
    scheduleTicking = false;
  }
}
if (Number.isInteger(SCHEDULE_MS) && SCHEDULE_MS > 0) setInterval(scheduleTick, SCHEDULE_MS).unref();

// What `schedule list` and `schedule show` read: the stored schedule plus the
// two things that make it trustworthy — when it fires next, and how it last
// went. The last fire comes off hookruns.jsonl (one backward walk for the whole
// list); there is no second copy of a run anywhere on this board.
function publicSchedules() {
  const last = lastRunsFor(WORKSPACE, board.schedules.map((s) => ({
    key: s.name, hook: s.hook, trigger: scheduleTrigger(s),
  })));
  return board.schedules.map((s) => {
    let next = null;
    try {
      const when = parseWhen(s.when);
      // A schedule that has never fired will arm at now, so now is the honest
      // answer for an empty cursor. An unparseable one is a different thing
      // entirely: there is no next fire to compute, and printing a plausible
      // "in 4m" for a clock that will never fire again is the lie `problem` is
      // there to replace.
      const from = s.lastWindow ? Date.parse(s.lastWindow) : Date.now();
      if (!Number.isNaN(from)) {
        const t = nextAfter(when, from, Date.parse(s.created) || 0);
        next = t ? new Date(t).toISOString() : null;
      }
    } catch (e) { /* an unparseable `when` has no next fire — `problem` says why */ }
    return Object.assign({}, s, { next, last: last.get(s.name) || null, describe: describeWhenSafe(s.when) });
  });
}
function describeWhenSafe(text) {
  try { return describeWhen(parseWhen(text)); } catch (e) { return String(text || ''); }
}

// validateSchedule(body) -> {error} | {schedule}
// The refusals are the point of `add`: a bad expression names the offending
// text, a hook that is not there is refused before it can become a dead window
// every five minutes, and an unregistered owner is refused because a firing's
// failure would land nowhere.
function validateSchedule(body) {
  const name = String(body.name || '').trim();
  if (!SCHEDULE_NAME_RE.test(name)) {
    return { error: 'bad schedule name "' + name + '" (letters, digits, _ . - ; starts with a letter, digit or _)' };
  }
  if (findSchedule(name)) return { error: 'schedule "' + name + '" already exists', status: 409 };
  const hook = String(body.hook || '').trim();
  if (!HOOK_NAME_RE.test(hook)) return { error: 'a schedule fires a NAMED hook — give one with --hook' };
  if (!namedHookFile(WORKSPACE, hook)) {
    return { error: 'no hook "' + hook + '" — a named hook is an executable file in ' + hooksDir(WORKSPACE)
      + ' (bc-axi hook list). A schedule naming a hook that does not exist is a window that fires nothing' };
  }
  let when;
  try { when = parseWhen(body.when); } catch (e) { return { error: e.message }; }
  const owner = String(body.owner || '').trim();
  if (!findLieutenant(owner)) {
    return { error: 'unknown lieutenant "' + owner + '" — a schedule needs an owner for its failures to land on' };
  }
  const overlap = body.overlap === undefined || body.overlap === null || body.overlap === ''
    ? 'skip' : String(body.overlap);
  if (!OVERLAP.includes(overlap)) return { error: 'overlap must be one of: ' + OVERLAP.join(', ') };
  const catchup = body.catchup === undefined || body.catchup === null || body.catchup === ''
    ? 'latest' : String(body.catchup);
  if (!CATCHUP.includes(catchup)) return { error: 'catch-up must be one of: ' + CATCHUP.join(', ') };
  return { schedule: { name, hook, when: when.text, owner, overlap, catchup,
    paused: false, created: now(), lastWindow: '', problem: '' } };
}

// ---------- static ui ----------
const MIME = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8', '.svg': 'image/svg+xml', '.png': 'image/png',
  // The keep-alive's loops. music.js fetches them as bytes and would not care
  // what this said — but a captain auditioning one before he merges it opens
  // the URL, and a browser plays audio/mp4 where it downloads octet-stream.
  '.m4a': 'audio/mp4',
  // The room's environment assets. A browser will sniff an image whatever this
  // says, but an HDR arrives through fetch() as bytes and a wrong type is the
  // kind of thing that works everywhere until it does not.
  '.webp': 'image/webp', '.hdr': 'image/vnd.radiance',
  '.glb': 'model/gltf-binary', '.gltf': 'model/gltf+json', '.ktx2': 'image/ktx2',
};
function serveStatic(res, rel) {
  const file = path.normalize(path.join(UI_DIR, rel));
  if (!file.startsWith(UI_DIR + path.sep) && file !== path.join(UI_DIR, 'index.html')) {
    return sendJson(res, 404, { error: 'not found' });
  }
  let data;
  try { data = fs.readFileSync(file); } catch (e) { return sendJson(res, 404, { error: 'not found' }); }
  // Two populations of file, two opposite policies — and `no-cache` was the
  // wrong answer for both. It permits a store-and-revalidate, and with no
  // validator to revalidate against, a phone behind a CDN handed the captain
  // yesterday's JavaScript three separate times. Each time it looked like a bug
  // in the thing he was actually testing, which is the expensive kind of wrong.
  //
  // Ours changes every few minutes and is small: never store it.
  // Vendored builds are immutable — their version is in the path, so a new
  // version is a new URL — and one of them is four megabytes: keep it a year.
  // Anchored at the start and cut at a separator: `ui/vendor/…` is vendored,
  // anything merely spelled like it is ours. No file exercises that difference
  // today, which is why it is written strictly here rather than pinned below.
  // `ui/env/` is the same population as `ui/vendor/`: fetched-once assets that
  // are replaced by editing the manifest rather than by mutating a file. One of
  // them is a 5.4 MB sky, and re-downloading it on every open — over a headset's
  // wifi — is the difference between a room that appears and one he gives up
  // waiting for. `no-store` on that would have been a real bug in the field and
  // never once in a test.
  const vendored = /^(vendor|env|audio)([/\\]|$)/.test(rel);
  res.writeHead(200, {
    'Content-Type': MIME[path.extname(file)] || 'application/octet-stream',
    'Cache-Control': vendored ? 'public, max-age=31536000, immutable' : 'no-store',
  });
  res.end(data);
}

// The one uri the artifact routes accept that is not listed on a card: a
// playbook. The config screen edits them in the same editor a card artifact
// opens in, which means the same GET, the same version check and the same 409 —
// a second file API would be a second place to get all of that wrong. So the
// widening is exactly one shape and nothing else: `<playbooks dir>/<name>.md`,
// one level deep, no symlink. The directory is DERIVED here, never taken from
// the client.
//
// Returns 'workspace' | 'packaged' | '' — the same two populations
// resolvePlaybook picks between, and the difference is what may be written.
// The packaged set is a git checkout of this repo: readable, so the captain can
// open one and copy it, and never written in place.
function playbookSource(uri) {
  if (typeof uri !== 'string' || !uri.startsWith('file://')) return '';
  const file = uri.slice('file://'.length);
  // path.resolve is idempotent on a clean absolute path — a `..` segment or a
  // relative path changes it, so `<dir>/../../board.json` never gets this far.
  if (path.resolve(file) !== file) return '';
  if (path.extname(file) !== '.md') return '';
  const dir = path.dirname(file);
  const source = dir === playbooksDir(STATE_DIR) ? 'workspace'
    : dir === PACKAGED_PLAYBOOKS_DIR ? 'packaged' : '';
  if (!source) return '';
  // A symlink IN the dir is not a file in the dir: what it points at is what
  // would be read or written. Refused here rather than followed. (ENOENT is
  // fine — that is the copy-to-workspace create, and PUT guards the dir itself.)
  try { if (fs.lstatSync(file).isSymbolicLink()) return ''; }
  catch (e) { if (e.code !== 'ENOENT') return ''; }
  return source;
}

// The second — and last — uri the artifact routes accept that is no card's:
// a lieutenant's charter, `<workspace>/lieutenants/<id>/README.md`. The config
// screen edits it in the same editor a playbook opens in, so it rides the same
// GET, the same version check and the same 409.
//
// The widening is exactly one shape. charterPath() BUILDS the only acceptable
// path from the workspace root and a REGISTERED id, and the uri has to equal
// it — which is what refuses an unregistered id, another file in that folder, a
// subdirectory of it, and a directory prefix from the client all at once.
// Returns the path when it is one, '' otherwise.
function charterFile(uri) {
  if (typeof uri !== 'string' || !uri.startsWith('file://')) return '';
  const file = uri.slice('file://'.length);
  // path.resolve is idempotent on a clean absolute path — a `..` segment or a
  // relative path changes it, so `<dir>/../../board.json` never gets this far.
  if (path.resolve(file) !== file) return '';
  if (!board.lieutenants.some((l) => charterPath(WORKSPACE, l.id) === file)) return '';
  // A symlink named README.md is not the charter: what it points at is what
  // would be read or written. Refused here rather than followed. (ENOENT is
  // fine — a lieutenant that has never written its memory file still opens it.)
  try { if (fs.lstatSync(file).isSymbolicLink()) return ''; }
  catch (e) { if (e.code !== 'ENOENT') return ''; }
  return file;
}

// The third — and last — uri the artifact routes accept that is no card's: a
// HOOK file. The hooks tab's ✎ opens one in the same editor a playbook opens
// in, which is where "he asks a lieutenant to help build one" happens: a file
// on a screen he can point at.
//
// The widening is exactly one shape, and it is the namespace hooks.js already
// defines: an executable file under <workspace>/.bridge-commander/hooks/, ONE
// level deep (a named hook) or TWO (a lifecycle hook, in its event's
// directory). The containing directory is BUILT here from STATE_DIR and
// compared for equality — never taken from the client — the way charterFile()
// does it, and the two names in it have to look like ids, so a traversal never
// survives the comparison.
//
// Returns the path when the uri is one, '' otherwise. A file that is not there
// YET is still one (that is the create), which is why the leaf check tolerates
// ENOENT and nothing else: a symlink, a directory and a socket all fail
// isFile() and are refused rather than followed.
// Three answers, because two of them are different things:
//   null      — not a hook path at all. Falls through to the other allowlists,
//               and the caller gets the ordinary "unknown artifact" refusal.
//   {file}    — a hook path the board reads and writes.
//   {error}   — a hook path that is LEGAL and whose tree is not there. Answering
//               "unknown artifact" to a legal path is a lie: the name is fine,
//               the id is fine, the only thing missing is a directory. So it
//               says which one, and what would have fired it.
function hookTarget(uri) {
  if (typeof uri !== 'string' || !uri.startsWith('file://')) return null;
  const file = uri.slice('file://'.length);
  // path.resolve is idempotent on a clean absolute path — a `..` segment or a
  // relative path changes it, so `<dir>/../../board.json` never gets this far.
  if (path.resolve(file) !== file) return null;
  if (!HOOK_NAME_RE.test(path.basename(file))) return null;
  const dir = path.dirname(file);
  const root = hooksDir(WORKSPACE);
  // '' = a named hook, one level deep. Otherwise the EVENT directory it sits in.
  let event = '';
  if (dir !== root) {
    if (path.dirname(dir) !== root || !HOOK_NAME_RE.test(path.basename(dir))) return null;
    event = path.basename(dir);
  }
  let real;
  try { real = fs.realpathSync(dir); }
  catch (e) {
    if (e.code !== 'ENOENT') return null;
    // The directory is not there. `hooks/` is a CONSTANT the board owns, so the
    // write below makes it — the same one level `charterFile` makes for a
    // lieutenant that never wrote its memory file, and the path the card names
    // when it says a new hook is a file a lieutenant writes.
    if (!event) return { file };
    // An event directory is NOT a constant: creating one invents a lifecycle
    // event, and a typo'd event is a hook that silently never fires, forever,
    // with nothing to notice it. So this stays a refusal — one that names the
    // event and the ones that exist, instead of pretending the path is unknown.
    return { code: 400, error: 'no hook event directory "' + event + '" — the board fires '
      + LIFECYCLE_EVENTS.join(', ') + '. Create ' + dir + ' yourself if that is really the event: '
      + 'one invented here would be a hook that never runs' };
  }
  // The directory has to be reached without following a link: a symlinked
  // hooks/ (or event dir) points somewhere else, and somewhere else is the
  // whole thing this refuses. Not a hook path, so it refuses as one.
  if (real !== dir) return null;
  try { if (!fs.lstatSync(file).isFile()) return null; }
  catch (e) { if (e.code !== 'ENOENT') return null; }
  return { file };
}

// ---------- server ----------
const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://localhost');
  const p = url.pathname;
  const route = req.method + ' ' + p;
  try {
    // ----- ui -----
    if (route === 'GET /') return serveStatic(res, 'index.html');
    if (req.method === 'GET' && p.startsWith('/ui/')) return serveStatic(res, p.slice(4));

    // ----- reads -----
    if (route === 'GET /api/board') return sendJson(res, 200, publicBoard(url.searchParams.get('user') || 'user'));
    if (route === 'GET /api/config') return sendJson(res, 200, userConfig());
    // ----- the TTS engine, on the board's own origin -----
    // Any method, any path under the prefix, streamed both ways. No engine
    // configured means no route at all: this falls through to the ordinary 404
    // and the board is as silent as it is with no tts block.
    if (p === TTS_PREFIX || p.startsWith(TTS_PREFIX + '/')) {
      const t = ttsConfig();
      // p, not a decoded path: what the browser encoded is what the engine gets.
      if (t) return proxyTts(req, res, t.url, p.slice(TTS_PREFIX.length) + url.search);
    }
    // ----- the STT engine, same deal (the websocket half is on 'upgrade') -----
    if (p === STT_PREFIX || p.startsWith(STT_PREFIX + '/')) {
      const t = sttConfig();
      if (t) return proxyStt(req, res, t.url, p.slice(STT_PREFIX.length) + url.search);
    }
    if (route === 'GET /api/status') {
      let pending = 0;
      for (const lt of queueIds()) pending += pendingItems(lt).length;
      return sendJson(res, 200, {
        // `host` is what this process actually BOUND, not what config said —
        // a caller that wants a different bind (init/open --host) can only tell
        // by asking, and a server that ignored the flag silently is the bug
        // that sent a stranger a URL their browser could not reach.
        workspace: WORKSPACE, port: PORT, host: BIND_HOST, cards: board.cards.length,
        lieutenants: board.lieutenants.length, seq: board.seq,
        queue_seq: qseq, queue_pending: pending,
        projects: board.projects.length, workers: board.workers.length,
        pid: process.pid,
        code: CODE, // {root, commit, short, dirty} as of BOOT — the CLI compares it to HEAD now
        sysload: sysload.stats(), // the monitoring refcount probe: {subscribers, sampling}
      });
    }
    // ----- first-run state (the onboarding conversation's memory) -----
    // Onboarding is a conversation, and a conversation that restarts from the
    // top on every server bounce is a conversation nobody finishes. The step
    // lives on the board (so it survives the session that is having it, and the
    // UI ships with it in GET /api/board) and Bridget reads it as her first act.
    if (route === 'GET /api/onboarding') return sendJson(res, 200, { onboarding: board.onboarding || null });
    if (route === 'POST /api/onboarding') {
      const body = JSON.parse(await readBody(req) || '{}');
      const cur = board.onboarding || { started: now() };
      const step = body.step === undefined ? cur.step : String(body.step || '');
      if (step && !ONBOARDING_STEPS.includes(step)) {
        return sendJson(res, 400, { error: 'unknown step: ' + step + ' (want ' + ONBOARDING_STEPS.join(' | ') + ')' });
      }
      const next = Object.assign({}, cur, body, { step, updated: now() });
      delete next.actor;
      board.onboarding = next;
      saveBoard(); broadcast();
      return sendJson(res, 200, { ok: true, onboarding: board.onboarding });
    }
    if (route === 'GET /api/archive') {
      // Paginated read over the append-only log, newest first: a limit+offset
      // window plus the total, so the UI's 🧊 archived mode can page-in ("load
      // more") instead of slurping an unbounded jsonl in one go. Offset-less
      // calls keep their old meaning (the newest `limit` records) and the
      // response stays a superset of the old shape (CLI reads `archive` only).
      const n = parseInt(url.searchParams.get('limit') || '50', 10) || 50;
      const off = parseInt(url.searchParams.get('offset') || '0', 10) || 0;
      const all = readArchive().reverse();
      return sendJson(res, 200, { archive: all.slice(off, off + n), total: all.length });
    }
    if (route === 'GET /api/notifications') {
      const items = notificationItems(url.searchParams.get('user'));
      return sendJson(res, 200, { items, unread: items.filter((e) => !e.read).length });
    }
    // Artifact directory serve. `/api/artifact?uri=…` is not a path: a page at
    // that address resolving `./audio.wav` asks the board for `/api/audio.wav`,
    // so there is no directory for a relative path to sit in — which is why
    // artifact pages had to inline their assets as base64. `/artifacts/<dir>/<rel>`
    // gives the page a folder, and its siblings load the way every relative path
    // on the web does. Scoped to the artifact's own directory: <dir> must be the
    // directory of a listed artifact, and the resolved file must stay inside it —
    // not as a security claim, but because "this URL means this folder" is what
    // makes a relative path mean anything.
    const adir = /^\/artifacts\/([^/]+)\/(.+)$/.exec(p);
    if (adir && req.method === 'GET') {
      let dir, rel;
      try { dir = decodeURIComponent(adir[1]); rel = decodeURIComponent(adir[2]); }
      catch (e) { return sendJson(res, 400, { error: 'bad artifact path' }); }
      const listed = dir && path.resolve(dir) === dir &&
        board.cards.some((c) => Array.isArray(c.attributes && c.attributes.artifacts) &&
          c.attributes.artifacts.some((a) => a && typeof a.uri === 'string' && a.uri.startsWith('file://') &&
            path.dirname(a.uri.slice('file://'.length)) === dir));
      if (!listed) return sendJson(res, 404, { error: 'unknown artifact directory' });
      const file = path.resolve(dir, rel);
      if (!file.startsWith(dir + path.sep)) return sendJson(res, 403, { error: 'outside the artifact directory' });
      let st;
      try { st = fs.statSync(file); }
      catch (e) { return sendJson(res, 404, { error: 'unreadable: ' + e.message }); }
      if (!st.isFile()) return sendJson(res, 404, { error: 'not a file' });
      if (st.size > ARTIFACT_MAX_BYTES) return sendJson(res, 413, { error: 'artifact too large (max ' + ARTIFACT_MAX_BYTES + ' bytes)' });
      // No sandbox CSP: the board has no auth and binds to the tailnet, so anyone
      // who reaches it can already ask a lieutenant to run anything. Hardening
      // this page against that board defends nothing.
      return sendBytes(req, res, fs.readFileSync(file), {
        'Content-Type': ARTIFACT_MIME[path.extname(file).toLowerCase()] || 'application/octet-stream',
        'Cache-Control': 'no-store',
        'X-Content-Type-Options': 'nosniff',
      });
    }
    // Artifact serve, for the UI's popup viewer. Servable is a uri listed
    // verbatim in some live card's attributes.artifacts, or one of the
    // workspace-owned files the same screen edits (playbookSource, charterFile,
    // hookTarget) — never an arbitrary file read. Same allowlist the write below
    // uses, plus the packaged playbooks, which are read-only.
    // Default (no raw): TEXT content of the file. raw=1: the raw
    // bytes with a real Content-Type, backing the inline <img> and downloads.
    if (route === 'GET /api/artifact') {
      const uri = url.searchParams.get('uri') || '';
      const raw = url.searchParams.get('raw') === '1' || url.searchParams.get('raw') === 'true';
      const charter = charterFile(uri);
      const ht = hookTarget(uri);
      if (ht && ht.error) return sendJson(res, ht.code, { error: ht.error });
      const hook = (ht && ht.file) || '';
      const listed = board.cards.some((c) => Array.isArray(c.attributes && c.attributes.artifacts) &&
        c.attributes.artifacts.some((a) => a && a.uri === uri)) || !!playbookSource(uri) || !!charter || !!hook;
      if (!listed) return sendJson(res, 404, { error: 'unknown artifact' });
      // A promoted chat attachment (attachment://id) resolves to its stored file
      // via the sidecar; file:// / bare paths read directly.
      let file = uri.startsWith('file://') ? uri.slice('file://'.length) : uri;
      let name = path.basename(file);
      let attMime = '';
      const am = /^attachment:\/\/(.+)$/.exec(uri);
      if (am) {
        const meta = readAttachmentMeta(am[1]);
        if (!meta) return sendJson(res, 404, { error: 'unknown attachment' });
        file = meta.path; name = meta.name; attMime = meta.mime || '';
      }
      if (raw) {
        // Byte mode. Only a real local file is servable: an attachment path is
        // already vetted by readAttachmentMeta; a plain artifact must be a
        // file:// absolute path with no traversal escaping it (path.resolve is
        // idempotent on a clean absolute path — a `..` segment or a relative
        // path changes it, so it is rejected).
        if (!am) {
          if (!uri.startsWith('file://')) return sendJson(res, 400, { error: 'not a file artifact' });
          if (path.resolve(file) !== file) return sendJson(res, 400, { error: 'unsafe artifact path' });
        }
        let st;
        try { st = fs.statSync(file); }
        catch (e) { return sendJson(res, 404, { error: 'unreadable: ' + e.message }); }
        if (!st.isFile()) return sendJson(res, 404, { error: 'not a file' });
        if (st.size > ARTIFACT_MAX_BYTES) return sendJson(res, 413, { error: 'artifact too large (max ' + ARTIFACT_MAX_BYTES + ' bytes)' });
        const ext = path.extname(name).toLowerCase();
        // A curated .html/.htm artifact (teach-me page, report) is a self-contained
        // document meant to be *rendered*: serve it as text/html inline so a page
        // opened here shows, not its source. Scoped to plain file artifacts, not
        // attachments (an uploaded .html keeps its neutralized download behavior)
        // and never a HOOK: a hook is a script whose basename the writer chooses,
        // so `hooks/report.html` is a legal hook path and rendering it would make
        // the gate that writes hooks a way to run script on the board's origin.
        const isHtml = !am && !hook && (ext === '.html' || ext === '.htm');
        const ctype = isHtml ? 'text/html; charset=utf-8'
          : am ? (attMime || 'application/octet-stream')
          : (ARTIFACT_MIME[ext] || 'application/octet-stream');
        // Images, video, audio, pdf, and rendered html show inline in the browser;
        // other binaries download. nosniff pins the Content-Type; the sandbox CSP
        // neutralizes an uploaded SVG/HTML if it is navigated to as a document
        // (inline <img>/<video> subresources unaffected). A curated .html artifact
        // is exempt — it is the captain's own deliverable, and sandboxing it against
        // a board anyone on the tailnet can drive defends nothing.
        const inline = isHtml || /^(image|video|audio)\//.test(ctype) || ctype === 'application/pdf';
        let data;
        try { data = fs.readFileSync(file); }
        catch (e) { return sendJson(res, 404, { error: 'unreadable: ' + e.message }); }
        return sendBytes(req, res, data, {
          'Content-Type': ctype,
          'Cache-Control': 'private, max-age=31536000, immutable',
          'X-Content-Type-Options': 'nosniff',
          ...(isHtml ? {} : { 'Content-Security-Policy': 'sandbox' }),
          'Content-Disposition': (inline ? 'inline' : 'attachment') + '; filename="' + name.replace(/["\\\r\n]/g, '_') + '"',
        });
      }
      let data;
      try { data = fs.readFileSync(file); }
      catch (e) {
        // A BOARD-OWNED file that is not written yet reads as the empty document
        // at version '' — whatever kind it is. The board owns the path (it built
        // it, not the client), so the file's absence is a state, not a 404: a
        // lieutenant that has never written its memory, a hook nobody has typed
        // yet. And '' is exactly what the PUT below reads as "I expect no file",
        // so the first 💾 creates it. A card artifact is NOT board-owned — that
        // path came from the card, and a missing one is genuinely unreadable.
        if ((charter || hook) && e.code === 'ENOENT') return sendJson(res, 200, { name, content: '', version: '' });
        return sendJson(res, 404, { error: 'unreadable: ' + e.message });
      }
      if (data.length > 2e6) return sendJson(res, 413, { error: 'file too large to preview' });
      if (data.includes(0)) return sendJson(res, 415, { error: 'binary file' });
      // The version travels with the content so an editor can hand it back on
      // save: sha256 of the exact bytes on disk. Content-derived on purpose —
      // mtime+size misses two writes in the same second at the same length.
      return sendJson(res, 200, { name, content: data.toString('utf8'), version: sha256(data) });
    }

    // Artifact WRITE — what the file editor's save actually does. Deliberately
    // narrow: this is an artifact editor, not remote arbitrary-file write on
    // this machine. The board has no auth of its own (the network boundary is
    // the auth boundary), so every guard below is load-bearing:
    //   - the uri must ALREADY be listed on a live card, or be a WORKSPACE
    //     playbook (playbookSource), or a registered lieutenant's charter
    //     (charterFile), or a hook file (hookTarget) — the GET's allowlist minus
    //     the packaged playbooks, which are read-only. Anything else is 403, and
    //     there is no flag to turn it off;
    //   - file:// only, absolute, no `..` (path.resolve is idempotent on a
    //     clean absolute path), and no symlink anywhere along it (realpath must
    //     come back unchanged), so a listed artifact can never be a door to
    //     somewhere else;
    //   - attachment:// is immutable: an upload is the record of what was sent.
    // Lost-update guard: the client sends the version it read. If disk has
    // moved since, nothing is written and the answer is 409 carrying what is
    // there now — the captain's text stays on his screen either way. It applies
    // to EVERY writer, agent included (`bc-axi artifact write`): the door is
    // locked on both sides or it is not locked.
    // A write that lands also announces itself on the board SSE (event
    // `artifact`), so an editor already open on the file follows along.
    if (route === 'PUT /api/artifact') {
      let raw;
      try { raw = await readBodyUpto(req, ARTIFACT_MAX_BYTES + 65536); }
      catch (e) {
        if (e.code === 413) return sendJson(res, 413, { error: 'content too large (max ' + ARTIFACT_MAX_BYTES + ' bytes)' });
        throw e;
      }
      const body = JSON.parse(raw || '{}');
      const uri = String(body.uri || '');
      if (typeof body.content !== 'string') return sendJson(res, 400, { error: 'content required' });
      const pbSource = playbookSource(uri);
      const charter = charterFile(uri);
      const ht = hookTarget(uri);
      if (ht && ht.error) return sendJson(res, ht.code, { error: ht.error });
      const hook = (ht && ht.file) || '';
      const listed = board.cards.some((c) => Array.isArray(c.attributes && c.attributes.artifacts) &&
        c.attributes.artifacts.some((a) => a && a.uri === uri)) || pbSource === 'workspace' || !!charter || !!hook;
      if (!listed) {
        // A packaged playbook is readable and never writable: it is a git
        // checkout of this repo, so the edit is a copy into the workspace.
        if (pbSource === 'packaged') {
          return sendJson(res, 403, { error: 'a packaged playbook is never written — copy it to the workspace first' });
        }
        return sendJson(res, 403, { error: 'not an artifact of any card — refusing to write' });
      }
      if (!uri.startsWith('file://')) return sendJson(res, 403, { error: 'only file:// artifacts are writable' });
      const file = uri.slice('file://'.length);
      if (path.resolve(file) !== file) return sendJson(res, 403, { error: 'unsafe artifact path' });
      // A listed artifact that is not on disk yet is CREATED — that is how a
      // derived file gets written beside its source (a drawing's .svg), and it
      // is the SAME lost-update rule with "nothing there" as the version read:
      // an empty version means "I expect no file", so a file that turned up
      // meanwhile is still a 409 below. The directory has to be real, for the
      // same reason the file does.
      let st = null, real;
      try { st = fs.statSync(file); real = fs.realpathSync(file); }
      catch (e) {
        if (e.code !== 'ENOENT' || String(body.version || '') !== '') {
          return sendJson(res, 404, { error: 'unreadable: ' + e.message });
        }
        const dir = path.dirname(file);
        // A charter's folder is the board's to make: a lieutenant registered
        // without one has no other way to get `lieutenants/<id>/`. So is a
        // workspace's `hooks/` — a fixed name the board owns, and the card's
        // "a new hook is a file you or a lieutenant writes" goes through this
        // very route, so a workspace that has no hooks yet must not be the one
        // place a lieutenant cannot write the first one. An EVENT directory is
        // never made here: hookTarget refused before we got this far, because a
        // directory invented from a typo is a hook that never runs.
        // mkdir is a no-op when it is already there — including when it is a
        // symlink, which the check right below still refuses.
        if (charter || hook) { try { fs.mkdirSync(dir, { recursive: true }); } catch (e2) { /* the check below answers */ } }
        try { if (fs.realpathSync(dir) !== dir) throw new Error('symlink'); }
        catch (e2) { return sendJson(res, 403, { error: 'artifact path resolves elsewhere (symlink) — refusing to write' }); }
      }
      if (st) {
        if (!st.isFile()) return sendJson(res, 403, { error: 'not a regular file' });
        if (real !== file) return sendJson(res, 403, { error: 'artifact path resolves elsewhere (symlink) — refusing to write' });
        let cur;
        try { cur = fs.readFileSync(file); }
        catch (e) { return sendJson(res, 404, { error: 'unreadable: ' + e.message }); }
        if (cur.includes(0)) return sendJson(res, 415, { error: 'binary file' });
        const version = sha256(cur);
        if (String(body.version || '') !== version) {
          return sendJson(res, 409, {
            error: 'the file changed on disk since you opened it — nothing was written',
            version, content: cur.toString('utf8'),
          });
        }
      }
      const next = Buffer.from(body.content, 'utf8');
      if (next.length > ARTIFACT_MAX_BYTES) return sendJson(res, 413, { error: 'content too large (max ' + ARTIFACT_MAX_BYTES + ' bytes)' });
      // Atomic swap: write a sibling temp file, then rename over the original.
      // Truncating the artifact and writing into it would leave it half-written
      // if the process died mid-write; a rename either happened or it didn't.
      const tmp = path.join(path.dirname(file), '.' + path.basename(file) + '.bc-' + process.pid + '-' + Date.now() + '.tmp');
      try {
        // An existing file keeps its mode. A hook created here is born
        // EXECUTABLE — a hook the runner would skip silently is not a hook, and
        // there is no chmod on a phone.
        fs.writeFileSync(tmp, next, st ? { mode: st.mode & 0o777 } : (hook ? { mode: 0o755 } : {}));
        fs.renameSync(tmp, file);
      } catch (e) {
        try { fs.unlinkSync(tmp); } catch (e2) {}
        return sendJson(res, 500, { error: 'write failed: ' + e.message });
      }
      const newVersion = sha256(next);
      // Whoever has this file open hears about it right away — that is what
      // makes four hands four hands instead of two taking turns around a
      // reload button. The writer's own client recognizes the echo.
      broadcastArtifact(uri, newVersion, String(body.client || ''));
      return sendJson(res, 200, { ok: true, version: newVersion, bytes: next.length });
    }

    // ----- chat attachments (uploads) -----
    // POST: base64 upload transport (zero-dep). Decode, size-cap (413), sanitize,
    // store under <STATE_DIR>/uploads with a sidecar; return {id, uri, ...}.
    if (route === 'POST /api/attachments') {
      let raw;
      try { raw = await readBodyUpto(req, Math.ceil(UPLOAD_MAX_BYTES * 1.4) + 65536); }
      catch (e) {
        if (e.code === 413) return sendJson(res, 413, { error: 'upload too large (max ' + UPLOAD_MAX_BYTES + ' bytes)' });
        throw e;
      }
      const body = JSON.parse(raw || '{}');
      const b64 = String(body.dataBase64 || '');
      if (!b64) return sendJson(res, 400, { error: 'dataBase64 required' });
      let data;
      try { data = Buffer.from(b64, 'base64'); } catch (e) { data = null; }
      if (!data || !data.length) return sendJson(res, 400, { error: 'bad base64 data' });
      if (data.length > UPLOAD_MAX_BYTES) return sendJson(res, 413, { error: 'upload too large (max ' + UPLOAD_MAX_BYTES + ' bytes)' });
      const meta = storeAttachment(body.name, body.mime, data);
      return sendJson(res, 200, { id: meta.id, uri: 'attachment://' + meta.id, name: meta.name, mime: meta.mime, size: meta.size });
    }
    // GET: stream the stored bytes with the stored Content-Type. Backs both the
    // inline <img> and file downloads. Strictly within the uploads dir; unknown
    // id → 404 (readAttachmentMeta rejects any traversal in the id).
    const attRoute = /^\/api\/attachments\/([^/]+)$/.exec(p);
    if (attRoute && req.method === 'GET') {
      const meta = readAttachmentMeta(decodeURIComponent(attRoute[1]));
      if (!meta) return sendJson(res, 404, { error: 'unknown attachment' });
      let data;
      try { data = fs.readFileSync(meta.path); } catch (e) { return sendJson(res, 404, { error: 'unreadable' }); }
      // Uploaded bytes are untrusted content served from the board's own origin.
      // nosniff pins the stored Content-Type (no MIME sniffing into executable
      // types); the sandbox CSP neutralizes scripts if an HTML/SVG upload is
      // navigated to as a document — inline <img>/<video> subresources are unaffected.
      return sendBytes(req, res, data, {
        'Content-Type': meta.mime || 'application/octet-stream',
        'Cache-Control': 'private, max-age=31536000, immutable',
        'X-Content-Type-Options': 'nosniff',
        'Content-Security-Policy': 'sandbox',
      });
    }

    // ----- lieutenants -----
    // `live=1` adds what the config screen's lieutenants tab shows and the board
    // payload cannot: the next card id this lieutenant would mint, how many live
    // cards it owns, where its charter file is, and — the one fact a board tile
    // never tells you — whether its session is actually up. The probe shells out
    // to the harness once per lieutenant, so it is gated the way /api/projects
    // gates its git reads: the tab asks, nobody else pays.
    if (route === 'GET /api/lieutenants') {
      if (!/^(1|true)$/.test(url.searchParams.get('live') || '')) {
        return sendJson(res, 200, { lieutenants: board.lieutenants.map(withStatusAge) });
      }
      const lieutenants = await Promise.all(board.lieutenants.map(async (l) => Object.assign({}, withStatusAge(l), {
        cards: board.cards.filter((c) => c.owner === l.id).length,
        next: l.prefix + '-' + ((l.cardSeq || 0) + 1),
        memory: charterPath(WORKSPACE, l.id),
        session: await sessionState(l),
      })));
      return sendJson(res, 200, { lieutenants });
    }
    if (route === 'POST /api/lieutenants') {
      const body = JSON.parse(await readBody(req) || '{}');
      if (body.ref !== undefined && body.ref !== null && !isHarnessRef(body.ref)) {
        return sendJson(res, 400, { error: 'bad ref (want {harness, session, cwd, resumeId?})' });
      }
      // spawn:true births a real session (harness.spawn in the workspace root)
      // and registers the lieutenant with the returned ref; without it this is
      // registration only (the founding lieutenant brings its own ref).
      const r = body.spawn ? await spawnLieutenant(body) : createLieutenant(body);
      if (r.error) return sendJson(res, r.code || 400, { error: r.error });
      saveBoard(); broadcast();
      // `spawned` is how a re-run of `init --onboard` tells "I revived her" from
      // "she was already up" — the second is not worth a line of anyone's output.
      return sendJson(res, 200, { ok: true, lieutenant: r.lieutenant, spawned: r.spawned });
    }
    const ltRoute = /^\/api\/lieutenants\/([^/]+)$/.exec(p);
    if (ltRoute && req.method === 'DELETE') { // lieutenant.retire — explicit only
      const body = JSON.parse(await readBody(req) || '{}');
      const r = await retireLieutenant(decodeURIComponent(ltRoute[1]), body);
      if (r.error) return sendJson(res, r.code || 400, { error: r.error });
      saveBoard(); broadcast();
      return sendJson(res, 200, { ok: true, event: r.event, memory: r.memory });
    }
    if (ltRoute && req.method === 'PATCH') { // update name/color/avatar/voice/prefix/ref (init idempotency)
      const lt = findLieutenant(decodeURIComponent(ltRoute[1]));
      if (!lt) return sendJson(res, 404, { error: 'unknown lieutenant: ' + decodeURIComponent(ltRoute[1]) });
      const body = JSON.parse(await readBody(req) || '{}');
      // Prefix first, and refused before anything else applies: it is the only
      // field a peer can veto (two lieutenants may not share one), so a rejected
      // pick must not leave half a patch behind. Past cards keep the id they
      // were minted with — a prefix change is about what comes next.
      if (body.prefix !== undefined) {
        const p = validPrefix(body.prefix);
        if (!p) return sendJson(res, 400, { error: BAD_PREFIX });
        const clash = prefixOwner(p, lt.id);
        if (clash) return sendJson(res, 409, { error: prefixTakenMsg(p, clash) });
        lt.prefix = p;
      }
      if (body.ref !== undefined) {
        if (body.ref !== null && !isHarnessRef(body.ref)) {
          return sendJson(res, 400, { error: 'bad ref (want {harness, session, cwd, resumeId?} or null)' });
        }
        // A re-run of `bc-axi init` re-sends the founder's session-granular ref
        // (the caller's tmux session is all it can see). Keep the window this
        // lieutenant was already pinned to — losing it would put the ref back
        // to killing its whole session, worker windows included, on revive.
        lt.ref = body.ref && !body.ref.window && lt.ref && lt.ref.window
          && lt.ref.session === body.ref.session
          ? { ...body.ref, window: lt.ref.window }
          : body.ref;
      }
      if (body.name !== undefined && String(body.name).trim()) lt.name = String(body.name).trim().slice(0, 60);
      if (body.color !== undefined && validColor(body.color)) lt.color = body.color;
      if (body.avatar !== undefined) {
        if (body.avatar === null) delete lt.avatar;
        else if (validAvatar(body.avatar)) lt.avatar = body.avatar;
        else return sendJson(res, 400, { error: 'avatar must be an integer 0-63 or null' });
      }
      // "" / null clears the pick — the lieutenant is back to the board's voice.
      if (body.voice !== undefined) {
        const v = validVoice(body.voice);
        if (v) lt.voice = v; else delete lt.voice;
      }
      saveBoard(); broadcast();
      return sendJson(res, 200, { ok: true, lieutenant: lt });
    }

    // ----- turn boundaries (the BC_TURNEND_URL target; posted by the Stop-hook relay) -----
    // The workspace-level hook fires for ANY claude in the workspace cwd, so
    // resolution dedupes by session_id: (1) a lieutenant ref whose resumeId
    // matches; (2) a lieutenant ref whose STATE KEY (refKey — `session:lt` for
    // the usual window-granular lieutenant) matches the hook's session arg;
    // (3) a WORKER ref by resumeId then session (workers' POSTs
    // arrive from the per-spawn hooks in their isolated worktrees — resolved
    // BEFORE lieutenant attribution so a worker's first POST can never be
    // mis-adopted); (4) tmux attribution — the hook runs inside the agent's
    // pane, so its tmux_session names the owning lieutenant's ref.session
    // exactly (adopts/refreshes resumeId; works for any number of founders);
    // (5) legacy adoption — only for old hooks whose payload carries no
    // tmux_session field: exactly one ref-bearing lieutenant missing its
    // resumeId, and never a session_id whose cwd is not that lieutenant's
    // ref.cwd (a stray claude in the workspace must not become a lieutenant).
    // Anything else is some other agent in the workspace: acknowledged, ignored.
    if (route === 'POST /api/turn-end') {
      const body = JSON.parse(await readBody(req) || '{}');
      const sid = body.session_id ? String(body.session_id) : '';
      const sname = body.session ? String(body.session) : '';
      const tmux = typeof body.tmux_session === 'string' ? body.tmux_session : null;
      let lt = sid ? board.lieutenants.find((l) => isHarnessRef(l.ref) && l.ref.resumeId === sid) : null;
      // A lieutenant's hook posts its state key, which for a window-granular
      // ref is `session:lt` — matching on ref.session alone never saw it, and
      // a codex lieutenant (born without a resumeId) had no other way in.
      if (!lt && sname) lt = board.lieutenants.find((l) => isHarnessRef(l.ref) && refKey(l.ref) === sname);
      if (!lt) {
        let w = sid ? board.workers.find((x) => x.ref.resumeId === sid) : null;
        // A window-granular worker's hook posts the `session:window` key —
        // never the bare session name it shares with its lieutenant.
        if (!w && sname) w = board.workers.find((x) => workerName(x.ref) === sname);
        if (w) {
          if (sid && w.ref.resumeId !== sid) w.ref.resumeId = sid; // hook payload is ground truth
          w.lastTurnEnd = now();
          w.turns = (w.turns || 0) + 1;
          if (typeof body.text === 'string' && body.text.trim()) w.lastTurnEndText = body.text.trim().slice(0, 300);
          clearStale(w); // a turn-end is activity: the stall ladder starts over
          // turn-end is the status refresh point (context bar / /status data)
          const statusChanged = await refreshAgentStatus(w);
          // A worker turn-end IS the stop signal: a Working card whose worker
          // stopped without done would otherwise be invisible to its owner.
          // EVERY such turn-end posts — a worker re-sent after a stop that ends
          // its turn again with no signal has stopped AGAIN, and an owner who
          // heard about the first stop only is the 3h silence of CMD-26.
          // stopNotified marks "this stop was notified" for the drain hint;
          // signal/done/leaving Working clear it.
          const card = findCard(w.card);
          let stopped = false;
          if (card && card.column === 'working' && !w.done) {
            w.stopNotified = true;
            stopped = true;
            const text = 'worker ' + workerName(w.ref) + ' stopped without reporting done';
            card.events.push(mkEvent({ text, actor: 'server' }, { kind: 'worker-stopped' }));
            card.updated = now();
            queuePush(card.owner, { kind: 'worker-stopped', card: card.id, text });
          }
          saveBoard();
          if (stopped || statusChanged) broadcast();
          return sendJson(res, 200, { ok: true, lieutenant: null, worker: w.card });
        }
      }
      // Worker hooks are excluded from tmux attribution: a worker's pane sits
      // in the lieutenant session it cohabits, so its tmux_session IS that
      // lieutenant's — without this guard a stale worker POST (its record
      // already gone) would corrupt the lieutenant's resumeId. The WINDOW part
      // of the key tells them apart: `:lt` is the lieutenant's own window,
      // `:w-<card>` is a worker's (names.js — workerWindow / LIEUTENANT_WINDOW).
      const keyWindow = sname.includes(':') ? sname.slice(sname.indexOf(':') + 1) : '';
      const workerKey = !!keyWindow && keyWindow !== names.LIEUTENANT_WINDOW;
      if (!lt && tmux && !workerKey) lt = board.lieutenants.find((l) => isHarnessRef(l.ref) && l.ref.session === tmux);
      if (!lt && tmux === null && sid) {
        const cands = board.lieutenants.filter((l) => isHarnessRef(l.ref) && !l.ref.resumeId);
        if (cands.length === 1 && body.cwd && path.resolve(String(body.cwd)) === cands[0].ref.cwd) lt = cands[0];
      }
      if (!lt) return sendJson(res, 200, { ok: true, lieutenant: null });
      if (sid && lt.ref.resumeId !== sid) lt.ref.resumeId = sid; // hook payload is ground truth
      lt.lastTurnEnd = now();
      lt.turns = (lt.turns || 0) + 1;
      // turn-end is the status refresh point (context bar / /status data)
      const statusChanged = await refreshAgentStatus(lt);
      saveBoard();
      if (statusChanged) broadcast();
      // Drain-at-turn-start backstop: the lieutenant just ended a turn with
      // items still unacked. Re-nudge unless a wake is already outstanding
      // since its last drain (a drained-but-unacked queue re-nudges here; an
      // ignored outstanding wake does not loop the session forever).
      const pending = pendingItems(lt.id).length;
      if (pending) scheduleWake(lt.id);
      return sendJson(res, 200, { ok: true, lieutenant: lt.id, pending });
    }

    // ----- cards -----
    if (route === 'POST /api/cards') {
      const body = JSON.parse(await readBody(req) || '{}');
      const r = createCard(body);
      if (r.error) return sendJson(res, r.code || 400, { error: r.error });
      saveBoard(); broadcast();
      return sendJson(res, 200, { ok: true, card: publicCard(r.card, 'user') });
    }
    // restore targets a card that is NOT on the board, so it routes before the
    // find-card paths (which would 404 the normal restore case).
    const restoreRoute = /^\/api\/cards\/([^/]+)\/restore$/.exec(p);
    if (restoreRoute && req.method === 'POST') {
      const r = restoreCard(decodeURIComponent(restoreRoute[1]), JSON.parse(await readBody(req) || '{}'));
      if (r.error) return sendJson(res, r.code || 400, { error: r.error });
      saveBoard(); broadcast();
      return sendJson(res, 200, { ok: true, card: publicCard(r.card, 'user'), event: r.event });
    }
    const cardRoute = /^\/api\/cards\/([^/]+)(\/(move|events|archive|status|start|park|artifacts|worker\/signal|worker\/done|worker\/send|worker\/pause))?$/.exec(p);
    if (cardRoute) {
      const card = findCard(decodeURIComponent(cardRoute[1]));
      if (!card) return sendJson(res, 404, { error: 'unknown card: ' + decodeURIComponent(cardRoute[1]) });
      const sub = cardRoute[3];
      if (sub === 'start' && req.method === 'POST') { // card.start — the ONE atomic op into Working
        const r = await startCard(card, JSON.parse(await readBody(req) || '{}'));
        if (r.error) return sendJson(res, r.code || 400, { error: r.error });
        saveBoard(); broadcast();
        return sendJson(res, 200, { ok: true, card: publicCard(card, 'user'), worker: r.worker, resumed: !!r.resumed });
      }
      if (sub === 'worker/signal' && req.method === 'POST') {
        const r = workerSignal(card, JSON.parse(await readBody(req) || '{}'));
        if (r.error) return sendJson(res, 400, { error: r.error });
        saveBoard(); broadcast();
        return sendJson(res, 200, { ok: true, event: r.event });
      }
      if (sub === 'worker/send' && req.method === 'POST') {
        const r = await workerSend(card, JSON.parse(await readBody(req) || '{}'));
        if (r.error) return sendJson(res, r.code || 400, { error: r.error });
        saveBoard(); broadcast();
        return sendJson(res, 200, { ok: true, event: r.event, session: r.session });
      }
      if (sub === 'worker/pause' && req.method === 'POST') {
        const r = await pauseWorker(card, JSON.parse(await readBody(req) || '{}'));
        if (r.error) return sendJson(res, r.code || 400, { error: r.error });
        saveBoard(); broadcast();
        return sendJson(res, 200, { ok: true, event: r.event, session: r.session,
          parked: r.parked, parkError: r.parkError, card: publicCard(card, 'user') });
      }
      if (sub === 'park' && req.method === 'POST') {
        const r = await parkCard(card, JSON.parse(await readBody(req) || '{}'));
        if (r.error) return sendJson(res, r.code || 400, { error: r.error });
        saveBoard(); broadcast();
        return sendJson(res, 200, { ok: true, event: r.event, card: publicCard(card, 'user') });
      }
      if (sub === 'worker/done' && req.method === 'POST') {
        const r = workerDone(card, JSON.parse(await readBody(req) || '{}'));
        if (r.error) return sendJson(res, 400, { error: r.error });
        saveBoard(); broadcast();
        // The worktree STAYS: done hands the card to its lieutenant, whose first
        // job is to read the diff in it. It goes at the handoff (the move out of
        // Working), not here.
        fireHooks('worker-done', card, findWorker(card.id)); // fire-and-forget
        return sendJson(res, 200, { ok: true, event: r.event, card: publicCard(card, 'user') });
      }
      if (!sub && req.method === 'GET') {
        const pc = publicCard(card, url.searchParams.get('user') || 'user');
        pc.status = await statusWithLiveness(card, pc.status);
        return sendJson(res, 200, pc);
      }
      if (!sub && req.method === 'PATCH') {
        const r = patchCard(card, JSON.parse(await readBody(req) || '{}'));
        if (r.error) return sendJson(res, 400, { error: r.error });
        saveBoard(); broadcast();
        return sendJson(res, 200, { ok: true, card: publicCard(card, 'user') });
      }
      if (sub === 'status' && req.method === 'POST') { // status.set(card, worker{id, state}, ttl?)
        const r = setStatus(card, JSON.parse(await readBody(req) || '{}'));
        if (r.error) return sendJson(res, 400, { error: r.error });
        saveBoard(); broadcast();
        return sendJson(res, 200, { ok: true, status: cardStatus(card, 'user') });
      }
      if (sub === 'move' && req.method === 'POST') {
        const wasWorking = card.column === 'working';
        const w = findWorker(card.id);
        const r = moveCard(card, JSON.parse(await readBody(req) || '{}'));
        if (r.error) return sendJson(res, r.code || 400, { error: r.error });
        // The handoff IS the end of the work: the lieutenant has read the diff
        // and the card left Working, so the worktree goes back. A worker that
        // has not reported done keeps its checkout — a card moved out from under
        // a live or crashed worker is the one case where that directory is still
        // the only copy of anything.
        //
        // NOT awaited. The release queues behind the per-clone lock, which a
        // concurrent `card start` holds across `git fetch` + `git worktree add`
        // — seconds, minutes on a big repo — and the move used to sit there with
        // it while the card stayed visibly in Working. The move answers as soon
        // as the card has left; the release lands on the timeline when it lands,
        // and its own saveBoard/broadcast carries it (including a refusal) to
        // every screen. Same shape archive already uses.
        if (wasWorking && card.column !== 'working' && (!w || w.done)) {
          // The worker dies first and the ground goes after it: the kill is a
          // tmux window closing (fast), while the release queues behind the
          // per-clone lock and a playbook's teardown — minutes, on a bad day.
          // Chained so the timeline reads in that order; neither ever throws.
          killCardWorker(card, w, { honorKeep: true, reason: 'the handoff — the card left Working' })
            .then(async (kill) => {
              // Read BEFORE the release: a landed one deletes the pointer.
              const ground = !!((w && w.worktree && w.worktree.path)
                || (card.attributes && card.attributes.worktree));
              const rel = await releaseCardWorktree(card, w, { honorKeep: true });
              // A release that REFUSED leaves work standing on that checkout,
              // and its teardown unspent. Keep the record — archive is the next
              // release point and reads it there. So does a release that could
              // not RUN (no clone to release against, or it threw): `not
              // released` means exactly that, and only a positive signal is
              // proof the ground went. The one drop without that proof is the
              // worker that had no ground to begin with — there is nothing left
              // for its record to be the handle for.
              if (kill && kill.killed && ((rel && rel.released) || !ground)) dropWorkerRecord(card, w);
            })
            .catch((e) => console.error(now() + ' handoff teardown for ' + card.id
              + ' failed: ' + String((e && e.message) || e)));
        }
        saveBoard(); broadcast();
        return sendJson(res, 200, r);
      }
      if (sub === 'events' && req.method === 'POST') {
        const body = JSON.parse(await readBody(req) || '{}');
        if (!String(body.text || '').trim()) return sendJson(res, 400, { error: 'text required' });
        // `key`: at-most-once for this card within the window. Answered 200 —
        // a poller that already reported this is not in error, and a hook that
        // exits non-zero on it would ring the bell sixty times instead.
        const key = String(body.key || '').trim().slice(0, 200);
        if (key && seenEventKey(card.id, key)) {
          return sendJson(res, 200, { ok: true, duplicate: true, key });
        }
        // Write-ahead, then the live board — the order queuePush itself keeps.
        // The append is the step that can throw, and a throw before the push
        // must leave NOTHING behind in the board object for somebody else's
        // saveBoard to write out later: the caller was told nothing happened,
        // so a phantom entry surfacing on the next unrelated save is the one
        // duplicate --key was never meant to buy. mkEvent has already spent a
        // board.seq by then, which costs nothing — seq is monotonic, not dense.
        const ev = mkEvent(body, { level: 2 });
        // `source`: who put this here. Rides onto the timeline entry AND the
        // queue item below, so a drain at 2am says who woke you.
        const source = String(body.source || '').trim().slice(0, 60);
        if (source) ev.source = source;
        // wakeOwner: the door an outside process (a workflow, a cron, a CI hook)
        // uses to wake a card's lieutenant. Same pair every server-side wake
        // already uses — timeline entry AND a queue item — so the escalation is
        // on the record instead of interjecting in the captain's chat thread.
        // Orthogonal to level: level 1 rings THE CAPTAIN and always has. Both
        // flags together does both, deliberately — the caller asked for both.
        if (body.wakeOwner) {
          queuePush(card.owner, Object.assign(
            { kind: 'card-event', card: card.id, eventKind: ev.kind || null, text: ev.text },
            source ? { source } : {}));
        }
        card.events.push(ev);
        card.updated = now();
        saveBoard();
        // Only now: the entry is on the card and the queue item is written, so
        // this key really has been said.
        if (key) claimEventKey(card.id, key);
        broadcast();
        return sendJson(res, 200, { ok: true, event: ev });
      }
      if (sub === 'archive' && req.method === 'POST') {
        const w = findWorker(card.id); // captured BEFORE the detached chain below drops the registry entry
        // The address goes onto the card BEFORE archiveCard freezes the
        // snapshot: the drop below is detached and lands long after, when the
        // card is off the board and there is nothing left to stamp. The frozen
        // record is the only place the transcript stays findable.
        stampWorkerAddress(card, w);
        const r = archiveCard(card, JSON.parse(await readBody(req) || '{}'));
        if (r.error) return sendJson(res, 400, { error: r.error });
        saveBoard(); broadcast();
        // Hooks first, then the release — the ordering guarantee: a hook may
        // still need paths inside $BC_WORKTREE. The card is gone, so nothing
        // is ever kept here; a worktree already released at the handoff is a
        // no-op, and an unclean one stays exactly where it is.
        // The kill first — it is fast and it is what an archived card must not
        // keep — then the hooks (which may still need paths inside
        // $BC_WORKTREE), then the release. `keep_worktree` buys nothing here:
        // the card is gone, there is nothing left to rework.
        killCardWorker(card, w, { reason: 'the card was archived' })
          .then(async (kill) => {
            await fireHooks('card-archived', card, w, { boardLevel: true });
            await releaseCardWorktree(card, w);
            // Last release point there will ever be: the record has nothing
            // left to be the handle FOR, refused release or not.
            if (kill && kill.killed) dropWorkerRecord(card, w);
          })
          .catch((e) => console.error(now() + ' archive teardown for ' + card.id
            + ' failed: ' + String((e && e.message) || e)));
        return sendJson(res, 200, r);
      }
      // promote-to-artifact — the deliberate tool. POST adds, DELETE removes an
      // entry on card.attributes.artifacts. A chat upload alone never lands here.
      if (sub === 'artifacts' && req.method === 'POST') {
        const r = cardArtifactAdd(card, JSON.parse(await readBody(req) || '{}'));
        if (r.error) return sendJson(res, r.code || 400, { error: r.error });
        saveBoard(); broadcast();
        return sendJson(res, 200, { ok: true, artifact: r.artifact, card: publicCard(card, 'user') });
      }
      if (sub === 'artifacts' && req.method === 'DELETE') {
        const r = cardArtifactRemove(card, JSON.parse(await readBody(req) || '{}'));
        if (r.error) return sendJson(res, r.code || 400, { error: r.error });
        saveBoard(); broadcast();
        return sendJson(res, 200, { ok: true, removed: r.removed, card: publicCard(card, 'user') });
      }
      return sendJson(res, 405, { error: 'method not allowed' });
    }

    // ----- projects (F6) -----
    // The registry as it is stored, plus what a reader needs to trust a row.
    // `cards` is board data (the live cards whose `repo` names this project), so
    // it is always there and costs nothing. `remote` and `branch` are two git
    // reads off the clone — only ?git=1 pays for them, so the CLI and every
    // other caller of this route are unchanged.
    // Ordered by live-card count then name: the registry grows monotonically and
    // most of it is idle, so the ones actually in use lead.
    if (route === 'GET /api/projects') {
      const git = /^(1|true)$/.test(url.searchParams.get('git') || '');
      const projects = board.projects.map((p) => {
        const out = Object.assign({}, p,
          { cards: board.cards.filter((c) => c.attributes && c.attributes.repo === p.name).length });
        return git ? Object.assign(out, projectGit(p.path)) : out;
      });
      projects.sort((a, b) => (b.cards - a.cards) || String(a.name).localeCompare(String(b.name)));
      return sendJson(res, 200, { projects });
    }
    if (route === 'POST /api/projects') {
      const r = await addProject(JSON.parse(await readBody(req) || '{}'));
      if (r.error) return sendJson(res, r.code || 400, { error: r.error });
      saveBoard(); broadcast();
      return sendJson(res, 200, { ok: true, project: r.project });
    }

    // ----- playbooks (the card's `playbook` picks one by id) -----
    // Read off the filesystem on every call, never cached: editing a template
    // (or dropping a new one in) changes the next card started, with no
    // restart, and the dropdown has to say so too.
    if (route === 'GET /api/playbooks') {
      const dir = playbooksDir(STATE_DIR);
      const ids = listPlaybooks(STATE_DIR);
      // `playbooks` stays the plain id list the picker and the CLI read.
      // `items` says WHERE each one comes from — resolvePlaybook already decides
      // which file wins, so where it landed is the answer, not a second guess at
      // the same rule. That is what lets the config screen open a workspace
      // playbook for editing and offer to copy a packaged one first.
      const items = ids.map((id) => {
        const file = resolvePlaybook(STATE_DIR, id);
        return { id, file, source: path.dirname(file) === dir ? 'workspace' : 'packaged' };
      });
      // `reference` is the two vocabularies a playbook is written in, straight
      // off playbooks.js — the screen renders it, never restates it.
      return sendJson(res, 200, { playbooks: ids, items, dir,
        reference: { placeholders: PLACEHOLDERS, frontmatter: FRONTMATTER } });
    }

    // ----- hooks (the workspace's own executable scripts; server/hooks.js) -----
    // Read off the filesystem on every call, never cached: a hook dropped in a
    // second ago is in the next answer, the way playbooks work.
    //
    // `last` is the newest trace line for that hook, read from the TAIL of
    // hookruns.jsonl in one backward walk for the whole list.
    if (route === 'GET /api/hooks') {
      const hooks = listAllHooks(WORKSPACE);
      const last = lastRuns(WORKSPACE, hooks);
      return sendJson(res, 200, {
        dir: hooksDir(WORKSPACE),
        hooks: hooks.map((h) => Object.assign({}, h, {
          last: last.get(hookKey(h)) || null,
          running: h.event ? null : runningHook(WORKSPACE, h.name),
        })),
      });
    }
    // The ONE code path a named hook runs through: `bc-axi hook run` posts here,
    // and so does the board's ▶. Not a door for outside callers — an external
    // trigger runs on this machine and speaks CLI; this is what the CLI speaks
    // to, the same way every other verb does.
    if (route === 'POST /api/hooks/run') {
      const body = JSON.parse(await readBody(req) || '{}');
      const name = String(body.name || '');
      const cardId = String(body.card || '');
      let ctx = {};
      if (cardId) {
        const card = findCard(cardId);
        if (!card) return sendJson(res, 404, { error: 'unknown card: ' + cardId });
        ctx = hookContext(card, findWorker(card.id));
      }
      try {
        const run = await runNamedHook(WORKSPACE, name, ctx, {
          trigger: String(body.trigger || 'cli'),
          timeoutMs: HOOK_TIMEOUT_MS || 0,
        });
        return sendJson(res, 200, { ok: true, run });
      } catch (e) {
        if (e && e.code === 'ENOHOOK') return sendJson(res, 404, { error: e.message });
        if (e && e.code === 'EBUSY') return sendJson(res, 409, { error: e.message, running: e.running });
        throw e;
      }
    }
    // The trace, newest first. Reads the tail — never the whole file.
    if (route === 'GET /api/hookruns') {
      const limit = Math.min(parseInt(url.searchParams.get('limit') || '20', 10) || 20, 500);
      return sendJson(res, 200, {
        runs: readRuns(WORKSPACE, { hook: url.searchParams.get('hook') || '', limit }),
      });
    }

    // ----- schedules (the board's own clock) -----
    // A schedule is board state, so it rides board.json into git with everything
    // else — which is the whole difference from the host cron it replaces.
    if (route === 'GET /api/schedules') {
      return sendJson(res, 200, { schedules: publicSchedules() });
    }
    if (route === 'POST /api/schedules') {
      const body = JSON.parse(await readBody(req) || '{}');
      const v = validateSchedule(body);
      if (v.error) return sendJson(res, v.status || 400, { error: v.error });
      board.schedules.push(v.schedule);
      board.events.push(mkEvent({
        text: 'schedule ' + v.schedule.name + ' added — hook ' + v.schedule.hook + ', '
          + describeWhenSafe(v.schedule.when) + ', owner ' + v.schedule.owner,
        actor: String(body.actor || 'agent'), level: 2,
      }, { kind: 'schedule' }));
      saveBoard(); broadcast();
      return sendJson(res, 200, { ok: true, schedule: publicSchedules().find((s) => s.name === v.schedule.name) });
    }
    const schedRoute = /^\/api\/schedules\/([^/]+)$/.exec(p);
    if (schedRoute) {
      const name = decodeURIComponent(schedRoute[1]);
      const s = findSchedule(name);
      if (!s) return sendJson(res, 404, { error: 'unknown schedule: ' + name });
      if (req.method === 'GET') {
        // The firings come off the trace — the run detail is already there, and
        // a second copy on the schedule would be a second truth.
        const limit = Math.min(parseInt(url.searchParams.get('limit') || '10', 10) || 10, 200);
        const runs = readRuns(WORKSPACE, { hook: s.hook, limit: limit * 20 })
          .filter((r) => r.trigger === scheduleTrigger(s)).slice(0, limit);
        return sendJson(res, 200, { schedule: publicSchedules().find((x) => x.name === name), runs });
      }
      if (req.method === 'PATCH') {
        const body = JSON.parse(await readBody(req) || '{}');
        if (typeof body.paused !== 'boolean') return sendJson(res, 400, { error: 'only {paused: true|false} is patchable' });
        // Resuming re-arms the cursor at NOW: a schedule paused over the weekend
        // is paused, not queued, and must not wake up owing sixty windows.
        if (s.paused && !body.paused) s.lastWindow = now();
        s.paused = body.paused;
        saveBoard(); broadcast();
        return sendJson(res, 200, { ok: true, schedule: publicSchedules().find((x) => x.name === name) });
      }
      if (req.method === 'DELETE') {
        board.schedules = board.schedules.filter((x) => x.name !== name);
        board.events.push(mkEvent({ text: 'schedule ' + name + ' removed', actor: 'agent', level: 2 },
          { kind: 'schedule' }));
        saveBoard(); broadcast();
        return sendJson(res, 200, { ok: true });
      }
    }

    // ----- board-level events (free-form notify) -----
    if (route === 'POST /api/events') {
      const body = JSON.parse(await readBody(req) || '{}');
      if (!String(body.text || '').trim()) return sendJson(res, 400, { error: 'text required' });
      const ev = mkEvent(body, { level: 1 });
      board.events.push(ev);
      saveBoard(); broadcast();
      return sendJson(res, 200, { ok: true, event: ev });
    }

    // ----- kinds (registered map; idempotent replace) -----
    if (route === 'GET /api/kinds') {
      return sendJson(res, 200, { kinds: effectiveKinds(), registered: board.kinds });
    }
    if (route === 'PUT /api/kinds') {
      const doc = JSON.parse(await readBody(req) || 'null');
      if (!doc || typeof doc !== 'object' || Array.isArray(doc)) {
        return sendJson(res, 400, { error: 'kinds must be {"<kind>": {"emoji": "...", "level": 1|2}}' });
      }
      for (const [k, v] of Object.entries(doc)) {
        if (!k.trim() || !validKindEntry(v)) {
          return sendJson(res, 400, { error: 'bad kind "' + k + '": each entry needs {emoji: non-empty string, level: 1|2}' });
        }
      }
      const next = sanitizeKinds(doc);
      if (JSON.stringify(next) === JSON.stringify(board.kinds)) {
        return sendJson(res, 200, { ok: true, kinds: Object.keys(board.kinds).length, unchanged: true });
      }
      board.kinds = next;
      saveBoard(); broadcast();
      return sendJson(res, 200, { ok: true, kinds: Object.keys(board.kinds).length });
    }

    // ----- board meta (title/subtitle) -----
    if (route === 'PATCH /api/board') {
      const body = JSON.parse(await readBody(req) || '{}');
      if (body.title !== undefined) board.title = String(body.title).slice(0, 120);
      if (body.subtitle !== undefined) board.subtitle = String(body.subtitle).slice(0, 300);
      saveBoard(); broadcast();
      return sendJson(res, 200, { ok: true });
    }

    // ----- slash commands -----
    // The composer autocomplete's source: what the target session's harness
    // answers. A valid target with no live session (or a harness without the
    // capability) is an EMPTY list, not an error — the composer just shows
    // nothing, and the in-thread reply explains if a command is sent anyway.
    if (route === 'GET /api/commands') {
      const target = String(url.searchParams.get('target') || '');
      const r = commandTargetRef(target);
      if (r.error) return sendJson(res, r.code || 400, { error: r.error });
      // A board command is offered even with no live session — /reset is how a
      // dead lieutenant comes back, so hiding it exactly when it is needed
      // would be the wrong way round.
      if (!r.ref) return sendJson(res, 200, { target, commands: boardCommands(target) });
      return sendJson(res, 200, {
        target,
        harness: r.ref.harness,
        commands: harnessCommands(r.ref).concat(boardCommands(target)),
      });
    }

    // ----- chat -----
    // Older history, straight off the append-only log: the board payload carries
    // only the newest CHAT_TAIL, so the pane pages backwards through here as the
    // captain scrolls up. `before` = the ts of the oldest message he already has;
    // the answer is oldest-first (render order) and EMPTY past the beginning —
    // running out of conversation is not an error. `limit=0` = the whole thing
    // (what `bc-axi thread` prints). Card threads ride the board payload and
    // have nothing to page.
    if (route === 'GET /api/chat') {
      const target = String(url.searchParams.get('target') || '');
      const m = /^lieutenant:(.+)$/.exec(target);
      if (!m) return sendJson(res, 400, { error: 'target must be lieutenant:<id> (card threads ride the board payload)' });
      const lt = findLieutenant(m[1]);
      if (!lt) return sendJson(res, 404, { error: 'unknown target: ' + target });
      // Only an explicit 0 means the whole conversation; anything unreadable
      // falls back to the default page rather than shipping the entire log.
      const raw = url.searchParams.get('limit');
      const n = raw == null ? NaN : parseInt(raw, 10);
      const limit = Number.isNaN(n) ? CHAT_TAIL : Math.max(0, n);
      const before = String(url.searchParams.get('before') || '');
      return sendJson(res, 200, { target, before: before || null, messages: chatPage(lt.id, before, limit) });
    }
    if (route === 'POST /api/message') { // lieutenant -> captain (chat.say, lieutenant side)
      const body = JSON.parse(await readBody(req) || '{}');
      const target = String(body.target || '');
      if (!threadFor(target)) return sendJson(res, 404, { error: 'unknown target: ' + target });
      const text = String(body.text_md || body.text || '');
      const attachments = resolveAttachments(body.attachments);
      if (!text.trim() && !attachments.length) return sendJson(res, 400, { error: 'text or attachments required' });
      // Default author, most-identified first: explicit body.author; then the
      // CALLER resolved from its tmux session (like drain/ack — so a lieutenant
      // posting to another's chat or card is stamped as itself, not the target);
      // then the target's lieutenant (unidentified callers — the interlocutor
      // is the owning lieutenant, card threads included).
      const lt = targetLieutenant(target);
      const sess = body.session ? String(body.session) : '';
      const caller = sess ? board.lieutenants.find((l) => l.ref && l.ref.session === sess) : null;
      const msg = { author: String(body.author || (caller && caller.name) || (lt && lt.name) || 'agent').slice(0, 60), text, ts: now() };
      if (attachments.length) msg.attachments = attachments;
      appendMessage(target, msg);
      const m = /^card:(.+)$/.exec(target);
      if (m) {
        const card = findCard(m[1]);
        if (card) {
          card.updated = now(); if (!card.threadStart) card.threadStart = msg.ts;
          // A card-thread say from anyone but the owning lieutenant — its own
          // worker (whose session resolves to no lieutenant), a peer, raw
          // tooling — must WAKE the owner: the thread alone notifies nobody.
          // Default-notify: only a session-identified owner is exempt (author
          // names can't be trusted — an unidentified worker is stamped with
          // the owner's name). Captain messages ride /api/feedback, never here.
          const fromOwner = !!(caller && caller.id === card.owner);
          if (!fromOwner && msg.author !== 'user') {
            queuePush(card.owner, { kind: 'worker-said', card: card.id, target, author: msg.author,
              text: text.slice(0, 2000), attachments });
          }
        }
      } else {
        // A free-form lieutenant message in its main chat is a level-1 notification.
        const ev = mkEvent({ text: text.slice(0, 200), actor: msg.author, level: body.level, kind: body.kind }, { level: 1 });
        board.events.push(ev);
        // A PEER's message into another lieutenant's main chat must also be
        // DELIVERED to that lieutenant: the chat append alone notifies nobody
        // (same rule as the non-owner card-thread say above). Without this,
        // lieutenant→lieutenant orders sit in the chat unread forever.
        const fromPeer = !!(caller && lt && caller.id !== lt.id);
        if (fromPeer) {
          queuePush(lt.id, { kind: 'peer-message', target, author: msg.author,
            text: text.slice(0, 4000), attachments });
        }
        // …and it is the last voice the captain heard, so the line follows it:
        // an answer over the line keeps the line, and a lieutenant that speaks
        // up on its own becomes who he reaches when he answers with the screen
        // off. Card threads never move it — they are a board surface, read with
        // eyes on a picker, not the channel with no picker. A peer's post is
        // the PEER speaking, not the chat's owner — the line must not follow
        // the silent recipient.
        if (lt && !fromPeer) lineFollow(lt.id);
      }
      saveBoard(); broadcast(); // owed clears on ACK, not here — the reply alone leaves it derived from the queue
      return sendJson(res, 200, { ok: true });
    }
    if (route === 'POST /api/feedback') { // captain -> lieutenant (chat.say, captain side)
      const body = JSON.parse(await readBody(req) || '{}');
      let target = String(body.target || '');
      // `target: "line"` = whoever is on the line. The voice shortcut posts
      // this and names nobody; the server resolves it to a real main chat, so
      // everything below is an ordinary captain message — it just knows it
      // came over the line.
      const overLine = target === 'line';
      if (overLine) {
        const holder = lineHolder().lieutenant;
        if (!holder) return sendJson(res, 404, { error: 'nobody is on the line — this board has no lieutenant' });
        target = 'lieutenant:' + holder.id;
      }
      if (!threadFor(target)) return sendJson(res, 404, { error: 'unknown target: ' + target });
      const text = String(body.text || '');
      const attachments = resolveAttachments(body.attachments);
      if (!text.trim() && !attachments.length) return sendJson(res, 400, { error: 'text or attachments required' });
      // A bare "/command" (no attachments riding along) is a slash command,
      // not a say: it routes to the target harness's runCommand and both the
      // command and its reply land in the thread — no QueueItem, no wake.
      if (text.trim().startsWith('/') && !attachments.length) {
        const r = await runChatCommand(target, text.trim());
        if (r.error) return sendJson(res, r.code || 400, { error: r.error });
        saveBoard(); broadcast();
        return sendJson(res, 200, r);
      }
      const lt = targetLieutenant(target);
      if (!lt) return sendJson(res, 404, { error: 'no lieutenant behind target: ' + target });
      // Write-ahead delivery: the QueueItem lands FIRST; the send-keys wake half
      // of delivery arrives in a later phase. A dead session loses nothing. The
      // attachments (with absolute paths) ride the queue item so drain surfaces
      // the file paths to the agent.
      // `via: 'line'` rides the ENVELOPE, never the captain's words: a lieutenant
      // that reads channel information back to him got it glued into the text.
      const item = queuePush(lt.id, Object.assign({ kind: 'message', target, text, attachments },
        overLine ? { via: 'line' } : null));
      const msg = { author: 'user', text, ts: now() };
      if (attachments.length) msg.attachments = attachments;
      appendMessage(target, msg);
      const m = /^card:(.+)$/.exec(target);
      if (m) {
        const card = findCard(m[1]);
        if (card) { card.updated = now(); if (!card.threadStart) card.threadStart = msg.ts; }
      }
      saveBoard(); broadcast(); // a captain message flips derived owed via broadcast
      return sendJson(res, 200, { ok: true, seq: item.seq, target, via: overLine ? 'line' : undefined });
    }

    // ----- the line -----
    if (route === 'GET /api/line') { // line.who
      const h = lineHolder();
      if (!h.lieutenant) return sendJson(res, 200, { lieutenant: null, name: null, source: h.source });
      return sendJson(res, 200, { lieutenant: h.lieutenant.id, name: h.lieutenant.name, source: h.source });
    }
    if (route === 'POST /api/line') { // line.pass — a DELIVERY, not a quiet flag flip
      const body = JSON.parse(await readBody(req) || '{}');
      const id = String(body.lieutenant || '').trim();
      const lt = findLieutenant(id);
      if (!lt) return sendJson(res, 404, { error: 'unknown lieutenant: ' + (id || '(none)') });
      const note = String(body.note || '').trim().slice(0, 2000);
      // Who is handing it over: explicit actor, else the CALLER resolved from
      // its tmux session (like say/drain/ack), else the captain.
      const sess = body.session ? String(body.session) : '';
      const caller = sess ? board.lieutenants.find((l) => l.ref && l.ref.session === sess) : null;
      const from = String(body.actor || (caller && caller.name) || 'user').trim().slice(0, 60);
      board.line = lt.id;
      // The receiver finds out because it was TOLD — same durable queue as
      // everything else, so it wakes and greets him in its own voice.
      const item = queuePush(lt.id, { kind: 'line-passed', from, text: note });
      board.events.push(mkEvent({ text: 'the line passed to ' + lt.name + (note ? ': ' + note : ''),
        actor: from, kind: 'line' }, {}));
      saveBoard(); broadcast();
      return sendJson(res, 200, { ok: true, lieutenant: lt.id, name: lt.name, seq: item.seq });
    }

    // ----- read state (persisted server-side, per user) -----
    if (route === 'POST /api/notifications/read') {
      const body = JSON.parse(await readBody(req) || '{}');
      const r = userReads(body.user);
      if (body.all) {
        r.notifSeq = board.seq; r.notifSeqs = [];
        // Clearing is reading: unseen lieutenant replies clear via the same
        // thread read marker that opening the card would set, so mark-all
        // advances it for every card that still has an unseen reply.
        const ts = now();
        for (const c of board.cards) {
          const readMs = lastThreadReadMs('card:' + c.id, body.user);
          if ((c.thread || []).some((m) => m.author !== 'user' && Date.parse(m.ts) > readMs)) {
            r.threads['card:' + c.id] = ts;
          }
        }
      }
      else if (Array.isArray(body.seqs)) {
        for (const s of body.seqs) if (Number.isInteger(s) && s > r.notifSeq && !r.notifSeqs.includes(s)) r.notifSeqs.push(s);
      }
      saveBoard(); broadcast();
      return sendJson(res, 200, { ok: true });
    }
    if (route === 'POST /api/read') { // thread read marker: {user?, target, ts?}
      const body = JSON.parse(await readBody(req) || '{}');
      const r = userReads(body.user);
      const target = String(body.target || '');
      if (!/^(lieutenant:.+|card:.+)$/.test(target)) return sendJson(res, 400, { error: 'bad target' });
      r.threads[target] = body.ts || now();
      // No broadcast: a read marker only moves the POSTING user's unread/bell
      // derivation, and that device applies it locally when it POSTs. The
      // unified stream fires one POST per viewed thread per device — full
      // board pushes here burst every SSE client. Other devices of the same
      // user converge on the next real broadcast.
      saveBoard();
      return sendJson(res, 200, { ok: true });
    }

    // ----- labels registry -----
    if (route === 'POST /api/labels') {
      const b = JSON.parse(await readBody(req) || '{}');
      if (b.create) {
        const name = String(b.create.name || '').trim();
        if (!name) return sendJson(res, 400, { error: 'label name required' });
        const color = validColor(b.create.color);
        const i = labelIndex(name);
        if (i >= 0) { if (color) board.labels[i].color = color; }
        else board.labels.push({ name, color: color || LABEL_PALETTE[board.labels.length % LABEL_PALETTE.length] });
      } else if (b.rename) {
        const from = String(b.rename.from || ''), to = String(b.rename.to || '').trim();
        const i = labelIndex(from);
        if (i < 0) return sendJson(res, 404, { error: 'unknown label: ' + from });
        if (!to) return sendJson(res, 400, { error: 'new name required' });
        if (to !== from && labelIndex(to) >= 0) return sendJson(res, 400, { error: 'label exists: ' + to });
        board.labels[i].name = to;
        for (const c of board.cards) {
          if (Array.isArray(c.labels)) c.labels = c.labels.map((n) => (n === from ? to : n)).filter((n, k, a) => a.indexOf(n) === k);
        }
      } else if (b.recolor) {
        const i = labelIndex(String(b.recolor.name || ''));
        const color = validColor(b.recolor.color);
        if (i < 0) return sendJson(res, 404, { error: 'unknown label: ' + String(b.recolor.name || '') });
        if (!color) return sendJson(res, 400, { error: 'color must be #rrggbb' });
        board.labels[i].color = color;
      } else if (b.delete) {
        const name = String(b.delete.name || '');
        const i = labelIndex(name);
        if (i < 0) return sendJson(res, 404, { error: 'unknown label: ' + name });
        board.labels.splice(i, 1);
        for (const c of board.cards) {
          if (Array.isArray(c.labels)) c.labels = c.labels.filter((n) => n !== name);
        }
      } else {
        return sendJson(res, 400, { error: 'expected create|rename|recolor|delete' });
      }
      saveBoard(); broadcast();
      return sendJson(res, 200, { ok: true, labels: board.labels });
    }

    // ----- feed.drain: pending QueueItems past the committed ack cursor -----
    if (route === 'GET /api/feed') {
      let lt = url.searchParams.get('lieutenant') || '';
      const sess = url.searchParams.get('session') || '';
      // Session-scoped drain: a lieutenant identifies itself by its tmux session
      // so it drains ONLY its own queue — the fix for cross-lieutenant drain. A
      // registered lieutenant always resolves here; an unresolved session (a
      // non-lieutenant caller, or a stale ref) falls back to unscoped behavior
      // rather than erroring, so tooling and peeks keep working.
      if (lt && !findLieutenant(lt)) return sendJson(res, 404, { error: 'unknown lieutenant: ' + lt });
      if (!lt && sess) {
        const owner = board.lieutenants.find((l) => l.ref && l.ref.session === sess);
        // A session-identified caller drains ONLY its own queue. If the session
        // resolves to no lieutenant (a worker, a stale ref, a non-lieutenant
        // tmux), return nothing — draining every queue here is exactly what let
        // a non-owner ack-wipe another lieutenant's items.
        if (!owner) return sendJson(res, 200, { items: [], head: qseq });
        lt = owner.id;
      }
      // A drain clears the nudged flag: the next append (or a turn-end with
      // still-unacked items) wakes again. Only a truly unidentified caller
      // (no lieutenant, no session — raw tooling) drains all queues.
      if (lt) nudged.delete(lt); else nudged.clear();
      const items = drainItems(lt);
      // Draining is SEEING: advance the lieutenant's durable drained cursor to
      // the highest seq just served, and let the UI flip queued→seen. Only an
      // identified drain advances — an unscoped all-queues drain is raw tooling
      // peeking, not a lieutenant starting its turn.
      if (lt && items.length && advanceDrained(lt, items[items.length - 1].seq)) broadcast();
      return sendJson(res, 200, { items, head: qseq });
    }

    // ----- feed.ack: commit the cursor AFTER the items were handled -----
    if (route === 'POST /api/feed/ack') {
      const body = JSON.parse(await readBody(req) || '{}');
      const seq = parseInt(body.seq, 10);
      if (!Number.isInteger(seq) || seq < 0) return sendJson(res, 400, { error: 'seq required (integer)' });
      // Identity-scoped ack: a lieutenant commits only within its own queue.
      let ackOwner = body.lieutenant || '';
      if (!ackOwner && body.session) {
        const owner = board.lieutenants.find((l) => l.ref && l.ref.session === body.session);
        if (owner) ackOwner = owner.id;
      }
      const r = commitAck(seq, ackOwner || null);
      if (r.error) return sendJson(res, r.code || 400, { error: r.error });
      nudged.delete(r.lieutenant); // handled: a fresh append nudges anew
      broadcast(); // the ack advances the seen cursor too (drain normally beat it here)
      return sendJson(res, 200, r);
    }

    // ----- pane streams (👁 peek — per-target SSE; see the pane hub above) -----
    // The HTTP connection's lifetime IS the subscription: connect to watch,
    // disconnect to release (refcounted). Ref resolution happens HERE — the
    // route knows cards and lieutenants, the hub knows refs, the harness knows
    // the rest. Every guard is an SSE event, not an HTTP error: the client is
    // an EventSource, which can't read error bodies.
    const paneRoute = /^\/api\/(cards|lieutenants)\/([^/]+)\/pane\/stream$/.exec(p);
    if (paneRoute && req.method === 'GET') {
      const { ref, reason } = resolvePaneRef(paneRoute[1], decodeURIComponent(paneRoute[2]), url.searchParams.get('window'));
      return paneStream(req, res, ref, reason);
    }

    // ----- pane input (⌨️ type into the LIVE pane — the write half of 👁) -----
    // Same ref resolution as the stream above (resolvePaneRef), same targets,
    // opposite direction: one keystroke or a short literal burst forwarded raw
    // to the pane's tmux target. NOT the agent `send` verb — that one types,
    // settles and Enters with verified retries, which is right for a brief and
    // wrong for an arrow key. Ordinary JSON in, ordinary status codes out (the
    // client is fetch(), not an EventSource): 404 nothing to type into, 501 the
    // harness cannot take input, 502 the harness refused or tmux failed.
    // Same-origin only, exactly like every other route that writes — the
    // network boundary is the auth boundary (README).
    const paneInputRoute = /^\/api\/(cards|lieutenants)\/([^/]+)\/pane\/input$/.exec(p);
    if (paneInputRoute && req.method === 'POST') {
      const { ref, reason } = resolvePaneRef(paneInputRoute[1], decodeURIComponent(paneInputRoute[2]),
        url.searchParams.get('window'));
      if (!ref) return sendJson(res, 404, { error: reason });
      let impl;
      try { impl = harnessFor(ref); }
      catch (e) { return sendJson(res, 404, { error: String((e && e.message) || e) }); }
      if (typeof impl.paneInput !== 'function') {
        return sendJson(res, 501, { error: 'harness "' + ref.harness + '" cannot take pane input' });
      }
      const body = JSON.parse(await readBody(req) || '{}');
      try { await impl.paneInput(ref, { key: body.key, text: body.text }); }
      catch (e) { return sendJson(res, 502, { error: String((e && e.message) || e) }); }
      return sendJson(res, 200, { ok: true });
    }

    // ----- sysload stream (⚙️ → monitoring; see the sysload section above) -----
    // The HTTP connection's lifetime IS the subscription, exactly like the
    // pane streams: connect to watch, disconnect to release. Each sample lands
    // as one `sample` event; samples flow every ~2s, so no extra ping rides here.
    if (route === 'GET /api/sysload/stream') {
      res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', Connection: 'keep-alive' });
      const unsubscribe = sysload.subscribe((sample) => {
        res.write('event: sample\ndata: ' + JSON.stringify(sample) + '\n\n');
      });
      req.on('close', unsubscribe);
      return;
    }

    // ----- SSE -----
    if (route === 'GET /api/events') {
      res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', Connection: 'keep-alive' });
      res.write('event: board\ndata: ' + JSON.stringify(publicBoard('user')) + '\n\n');
      sseClients.add(res);
      req.on('close', () => sseClients.delete(res));
      return;
    }

    sendJson(res, 404, { error: 'not found' });
  } catch (e) {
    sendJson(res, 400, { error: String(e.message || e) });
  }
});

// The only websocket the board has an opinion about: the STT engine's. Anything
// else asking to upgrade gets the socket dropped, which is what an http server
// with no upgrade handler does anyway.
function onUpgrade(req, socket, head) {
  const u = new URL(req.url, 'http://localhost');
  const p = u.pathname;
  if (p === STT_PREFIX || p.startsWith(STT_PREFIX + '/')) {
    const t = sttConfig();
    if (t) return proxySttUpgrade(req, socket, head, t.url, p.slice(STT_PREFIX.length) + u.search);
  }
  socket.destroy();
}
server.on('upgrade', onUpgrade);

server.on('error', (e) => { console.error('server error: ' + e.message); cleanup(); process.exit(1); });
server.listen(PORT, BIND_HOST, () => {
  console.log('bridge-commander server up: http://localhost:' + PORT + '/ host=' + BIND_HOST +
    ' workspace=' + WORKSPACE + ' pid=' + process.pid);
  // A worker outlives neither its card's Working state nor a board restart that
  // forgot to notice. Off the critical path of the boot, and it never throws.
  sweepStaleWorkers().catch((e) => console.error(now() + ' worker sweep failed: ' + String((e && e.message) || e)));
});
// Non-loopback bind: also listen on loopback so local CLI/UI keep working.
if (!LOOPBACKS.includes(BIND_HOST) && BIND_HOST !== '0.0.0.0') {
  const local = http.createServer(server.listeners('request')[0]);
  local.on('upgrade', onUpgrade);
  local.on('error', (e) => { console.error('loopback listener error: ' + e.message); });
  local.listen(PORT, '127.0.0.1');
}
