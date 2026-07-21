#!/usr/bin/env node
// dev/ui-server.js — frontend-only dev playground. Node built-ins only, zero deps.
//
// Serves ui/ from THIS worktree and fakes every endpoint the UI calls, backed by
// an in-memory board seeded from dev/fixtures/ (restart = reseed, nothing
// persists). Write routes mutate the fixture and re-broadcast on the board SSE,
// and a tiny "fake lieutenant" simulation answers captain messages and acts on
// start/rework orders after a short delay, so clicking around feels real.
//
// It never touches server/server.js or any real workspace state, and binds
// 127.0.0.1 ONLY. Usage: node dev/ui-server.js [--port N]   (default 4790)
'use strict';

const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const UI_DIR = path.join(__dirname, '..', 'ui');
const FIX_DIR = path.join(__dirname, 'fixtures');

// ---------- fixtures ----------
// Timestamps in the fixture JSON are tokens relative to server start:
// "T-3600" = an hour ago, "T+600" = ten minutes from now. Resolved to ISO at load.
function resolveTimes(v, base) {
  if (typeof v === 'string') {
    const m = /^T([+-]\d+)$/.exec(v);
    return m ? new Date(base + parseInt(m[1], 10) * 1000).toISOString() : v;
  }
  if (Array.isArray(v)) return v.map((x) => resolveTimes(x, base));
  if (v && typeof v === 'object') {
    const out = {};
    for (const [k, x] of Object.entries(v)) out[k] = resolveTimes(x, base);
    return out;
  }
  return v;
}
function readFixture(name) {
  return JSON.parse(fs.readFileSync(path.join(FIX_DIR, name), 'utf8'));
}
function now() { return new Date().toISOString(); }

// The kinds the real server ships (server.js BUILTIN_KINDS) — copied, not
// imported: the harness must not require server code.
const BUILTIN_KINDS = {
  created: { emoji: '🐣', level: 2 }, moved: { emoji: '🔁', level: 2 },
  ordered: { emoji: '⏳', level: 2 }, handoff: { emoji: '👀', level: 1 },
  landed: { emoji: '🏁', level: 1 }, killed: { emoji: '🪦', level: 2 },
  resurrected: { emoji: '🧟', level: 1 }, question: { emoji: '🙋', level: 1 },
  started: { emoji: '🚀', level: 2 }, signal: { emoji: '📡', level: 2 },
  'worker-done': { emoji: '✅', level: 2 }, 'worker-died': { emoji: '💀', level: 2 },
  'hook-ran': { emoji: '🪝', level: 2 }, 'hook-failed': { emoji: '🧨', level: 1 },
  'worker-stopped': { emoji: '⏸️', level: 2 }, 'worker-stalled': { emoji: '🐢', level: 1 },
  'worker-paused': { emoji: '💤', level: 2 }, parked: { emoji: '🅿️', level: 2 },
  respawned: { emoji: '♻️', level: 1 }, 'needs-captain': { emoji: '🚨', level: 1 },
};
const COLUMNS = [
  { id: 'backlog', title: '📋 Backlog' },
  { id: 'working', title: '🔨 Working' },
  { id: 'review', title: '👀 Your review' },
  { id: 'peer', title: '🤝 Peer review' },
];

const MIME = {
  '.html': 'text/html; charset=utf-8', '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8', '.json': 'application/json',
  '.svg': 'image/svg+xml', '.png': 'image/png', '.jpg': 'image/jpeg',
  '.webp': 'image/webp', '.ico': 'image/x-icon', '.woff2': 'font/woff2',
};

