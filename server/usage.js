'use strict';
// usage — where the tokens go. Node built-ins only.
//
// Two halves with a file between them:
//
//   INDEX (runIndex, a child process: `node server/usage.js index`)
//     reads the agents' own transcripts — Claude Code's
//     ~/.claude/projects/**/*.jsonl and Codex's ~/.codex/sessions/**/*.jsonl —
//     from the byte offset it stopped at last time, and folds every API
//     response into FACT rows: (source, UTC hour, session, model, speed, cwd,
//     git branch) → [input, output, cache read, cache write 5m, cache write 1h,
//     responses]. A full first run reads every byte once; after that only the
//     tails that grew. Facts carry no opinion about who the tokens belong to.
//
//   SUMMARIZE (summarize, in the server, per request)
//     attributes each fact row to a lieutenant, a worker's card, or non-BC
//     work, prices it, and folds the rows into a time series and a drill-down
//     tree. Attribution happens HERE, against the board as it stands now, so a
//     card that changes owner or a session mapped late re-attributes without a
//     reindex.
//
// Dedupe. Claude Code writes ONE API response as several transcript lines
// (one per content block), and the early lines carry a streaming snapshot of
// usage — output_tokens grows line to line. A forked subagent's transcript
// also opens with a copy of its parent's last response. So responses are
// keyed by message.id + requestId and each key contributes the per-field MAX
// it was ever seen with: a later, larger copy adds only its delta to the row
// the first copy landed in. Keys are remembered for SEEN_TTL_MS after their
// timestamp — long past any copy's lag — so the store stays small.
//
// Codex writes cumulative token_count events; a row gets the DELTA of
// total_token_usage per event. OpenAI's input_tokens includes the cached
// part, so input = input - cached and cache read = cached.
//
// Store, under <workspace>/.bridge-commander/usage/ (own `.gitignore: *`):
//   state.json   per-file offsets + codex per-file context + dedupe keys
//   facts.json   the fact rows
//   context.json the attribution maps (session → lieutenant / card, cards → owner)
//   quota.jsonl  rate-limit samples over time (Codex events; Claude via statusline.js)
//   index.lock   held while a run is in flight

const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');

const STATE_DIRS = ['.bridge-commander', '.bridge-command'];
const SEEN_TTL_MS = 3 * 24 * 3600 * 1000;
const CHUNK = 8 * 1024 * 1024;
const LOCK_STALE_MS = 30 * 60 * 1000;

// ---------- prices ----------
// $ per million tokens at API LIST prices: [input, output, cache read,
// cache write 5m, cache write 1h]. Claude rates are Anthropic's first-party
// list (cache writes 1.25x / 2x input; reads as listed per model). OpenAI
// rates come from third-party pricing aggregators, not OpenAI's own page:
// best-effort, standard tier, ignoring the >272K-input surcharge. A subscription
// does not bill by these: the number is a WEIGHT to compare work by, not quota.
// Override or extend per workspace with usage/prices.json ({model: [5 numbers]}).
const PRICES = {
  'claude-fable-5-1': [10, 50, 0.25, 12.5, 20],
  'claude-mythos-5-1': [10, 50, 0.25, 12.5, 20],
  'claude-fable-5': [10, 50, 1, 12.5, 20],
  'claude-opus-5-5': [4, 20, 0.2, 5, 8],
  'claude-opus-5': [5, 25, 0.5, 6.25, 10],
  'claude-opus-4-8': [5, 25, 0.5, 6.25, 10],
  'claude-opus-4-7': [5, 25, 0.5, 6.25, 10],
  'claude-opus-4-6': [5, 25, 0.5, 6.25, 10],
  'claude-opus-4-5': [5, 25, 0.5, 6.25, 10],
  'claude-sonnet-5-5': [2, 10, 0.2, 2.5, 4],
  'claude-sonnet-5': [2, 10, 0.2, 2.5, 4],
  'claude-sonnet-4-6': [3, 15, 0.3, 3.75, 6],
  'claude-sonnet-4-5': [3, 15, 0.3, 3.75, 6],
  'claude-haiku-5-5': [0.1, 0.5, 0.01, 0.125, 0.2],
  'claude-haiku-4-5': [1, 5, 0.1, 1.25, 2],
  'gpt-6-sol': [2, 10, 0.1, 2.5, 2.5],
  'gpt-6-luna': [0.1, 0.5, 0.01, 0.1, 0.1],
  'gpt-5.6-sol': [5, 30, 0.5, 5, 5],
  'gpt-5.5': [5, 30, 0.5, 5, 5],
  'gpt-5.4': [2.5, 15, 0.25, 2.5, 2.5],
  'gpt-5.3-codex': [1.75, 14, 0.175, 1.75, 1.75],
  'gpt-5-codex': [1.25, 10, 0.125, 1.25, 1.25],
};
// Fast mode bills the same model at 2x (Opus 5 / 5.5 / 4.8).
const FAST_MULT = 2;

