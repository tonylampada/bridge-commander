#!/usr/bin/env node
// bridge server — generic agent board. Node built-ins only, zero deps.
// Usage: node server.js --port 4777 --board default [--host H]
// Bind host: --host flag > "host" in ~/.bridge/config.json > 127.0.0.1 (localhost-only).
// A non-loopback bind also listens on 127.0.0.1 so local CLI calls keep working.
//
// Data model v2 (one JSON file per board, ~/.bridge/boards/<name>.json):
//   board = { title, subtitle, updated, seq,
//             columns: [{id, title}],                       // owned state, ordered
//             cards:   [{id, title, column, labels[], attributes{}, body,
//                        created, updated, threadStart,
//                        status: {worker: null|{id, state, expires}},  // lease; only status.set writes it
//                        events: [{seq, ts, level, kind, text, actor}],
//                        thread: [{author, text, ts}] }],
//             chat:    [{author, text, ts}],
//             events:  [{seq, ts, level, kind?, text, actor, card?, cardTitle?}], // board-level
//             labels:  [{name, color}],                     // user-owned registry
//             kinds:   {<kind>: {emoji, level}},            // registered kinds map (overrides built-ins)
//             reads:   { <user>: { notifSeq, notifSeqs[], threads: {<target>: ts} } } }
//
// Events are append-only and carry a global monotonic seq. The unified stream =
// board.events + every card's events, ordered by seq. Notifications are the
// level-1 slice of that stream UNION unseen agent-authored card-thread replies
// (the same per-user read state that derives a card's `unread`); read state
// persists in board.reads (server-side).
// Kill = archive: the card is snapshotted to <name>.archive.jsonl (append-only,
// reason: merged|killed) and removed from the board. No destructive delete.
// Restore = resurrection: the most recent archived snapshot comes back onto the
// board in full (never a blank rebirth) with a loud level-1 event; the archive
// log stays append-only, so the board — not the archive — is truth for liveness.
'use strict';

const http = require('http');
const fs = require('fs');
const path = require('path');
const os = require('os');

// ---------- args ----------
function parseArgs(argv) {
  const o = { port: 4777, board: 'default', host: '' };
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--port') o.port = parseInt(argv[++i], 10);
    else if (argv[i] === '--board') o.board = argv[++i];
    else if (argv[i] === '--host') o.host = argv[++i];
  }
  if (!Number.isInteger(o.port) || o.port <= 0) { console.error('bad --port'); process.exit(1); }
  if (o.host && !/^[\w.:-]+$/.test(o.host)) { console.error('bad --host'); process.exit(1); }
  if (!/^[\w.-]+$/.test(o.board)) { console.error('bad --board (use [A-Za-z0-9_.-])'); process.exit(1); }
  return o;
}
const opts = parseArgs(process.argv.slice(2));

// ---------- paths ----------
// State root: $BRIDGE_DIR when set (tests point it at a temp dir), else ~/.bridge.
const BRIDGE_DIR = process.env.BRIDGE_DIR || path.join(os.homedir(), '.bridge');
const BOARDS_DIR = path.join(BRIDGE_DIR, 'boards');
const BOARD_FILE = path.join(BOARDS_DIR, opts.board + '.json');
const ARCHIVE_FILE = path.join(BOARDS_DIR, opts.board + '.archive.jsonl');
const FEEDBACK_FILE = path.join(BOARDS_DIR, opts.board + '.feedback.jsonl');
const PID_FILE = path.join(BRIDGE_DIR, 'server-' + opts.port + '.pid');
const CONFIG_FILE = path.join(BRIDGE_DIR, 'config.json');
const UI_DIR = path.join(__dirname, 'ui');
fs.mkdirSync(BOARDS_DIR, { recursive: true });

// ---------- user config (~/.bridge/config.json; read per-request, defensive) ----------
function userConfig() {
  try {
    const c = JSON.parse(fs.readFileSync(CONFIG_FILE, 'utf8'));
    if (c && typeof c === 'object' && Array.isArray(c.voices)) {
      const voices = c.voices.filter((v) => typeof v === 'string' && v.trim()).map((v) => v.trim());
      if (voices.length) return { voices };
    }
  } catch (e) {}
  return { voices: null };
}

