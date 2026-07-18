#!/usr/bin/env node
// bridge-commander server — the harness control surface. Node built-ins only, zero deps.
// Usage: node server/server.js [workspace] [--workspace DIR] [--port N] [--host H]
// One workspace = one board. All state lives in <workspace>/.bridge-commander/:
//   board.json     the board (canonical state of the world)
//   archive.jsonl  append-only frozen card snapshots (reason: merged|killed)
//   config.json    { port, host?, voices? } — port default 4780, written on first boot
//   queue/<lieutenant>.jsonl  durable per-lieutenant delivery queue (global seq)
//   queue/<lieutenant>.ack    committed ack cursor (at-least-once; only ack removes)
//   server.pid     single server instance per workspace
//
// Data model (docs/api/overview.md is the DNA):
//   board = { title, subtitle, updated, seq,
//             columns: fixed frame (backlog | working | review | peer),
//             lieutenants: [{id, name, color, avatar?: 0-63, charter, chat: [{author,text,ts}], created,
//                            ref: null|HarnessRef {harness, session, cwd, resumeId?},
//                            lastTurnEnd?, turns?}],
//             projects: [{name, path, mode, source?, added}],   // registered repos (F6)
//             workers:  [{card, ref, worktree: {path, tool}, branch?, project,
//                         spawnedAt, done?, outcome?, flagged?, paused?, lastTurnEnd?, lastSignalAt?, turns?}],
//             cards:   [{id, title, type, owner, column, labels[], attributes{}, body,
//                        created, updated, threadStart, pendingOrder,
//                        status: {worker: null|{id, state, expires}},  // lease; only status.set writes it
//                        events: [{seq, ts, level, kind, text, actor}],
//                        thread: [{author, text, ts}] }],
//             events:  [{seq, ts, level, kind?, text, actor, card?, cardTitle?}], // board-level
//             labels:  [{name, color}],                     // user-owned registry
//             kinds:   {<kind>: {emoji, level}},            // registered kinds map (overrides built-ins)
//             reads:   { <user>: { notifSeq, notifSeqs[], threads: {<target>: ts} } } }
//
// Every card belongs to exactly one lieutenant (`owner`); card `type` is
// plan | implementation | investigation. Chat targets are `lieutenant:<id>`
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
const { createWorktree, releaseWorktree } = require(path.join(__dirname, 'worktrees.js'));
const { workerBrief, PROJECT_MODES } = require(path.join(__dirname, 'brief.js'));
const names = require(path.join(__dirname, 'names.js'));
const { STATE_DIR_NAME, migrateStateDir, migrateHomeStateDir } = require(path.join(__dirname, 'statedir.js'));
const { execFile } = require('child_process');

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
const WORKSPACE = path.resolve(opts.workspace || process.cwd());
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
// Extension → Content-Type for raw artifact byte serving. Images render inline
// in the viewer; pdf may render inline; everything else downloads.
const ARTIFACT_MIME = {
  '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.gif': 'image/gif',
  '.webp': 'image/webp', '.svg': 'image/svg+xml', '.bmp': 'image/bmp', '.avif': 'image/avif',
  '.pdf': 'application/pdf',
};