// claude-haiku-4-5-20251001 → claude-haiku-4-5: a dated snapshot prices as its family.
function priceOf(model, table) {
  const t = table || PRICES;
  if (!model) return null;
  if (t[model]) return t[model];
  const bare = model.replace(/-\d{8}$/, '').replace(/\[.*\]$/, '');
  return t[bare] || null;
}

// tok = [in, out, cacheRead, cacheWrite5m, cacheWrite1h] → $ per field (null when unpriced).
function costOf(model, speed, tok, table) {
  const p = priceOf(model, table);
  if (!p) return null;
  const mult = speed === 'fast' ? FAST_MULT : 1;
  return [0, 1, 2, 3, 4].map((i) => (tok[i] || 0) * p[i] * mult / 1e6);
}

// ---------- line parsing ----------

// One Claude Code transcript line → a usage record, or null when the line
// carries no usage (or all zeros: the synthetic error responses).
function claudeRecord(o) {
  if (!o || o.type !== 'assistant') return null;
  const m = o.message;
  if (!m || typeof m !== 'object' || !m.usage) return null;
  const u = m.usage;
  const cc = u.cache_creation || {};
  let cw1 = cc.ephemeral_1h_input_tokens || 0;
  let cw5 = cc.ephemeral_5m_input_tokens || 0;
  const cwAll = u.cache_creation_input_tokens || 0;
  // older lines carry only the total: price it as the cheaper 5m write
  if (cw1 + cw5 < cwAll) cw5 += cwAll - cw1 - cw5;
  const tok = [u.input_tokens || 0, u.output_tokens || 0, u.cache_read_input_tokens || 0, cw5, cw1];
  if (!tok.some(Boolean)) return null;
  const key = m.id ? m.id + '|' + (o.requestId || '') : 'u|' + (o.uuid || '');
  return {
    key, ts: o.timestamp || '', sid: o.sessionId || '', model: m.model || '?',
    speed: u.speed === 'fast' ? 'fast' : 'standard', cwd: o.cwd || '', branch: o.gitBranch || '', tok,
  };
}

// One Codex rollout line, folded into the per-file context `fc`. Returns a
// usage record for a token_count event that moved the cumulative total.
function codexRecord(o, fc) {
  if (!o || !o.payload) return null;
  const p = o.payload;
  if (o.type === 'session_meta') {
    fc.sid = p.id || p.session_id || fc.sid || '';
    fc.cwd = p.cwd || fc.cwd || '';
    fc.branch = (p.git && p.git.branch) || fc.branch || '';
    return null;
  }
  if (o.type === 'turn_context') {
    if (p.model) fc.model = p.model;
    if (p.cwd) fc.cwd = p.cwd;
    return null;
  }
  if (o.type !== 'event_msg' || p.type !== 'token_count' || !p.info) return null;
  if (p.rate_limits) fc.rate = { ts: o.timestamp, rl: p.rate_limits };
  const t = p.info.total_token_usage;
  if (!t) return null;
  const cur = [t.input_tokens || 0, t.cached_input_tokens || 0, t.output_tokens || 0, t.cache_write_input_tokens || 0];
  const last = fc.last || [0, 0, 0, 0];
  let d = cur.map((v, i) => v - last[i]);
  // the counter went backwards (a reset): this event's own usage is the delta
  if (d.some((v) => v < 0)) {
    const l = p.info.last_token_usage || {};
    d = [l.input_tokens || 0, l.cached_input_tokens || 0, l.output_tokens || 0, l.cache_write_input_tokens || 0];
  }
  fc.last = cur;
  if (!d.some(Boolean)) return null;
  const tok = [Math.max(0, d[0] - d[1]), d[2], d[1], d[3], 0];
  return {
    // a forked rollout copies its parent's events verbatim: same ts, same total
    key: 'cx|' + o.timestamp + '|' + (t.total_tokens || cur.join(',')),
    ts: o.timestamp || '', sid: fc.sid || '', model: fc.model || '?', speed: 'standard',
    cwd: fc.cwd || '', branch: fc.branch || '', tok,
  };
}

// ---------- session hints ----------
// Who a session is, read from its own first prompt: a lieutenant's doctrine
// ends with `You are lieutenant "Selma" (id: selma)`, a worker's brief opens
// with `- card `MNC-257` · project …`. The fallback for sessions the harness
// records never captured (a respawn, a codex worker before its branch exists).
const HINT_NEEDLES = ['You are lieutenant', '- card `'];
const LT_HINT = /You are lieutenant "[^"]*" \(id: ([A-Za-z0-9_.-]+)\)/;
const CARD_HINT = /- card `([A-Za-z0-9_.-]+)` · project/;
// o = the parsed line (a real prompt only: no tool results, no sidechains)
function promptText(o) {
  if (!o || o.isSidechain) return null;
  if (o.type === 'user' && o.message) {
    const c = o.message.content;
    if (typeof c === 'string') return c;
    if (Array.isArray(c) && !c.some((b) => b && b.type === 'tool_result')) return c.map((b) => (b && b.text) || '').join('\n');
    return null;
  }
  if (o.type === 'response_item' && o.payload && o.payload.type === 'message' && o.payload.role === 'user') {
    return (o.payload.content || []).map((b) => (b && b.text) || '').join('\n');
  }
  return null;
}
function hintOf(o) {
  const t = promptText(o);
  if (!t) return null;
  const lt = LT_HINT.exec(t);
  if (lt) return { lt: lt[1] };
  const card = CARD_HINT.exec(t);
  return card ? { card: card[1] } : null;
}