function createDevServer() {
  const base = Date.now();
  const BOOT_ID = 'dev-' + process.pid + '-' + base;

  // ----- state (all in-memory; restart = reseed) -----
  const raw = resolveTimes(readFixture('board.json'), base);
  // owed simulation: target -> 'queued' | 'seen' (the real thing is queue-derived;
  // here it's just this map, seeded from the fixture and driven by the fake replies)
  const owed = new Map(Object.entries(raw.owedSeed || {}));
  delete raw.owedSeed;
  // frozen card snapshots, newest last — the fake of archive.jsonl. Append-only
  // here too: restore does NOT remove the record (the board is truth for liveness).
  const archive = raw.archive || [];
  delete raw.archive;
  const board = Object.assign({ columns: COLUMNS }, raw);
  board.columns = COLUMNS;
  for (const c of board.cards) {
    if (c.bodyFile) { c.body = fs.readFileSync(path.join(FIX_DIR, c.bodyFile), 'utf8'); delete c.bodyFile; }
  }
  let seq = 0;
  for (const e of board.events) if (e.seq > seq) seq = e.seq;
  for (const c of board.cards) for (const e of c.events) if (e.seq > seq) seq = e.seq;
  board.seq = seq;

  const artifacts = new Map(); // uri -> {name, mime, data:Buffer}
  for (const [uri, a] of Object.entries(resolveTimes(readFixture('artifacts.json'), base))) {
    artifacts.set(uri, { name: a.name, mime: a.mime || 'text/plain', data: fs.readFileSync(path.join(FIX_DIR, a.contentFile)) });
  }
  const attachments = new Map(); // id -> {name, mime, data:Buffer}
  for (const [id, a] of Object.entries(readFixture('attachments.json'))) {
    attachments.set(id, { name: a.name, mime: a.mime, data: fs.readFileSync(path.join(FIX_DIR, a.file)) });
  }

  // ----- timers (all tracked so stop() leaves nothing running) -----
  const timers = new Set();
  function schedule(ms, fn) {
    const t = setTimeout(() => { timers.delete(t); fn(); }, ms);
    timers.add(t);
    return t;
  }
  function every(ms, fn) { const t = setInterval(fn, ms); timers.add(t); return t; }

  // ----- lookups -----
  const findCard = (id) => board.cards.find((c) => c.id === id);
  const findLt = (id) => board.lieutenants.find((l) => l.id === id);
  function threadFor(target) {
    let m = /^card:(.+)$/.exec(target);
    if (m) { const c = findCard(m[1]); return c ? c.thread : null; }
    m = /^lieutenant:(.+)$/.exec(target);
    if (m) { const l = findLt(m[1]); return l ? l.chat : null; }
    return null;
  }
  function targetLieutenant(target) {
    let m = /^lieutenant:(.+)$/.exec(target);
    if (m) return findLt(m[1]);
    m = /^card:(.+)$/.exec(target);
    if (m) { const c = findCard(m[1]); return c ? findLt(c.owner) : null; }
    return null;
  }

  // ----- derived board (mirrors publicBoard/publicCard/cardStatus shapes) -----
  function derivedWorker(c) {
    const w = c.status && c.status.worker;
    if (!w || !w.id) return { id: null, state: 'absent' };
    let state = w.state;
    if ((state === 'working' || state === 'needs-you') && w.expires && Date.parse(w.expires) <= Date.now()) state = 'idle';
    return { id: w.id, state, expires: w.expires };
  }
  function lastReadMs(target) {
    const r = board.reads.user || {};
    const ts = r.threads && r.threads[target];
    return ts ? Date.parse(ts) : 0;
  }
  function cardStatus(c) {
    const state = owed.get('card:' + c.id) || null;
    const readMs = lastReadMs('card:' + c.id);
    let unread = false;
    for (const m of c.thread || []) if (m.author !== 'user' && Date.parse(m.ts) > readMs) { unread = true; break; }
    if (!unread) for (const e of c.events || []) if (e.level === 1 && Date.parse(e.ts) > readMs) { unread = true; break; }
    return { worker: derivedWorker(c), owed: !!state, owedState: state, unread };
  }
  function cardActivity(c) {
    let ts = c.created || c.updated || '';
    for (const e of c.events || []) if (e.ts && e.ts > ts) ts = e.ts;
    for (const m of c.thread || []) if (m.ts && m.ts > ts) ts = m.ts;
    return ts;
  }
  function publicBoard() {
    return Object.assign({}, board, {
      boot: BOOT_ID,
      kinds: Object.assign({}, BUILTIN_KINDS, board.kinds),
      cards: board.cards.map((c) => Object.assign({}, c, { status: cardStatus(c), activity: cardActivity(c) })),
      lieutenants: board.lieutenants.map((l) => Object.assign({}, l, {
        chatOwed: owed.has('lieutenant:' + l.id),
        chatQueued: owed.get('lieutenant:' + l.id) === 'queued',
      })),
    });
  }

  // ----- SSE: board push -----
  const sseClients = new Set();
  function broadcast() {
    board.updated = now();
    const payload = 'event: board\ndata: ' + JSON.stringify(publicBoard()) + '\n\n';
    for (const res of sseClients) res.write(payload);
  }
  function sseHead(res) {
    res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', Connection: 'keep-alive' });
  }

  function mkEvent(kind, text, actor, level) {
    const known = Object.assign({}, BUILTIN_KINDS, board.kinds)[kind];
    return { seq: ++board.seq, ts: now(), level: level || (known ? known.level : 2), kind, text, actor };
  }

  // ----- the fake lieutenant: canned replies + order simulation -----
  const REPLIES = [
    'On it. I\'ll signal when there\'s something to look at.',
    'Good catch — folding that into the next worker turn.',
    'Done:\n\n```bash\ngit log --oneline -1\n# a1b2c3d the thing you asked for\n```\n\nAnything else on this one?',
    'Two options:\n\n1. **quick** — patch it on the current branch\n2. **right** — split a follow-up card\n\nI\'d go with 2; the branch is already review-sized.',
    'The worker picked it up. Context is healthy, no compact needed yet.',
    'Hmm — that contradicts the card body. Want me to update the body to match, or keep the original scope?',
  ];
  let replyIdx = 0;
  function simulateReply(target) {
    const lt = targetLieutenant(target);
    if (!lt || !lt.ref) return; // a dead lieutenant answers nothing — owed sticks (gnarly on purpose)
    owed.set(target, 'queued');
    schedule(1500, () => { owed.set(target, 'seen'); broadcast(); });
    schedule(4500 + Math.floor(Math.random() * 3000), () => {
      const thread = threadFor(target);
      if (!thread) return;
      owed.delete(target);
      thread.push({ author: lt.id, text: REPLIES[replyIdx++ % REPLIES.length], ts: now() });
      const m = /^card:(.+)$/.exec(target);
      if (m) { const c = findCard(m[1]); if (c) c.updated = now(); }
      broadcast();
    });
  }
  function simulateOrder(card, kind) {
    const lt = findLt(card.owner);
    schedule(3500, () => {
      if (!findCard(card.id)) return; // archived meanwhile
      card.pendingOrder = null;
      if (kind === 'start-order') {
        card.column = 'working';
        const wid = 'wk-' + card.id.slice(0, 12);
        card.status = { worker: { id: wid, state: 'working', expires: new Date(Date.now() + 600000).toISOString() } };
        card.events.push(mkEvent('started', 'worker spawned on bc/' + card.id, (lt && lt.id) || 'agent'));
        board.workers.push({
          card: card.id, project: 'bridge-commander', branch: 'bc/' + card.id,
          ref: { harness: 'claude', session: 'bc-w-' + card.id, cwd: '/fake/wt/' + card.id },
          worktree: { path: '/fake/wt/' + card.id, tool: 'git' },
          spawnedAt: now(), turns: 1, lastTurnEnd: now(),
          agentStatus: { model: 'claude-fable-5', contextUsed: 18000, contextWindow: 200000, ts: now() },
        });
      } else { // rework-order
        card.column = 'backlog';
        card.events.push(mkEvent('moved', 'review → backlog (rework)', (lt && lt.id) || 'agent'));
      }
      card.updated = now();
      broadcast();
    });
  }

  // ----- slash commands -----
  const COMMANDS = [
    { name: '/status', description: 'model, context usage, rate limits' },
    { name: '/compact', description: 'compact the conversation' },
    { name: '/usage', description: 'token usage this session' },
  ];
  function runCommand(target, thread, text) {
    const name = text.split(/\s+/)[0];
    const stamp = (author, t, cmd, extra) => thread.push(Object.assign({ author, text: t, ts: now(), cmd }, extra || {}));
    stamp('user', text, { name });
    if (!COMMANDS.some((c) => c.name === name)) {
      stamp('bridge', '⚠ unknown command ' + name + ' — available: ' + COMMANDS.map((c) => c.name).join(', '), { name, reply: true });
      return { ok: true, command: name };
    }
    if (name === '/status') {
      stamp('claude', 'model claude-fable-5 · context 91k/200k (46%)', { name, reply: true }, {
        status: {
          model: 'claude-fable-5', effort: 'high', contextUsed: 91234, contextWindow: 200000,
          rateLimits: { primary: { windowMinutes: 300, usedPercent: 34 }, secondary: { windowMinutes: 10080, usedPercent: 12 } },
        },
      });
    } else if (name === '/compact') {
      stamp('claude', 'Compacted: 91k → 24k tokens. Carry-on summary written.', { name, reply: true });
    } else {
      stamp('claude', 'session tokens: 1.2M in / 84k out (fake numbers, obviously)', { name, reply: true });
    }
    return { ok: true, command: name };
  }

  // ----- fake pane frames (👁 peek) -----
  const ESC = '\x1b[';
  function paneFrames(label) {
    const g = (s) => ESC + '32m' + s + ESC + '0m';
    const d = (s) => ESC + '2m' + s + ESC + '0m';
    const c = (s) => ESC + '36m' + s + ESC + '0m';
    const head = c('╭─ ' + label + ' ─ fake pane ─────────────────╮') + '\n';
    return [
      head + g('⏺') + ' Reading ui/js/board.js…\n' + d('  · tileHtml — 66 lines'),
      head + g('⏺') + ' Running tests…\n' + d('  node --test test/*.test.js'),
      head + g('⏺') + ' Tests ' + g('green') + ' (325 pass)\n' + d('  committing…'),
      head + g('⏺') + ' ' + g('✔') + ' committed a1b2c3d\n' + d('  waiting for the next instruction ') + c('▋'),
    ];
  }
  function streamPane(res, label) {
    sseHead(res);
    const frames = paneFrames(label);
    let i = 0;
    const t = every(900, () => res.write('event: frame\ndata: ' + JSON.stringify(frames[i++ % frames.length]) + '\n\n'));
    res.write('event: frame\ndata: ' + JSON.stringify(frames[frames.length - 1]) + '\n\n');
    res.on('close', () => { clearInterval(t); timers.delete(t); });
  }

  // ----- fake sysload samples -----
  function sysloadSample(tick) {
    const wob = (base2, amp, phase) => Math.max(0, base2 + amp * Math.sin(tick / 7 + phase) + (Math.random() * 2 - 1));
    const gb = 1024 ** 3;
    const entities = [];
    for (const w of board.workers) {
      entities.push({ kind: 'worker', id: w.card, label: w.ref.session, cpuPct: +wob(22, 15, entities.length).toFixed(1), rssBytes: Math.round((1.1 + 0.15 * entities.length) * gb), pids: 4 + (entities.length % 3) });
    }
    for (const l of board.lieutenants) {
      if (!l.ref) continue;
      entities.push({ kind: 'lieutenant', id: l.id, label: l.ref.session, cpuPct: +wob(6, 5, entities.length).toFixed(1), rssBytes: Math.round(0.9 * gb), pids: 3 });
    }
    entities.sort((a, b) => b.cpuPct - a.cpuPct);
    return {
      ts: now(),
      machine: {
        cpuPct: +wob(35, 20, 0).toFixed(1), cores: 16,
        memUsedBytes: Math.round((9.2 + 1.5 * Math.sin(tick / 11)) * gb), memTotalBytes: 16 * gb,
        diskUsedBytes: Math.round(212 * gb), diskTotalBytes: 500 * gb,
      },
      entities,
      containers: 3,
    };
  }

  // ----- http plumbing -----
  function sendJson(res, code, obj) {
    const data = JSON.stringify(obj);
    res.writeHead(code, { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(data) });
    res.end(data);
  }
  function readBody(req) {
    return new Promise((resolve, reject) => {
      let s = '';
      req.on('data', (d) => { s += d; if (s.length > 30e6) { reject(new Error('too big')); req.destroy(); } });
      req.on('end', () => resolve(s));
      req.on('error', reject);
    });
  }
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
  function slug(title) {
    let s = String(title).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 40) || 'card';
    while (findCard(s)) s += '-' + crypto.randomBytes(2).toString('hex');
    return s;
  }

  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url, 'http://localhost');
    const p = url.pathname;
    const route = req.method + ' ' + p;
    try {
      // ----- ui -----
      if (route === 'GET /') return serveStatic(res, 'index.html');
      if (req.method === 'GET' && p.startsWith('/ui/')) return serveStatic(res, p.slice(4));

      // ----- reads -----
      if (route === 'GET /api/board') return sendJson(res, 200, publicBoard());
      if (route === 'GET /api/config') return sendJson(res, 200, { voices: null });
      if (route === 'GET /api/status') {
        return sendJson(res, 200, {
          workspace: '/fake/ws (dev playground)', port: server.address() && server.address().port,
          cards: board.cards.length, lieutenants: board.lieutenants.length, seq: board.seq,
          queue_seq: 0, queue_pending: owed.size, projects: board.projects.length,
          workers: board.workers.length, pid: process.pid,
          sysload: { subscribers: 0, sampling: false },
        });
      }
      if (route === 'GET /api/commands') {
        const target = String(url.searchParams.get('target') || '');
        const lt = targetLieutenant(target);
        if (!lt || !lt.ref) return sendJson(res, 200, { target, commands: [] });
        return sendJson(res, 200, { target, harness: 'claude', commands: COMMANDS });
      }
      if (route === 'GET /api/notifications') return sendJson(res, 200, { items: [], unread: 0 });
      if (route === 'GET /api/archive') {
        const n = parseInt(url.searchParams.get('limit') || '50', 10) || 50;
        return sendJson(res, 200, { archive: archive.slice(-n).reverse() });
      }
      if (route === 'GET /api/artifact') {
        const uri = url.searchParams.get('uri') || '';
        const raw2 = url.searchParams.get('raw') === '1' || url.searchParams.get('raw') === 'true';
        const am = /^attachment:\/\/(.+)$/.exec(uri);
        const a = am ? attachments.get(am[1]) : artifacts.get(uri);
        if (!a) return sendJson(res, 404, { error: 'unknown artifact' });
        if (raw2) {
          res.writeHead(200, { 'Content-Type': a.mime, 'Content-Length': a.data.length, 'X-Content-Type-Options': 'nosniff', 'Content-Security-Policy': 'sandbox', 'Content-Disposition': 'inline; filename="' + a.name + '"' });
          return res.end(a.data);
        }
        if (a.data.includes(0)) return sendJson(res, 415, { error: 'binary file' });
        return sendJson(res, 200, { name: a.name, content: a.data.toString('utf8') });
      }

      // ----- attachments -----
      if (route === 'POST /api/attachments') {
        const body = JSON.parse(await readBody(req) || '{}');
        const data = Buffer.from(String(body.dataBase64 || ''), 'base64');
        if (!data.length) return sendJson(res, 400, { error: 'dataBase64 required' });
        const id = 'att-' + crypto.randomBytes(5).toString('hex');
        attachments.set(id, { name: String(body.name || 'file'), mime: String(body.mime || 'application/octet-stream'), data });
        const a = attachments.get(id);
        return sendJson(res, 200, { id, uri: 'attachment://' + id, name: a.name, mime: a.mime, size: data.length });
      }
      const attRoute = /^\/api\/attachments\/([^/]+)$/.exec(p);
      if (attRoute && req.method === 'GET') {
        const a = attachments.get(decodeURIComponent(attRoute[1]));
        if (!a) return sendJson(res, 404, { error: 'unknown attachment' });
        res.writeHead(200, { 'Content-Type': a.mime, 'Content-Length': a.data.length, 'X-Content-Type-Options': 'nosniff', 'Content-Security-Policy': 'sandbox' });
        return res.end(a.data);
      }

      // ----- lieutenants -----
      if (route === 'POST /api/lieutenants') {
        const body = JSON.parse(await readBody(req) || '{}');
        const name = String(body.name || '').trim();
        if (!name) return sendJson(res, 400, { error: 'name required' });
        const id = slug(name);
        const lt = {
          id, name, color: body.color || '#66788a',
          avatar: Number.isInteger(body.avatar) ? body.avatar : null,
          charter: String(body.charter || ''), created: now(), chat: [], turns: 0,
          ref: { harness: String(body.harness || 'claude'), session: 'bc-lt-' + id, cwd: '/fake/ws' },
        };
        board.lieutenants.push(lt);
        board.events.push(mkEvent('signal', 'lieutenant ' + name + ' spawned (fake)', 'user'));
        // the real spawn takes a while — a small delay keeps the modal's "spawning…" honest
        return schedule(800, () => { broadcast(); sendJson(res, 200, { ok: true, lieutenant: lt }); });
      }
      let m = /^\/api\/lieutenants\/([^/]+)$/.exec(p);
      if (m && req.method === 'PATCH') {
        const lt = findLt(decodeURIComponent(m[1]));
        if (!lt) return sendJson(res, 404, { error: 'unknown lieutenant' });
        const body = JSON.parse(await readBody(req) || '{}');
        for (const k of ['name', 'color', 'charter']) if (typeof body[k] === 'string') lt[k] = body[k];
        if (body.avatar === null || Number.isInteger(body.avatar)) lt.avatar = body.avatar;
        broadcast();
        return sendJson(res, 200, { ok: true, lieutenant: lt });
      }
      if (m && req.method === 'DELETE') {
        const id = decodeURIComponent(m[1]);
        const i = board.lieutenants.findIndex((l) => l.id === id);
        if (i < 0) return sendJson(res, 404, { error: 'unknown lieutenant' });
        if (board.cards.some((c) => c.owner === id)) return sendJson(res, 409, { error: 'lieutenant still owns cards' });
        board.lieutenants.splice(i, 1);
        board.events.push(mkEvent('killed', 'lieutenant ' + id + ' retired', 'user'));
        broadcast();
        return sendJson(res, 200, { ok: true });
      }
      m = /^\/api\/lieutenants\/([^/]+)\/pane\/stream$/.exec(p);
      if (m && req.method === 'GET') {
        const lt = findLt(decodeURIComponent(m[1]));
        if (!lt) { sseHead(res); res.write('event: no-pane\ndata: {"reason":"unknown lieutenant"}\n\n'); return res.end(); }
        if (!lt.ref) { sseHead(res); res.write('event: no-pane\ndata: {"reason":"session died"}\n\n'); return res.end(); }
        return streamPane(res, lt.ref.session);
      }

      // ----- cards -----
      if (route === 'POST /api/cards') {
        const body = JSON.parse(await readBody(req) || '{}');
        const title = String(body.title || '').trim();
        if (!title) return sendJson(res, 400, { error: 'title required' });
        if (!findLt(body.owner)) return sendJson(res, 400, { error: 'unknown owner' });
        const card = {
          id: slug(title), title, type: ['plan', 'implementation', 'investigation'].includes(body.type) ? body.type : 'implementation',
          owner: body.owner, column: COLUMNS.some((k) => k.id === body.column) ? body.column : 'backlog',
          labels: [], attributes: Object.assign({ repo: 'bridge-commander' }, body.attributes || {}),
          body: String(body.body || ''), created: now(), updated: now(),
          events: [], thread: [],
        };
        card.events.push(mkEvent('created', 'card created', 'user'));
        board.cards.push(card);
        broadcast();
        return sendJson(res, 200, { ok: true, card });
      }
      m = /^\/api\/cards\/([^/]+)$/.exec(p);
      if (m && req.method === 'PATCH') {
        const card = findCard(decodeURIComponent(m[1]));
        if (!card) return sendJson(res, 404, { error: 'unknown card' });
        const body = JSON.parse(await readBody(req) || '{}');
        for (const k of ['title', 'body']) if (typeof body[k] === 'string') card[k] = body[k];
        if (typeof body.owner === 'string' && findLt(body.owner)) card.owner = body.owner;
        if (['plan', 'implementation', 'investigation'].includes(body.type)) card.type = body.type;
        if (Array.isArray(body.labels)) {
          card.labels = body.labels.map(String).filter(Boolean);
          for (const n of card.labels) { // auto-register unknown names, like the real server
            if (!board.labels.some((l) => l.name === n)) board.labels.push({ name: n, color: '#66788a' });
          }
        }
        if (body.attributes && typeof body.attributes === 'object') Object.assign(card.attributes, body.attributes);
        card.updated = now();
        broadcast();
        return sendJson(res, 200, { ok: true, card });
      }
      m = /^\/api\/cards\/([^/]+)\/move$/.exec(p);
      if (m && req.method === 'POST') {
        const card = findCard(decodeURIComponent(m[1]));
        if (!card) return sendJson(res, 404, { error: 'unknown card' });
        const body = JSON.parse(await readBody(req) || '{}');
        const to = String(body.column || '');
        if (!COLUMNS.some((k) => k.id === to)) return sendJson(res, 400, { error: 'unknown column' });
        if (to === card.column) return sendJson(res, 200, { ok: true, unchanged: true });
        // captain-drag DNA: any → working is a start-order, review → backlog a
        // rework-order; both queue for the lieutenant instead of moving the card
        const order = to === 'working' ? 'start-order' : (card.column === 'review' && to === 'backlog') ? 'rework-order' : '';
        if (order) {
          card.pendingOrder = { kind: order, by: 'user', ts: now() };
          card.events.push(mkEvent('ordered', order.replace('-', ' ') + ' sent to ' + card.owner + (body.text ? ' — “' + body.text + '”' : ''), 'user'));
          card.updated = now();
          broadcast();
          simulateOrder(card, order);
          return sendJson(res, 200, { ok: true, ordered: order });
        }
        card.events.push(mkEvent('moved', card.column + ' → ' + to, 'user'));
        card.column = to;
        card.updated = now();
        broadcast();
        return sendJson(res, 200, { ok: true, moved: to });
      }
      m = /^\/api\/cards\/([^/]+)\/archive$/.exec(p);
      if (m && req.method === 'POST') {
        const id = decodeURIComponent(m[1]);
        const i = board.cards.findIndex((c) => c.id === id);
        if (i < 0) return sendJson(res, 404, { error: 'unknown card' });
        const body = JSON.parse(await readBody(req) || '{}');
        const reason = body.reason === 'merged' ? 'merged' : 'killed';
        const card = board.cards[i];
        board.cards.splice(i, 1);
        board.workers = board.workers.filter((w) => w.card !== id);
        owed.delete('card:' + id);
        archive.push({ ts: now(), actor: 'user', reason, card: JSON.parse(JSON.stringify(card)) });
        board.events.push(Object.assign(
          mkEvent(reason === 'merged' ? 'landed' : 'killed', reason + ': ' + card.title, 'user'),
          { card: id, cardTitle: card.title, archived: true }));
        broadcast();
        return sendJson(res, 200, { ok: true });
      }
      m = /^\/api\/cards\/([^/]+)\/restore$/.exec(p);
      if (m && req.method === 'POST') {
        const id = decodeURIComponent(m[1]);
        if (findCard(id)) return sendJson(res, 409, { error: 'card already on the board: ' + id });
        let rec = null;
        for (const r of archive) if (r.card && r.card.id === id) rec = r; // last = most recent
        if (!rec) return sendJson(res, 404, { error: 'not in archive: ' + id });
        const card = JSON.parse(JSON.stringify(rec.card)); // frozen snapshot, in full
        card.status = { worker: null };
        card.pendingOrder = null;
        const wasWorking = card.column === 'working';
        if (wasWorking) card.column = 'backlog'; // Working ⇔ live worker: restore workerless
        for (const e of card.events) if (e.seq > board.seq) board.seq = e.seq;
        card.events.push(mkEvent('resurrected', 'resurrected' + (wasWorking ? ' — restored to backlog (was working)' : ''), 'user'));
        card.updated = now();
        board.cards.push(card);
        broadcast();
        return sendJson(res, 200, { ok: true, card });
      }
      m = /^\/api\/cards\/([^/]+)\/artifacts$/.exec(p);
      if (m && (req.method === 'POST' || req.method === 'DELETE')) {
        const card = findCard(decodeURIComponent(m[1]));
        if (!card) return sendJson(res, 404, { error: 'unknown card' });
        const body = JSON.parse(await readBody(req) || '{}');
        const uri = String(body.uri || '');
        if (!uri) return sendJson(res, 400, { error: 'uri required' });
        const list = Array.isArray(card.attributes.artifacts) ? card.attributes.artifacts : (card.attributes.artifacts = []);
        if (req.method === 'POST') {
          if (!list.some((a) => a.uri === uri)) list.push(Object.assign({ uri }, body.label ? { label: String(body.label) } : {}));
        } else {
          card.attributes.artifacts = list.filter((a) => a.uri !== uri);
        }
        card.updated = now();
        broadcast();
        return sendJson(res, 200, { ok: true });
      }
      m = /^\/api\/cards\/([^/]+)\/pane\/stream$/.exec(p);
      if (m && req.method === 'GET') {
        const card = findCard(decodeURIComponent(m[1]));
        const w = card && board.workers.find((x) => x.card === card.id);
        if (!card || card.column !== 'working' || !w) {
          sseHead(res);
          res.write('event: no-pane\ndata: {"reason":"' + (!card ? 'unknown card' : 'no live worker') + '"}\n\n');
          return res.end();
        }
        return streamPane(res, w.ref.session);
      }

      // ----- chat -----
      if (route === 'POST /api/feedback') {
        const body = JSON.parse(await readBody(req) || '{}');
        const target = String(body.target || '');
        const thread = threadFor(target);
        if (!thread) return sendJson(res, 404, { error: 'unknown target: ' + target });
        const text = String(body.text || '');
        const atts = (Array.isArray(body.attachments) ? body.attachments : [])
          .map((a) => (typeof a === 'string' ? a : a && a.id)).filter((id) => attachments.has(id))
          .map((id) => { const a = attachments.get(id); return { id, name: a.name, mime: a.mime, size: a.data.length }; });
        if (!text.trim() && !atts.length) return sendJson(res, 400, { error: 'text or attachments required' });
        if (text.trim().startsWith('/') && !atts.length) {
          const r = runCommand(target, thread, text.trim());
          broadcast();
          return sendJson(res, 200, r);
        }
        const msg = { author: 'user', text, ts: now() };
        if (atts.length) msg.attachments = atts;
        thread.push(msg);
        const cm = /^card:(.+)$/.exec(target);
        if (cm) { const c = findCard(cm[1]); if (c) { c.updated = now(); if (!c.threadStart) c.threadStart = msg.ts; } }
        broadcast();
        simulateReply(target);
        return sendJson(res, 200, { ok: true, seq: ++board.seq });
      }

      // ----- read state -----
      if (route === 'POST /api/notifications/read') {
        const body = JSON.parse(await readBody(req) || '{}');
        const r = board.reads.user || (board.reads.user = { notifSeq: 0, notifSeqs: [], threads: {} });
        if (body.all) {
          r.notifSeq = board.seq; r.notifSeqs = [];
          const ts = now();
          for (const c of board.cards) {
            const readMs = lastReadMs('card:' + c.id);
            if ((c.thread || []).some((x) => x.author !== 'user' && Date.parse(x.ts) > readMs)) r.threads['card:' + c.id] = ts;
          }
        } else if (Array.isArray(body.seqs)) {
          for (const s of body.seqs) if (Number.isInteger(s) && s > r.notifSeq && !r.notifSeqs.includes(s)) r.notifSeqs.push(s);
        }
        broadcast();
        return sendJson(res, 200, { ok: true });
      }
      if (route === 'POST /api/read') {
        const body = JSON.parse(await readBody(req) || '{}');
        const r = board.reads.user || (board.reads.user = { notifSeq: 0, notifSeqs: [], threads: {} });
        if (body.target) r.threads[String(body.target)] = String(body.ts || now());
        broadcast();
        return sendJson(res, 200, { ok: true });
      }

      // ----- labels -----
      if (route === 'POST /api/labels') {
        const body = JSON.parse(await readBody(req) || '{}');
        if (body.create && body.create.name) {
          const name = String(body.create.name);
          if (!board.labels.some((l) => l.name === name)) board.labels.push({ name, color: body.create.color || '#66788a' });
        } else if (body.rename && body.rename.from && body.rename.to) {
          const { from, to } = body.rename;
          const l = board.labels.find((x) => x.name === from);
          if (!l) return sendJson(res, 404, { error: 'unknown label' });
          l.name = String(to);
          for (const c of board.cards) c.labels = (c.labels || []).map((n) => (n === from ? String(to) : n));
        } else if (body.recolor && body.recolor.name) {
          const l = board.labels.find((x) => x.name === body.recolor.name);
          if (l) l.color = String(body.recolor.color || l.color);
        } else if (body.delete && body.delete.name) {
          const name = String(body.delete.name);
          board.labels = board.labels.filter((l) => l.name !== name);
          for (const c of board.cards) c.labels = (c.labels || []).filter((n) => n !== name);
        } else {
          return sendJson(res, 400, { error: 'want create|rename|recolor|delete' });
        }
        broadcast();
        return sendJson(res, 200, { ok: true });
      }

      // ----- SSE: board + sysload -----
      if (route === 'GET /api/events') {
        sseHead(res);
        sseClients.add(res);
        res.write('event: board\ndata: ' + JSON.stringify(publicBoard()) + '\n\n');
        const ping = every(25000, () => res.write('event: ping\ndata: {}\n\n'));
        res.on('close', () => { sseClients.delete(res); clearInterval(ping); timers.delete(ping); });
        return;
      }
      if (route === 'GET /api/sysload/stream') {
        sseHead(res);
        let tick = 0;
        const send = () => res.write('event: sample\ndata: ' + JSON.stringify(sysloadSample(tick++)) + '\n\n');
        send();
        const t = every(2000, send);
        res.on('close', () => { clearInterval(t); timers.delete(t); });
        return;
      }

      return sendJson(res, 404, { error: 'not found: ' + route });
    } catch (e) {
      return sendJson(res, 500, { error: String((e && e.message) || e) });
    }
  });

  function stop() {
    for (const t of timers) { clearTimeout(t); clearInterval(t); }
    timers.clear();
    for (const res of sseClients) { try { res.end(); } catch (e) {} }
    sseClients.clear();
    return new Promise((resolve) => server.close(resolve));
  }

  return { server, board, owed, broadcast, stop };
}

module.exports = { createDevServer };

// ---------- main ----------
if (require.main === module) {
  let port = 4790;
  const argv = process.argv.slice(2);
  for (let i = 0; i < argv.length; i++) if (argv[i] === '--port') port = parseInt(argv[++i], 10);
  if (!Number.isInteger(port) || port <= 0) { console.error('bad --port'); process.exit(1); }
  const { server } = createDevServer();
  // loopback ONLY — this is a fixtures toy, it must never be reachable off-box
  server.listen(port, '127.0.0.1', () => {
    console.log('[dev-playground] http://127.0.0.1:' + port + '  (fixture board, nothing persists)');
  });
}