// Bind host is machine-private config, never baked into callers:
// --host flag > "host" in config.json > 127.0.0.1.
function configHost() {
  try {
    const c = JSON.parse(fs.readFileSync(CONFIG_FILE, 'utf8'));
    if (c && typeof c === 'object' && typeof c.host === 'string' && /^[\w.:-]+$/.test(c.host.trim())) return c.host.trim();
  } catch (e) {}
  return '';
}
const LOOPBACKS = ['127.0.0.1', 'localhost', '::1'];
const BIND_HOST = opts.host || configHost() || '127.0.0.1';

// ---------- pidfile: single instance per port ----------
function pidAlive(pid) { try { process.kill(pid, 0); return true; } catch (e) { return e.code === 'EPERM'; } }
if (fs.existsSync(PID_FILE)) {
  const old = parseInt(fs.readFileSync(PID_FILE, 'utf8'), 10);
  if (old && pidAlive(old)) process.exit(0); // live server already on this port
}
fs.writeFileSync(PID_FILE, String(process.pid));
function cleanup() {
  try { if (parseInt(fs.readFileSync(PID_FILE, 'utf8'), 10) === process.pid) fs.unlinkSync(PID_FILE); } catch (e) {}
}
process.on('exit', cleanup);
for (const sig of ['SIGINT', 'SIGTERM']) process.on(sig, () => { cleanup(); process.exit(0); });