// ---------- the fact store ----------

function factKey(src, r) {
  return [src, String(r.ts).slice(0, 13), r.sid, r.model, r.speed, r.cwd, r.branch].join('\t');
}
function splitKey(k) {
  const [src, hour, sid, model, speed, cwd, branch] = k.split('\t');
  return { src, hour, sid, model, speed, cwd, branch };
}

// Fold one record into facts with the max-per-field dedupe (see the header).
function addRecord(facts, seen, src, r) {
  const prev = seen[r.key];
  if (prev) {
    const row = facts[prev.k];
    let changed = false;
    for (let i = 0; i < 5; i++) {
      if (r.tok[i] > prev.t[i]) {
        if (row) row[i] += r.tok[i] - prev.t[i];
        prev.t[i] = r.tok[i];
        changed = true;
      }
    }
    return changed;
  }
  const k = factKey(src, r);
  const row = facts[k] || (facts[k] = [0, 0, 0, 0, 0, 0]);
  for (let i = 0; i < 5; i++) row[i] += r.tok[i];
  row[5] += 1;
  seen[r.key] = { k, t: r.tok.slice(), ts: Date.parse(r.ts) || Date.now() };
  return true;
}

// ---------- file walking + incremental reads ----------

function walkJsonl(root, out) {
  let ents;
  try { ents = fs.readdirSync(root, { withFileTypes: true }); } catch (e) { return out; }
  for (const e of ents) {
    const p = path.join(root, e.name);
    if (e.isDirectory()) walkJsonl(p, out);
    else if (e.isFile() && e.name.endsWith('.jsonl')) out.push(p);
  }
  return out;
}

// Read complete lines from [offset, size) and hand the ones containing
// `needle` to onLine. Returns the offset just past the last complete line, so
// a line still being written is picked up whole next run.
function readLines(file, offset, size, needles, onLine) {
  const fd = fs.openSync(file, 'r');
  let pos = offset;
  let carry = Buffer.alloc(0);
  let done = offset;
  try {
    while (pos < size) {
      const buf = Buffer.allocUnsafe(Math.min(CHUNK, size - pos));
      const n = fs.readSync(fd, buf, 0, buf.length, pos);
      if (n <= 0) break;
      pos += n;
      const chunk = carry.length ? Buffer.concat([carry, buf.subarray(0, n)]) : buf.subarray(0, n);
      const lastNl = chunk.lastIndexOf(10);
      if (lastNl < 0) { carry = Buffer.from(chunk); continue; }
      const text = chunk.toString('utf8', 0, lastNl);
      carry = Buffer.from(chunk.subarray(lastNl + 1));
      done = pos - carry.length;
      for (const line of text.split('\n')) {
        if (!line || !needles.some((s) => line.includes(s))) continue;
        let o;
        try { o = JSON.parse(line); } catch (e) { continue; }
        onLine(o, line);
      }
    }
  } finally { fs.closeSync(fd); }
  return done;
}

// ---------- workspaces + attribution context ----------

// A workspace a board server has run in. board.json alone is not enough: a
// workspace repo tracks it in git, so every clone of that repo carries one.
function isWorkspace(dir) {
  return STATE_DIRS.some((n) => fs.existsSync(path.join(dir, n, 'board.json')) &&
    (fs.existsSync(path.join(dir, n, 'server.log')) || fs.existsSync(path.join(dir, n, 'server.pid'))));
}

// Nearest ancestor of cwd that is a BC workspace (cached per cwd).
function makeWsFinder(extra) {
  const cache = new Map();
  const known = new Set((extra || []).filter(Boolean));
  function find(cwd) {
    if (!cwd) return null;
    if (cache.has(cwd)) return cache.get(cwd);
    let ws = null;
    for (let d = cwd; ; d = path.dirname(d)) {
      if (known.has(d) || isWorkspace(d)) { ws = d; break; }
      if (path.dirname(d) === d) break;
    }
    cache.set(cwd, ws);
    return ws;
  }
  return find;
}

function readJson(file) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch (e) { return null; }
}
function readJsonl(file) {
  let text = '';
  try { text = fs.readFileSync(file, 'utf8'); } catch (e) { return []; }
  const out = [];
  for (const line of text.split('\n')) {
    if (!line) continue;
    try { out.push(JSON.parse(line)); } catch (e) {}
  }
  return out;
}