const DEFAULT_PORT = 4780;

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
  if (Array.isArray(c.voices)) {
    const voices = c.voices.filter((v) => typeof v === 'string' && v.trim()).map((v) => v.trim());
    if (voices.length) return { voices };
  }
  return { voices: null };
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
    projects: [], workers: [],
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
  b.kinds = sanitizeKinds(b.kinds);
  for (const lt of b.lieutenants) {
    if (!Array.isArray(lt.chat)) lt.chat = [];
    if (typeof lt.charter !== 'string') lt.charter = '';
    // ref: a persisted HarnessRef or null (odd shapes collapse to null).
    if (lt.ref !== undefined && !isHarnessRef(lt.ref)) lt.ref = null;
  }
  // projects: the registered-repo registry; workers: the live worker-ref registry
  // (both survive restarts — board is truth). Odd shapes are dropped.
  if (!Array.isArray(b.projects)) b.projects = [];
  b.projects = b.projects.filter((p) => p && typeof p === 'object'
    && typeof p.name === 'string' && p.name
    && typeof p.path === 'string' && p.path
    && PROJECT_MODES.includes(p.mode));
  if (!Array.isArray(b.workers)) b.workers = [];
  b.workers = b.workers.filter((w) => w && typeof w === 'object' && w.card && isHarnessRef(w.ref));
  for (const c of b.cards) {
    if (!Array.isArray(c.events)) c.events = [];
    if (!Array.isArray(c.thread)) c.thread = [];
    if (!Array.isArray(c.labels)) c.labels = [];
    if (!c.attributes || typeof c.attributes !== 'object') c.attributes = {};
    if (!CARD_TYPES.includes(c.type)) c.type = 'implementation';
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
function saveBoard() {
  board.updated = now();
  const tmp = BOARD_FILE + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(board, null, 2));
  fs.renameSync(tmp, BOARD_FILE);
}

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
  'worker-stopped': { emoji: '⏸️', level: 2 },
  'worker-stalled': { emoji: '🐢', level: 1 },
  'worker-paused': { emoji: '💤', level: 2 },
  parked: { emoji: '🅿️', level: 2 },
  respawned: { emoji: '♻️', level: 1 },
  'needs-captain': { emoji: '🚨', level: 1 },
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
function createLieutenant(body) {
  const name = String(body.name || '').trim();
  if (!name) return { error: 'name required' };
  const id = body.id ? String(body.id) : lieutenantIdFrom(name);
  if (!/^[\w][\w.-]*$/.test(id)) return { error: 'bad lieutenant id (use [A-Za-z0-9_.-])' };
  if (findLieutenant(id)) return { error: 'lieutenant exists: ' + id, code: 409 };
  if (body.avatar !== undefined && body.avatar !== null && !validAvatar(body.avatar)) {
    return { error: 'avatar must be an integer 0-63' };
  }
  const color = validColor(body.color) || LT_PALETTE[board.lieutenants.length % LT_PALETTE.length];
  const lt = {
    id, name: name.slice(0, 60), color,
    charter: String(body.charter || '').slice(0, 8000),
    chat: [], created: now(),
  };
  if (validAvatar(body.avatar)) lt.avatar = body.avatar;
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
function lieutenantPrompt(name, id, charter) {
  const cli = path.join(__dirname, '..', 'cli', 'bc-axi');
  return [
    doctrineText(),
    '## Your charter\n\n' + (String(charter || '').trim() || "(none yet — await the captain's orders)"),
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
  return lieutenantPrompt(lt.name, lt.id, lt.charter) + '\n\n'
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
  if (findLieutenant(id)) return { error: 'lieutenant exists: ' + id, code: 409 };
  const harnessName = String(body.harness || readConfig().harness || 'claude');
  let impl;
  try { impl = getHarness(harnessName); } catch (e) { return { error: String(e.message || e) }; }
  const session = names.lieutenantSession(WORKSPACE, id);
  let ref;
  try {
    ref = await impl.spawn(WORKSPACE, lieutenantPrompt(name, id, body.charter), {
      session,
      stateDir: HARNESS_STATE_DIR,
      callbackUrl: TURNEND_URL,
      installHooks: false,
    });
  } catch (e) {
    return { error: 'spawn failed: ' + String((e && e.message) || e), code: 502 };
  }
  return createLieutenant(Object.assign({}, body, { id, ref }));
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
  respawnAttempts.delete(id);
  nudged.delete(id);
  // A retired lieutenant can never drain again: its queue files go too.
  try { fs.unlinkSync(queueFile(id)); } catch (e) { /* none */ }
  try { fs.unlinkSync(ackFile(id)); } catch (e) { /* none */ }
  try { fs.unlinkSync(drainedFile(id)); } catch (e) { /* none */ }
  const ev = mkEvent({ text: 'lieutenant ' + lt.name + ' retired',
    actor: (body && body.actor) || 'user', level: 1 }, {});
  board.events.push(ev);
  return { ok: true, event: ev };
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
  return Object.assign({}, board, {
    boot: BOOT_ID,
    kinds: effectiveKinds(),
    cards: board.cards.map((c) => publicCard(c, user, msgSeqs)),
    // chatOwed/chatQueued mirror status.owed/owedState:'queued' for a
    // lieutenant's MAIN chat — both queue-derived, same rules as cards.
    lieutenants: board.lieutenants.map((l) => Object.assign({}, l, {
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
function broadcast() {
  const payload = 'event: board\ndata: ' + JSON.stringify(publicBoard('user')) + '\n\n';
  for (const res of sseClients) res.write(payload);
}

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

// Named ping (not an SSE comment): comments are invisible to EventSource, so
// the client's staleness watchdog couldn't see the stream is alive. Pane
// streams piggyback on the same ping so proxies don't drop them either.
setInterval(() => {
  for (const res of sseClients) res.write('event: ping\ndata: {}\n\n');
  for (const hub of panes.values()) for (const res of hub.clients) res.write('event: ping\ndata: {}\n\n');
}, 25000).unref();

// ---------- helpers ----------
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
// A captain chat message starting with "/" routes HERE instead of becoming a
// say: the command runs against the target session's harness and both the
// command and its reply land in the thread — nothing rides the delivery queue
// (no wake, no owed). Unknown commands and missing sessions answer in-thread
// too (a composer conversation, not an HTTP failure).
async function runChatCommand(target, thread, text) {
  // command messages carry `cmd` metadata the UI keys off for its console-style
  // rendering: the request (cmd.name only) and its reply (cmd.reply true). The
  // /status reply additionally carries the structured `status` payload so the UI
  // renders a real progress bar instead of regex-parsing the formatted prose.
  const stamp = (author, t, cmd, extra) => {
    const msg = Object.assign({ author, text: t, ts: now(), cmd }, extra || {});
    thread.push(msg);
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
  if (!r.ref) {
    reply('bridge', '⚠ ' + name + ' — ' + r.why);
    return { ok: true, command: name };
  }
  const cmds = harnessCommands(r.ref);
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
    const result = await impl.runCommand(r.ref, text);
    // /status also fetches the structured status (a cheap transcript read) so the
    // reply carries both the formatted text (fallback) and the payload the UI
    // renders as model + context bar + rate lines — never parsing the prose.
    let extra;
    if (name === '/status' && typeof impl.status === 'function') {
      try { const st = await impl.status(r.ref); if (st && typeof st === 'object') extra = { status: st }; } catch {}
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
    const st = await impl.status(rec.ref);
    if (!st || typeof st !== 'object') return false;
    rec.agentStatus = Object.assign({}, st, { ts: now() });
    return true;
  } catch {
    return false;
  }
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
function slug(s) { return slugBase(s) || 'card'; }
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
function newCardId(title) {
  const base = slug(title);
  if (!findCard(base)) return base;
  for (let i = 2; ; i++) if (!findCard(base + '-' + i)) return base + '-' + i;
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
function createCard(body, actorDefault) {
  const title = String(body.title || '').trim();
  if (!title) return { error: 'title required' };
  const owner = String(body.owner || '').trim();
  if (!owner) return { error: 'owner required (every card belongs to exactly one lieutenant)' };
  if (!findLieutenant(owner)) return { error: 'unknown lieutenant: ' + owner };
  const type = body.type ? String(body.type) : 'implementation';
  if (!CARD_TYPES.includes(type)) return { error: 'bad type (use ' + CARD_TYPES.join('|') + ')' };
  const id = body.id ? String(body.id) : newCardId(title);
  if (!/^[\w][\w.:-]*$/.test(id)) return { error: 'bad card id (use [A-Za-z0-9_.:-])' };
  if (findCard(id)) return { error: 'card exists: ' + id, code: 409 };
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
    id, title: title.slice(0, 200), type, owner, column,
    labels: Array.isArray(body.labels) ? body.labels.filter((l) => typeof l === 'string' && l) : [],
    attributes: (body.attributes && typeof body.attributes === 'object') ? body.attributes : {},
    body: typeof body.body === 'string' ? body.body : '',
    created: now(), updated: now(), threadStart: null, pendingOrder: null,
    events: [], thread: [],
  };
  card.events.push(mkEvent({ text: 'created in ' + columnTitle(column), actor }, { kind: 'created' }));
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
    if (w) { delete w.stopNotified; delete w.staleNotified; } // leaving Working ends the stop/stale-state
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
  // An archived card has no worker (invariant: Working ⇔ live worker): kill any
  // lingering worker session (best-effort, fire-and-forget — a done worker's
  // session otherwise outlives its card) and drop the registry entry so
  // supervision stops watching a session that no longer represents live work.
  for (const w of board.workers) {
    if (w.card !== card.id) continue;
    const ref = w.ref;
    Promise.resolve().then(() => harnessFor(ref).kill(ref)).catch(() => {});
  }
  board.workers = board.workers.filter((w) => w.card !== card.id);
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
// record {name, path, mode}. A card's `repo` attribute must name a registered
// project for card.start to provision its worker a worktree.
function findProject(name) { return board.projects.find((p) => p.name === name); }
const addingProjects = new Set(); // names with a clone in flight (async clone opens racing duplicate adds)
async function addProject(body) {
  const source = String((body && body.source) || '').trim();
  if (!source) return { error: 'source required (git URL or local path)' };
  const mode = String((body && body.mode) || 'no-mistakes');
  if (!PROJECT_MODES.includes(mode)) return { error: 'bad mode (use ' + PROJECT_MODES.join('|') + ')' };
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
  const project = { name, path: dest, mode, source: src, added: now() };
  board.projects.push(project);
  board.events.push(mkEvent({ text: 'project ' + name + ' registered (' + mode + ')',
    actor: (body && body.actor) || 'agent', level: 2 }, {}));
  return { project };
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
function workerName(ref) { return ref.window ? ref.session + ':' + ref.window : ref.session; }
function findWorker(cardId) { return board.workers.find((w) => w.card === cardId); }

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

  const existing = findWorker(card.id);
  if (body && body.resume) {
    if (body.brief) {
      return { error: 'resume does not deliver briefs — the reincarnated worker keeps its own context '
        + 'and the brief would be silently dropped. To hand a live worker new instructions: '
        + 'bc-axi worker send ' + card.id + ' --text-file <f|->' };
    }
    if (!existing) return { error: 'nothing to resume: card ' + card.id + ' has no recorded worker' };
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
    existing.done = false;
    delete existing.outcome;
    delete existing.flagged;
    delete existing.stopNotified;
    delete existing.staleNotified;
    delete existing.paused; // a revived worker is watched again
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
  if (!project) return { error: 'unregistered project: ' + repoAttr + ' (register it: bc-axi project add <url|path> --mode <mode>)' };

  // Harness precedence: explicit CLI --harness wins, then the card's stored
  // hint (attributes.harness, set from the new-card modal), then config/default.
  const harnessName = String((body && body.harness) || (card.attributes && card.attributes.harness) || readConfig().harness || 'claude');
  let impl;
  try { impl = getHarness(harnessName); } catch (e) { return { error: String((e && e.message) || e) }; }

  // A finished previous worker (rework restart): its session must be gone
  // (a live one is resumed/steered, not spawned over), then its worktree is
  // released first — only when clean, so committed-but-unmerged work is never
  // discarded.
  if (existing) {
    let up = false;
    try { up = await harnessFor(existing.ref).alive(existing.ref); } catch (e) { up = false; }
    if (up) {
      const reopenHint = existing.done ? ' (or, since it reported done, reopen it in place with worker send)' : '';
      return { error: 'previous worker session ' + workerName(existing.ref) + ' is still alive — resume it (card start --resume) or steer it instead of spawning over it' + reopenHint, code: 409 };
    }
    const prevProject = findProject(existing.project) || project;
    const rel = await releaseWorktree(existing.worktree, prevProject.path);
    if (!rel.released) {
      return { error: 'previous worker worktree not releasable (' + rel.reason + '): ' + existing.worktree.path, code: 409 };
    }
    const idx = board.workers.indexOf(existing);
    if (idx !== -1) board.workers.splice(idx, 1);
  }

  let wt;
  try { wt = await createWorktree(project.path, card.id, WORKSPACE); }
  catch (e) { return { error: 'worktree provisioning failed: ' + String((e && e.message) || e), code: 502 }; }

  const session = ownerSession(card);
  const window = names.workerWindow(card.id);
  const branch = card.type === 'investigation' ? null : 'bc/' + card.id;
  const prompt = workerBrief({
    card, task: body && body.brief, thread: card.thread || [],
    project, worktree: wt.path, branch: branch || '', workspace: WORKSPACE,
    cli: path.join(__dirname, '..', 'cli', 'bc-axi'),
  });
  const spawnOpts = { session, window, stateDir: HARNESS_STATE_DIR, callbackUrl: TURNEND_URL };
  const extraArgs = [];
  // Model precedence mirrors harness: explicit --model wins, else the card's
  // stored hint (attributes.model, set from the new-card modal).
  const modelHint = (body && body.model) || (card.attributes && card.attributes.model);
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

  card.attributes.session = workerName(ref);
  card.attributes.worktree = wt.path;
  if (branch) card.attributes.branch = branch;
  attachBriefArtifact(card, ref);
  const worker = { card: card.id, ref, worktree: wt, project: project.name, spawnedAt: now(), done: false };
  if (branch) worker.branch = branch;
  board.workers.push(worker);
  enterWorking(card, 'worker ' + workerName(ref) + ' started in ' + wt.path);
  return { worker };
}

// worker.signal — a real milestone from the worker: level-2 event on the card
// + a QueueItem to the owning lieutenant.
function workerSignal(card, body) {
  const text = String((body && body.text) || '').trim();
  if (!text) return { error: 'text required' };
  const w = findWorker(card.id);
  if (w) {
    delete w.stopNotified; // a fresh signal starts a fresh stop-state
    delete w.staleNotified;
    w.lastSignalAt = now(); // a milestone is real activity: resets the stale clock
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
  if (w) { w.done = true; w.outcome = outcome.slice(0, 2000); delete w.flagged; delete w.stopNotified; delete w.staleNotified; }
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
    delete w.staleNotified;
    delete w.paused;
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
  delete w.staleNotified;
  try {
    await harnessFor(w.ref).kill(w.ref);
  } catch (e) {
    delete w.paused; // the session may still be alive — stay honest, let supervision judge
    return { error: 'pause failed killing session ' + workerName(w.ref) + ': ' + String((e && e.message) || e), code: 502 };
  }
  const actor = String((body && body.actor) || 'agent').slice(0, 60);
  const ev = mkEvent({
    text: 'worker ' + workerName(w.ref) + ' paused (deliberate) — resume: card start ' + card.id + ' --resume',
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
  if (w) { delete w.stopNotified; delete w.staleNotified; } // leaving Working ends the stop/stale-state
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
      let up = false;
      try { up = await harnessFor(lt.ref).alive(lt.ref); } catch (e) { up = false; }
      if (up) {
        respawnAttempts.delete(lt.id);
        // Alive but possibly deaf: a wake that landed in a busy pane never
        // became a turn, yet was recorded as sent. Re-run scheduleWake — it
        // no-ops while the last nudge is within WAKE_TTL_MS or nothing is
        // pending, so only a genuinely stuck wake re-fires.
        if (pendingItems(lt.id).length) scheduleWake(lt.id);
        continue;
      }
      const n = (respawnAttempts.get(lt.id) || 0) + 1;
      if (n > 3) continue; // already flagged needs-captain; a manual revival resets via alive
      respawnAttempts.set(lt.id, n);
      try {
        // Resume when memory is recoverable; else relaunch a fresh session with
        // charter + owned cards + pending queue as the prompt (the DNA's
        // auto-respawn side effect) — a bare agent with no context helps nobody.
        const impl = harnessFor(lt.ref);
        const opts = { stateDir: HARNESS_STATE_DIR, callbackUrl: TURNEND_URL, installHooks: false };
        let ref;
        if (await impl.resumable(lt.ref, opts)) {
          ref = await impl.resume(lt.ref, opts);
        } else {
          await impl.kill(lt.ref); // clear any dead pane still holding the name
          // Keep the session name (an incarnation, not a new entity) when it is
          // spawnable; a founder's foreign name gets a workspace-scoped one.
          const session = /^bc-[A-Za-z0-9_-]+$/.test(lt.ref.session)
            ? lt.ref.session : names.lieutenantSession(WORKSPACE, lt.id);
          ref = await impl.spawn(lt.ref.cwd, respawnPrompt(lt), Object.assign({ session }, opts));
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
      // Working card. One item per stall (staleNotified mirrors the
      // stopNotified lifecycle); any real activity — signal, turn-end,
      // resume — re-arms it.
      if (up && !w.paused && BC_WORKER_STALE_SECS > 0 && !w.staleNotified) {
        const card = findCard(w.card);
        if (card && card.column === 'working') {
          const stamps = [w.spawnedAt, w.lastTurnEnd, w.lastSignalAt]
            .map((t) => (t ? Date.parse(t) : NaN)).filter((n) => !Number.isNaN(n));
          const lastActivity = stamps.length ? Math.max(...stamps) : 0;
          if (lastActivity && Date.now() - lastActivity > BC_WORKER_STALE_SECS * 1000) {
            w.staleNotified = true;
            const mins = Math.round((Date.now() - lastActivity) / 60000);
            const text = 'worker ' + workerName(w.ref) + ' alive but silent for '
              + mins + 'min (no signal/turn-end) — may be hung';
            card.events.push(mkEvent({ text, actor: 'server' }, { kind: 'worker-stalled' }));
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
// MERGED -> release the worktree (only when clean — uncommitted work is never
// discarded), archive the card (reason merged: the landed level-1 event), and
// queue a pr-merged item to the owner. CLOSED (unmerged) -> mark the state and
// tell the owner; the card stays. gh failures leave state untouched.
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
      let merged = null;
      let changed = false;
      for (const pr of prs) {
        if (!pr || pr.state !== 'open' || !pr.url) continue;
        const st = await ghPrState(pr.url);
        if (!st || !st.state) continue;
        if (st.state === 'MERGED') { pr.state = 'merged'; merged = pr; changed = true; }
        else if (st.state === 'CLOSED') {
          pr.state = 'closed';
          changed = true;
          card.events.push(mkEvent({ text: 'PR closed without merge: ' + pr.url, actor: 'server', level: 2 }, {}));
          queuePush(card.owner, { kind: 'pr-closed', card: card.id, text: pr.url });
        }
      }
      if (!changed) continue;
      if (merged) {
        const w = findWorker(card.id);
        const project = findProject(w ? w.project : String((card.attributes && card.attributes.repo) || ''));
        const wtRec = w ? w.worktree
          : (card.attributes && card.attributes.worktree ? { path: card.attributes.worktree, tool: 'git' } : null);
        let note = merged.url;
        if (wtRec && project) {
          const rel = await releaseWorktree(wtRec, project.path);
          if (!rel.released) {
            note += ' (worktree NOT released: ' + rel.reason + ')';
            console.error(now() + ' worktree not released for ' + card.id + ': ' + rel.reason);
          }
        }
        queuePush(card.owner, { kind: 'pr-merged', card: card.id, text: merged.url });
        archiveCard(card, { reason: 'merged', note, actor: 'server' }); // landed — the level-1 bell
      }
      saveBoard(); broadcast();
    }
  } finally {
    prWatching = false;
  }
}
if (Number.isInteger(PRWATCH_MS) && PRWATCH_MS > 0) setInterval(prWatchTick, PRWATCH_MS).unref();

// ---------- static ui ----------
const MIME = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8', '.svg': 'image/svg+xml', '.png': 'image/png',
};
function serveStatic(res, rel) {
  const file = path.normalize(path.join(UI_DIR, rel));
  if (!file.startsWith(UI_DIR + path.sep) && file !== path.join(UI_DIR, 'index.html')) {
    return sendJson(res, 404, { error: 'not found' });
  }
  let data;
  try { data = fs.readFileSync(file); } catch (e) { return sendJson(res, 404, { error: 'not found' }); }
  res.writeHead(200, { 'Content-Type': MIME[path.extname(file)] || 'application/octet-stream', 'Cache-Control': 'no-cache' });
  res.end(data);
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
    if (route === 'GET /api/status') {
      let pending = 0;
      for (const lt of queueIds()) pending += pendingItems(lt).length;
      return sendJson(res, 200, {
        workspace: WORKSPACE, port: PORT, cards: board.cards.length,
        lieutenants: board.lieutenants.length, seq: board.seq,
        queue_seq: qseq, queue_pending: pending,
        projects: board.projects.length, workers: board.workers.length,
        pid: process.pid,
      });
    }
    if (route === 'GET /api/archive') {
      const recs = readArchive();
      const n = parseInt(url.searchParams.get('limit') || '50', 10) || 50;
      return sendJson(res, 200, { archive: recs.slice(-n).reverse() });
    }
    if (route === 'GET /api/notifications') {
      const items = notificationItems(url.searchParams.get('user'));
      return sendJson(res, 200, { items, unread: items.filter((e) => !e.read).length });
    }
    // Artifact serve, for the UI's popup viewer. Only a uri listed verbatim in
    // some live card's attributes.artifacts is servable — never an arbitrary
    // file read. Default (no raw): TEXT content of the file. raw=1: the raw
    // bytes with a real Content-Type, backing the inline <img> and downloads.
    if (route === 'GET /api/artifact') {
      const uri = url.searchParams.get('uri') || '';
      const raw = url.searchParams.get('raw') === '1' || url.searchParams.get('raw') === 'true';
      const listed = board.cards.some((c) => Array.isArray(c.attributes && c.attributes.artifacts) &&
        c.attributes.artifacts.some((a) => a && a.uri === uri));
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
        // document meant to be *rendered*: serve it as text/html inline so the
        // viewer iframe shows the page, not its source. It runs under a stricter-
        // than-default CSP — `sandbox allow-scripts` gives it a unique origin (no
        // same-origin access to the board, no top navigation, no forms) while its
        // own inline JS/CSS still work. Scoped to plain file artifacts, not
        // attachments (an uploaded .html keeps its neutralized download behavior).
        const isHtml = !am && (ext === '.html' || ext === '.htm');
        const ctype = isHtml ? 'text/html; charset=utf-8'
          : am ? (attMime || 'application/octet-stream')
          : (ARTIFACT_MIME[ext] || 'application/octet-stream');
        // Images, pdf, and rendered html show inline in the browser; other
        // binaries download. Same hardening as the attachments serve: nosniff pins
        // the Content-Type; the sandbox CSP neutralizes an uploaded SVG/HTML if it
        // is navigated to as a document (inline <img> subresources unaffected).
        const inline = isHtml || /^image\//.test(ctype) || ctype === 'application/pdf';
        const csp = isHtml ? 'sandbox allow-scripts' : 'sandbox';
        let data;
        try { data = fs.readFileSync(file); }
        catch (e) { return sendJson(res, 404, { error: 'unreadable: ' + e.message }); }
        res.writeHead(200, {
          'Content-Type': ctype,
          'Content-Length': data.length,
          'Cache-Control': 'private, max-age=31536000, immutable',
          'X-Content-Type-Options': 'nosniff',
          'Content-Security-Policy': csp,
          'Content-Disposition': (inline ? 'inline' : 'attachment') + '; filename="' + name.replace(/["\\\r\n]/g, '_') + '"',
        });
        return res.end(data);
      }
      let data;
      try { data = fs.readFileSync(file); }
      catch (e) { return sendJson(res, 404, { error: 'unreadable: ' + e.message }); }
      if (data.length > 2e6) return sendJson(res, 413, { error: 'file too large to preview' });
      if (data.includes(0)) return sendJson(res, 415, { error: 'binary file' });
      return sendJson(res, 200, { name, content: data.toString('utf8') });
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
      // navigated to as a document — inline <img> subresources are unaffected.
      res.writeHead(200, {
        'Content-Type': meta.mime || 'application/octet-stream',
        'Content-Length': data.length,
        'Cache-Control': 'private, max-age=31536000, immutable',
        'X-Content-Type-Options': 'nosniff',
        'Content-Security-Policy': 'sandbox',
      });
      return res.end(data);
    }

    // ----- lieutenants -----
    if (route === 'GET /api/lieutenants') return sendJson(res, 200, { lieutenants: board.lieutenants });
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
      return sendJson(res, 200, { ok: true, lieutenant: r.lieutenant });
    }
    const ltRoute = /^\/api\/lieutenants\/([^/]+)$/.exec(p);
    if (ltRoute && req.method === 'DELETE') { // lieutenant.retire — explicit only
      const body = JSON.parse(await readBody(req) || '{}');
      const r = await retireLieutenant(decodeURIComponent(ltRoute[1]), body);
      if (r.error) return sendJson(res, r.code || 400, { error: r.error });
      saveBoard(); broadcast();
      return sendJson(res, 200, { ok: true, event: r.event });
    }
    if (ltRoute && req.method === 'PATCH') { // update name/color/avatar/charter/ref (init idempotency)
      const lt = findLieutenant(decodeURIComponent(ltRoute[1]));
      if (!lt) return sendJson(res, 404, { error: 'unknown lieutenant: ' + decodeURIComponent(ltRoute[1]) });
      const body = JSON.parse(await readBody(req) || '{}');
      if (body.ref !== undefined) {
        if (body.ref !== null && !isHarnessRef(body.ref)) {
          return sendJson(res, 400, { error: 'bad ref (want {harness, session, cwd, resumeId?} or null)' });
        }
        lt.ref = body.ref;
      }
      if (body.name !== undefined && String(body.name).trim()) lt.name = String(body.name).trim().slice(0, 60);
      if (body.color !== undefined && validColor(body.color)) lt.color = body.color;
      if (body.avatar !== undefined) {
        if (body.avatar === null) delete lt.avatar;
        else if (validAvatar(body.avatar)) lt.avatar = body.avatar;
        else return sendJson(res, 400, { error: 'avatar must be an integer 0-63 or null' });
      }
      if (body.charter !== undefined) lt.charter = String(body.charter).slice(0, 8000);
      saveBoard(); broadcast();
      return sendJson(res, 200, { ok: true, lieutenant: lt });
    }

    // ----- turn boundaries (the BC_TURNEND_URL target; posted by the Stop-hook relay) -----
    // The workspace-level hook fires for ANY claude in the workspace cwd, so
    // resolution dedupes by session_id: (1) a lieutenant ref whose resumeId
    // matches; (2) a lieutenant ref whose session name matches the hook's
    // session arg; (3) a WORKER ref by resumeId then session (workers' POSTs
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
      if (!lt && sname) lt = board.lieutenants.find((l) => isHarnessRef(l.ref) && l.ref.session === sname);
      if (!lt) {
        let w = sid ? board.workers.find((x) => x.ref.resumeId === sid) : null;
        // A window-granular worker's hook posts the `session:window` key —
        // never the bare session name it shares with its lieutenant.
        if (!w && sname) w = board.workers.find((x) => workerName(x.ref) === sname);
        if (w) {
          if (sid && w.ref.resumeId !== sid) w.ref.resumeId = sid; // hook payload is ground truth
          w.lastTurnEnd = now();
          w.turns = (w.turns || 0) + 1;
          // turn-end is the status refresh point (context bar / /status data)
          const statusChanged = await refreshAgentStatus(w);
          // A worker turn-end IS the stop signal: a Working card whose worker
          // stopped without done would otherwise be invisible to its owner.
          // One item per stop-state — the flag clears on signal/done or when
          // the card leaves Working, so repeats never stack.
          const card = findCard(w.card);
          let stopped = false;
          if (card && card.column === 'working' && !w.done && !w.stopNotified) {
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
      // Window-granular worker hooks are excluded from tmux attribution: their
      // `session:window` key carries a ':' no session name can (names.js emits
      // [A-Za-z0-9-] only), and their pane's tmux_session IS the lieutenant
      // session they cohabit — without this guard a stale worker POST (its
      // record already gone) would corrupt that lieutenant's resumeId.
      if (!lt && tmux && !sname.includes(':')) lt = board.lieutenants.find((l) => isHarnessRef(l.ref) && l.ref.session === tmux);
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
        return sendJson(res, 200, { ok: true, event: r.event, card: publicCard(card, 'user') });
      }
      if (!sub && req.method === 'GET') return sendJson(res, 200, publicCard(card, url.searchParams.get('user') || 'user'));
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
        const r = moveCard(card, JSON.parse(await readBody(req) || '{}'));
        if (r.error) return sendJson(res, r.code || 400, { error: r.error });
        saveBoard(); broadcast();
        return sendJson(res, 200, r);
      }
      if (sub === 'events' && req.method === 'POST') {
        const body = JSON.parse(await readBody(req) || '{}');
        if (!String(body.text || '').trim()) return sendJson(res, 400, { error: 'text required' });
        const ev = mkEvent(body, { level: 2 });
        card.events.push(ev);
        card.updated = now();
        saveBoard(); broadcast();
        return sendJson(res, 200, { ok: true, event: ev });
      }
      if (sub === 'archive' && req.method === 'POST') {
        const r = archiveCard(card, JSON.parse(await readBody(req) || '{}'));
        if (r.error) return sendJson(res, 400, { error: r.error });
        saveBoard(); broadcast();
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
    if (route === 'GET /api/projects') return sendJson(res, 200, { projects: board.projects });
    if (route === 'POST /api/projects') {
      const r = await addProject(JSON.parse(await readBody(req) || '{}'));
      if (r.error) return sendJson(res, r.code || 400, { error: r.error });
      saveBoard(); broadcast();
      return sendJson(res, 200, { ok: true, project: r.project });
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
      if (!r.ref) return sendJson(res, 200, { target, commands: [] });
      return sendJson(res, 200, { target, harness: r.ref.harness, commands: harnessCommands(r.ref) });
    }

    // ----- chat -----
    if (route === 'POST /api/message') { // lieutenant -> captain (chat.say, lieutenant side)
      const body = JSON.parse(await readBody(req) || '{}');
      const target = String(body.target || '');
      const thread = threadFor(target);
      if (!thread) return sendJson(res, 404, { error: 'unknown target: ' + target });
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
      thread.push(msg);
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
      }
      saveBoard(); broadcast(); // owed clears on ACK, not here — the reply alone leaves it derived from the queue
      return sendJson(res, 200, { ok: true });
    }
    if (route === 'POST /api/feedback') { // captain -> lieutenant (chat.say, captain side)
      const body = JSON.parse(await readBody(req) || '{}');
      const target = String(body.target || '');
      const thread = threadFor(target);
      if (!thread) return sendJson(res, 404, { error: 'unknown target: ' + target });
      const text = String(body.text || '');
      const attachments = resolveAttachments(body.attachments);
      if (!text.trim() && !attachments.length) return sendJson(res, 400, { error: 'text or attachments required' });
      // A bare "/command" (no attachments riding along) is a slash command,
      // not a say: it routes to the target harness's runCommand and both the
      // command and its reply land in the thread — no QueueItem, no wake.
      if (text.trim().startsWith('/') && !attachments.length) {
        const r = await runChatCommand(target, thread, text.trim());
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
      const item = queuePush(lt.id, { kind: 'message', target, text, attachments });
      const msg = { author: 'user', text, ts: now() };
      if (attachments.length) msg.attachments = attachments;
      thread.push(msg);
      const m = /^card:(.+)$/.exec(target);
      if (m) {
        const card = findCard(m[1]);
        if (card) { card.updated = now(); if (!card.threadStart) card.threadStart = msg.ts; }
      }
      saveBoard(); broadcast(); // a captain message flips derived owed via broadcast
      return sendJson(res, 200, { ok: true, seq: item.seq });
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
      saveBoard(); broadcast();
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
      const id = decodeURIComponent(paneRoute[2]);
      let ref = null;
      let reason = '';
      if (paneRoute[1] === 'cards') {
        const card = findCard(id);
        const w = card && findWorker(card.id);
        if (!card) reason = 'unknown card: ' + id;
        else if (card.column !== 'working') reason = 'card is not Working';
        else if (!w) reason = 'no worker bound to ' + id;
        else ref = w.ref;
      } else {
        const lt = findLieutenant(id);
        if (!lt) reason = 'unknown lieutenant: ' + id;
        else if (!isHarnessRef(lt.ref)) reason = 'lieutenant has no live session';
        else ref = lt.ref;
      }
      return paneStream(req, res, ref, reason);
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

server.on('error', (e) => { console.error('server error: ' + e.message); cleanup(); process.exit(1); });
server.listen(PORT, BIND_HOST, () => {
  console.log('bridge-commander server up: http://localhost:' + PORT + '/ host=' + BIND_HOST +
    ' workspace=' + WORKSPACE + ' pid=' + process.pid);
});
// Non-loopback bind: also listen on loopback so local CLI/UI keep working.
if (!LOOPBACKS.includes(BIND_HOST) && BIND_HOST !== '0.0.0.0') {
  const local = http.createServer(server.listeners('request')[0]);
  local.on('error', (e) => { console.error('loopback listener error: ' + e.message); });
  local.listen(PORT, '127.0.0.1');
}