// ---------- board state ----------
function now() { return new Date().toISOString(); }
// Worker lease states. `absent` is never persisted: it is the derived state of a
// card with no worker linked (persisted lease = null).
const WORKER_STATES = ['absent', 'idle', 'working', 'needs-you'];
const WORKER_LEASE_STATES = ['idle', 'working', 'needs-you'];
const WORKER_TTL_SECS = parseFloat(process.env.BRIDGE_WORKER_TTL_SECS) || 600;
function defaultBoard() {
  return {
    title: opts.board, subtitle: '', updated: now(), seq: 0,
    columns: [], cards: [], chat: [], events: [], labels: [], reads: {}, kinds: {},
  };
}
function normalizeBoard(doc) {
  const b = Object.assign(defaultBoard(), doc);
  if (!Array.isArray(b.columns)) b.columns = [];
  if (!Array.isArray(b.cards)) b.cards = [];
  if (!Array.isArray(b.chat)) b.chat = [];
  if (!Array.isArray(b.events)) b.events = [];
  if (!Array.isArray(b.labels)) b.labels = [];
  if (!b.reads || typeof b.reads !== 'object') b.reads = {};
  b.kinds = sanitizeKinds(b.kinds);
  for (const c of b.cards) {
    if (!Array.isArray(c.events)) c.events = [];
    if (!Array.isArray(c.thread)) c.thread = [];
    if (!Array.isArray(c.labels)) c.labels = [];
    if (!c.attributes || typeof c.attributes !== 'object') c.attributes = {};
    // status: keep only a valid persisted worker lease; an absent status stays
    // absent (means "status.set never touched this card"), odd shapes collapse
    // to a cleared lease. Decay is derived on read, never persisted.
    if (c.status !== undefined) {
      const w = c.status && typeof c.status === 'object' ? c.status.worker : null;
      const ok = w && typeof w === 'object' && w.id && WORKER_LEASE_STATES.includes(w.state);
      c.status = { worker: ok ? { id: String(w.id), state: w.state, expires: w.expires || null } : null };
    }
    // data migration: board files written before the status model may still
    // store the old feeder's `worker` attribute; adopt it as a lease on load
    // so existing stripes survive the upgrade off card.status alone.
    if (c.attributes && 'worker' in c.attributes) adoptWorkerAttr(c, c.attributes);
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
// A kind is an open token. The bridge ships structural defaults only for the
// kinds its OWN operations emit; a board may register its own kinds map
// (PUT /api/kinds) whose entries are merged OVER these built-ins. A kind in
// neither map is stored as-is (opaque token: no emoji, level falls back to 2).
const BUILTIN_KINDS = {
  created: { emoji: '🐣', level: 2 },
  moved: { emoji: '🔁', level: 2 },
  handoff: { emoji: '👀', level: 1 },
  landed: { emoji: '🏁', level: 1 },
  killed: { emoji: '🪦', level: 2 },
  resurrected: { emoji: '🧟', level: 1 },
  question: { emoji: '🙋', level: 1 },
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

// ---------- feedback queue (user -> agent; durable jsonl, monotonic seq) ----------
let feedback = [];
try {
  feedback = fs.readFileSync(FEEDBACK_FILE, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l));
} catch (e) {}
let fseq = feedback.length ? feedback[feedback.length - 1].seq : 0;
function pushFeedback(rec) {
  const ev = Object.assign({ seq: ++fseq, ts: now() }, rec);
  feedback.push(ev);
  fs.appendFileSync(FEEDBACK_FILE, JSON.stringify(ev) + '\n');
  flushPollers();
  return ev;
}

// ---------- committed ack cursor (at-least-once delivery) ----------
// Feedback <= ackSeq has been HANDLED by the agent, not merely delivered. Poll
// serves everything past it and never advances it; only POST /api/poll/ack does.
// So a poller that dies before the agent handles its lines re-offers the same
// feedback on the next poll — duplicates are possible, loss is not (dedupe by seq).
const ACK_FILE = path.join(BOARDS_DIR, opts.board + '.feedback.ack');
function loadAck() {
  try { return parseInt(fs.readFileSync(ACK_FILE, 'utf8'), 10) || 0; }
  catch (e) { return 0; }
}
let ackSeq = loadAck();
function commitAck(n) {
  if (n <= ackSeq) return;
  ackSeq = n;
  fs.writeFileSync(ACK_FILE, String(ackSeq));
}

// ---------- long-poll waiters ----------
let pollers = []; // {since, res, timer}; since=null means "the committed ack cursor"
function feedbackSince(since) { return feedback.filter((e) => e.seq > since); }
function pollerSince(p) { return p.since == null ? ackSeq : p.since; }
function flushPollers() {
  pollers = pollers.filter((p) => {
    const evs = feedbackSince(pollerSince(p));
    if (!evs.length) return true;
    clearTimeout(p.timer);
    sendJson(p.res, 200, { events: evs, cursor: fseq, ack: ackSeq });
    return false;
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
function lastCardReadMs(card, user) {
  const r = board.reads[String(user || 'user').slice(0, 60)];
  const ts = r && r.threads && r.threads['card:' + card.id];
  return ts ? Date.parse(ts) : 0;
}
function cardStatus(card, user) {
  const thread = card.thread || [];
  const last = thread.length ? thread[thread.length - 1] : null;
  const owed = !!(last && last.author === 'user'); // latest thread message is the user's, unanswered
  const readMs = lastCardReadMs(card, user);
  let unread = false;
  for (const m of thread) if (m.author !== 'user' && Date.parse(m.ts) > readMs) { unread = true; break; }
  if (!unread) for (const e of card.events || []) if (e.level === 1 && Date.parse(e.ts) > readMs) { unread = true; break; }
  return { worker: derivedWorker(card), owed, unread };
}
// Last REAL activity on a card, derived (never persisted). A card's mutable
// `updated` is bumped by incidental/system writes too — a status-lease refresh or
// decay (status.set) and any attribute patch (the feeder's periodic sync) — so it
// reads "now" for cards nothing meaningful happened to. Real activity always lands
// as an event (created/moved/handoff/…) or a thread message, so the max of those
// timestamps (floored at `created`) reflects genuine activity and ignores the
// bookkeeping writes. The UI shows and sorts on this, not `updated`.
function cardActivity(card) {
  let ts = card.created || card.updated || '';
  for (const e of card.events || []) if (e.ts && e.ts > ts) ts = e.ts;
  for (const m of card.thread || []) if (m.ts && m.ts > ts) ts = m.ts;
  return ts;
}
// Serialization view: cards go out with the derived `status` and `activity`
// attached; the stored board keeps only the raw lease. `card.status` is the single
// READ source for worker/owed/unread — nothing is mirrored into attributes.
function publicCard(card, user) {
  return Object.assign({}, card, { status: cardStatus(card, user), activity: cardActivity(card) });
}
// The served board carries the EFFECTIVE kinds map (built-ins merged under the
// registered entries); the stored board keeps only the registered map.
function publicBoard(user) {
  return Object.assign({}, board, { kinds: effectiveKinds(), cards: board.cards.map((c) => publicCard(c, user)) });
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

// Load-time data migration only (normalizeBoard): a stored pre-status-model
// `attributes.worker` value (working|needs-you|idle) is translated into the
// status.set lease (default TTL; worker id = the existing lease id or the card
// id) so old board files upgrade cleanly. The write API no longer translates:
// status.set is the only writer of card.status.worker.
function adoptWorkerAttr(card, attributes) {
  if (!attributes || typeof attributes !== 'object' || !('worker' in attributes)) return;
  const v = attributes.worker;
  delete attributes.worker;
  if (WORKER_LEASE_STATES.includes(v)) {
    const id = (card.status && card.status.worker && card.status.worker.id) || card.id;
    setStatus(card, { worker: { id, state: v } });
  } else {
    setStatus(card, { worker: null }); // null (delete) or unknown value: unlink
  }
}

// ---------- SSE clients ----------
const sseClients = new Set();
function broadcast() {
  const payload = 'event: board\ndata: ' + JSON.stringify(publicBoard('user')) + '\n\n';
  for (const res of sseClients) res.write(payload);
}
setInterval(() => { for (const res of sseClients) res.write(': ping\n\n'); }, 25000).unref();

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
function findCard(id) { return board.cards.find((c) => c.id === id); }
function threadFor(target) {
  if (target === 'chat') return board.chat;
  const m = /^card:(.+)$/.exec(target || '');
  if (m) {
    const card = findCard(m[1]);
    if (card) return (card.thread = card.thread || []);
  }
  return null;
}
function columnTitle(id) {
  const c = board.columns.find((k) => k.id === id);
  return c ? c.title : id;
}
function slug(s) {
  return String(s).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 40) || 'card';
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

// The bell: everything the user hasn't seen yet. Level-1 events (read state:
// notifSeq/notifSeqs) UNION agent-authored card-thread replies (read state: the
// same per-user thread read marker that derives a card's `unread`, so opening
// the card clears them). Main-chat agent messages already ride their level-1
// event, so chat threads are excluded here — no double count. Level-2 events
// never notify. Reply items are shaped like event items minus the seq
// (ts/text/actor/card/cardTitle/read) plus kind "reply" to tell them apart.
function notificationItems(user) {
  const r = userReads(user);
  const items = allEvents().filter((e) => e.level === 1)
    .map((e) => Object.assign({}, e, { read: e.seq <= r.notifSeq || r.notifSeqs.includes(e.seq) }));
  for (const c of board.cards) {
    const readMs = lastCardReadMs(c, user);
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
  const id = body.id ? String(body.id) : newCardId(title);
  if (!/^[\w][\w.:-]*$/.test(id)) return { error: 'bad card id (use [A-Za-z0-9_.:-])' };
  if (findCard(id)) return { error: 'card exists: ' + id, code: 409 };
  const column = body.column ? String(body.column) : (board.columns[0] && board.columns[0].id);
  if (!column || !board.columns.some((c) => c.id === column)) return { error: 'unknown column: ' + column };
  const actor = String(body.actor || actorDefault || 'agent').slice(0, 60);
  const card = {
    id, title: title.slice(0, 200), column,
    labels: Array.isArray(body.labels) ? body.labels.filter((l) => typeof l === 'string' && l) : [],
    attributes: (body.attributes && typeof body.attributes === 'object') ? body.attributes : {},
    body: typeof body.body === 'string' ? body.body : '',
    created: now(), updated: now(), threadStart: null,
    events: [], thread: [],
  };
  card.events.push(mkEvent({ text: 'created in ' + columnTitle(column), actor }, { kind: 'created' }));
  board.cards.push(card);
  registerCardLabels();
  if (actor !== 'agent') pushFeedback({ kind: 'card-created', target: 'card:' + id, text: title, column });
  return { card };
}

function moveCard(card, body, actorDefault) {
  const column = String(body.column || '');
  if (!board.columns.some((c) => c.id === column)) return { error: 'unknown column: ' + column };
  const actor = String(body.actor || actorDefault || 'agent').slice(0, 60);
  if (column === card.column) return { ok: true, unchanged: true };
  const from = card.column;
  card.column = column;
  card.updated = now();
  // A move is a deliberate act: it always lands on the timeline. Default kind:
  // an agent move is a handoff (level 1 from the kinds map — notifies the human);
  // any other actor's move is `moved` (level 2). `kind` in the body overrides
  // (e.g. a non-handoff agent move passes kind "moved"); levels come from the
  // effective kinds map unless an explicit level is given.
  const ev = mkEvent(
    { level: body.level, kind: body.kind, actor, text: columnTitle(from) + ' → ' + columnTitle(column) },
    { kind: actor === 'agent' ? 'handoff' : 'moved' });
  card.events.push(ev);
  if (actor !== 'agent') pushFeedback({ kind: 'card-moved', target: 'card:' + card.id, text: card.title, from, column });
  return { ok: true, event: ev };
}

function patchCard(card, body) {
  if (body.title !== undefined) card.title = String(body.title).slice(0, 200);
  if (body.body !== undefined) card.body = String(body.body);
  if (Array.isArray(body.labels)) card.labels = body.labels.filter((l) => typeof l === 'string' && l);
  if (body.attributes && typeof body.attributes === 'object') {
    for (const [k, v] of Object.entries(body.attributes)) {
      if (v === null) delete card.attributes[k];
      else card.attributes[k] = v;
    }
  }
  card.updated = now();
  registerCardLabels();
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
  // The kill lands on the board-level stream (the card is gone) with a card
  // reference. Typed by reason: merged = landed (level 1 — worth a bell),
  // killed = killed (level 2 — the human's own act, no bell). Levels come from
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
  card.status = { worker: null }; // the lease starts absent until the next status.set
  for (const e of card.events) if (e.seq > board.seq) board.seq = e.seq; // defensive: no seq reuse
  const ev = mkEvent({
    level: body && body.level, kind: body && body.kind, actor: body && body.actor,
    text: String((body && body.text) || '').trim() || 'resurrected',
  }, { kind: 'resurrected' });
  card.events.push(ev);
  card.updated = now();
  board.cards.push(card);
  registerCardLabels();
  return { ok: true, card, event: ev };
}

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
      return sendJson(res, 200, {
        board: opts.board, port: opts.port, cards: board.cards.length, seq: board.seq,
        feedback_seq: fseq, feedback_ack: ackSeq,
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
    // Artifact preview: text content of a local artifact, for the UI's popup
    // viewer. Only a uri listed verbatim in some live card's attributes.artifacts
    // is servable — never an arbitrary file read.
    if (route === 'GET /api/artifact') {
      const uri = url.searchParams.get('uri') || '';
      const listed = board.cards.some((c) => Array.isArray(c.attributes && c.attributes.artifacts) &&
        c.attributes.artifacts.some((a) => a && a.uri === uri));
      if (!listed) return sendJson(res, 404, { error: 'unknown artifact' });
      const file = uri.startsWith('file://') ? uri.slice('file://'.length) : uri;
      let data;
      try { data = fs.readFileSync(file); }
      catch (e) { return sendJson(res, 404, { error: 'unreadable: ' + e.message }); }
      if (data.length > 2e6) return sendJson(res, 413, { error: 'file too large to preview' });
      if (data.includes(0)) return sendJson(res, 415, { error: 'binary file' });
      return sendJson(res, 200, { name: path.basename(file), content: data.toString('utf8') });
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
    const cardRoute = /^\/api\/cards\/([^/]+)(\/(move|events|archive|status))?$/.exec(p);
    if (cardRoute) {
      const card = findCard(decodeURIComponent(cardRoute[1]));
      if (!card) return sendJson(res, 404, { error: 'unknown card: ' + decodeURIComponent(cardRoute[1]) });
      const sub = cardRoute[3];
      if (!sub && req.method === 'GET') return sendJson(res, 200, publicCard(card, url.searchParams.get('user') || 'user'));
      if (!sub && req.method === 'PATCH') {
        patchCard(card, JSON.parse(await readBody(req) || '{}'));
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
        if (r.error) return sendJson(res, 400, { error: r.error });
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
      return sendJson(res, 405, { error: 'method not allowed' });
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

    // ----- columns (owned state; idempotent replace) -----
    if (route === 'PUT /api/columns') {
      const cols = JSON.parse(await readBody(req) || 'null');
      if (!Array.isArray(cols) || !cols.every((c) => c && typeof c.id === 'string' && typeof c.title === 'string')) {
        return sendJson(res, 400, { error: 'columns must be [{id:string,title:string}]' });
      }
      const next = cols.map((c) => ({ id: c.id, title: c.title }));
      if (JSON.stringify(next) === JSON.stringify(board.columns)) {
        return sendJson(res, 200, { ok: true, columns: board.columns.length, unchanged: true });
      }
      board.columns = next;
      saveBoard(); broadcast();
      return sendJson(res, 200, { ok: true, columns: board.columns.length });
    }

    // ----- kinds (registered map; idempotent replace, mirrors the columns frame) -----
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

    // ----- chat -----
    if (route === 'POST /api/message') { // agent -> human
      const body = JSON.parse(await readBody(req) || '{}');
      const target = body.target || 'chat';
      const thread = threadFor(target);
      if (!thread) return sendJson(res, 404, { error: 'unknown target: ' + target });
      const text = String(body.text_md || body.text || '');
      if (!text.trim()) return sendJson(res, 400, { error: 'text required' });
      const msg = { author: String(body.author || 'agent').slice(0, 60), text, ts: now() };
      thread.push(msg);
      const m = /^card:(.+)$/.exec(target);
      if (m) {
        const card = findCard(m[1]);
        if (card) { card.updated = now(); if (!card.threadStart) card.threadStart = msg.ts; }
      } else {
        // A free-form agent message in the main chat is a level-1 notification.
        const ev = mkEvent({ text: text.slice(0, 200), actor: msg.author, level: body.level, kind: body.kind }, { level: 1 });
        board.events.push(ev);
      }
      saveBoard(); broadcast(); // an agent reply clears derived owed via broadcast
      return sendJson(res, 200, { ok: true });
    }
    if (route === 'POST /api/feedback') { // human -> agent
      const body = JSON.parse(await readBody(req) || '{}');
      const target = body.target || 'chat';
      const thread = threadFor(target);
      if (!thread) return sendJson(res, 404, { error: 'unknown target: ' + target });
      const text = String(body.text || '');
      if (!text.trim()) return sendJson(res, 400, { error: 'text required' });
      const msg = { author: 'user', text, ts: now() };
      thread.push(msg);
      const m = /^card:(.+)$/.exec(target);
      if (m) {
        const card = findCard(m[1]);
        if (card) { card.updated = now(); if (!card.threadStart) card.threadStart = msg.ts; }
      }
      const ev = pushFeedback({ kind: 'message', target, text });
      saveBoard(); broadcast(); // user message flips derived owed via broadcast
      return sendJson(res, 200, { ok: true, seq: ev.seq });
    }

    // ----- read state (persisted server-side, per user) -----
    if (route === 'POST /api/notifications/read') {
      const body = JSON.parse(await readBody(req) || '{}');
      const r = userReads(body.user);
      if (body.all) {
        r.notifSeq = board.seq; r.notifSeqs = [];
        // Clearing is reading: unseen agent replies clear via the same thread
        // read marker that opening the card would set, so mark-all advances it
        // for every card that still has an unseen reply.
        const ts = now();
        for (const c of board.cards) {
          const readMs = lastCardReadMs(c, body.user);
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
      if (!/^(chat|card:.+)$/.test(target)) return sendJson(res, 400, { error: 'bad target' });
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

    // ----- agent long-poll (no ?since = everything past the committed ack cursor) -----
    if (route === 'GET /api/poll') {
      const sinceParam = url.searchParams.get('since');
      const since = sinceParam == null || sinceParam === '' ? null : (parseInt(sinceParam, 10) || 0);
      const evs = feedbackSince(since == null ? ackSeq : since);
      if (evs.length) return sendJson(res, 200, { events: evs, cursor: fseq, ack: ackSeq });
      if (url.searchParams.get('nowait')) return sendJson(res, 200, { events: [], cursor: fseq, ack: ackSeq });
      const poller = { since, res, timer: null };
      poller.timer = setTimeout(() => {
        pollers = pollers.filter((x) => x !== poller);
        sendJson(res, 200, { events: [], cursor: fseq, ack: ackSeq });
      }, 60000);
      req.on('close', () => { clearTimeout(poller.timer); pollers = pollers.filter((x) => x !== poller); });
      pollers.push(poller);
      return;
    }

    // ----- agent ack: commit the cursor AFTER the feedback was handled -----
    if (route === 'POST /api/poll/ack') {
      const body = JSON.parse(await readBody(req) || '{}');
      const seq = parseInt(body.seq, 10);
      if (!Number.isInteger(seq) || seq < 0) return sendJson(res, 400, { error: 'seq required (integer)' });
      if (seq > fseq) return sendJson(res, 400, { error: 'seq ' + seq + ' beyond queue head ' + fseq });
      commitAck(seq);
      return sendJson(res, 200, { ok: true, ack: ackSeq });
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
server.listen(opts.port, BIND_HOST, () => {
  console.log('bridge server up: http://localhost:' + opts.port + '/ host=' + BIND_HOST + ' board=' + opts.board + ' pid=' + process.pid);
});
// Non-loopback bind: also listen on loopback so local CLI/UI keep working.
if (!LOOPBACKS.includes(BIND_HOST) && BIND_HOST !== '0.0.0.0') {
  const local = http.createServer(server.listeners('request')[0]);
  local.on('error', (e) => { console.error('loopback listener error: ' + e.message); });
  local.listen(opts.port, '127.0.0.1');
}