// The attribution maps of one workspace, from the board, the archive and the
// harness records (<tmux-session>[:<window>].session-id / .turnend.jsonl).
function workspaceContext(ws) {
  const sd = STATE_DIRS.map((n) => path.join(ws, n)).find((d) => fs.existsSync(path.join(d, 'board.json')));
  const ctx = { ws, lts: {}, cards: {}, ltSessions: {}, workerSessions: {}, tmux: {}, prefixes: {} };
  if (!sd) return ctx;
  const board = readJson(path.join(sd, 'board.json')) || {};
  for (const lt of board.lieutenants || []) {
    ctx.lts[lt.id] = { name: lt.name || lt.id, color: lt.color || '' };
    if (lt.prefix) ctx.prefixes[lt.prefix] = lt.id;
    const ref = lt.ref || {};
    if (ref.session) ctx.tmux[ref.session] = { lt: lt.id };
    if (ref.resumeId) ctx.ltSessions[ref.resumeId] = lt.id;
  }
  const addCard = (c) => {
    if (!c || !c.id) return;
    const a = c.attributes || {};
    ctx.cards[c.id] = { owner: c.owner || '', title: c.title || '', project: a.repo || '' };
    if (a.resumeId) ctx.workerSessions[a.resumeId] = c.id;
    if (a.session) ctx.tmux[a.session] = { card: c.id };
  };
  for (const r of readJsonl(path.join(sd, 'archive.jsonl'))) addCard(r.card);
  for (const c of board.cards || []) addCard(c); // live cards win over their old snapshots
  for (const w of board.workers || []) {
    if (!w || !w.card) continue;
    const ref = w.ref || {};
    if (ref.resumeId) ctx.workerSessions[ref.resumeId] = w.card;
    if (ref.session) ctx.tmux[ref.session] = { card: w.card };
    if (ctx.cards[w.card] && !ctx.cards[w.card].project) ctx.cards[w.card].project = w.project || '';
  }
  // harness records: every session id a tmux session/window ever ran under
  let files = [];
  try { files = fs.readdirSync(path.join(sd, 'harness')); } catch (e) {}
  const ids = {};
  for (const f of files) {
    const m = /^(.+?)\.(session-id|turnend\.jsonl)$/.exec(f);
    if (!m) continue;
    const name = m[1];
    const p = path.join(sd, 'harness', f);
    const set = ids[name] || (ids[name] = new Set());
    if (m[2] === 'session-id') {
      try { const s = fs.readFileSync(p, 'utf8').trim(); if (s) set.add(s); } catch (e) {}
    } else {
      for (const r of readJsonl(p)) if (r.session_id) set.add(r.session_id);
    }
  }
  for (const [name, set] of Object.entries(ids)) {
    const owner = harnessOwner(name, ctx);
    if (!owner) continue;
    for (const sid of set) {
      if (owner.card) ctx.workerSessions[sid] = owner.card;
      else if (owner.lt && !ctx.workerSessions[sid]) ctx.ltSessions[sid] = owner.lt;
    }
  }
  return ctx;
}

// A harness record name → {lt} or {card}. Names are `<tmux>:<window>` (window
// `lt` or `w-<card>`) or, from before windows, a bare `…-lt-<id>` / `…-w-<card>`.
function harnessOwner(name, ctx) {
  if (ctx.tmux[name]) return ctx.tmux[name];
  const [sess, win] = name.split(':');
  if (win === 'lt') {
    if (ctx.tmux[sess] && ctx.tmux[sess].lt) return ctx.tmux[sess];
    const m = /(?:^bc-lt-|-lt-)(.+)$/.exec(sess);
    return m ? { lt: m[1] } : null;
  }
  const w = win ? /^w-(.+)$/.exec(win) : /-w-(.+)$/.exec(sess);
  if (w && ctx.cards[w[1]]) return { card: w[1] };
  return null;
}

// Merge the contexts of every workspace seen in the facts. With more than one
// workspace a lieutenant id is prefixed by its workspace's folder name.
// hints (sid → {lt}|{card}, cwd) fill in what the harness records missed.
function buildContext(wsRoots, hints, finder) {
  const all = { workspaces: [], lts: {}, cards: {}, ltSessions: {}, workerSessions: {}, prefixes: {} };
  const multi = wsRoots.length > 1;
  const ltIdIn = (ws) => (id) => (multi ? path.basename(ws) + '/' : '') + id;
  for (const ws of wsRoots) {
    const c = workspaceContext(ws);
    all.workspaces.push(ws);
    const ltId = ltIdIn(ws);
    for (const [id, v] of Object.entries(c.lts)) all.lts[ltId(id)] = v;
    for (const [id, v] of Object.entries(c.cards)) all.cards[id] = Object.assign({}, v, { owner: v.owner ? ltId(v.owner) : '' });
    for (const [sid, id] of Object.entries(c.ltSessions)) all.ltSessions[sid] = ltId(id);
    for (const [px, id] of Object.entries(c.prefixes)) all.prefixes[px] = ltId(id);
    Object.assign(all.workerSessions, c.workerSessions);
  }
  for (const [sid, h] of Object.entries(hints || {})) {
    if (all.ltSessions[sid] || all.workerSessions[sid]) continue;
    if (h.card) all.workerSessions[sid] = h.card;
    else if (h.lt) {
      const ws = finder ? finder(h.cwd) : null;
      if (ws && wsRoots.includes(ws)) all.ltSessions[sid] = ltIdIn(ws)(h.lt);
    }
  }
  return all;
}

// ---------- attribution ----------

const HOME = os.homedir();

// Where a non-BC cwd's work is grouped: its repo, best effort.
function repoLabel(cwd) {
  if (!cwd) return '(unknown)';
  const rel = path.relative(HOME, cwd);
  if (rel.startsWith('..') || path.isAbsolute(rel)) return cwd;
  if (!rel) return '~';
  const seg = rel.split(path.sep);
  if (seg[0] === '.treehouse' && seg.length >= 4) return seg[3];
  if (seg[0] === '.treehouse' && seg[1]) return seg[1].replace(/-[0-9a-f]{6}$/, '');
  if (seg[0] === '.no-mistakes') return 'no-mistakes';
  if (seg[0] === 'repos' && seg[1]) return seg[1];
  return seg.slice(0, 2).join('/');
}
// /tmp/brag-51vecfwy → /tmp/brag-*: throwaway dirs group by their stem
function tmpLabel(cwd) {
  if (!/^\/tmp\/./.test(cwd)) return null;
  const top = cwd.split('/').slice(0, 3).join('/');
  const m = /^(\/tmp\/.+?)[-_]*[A-Za-z0-9_]{8}$/.exec(top);
  return m ? m[1] + '-*' : top;
}

// One fact → { cat: 'lt'|'worker'|'other', lt, card, repo }. First match wins:
//   1. branch bc/<CARD>          a worker's line, per line (treehouse slots are reused)
//   2. session of a worker       lines before the branch was cut
//   3. session of a lieutenant   incl. its subagents, wherever they cd'd
//   4. cwd in <ws>/.bridge-commander/worktrees/<CARD>
//   5. cwd in <ws>/projects/<p>  the captain working a project by hand: non-BC
//   6. cwd elsewhere in a ws     lieutenant work nobody claimed ('?')
//   7. anything else             non-BC, by repo
function attributor(ctx, wsFinder) {
  const memo = new Map();
  // bc/LEN-121-pnpm → LEN-121 when only the shorter id is a card; an unknown
  // card still finds its lieutenant through the id prefix (LEN → lennya)
  const worker = (raw) => {
    let card = raw;
    for (let id = raw; !ctx.cards[card] && id.includes('-'); ) {
      id = id.slice(0, id.lastIndexOf('-'));
      if (ctx.cards[id]) card = id;
    }
    const c = ctx.cards[card] || {};
    const px = /^([A-Z]+)-\d+/.exec(card);
    const owner = c.owner || (px && (ctx.prefixes || {})[px[1]]) || '?';
    return { cat: 'worker', card, lt: owner, project: c.project || '' };
  };
  return function attribute(f) {
    const mk = f.sid + '\t' + f.cwd + '\t' + f.branch;
    if (memo.has(mk)) return memo.get(mk);
    let a;
    const b = /^bc\/(.+)$/.exec(f.branch || '');
    if (b) a = worker(b[1]);
    else if (ctx.workerSessions[f.sid]) a = worker(ctx.workerSessions[f.sid]);
    else if (ctx.ltSessions[f.sid]) a = { cat: 'lt', lt: ctx.ltSessions[f.sid] };
    else {
      const ws = wsFinder(f.cwd);
      const rel = ws ? path.relative(ws, f.cwd) : null;
      const wt = rel != null && /^\.bridge-command(?:er)?\/worktrees\/([^/]+)/.exec(rel);
      const pr = rel != null && /^projects\/([^/]+)/.exec(rel);
      if (wt) a = worker(wt[1]);
      else if (pr) a = { cat: 'other', repo: pr[1] };
      // e.g. a scheduled hook's run folder: artifacts/jarbas-problems-runs/<ts>/…
      else if (ws) {
        const seg = rel.split(path.sep);
        a = { cat: 'lt', lt: '?' + seg.slice(0, STATE_DIRS.includes(seg[0]) ? 3 : 2).join('/') };
      }
      else a = { cat: 'other', repo: tmpLabel(f.cwd) || repoLabel(f.cwd) };
    }
    memo.set(mk, a);
    return a;
  };
}

// ---------- summarize ----------

const ZERO = () => [0, 0, 0, 0, 0];
function addInto(node, tok, usd, n) {
  for (let i = 0; i < 5; i++) { node.tok[i] += tok[i]; node.usd[i] += usd ? usd[i] : 0; }
  node.n += n;
  if (!usd) node.unpriced += tok.reduce((a, b) => a + b, 0);
}
function newNode(id, label, extra) {
  return Object.assign({ id, label, tok: ZERO(), usd: ZERO(), n: 0, unpriced: 0, kids: {} }, extra || {});
}
// kids map → array, heaviest first
function finish(node) {
  const kids = Object.values(node.kids).map(finish);
  kids.sort((a, b) => sum(b.usd) - sum(a.usd) || sum(b.tok) - sum(a.tok));
  const out = Object.assign({}, node, { kids });
  if (!kids.length) delete out.kids;
  return out;
}
function sum(a) { return a.reduce((x, y) => x + y, 0); }

// Hour 'YYYY-MM-DDTHH' (UTC) → local bucket label for tzOffsetMin (minutes
// EAST of UTC, i.e. -getTimezoneOffset()). Week buckets start on Monday.
function bucketOf(hour, tzOffsetMin, by) {
  const t = Date.parse(hour + ':00:00Z') + tzOffsetMin * 60000;
  const d = new Date(t);
  if (by === 'week') {
    const dow = (d.getUTCDay() + 6) % 7;
    d.setUTCDate(d.getUTCDate() - dow);
  }
  return d.toISOString().slice(0, 10);
}

const CAT_LABEL = { lt: 'lieutenants', worker: 'workers', other: 'non-BC' };

// facts → { buckets: [{ key, cats: {lt, worker, other}: {tok, usd} }], tree, totals, models }
// opts: { src: 'claude'|'codex', from, to (ms), tz (min east), by: 'day'|'week',
//         focus (a bucket key: the tree covers that bucket only), prices }
function summarize(facts, ctx, opts) {
  const o = Object.assign({ src: 'claude', tz: 0, by: 'day' }, opts || {});
  const finder = makeWsFinder(ctx.workspaces);
  const attribute = attributor(ctx, finder);
  const fromH = o.from ? new Date(o.from).toISOString().slice(0, 13) : '';
  const toH = o.to ? new Date(o.to).toISOString().slice(0, 13) : '￿';
  const buckets = {};
  const root = newNode('all', 'all');
  const models = {};
  const ltLabel = (id) => (id[0] === '?' ? '(unclaimed) ' + (id.slice(1).replace(/^\.bridge-commander\//, '') || 'workspace root')
    : (ctx.lts[id] && ctx.lts[id].name) || id);
  for (const [k, row] of Object.entries(facts)) {
    const f = splitKey(k);
    if (f.src !== o.src || f.hour < fromH || f.hour > toH) continue;
    const tok = row.slice(0, 5);
    const usd = costOf(f.model, f.speed, tok, o.prices);
    const a = attribute(f);
    const bk = bucketOf(f.hour, o.tz, o.by);
    const b = buckets[bk] || (buckets[bk] = { key: bk, cats: {} });
    const bc = b.cats[a.cat] || (b.cats[a.cat] = { tok: ZERO(), usd: ZERO(), n: 0, unpriced: 0 });
    addInto(bc, tok, usd, row[5]);
    // a focused bucket narrows the tree and the models; the series stays whole
    if (o.focus && bk !== o.focus) continue;
    const m = models[f.model] || (models[f.model] = { model: f.model, tok: ZERO(), usd: ZERO(), n: 0, unpriced: 0, priced: !!usd });
    addInto(m, tok, usd, row[5]);
    // tree: category → lieutenant|repo → card → session
    addInto(root, tok, usd, row[5]);
    const cat = root.kids[a.cat] || (root.kids[a.cat] = newNode(a.cat, CAT_LABEL[a.cat], { kind: 'cat' }));
    addInto(cat, tok, usd, row[5]);
    let parent = cat;
    if (a.cat === 'other') {
      parent = cat.kids[a.repo] || (cat.kids[a.repo] = newNode(a.repo, a.repo, { kind: 'repo' }));
      addInto(parent, tok, usd, row[5]);
    } else {
      const lt = cat.kids[a.lt] || (cat.kids[a.lt] = newNode(a.lt, ltLabel(a.lt), { kind: 'lt', color: (ctx.lts[a.lt] || {}).color || '' }));
      addInto(lt, tok, usd, row[5]);
      parent = lt;
      if (a.cat === 'worker') {
        const c = ctx.cards[a.card] || {};
        parent = lt.kids[a.card] || (lt.kids[a.card] = newNode(a.card, c.title || a.card, { kind: 'card', project: a.project || '' }));
        addInto(parent, tok, usd, row[5]);
      }
    }
    const sid = f.sid || '(no session)';
    const s = parent.kids[sid] || (parent.kids[sid] = newNode(sid, sid.slice(0, 8), { kind: 'session', first: f.hour, last: f.hour, cwd: f.cwd, models: [] }));
    addInto(s, tok, usd, row[5]);
    if (f.hour < s.first) s.first = f.hour;
    if (f.hour > s.last) s.last = f.hour;
    if (!s.models.includes(f.model)) s.models.push(f.model);
  }
  return {
    src: o.src, by: o.by, focus: o.focus || null,
    buckets: Object.values(buckets).sort((a, b) => (a.key < b.key ? -1 : 1)),
    tree: finish(root),
    models: Object.values(models).sort((a, b) => sum(b.tok) - sum(a.tok)),
  };
}

// ---------- the store ----------

function storeDir(ws) {
  const sd = STATE_DIRS.map((n) => path.join(ws, n)).find((d) => fs.existsSync(d)) || path.join(ws, STATE_DIRS[0]);
  return path.join(sd, 'usage');
}
function ensureStore(dir) {
  fs.mkdirSync(dir, { recursive: true });
  const gi = path.join(dir, '.gitignore');
  if (!fs.existsSync(gi)) fs.writeFileSync(gi, '# token usage index: machine-local, rebuildable\n*\n');
}
function writeJson(file, obj) {
  const tmp = file + '.' + process.pid + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(obj));
  fs.renameSync(tmp, file);
}

function loadPrices(dir) {
  const extra = readJson(path.join(dir, 'prices.json'));
  return extra && typeof extra === 'object' ? Object.assign({}, PRICES, extra) : PRICES;
}

// The quota trail: one line per change in a source's used percentages, moving
// forward in time only (a forked Codex rollout replays its parent's samples).
function appendQuota(dir, sample, lastBySrc) {
  const sig = JSON.stringify(sample.windows);
  const last = lastBySrc[sample.src];
  if (last && typeof last === 'object' && (last.sig === sig || String(sample.ts) <= String(last.ts))) return;
  lastBySrc[sample.src] = { sig, ts: sample.ts };
  fs.appendFileSync(path.join(dir, 'quota.jsonl'), JSON.stringify(sample) + '\n');
}
function readQuota(dir, fromMs) {
  return readJsonl(path.join(dir, 'quota.jsonl')).filter((q) => !fromMs || Date.parse(q.ts) >= fromMs);
}
function codexQuotaSample(rate) {
  const rl = rate.rl || {};
  const windows = {};
  for (const k of ['primary', 'secondary']) {
    const w = rl[k];
    if (w && w.used_percent != null) windows[w.window_minutes === 300 ? '5h' : w.window_minutes === 10080 ? '7d' : String(w.window_minutes) + 'm'] = w.used_percent;
  }
  return Object.keys(windows).length ? { ts: rate.ts, src: 'codex', windows } : null;
}

// Claude's rate limits reach disk only through the statusline sidecars
// (<ws>/.bridge-commander/statusline/<session>.json, one per session, the
// latest payload each). Each sidecar newer than the last harvest is a sample.
function harvestSidecars(ws, dir, state) {
  const sd = STATE_DIRS.map((n) => path.join(ws, n, 'statusline')).find((d) => fs.existsSync(d));
  if (!sd) return;
  const since = state.sidecarAt || '';
  const samples = [];
  let files = [];
  try { files = fs.readdirSync(sd).filter((f) => f.endsWith('.json')); } catch (e) {}
  for (const f of files) {
    const doc = readJson(path.join(sd, f));
    const rl = doc && doc.payload && doc.payload.rate_limits;
    if (!rl || !doc.receivedAt || doc.receivedAt <= since) continue;
    const windows = {};
    if (rl.five_hour && rl.five_hour.used_percentage != null) windows['5h'] = Number(rl.five_hour.used_percentage);
    if (rl.seven_day && rl.seven_day.used_percentage != null) windows['7d'] = Number(rl.seven_day.used_percentage);
    if (Object.keys(windows).length) samples.push({ ts: doc.receivedAt, src: 'claude', windows });
  }
  samples.sort((a, b) => (a.ts < b.ts ? -1 : 1));
  for (const q of samples) appendQuota(dir, q, state.quotaLast);
  if (samples.length) state.sidecarAt = samples[samples.length - 1].ts;
}

function acquireLock(dir) {
  const lock = path.join(dir, 'index.lock');
  try {
    const st = fs.statSync(lock);
    if (Date.now() - st.mtimeMs < LOCK_STALE_MS) return null;
    fs.unlinkSync(lock);
  } catch (e) {}
  try { fs.writeFileSync(lock, String(process.pid), { flag: 'wx' }); } catch (e) { return null; }
  return () => { try { fs.unlinkSync(lock); } catch (e) {} };
}

// One incremental pass. opts: { workspace, claudeRoot, codexRoot, now, log }
function runIndex(opts) {
  const o = Object.assign({
    claudeRoot: path.join(HOME, '.claude', 'projects'),
    codexRoot: path.join(HOME, '.codex', 'sessions'),
    now: Date.now(),
  }, Object.fromEntries(Object.entries(opts || {}).filter(([, v]) => v !== undefined)));
  const dir = o.dir || storeDir(o.workspace);
  ensureStore(dir);
  const release = acquireLock(dir);
  if (!release) return { busy: true };
  try {
    const t0 = Date.now();
    const state = readJson(path.join(dir, 'state.json')) || {};
    const files = state.files || {};
    const seen = state.seen || {};
    const facts = readJson(path.join(dir, 'facts.json')) || {};
    const quotaLast = state.quotaLast || {};
    const hints = state.hints || {};
    let bytes = 0, records = 0, touched = 0;
    const sources = [
      { src: 'claude', root: o.claudeRoot, needles: ['"usage"'].concat(HINT_NEEDLES), parse: (obj) => claudeRecord(obj) },
      { src: 'codex', root: o.codexRoot, needles: ['"token_count"', '"session_meta"', '"turn_context"'].concat(HINT_NEEDLES), parse: (obj, fc) => codexRecord(obj, fc) },
    ];
    const live = new Set();
    for (const s of sources) {
      for (const file of walkJsonl(s.root, [])) {
        live.add(file);
        let st;
        try { st = fs.statSync(file); } catch (e) { continue; }
        let fs0 = files[file];
        // shrunk or replaced: read it again from the top; dedupe absorbs the overlap
        if (fs0 && (st.size < fs0.off || (fs0.ino && fs0.ino !== st.ino))) fs0 = null;
        if (fs0 && fs0.off === st.size) continue;
        const rec = fs0 || { off: 0, ino: st.ino };
        if (s.src === 'codex' && !rec.fc) rec.fc = {};
        bytes += st.size - rec.off;
        touched++;
        rec.off = readLines(file, rec.off, st.size, s.needles, (obj, line) => {
          if (HINT_NEEDLES.some((n) => line.includes(n))) {
            const sid = s.src === 'claude' ? obj.sessionId : rec.fc.sid;
            const h = sid && !hints[sid] && hintOf(obj);
            if (h) hints[sid] = Object.assign(h, { cwd: obj.cwd || (rec.fc && rec.fc.cwd) || '' });
          }
          const r = s.parse(obj, rec.fc);
          if (r) { addRecord(facts, seen, s.src, r); records++; }
          if (rec.fc && rec.fc.rate) {
            const q = codexQuotaSample(rec.fc.rate);
            delete rec.fc.rate;
            if (q) appendQuota(dir, q, quotaLast);
          }
        });
        rec.ino = st.ino;
        files[file] = rec;
      }
    }
    for (const f of Object.keys(files)) if (!live.has(f)) delete files[f];
    const qstate = { quotaLast, sidecarAt: state.sidecarAt || '' };
    if (o.workspace) harvestSidecars(o.workspace, dir, qstate);
    // forget dedupe keys well past any copy's lag
    const cutoff = o.now - SEEN_TTL_MS;
    for (const [k, v] of Object.entries(seen)) if (v.ts < cutoff) delete seen[k];
    // the workspaces the facts touched, then their attribution maps
    const finder = makeWsFinder(o.workspace ? [o.workspace] : []);
    const wsSet = new Set(o.workspace ? [o.workspace] : []);
    const cwds = new Set();
    for (const k of Object.keys(facts)) cwds.add(splitKey(k).cwd);
    for (const c of cwds) { const w = finder(c); if (w) wsSet.add(w); }
    const ctx = buildContext([...wsSet], hints, finder);
    writeJson(path.join(dir, 'facts.json'), facts);
    writeJson(path.join(dir, 'context.json'), ctx);
    const meta = { at: new Date(o.now).toISOString(), ms: Date.now() - t0, bytes, records, files: touched, facts: Object.keys(facts).length };
    writeJson(path.join(dir, 'state.json'), { files, seen, quotaLast, hints, sidecarAt: qstate.sidecarAt, last: meta });
    return meta;
  } finally { release(); }
}

// What the server reads: the facts, the context, and the last run's stamp.
function loadStore(dir) {
  const state = readJson(path.join(dir, 'state.json')) || {};
  return {
    facts: readJson(path.join(dir, 'facts.json')) || {},
    ctx: readJson(path.join(dir, 'context.json')) || { workspaces: [], lts: {}, cards: {}, ltSessions: {}, workerSessions: {} },
    last: state.last || null,
    prices: loadPrices(dir),
  };
}

module.exports = {
  PRICES, priceOf, costOf, claudeRecord, codexRecord, hintOf, addRecord, factKey, splitKey,
  readLines, workspaceContext, buildContext, attributor, makeWsFinder, repoLabel,
  summarize, bucketOf, runIndex, loadStore, storeDir, ensureStore, readQuota, appendQuota,
};

// CLI: node server/usage.js index --workspace <ws>  (a named hook can run this)
if (require.main === module) {
  const argv = process.argv.slice(2);
  const arg = (n) => { const i = argv.indexOf(n); return i >= 0 ? argv[i + 1] : undefined; };
  if (argv[0] !== 'index') {
    process.stderr.write('usage: node server/usage.js index [--workspace <ws>] [--claude <dir>] [--codex <dir>]\n');
    process.exit(2);
  }
  const ws = path.resolve(arg('--workspace') || process.env.BC_WORKSPACE || process.cwd());
  const r = runIndex({ workspace: ws, claudeRoot: arg('--claude'), codexRoot: arg('--codex') });
  process.stdout.write(JSON.stringify(r) + '\n');
}
