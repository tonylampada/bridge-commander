'use strict';
// 📊 usage — the indexer and the summary it feeds (server/usage.js), the route
// that serves it, and the quota trail statusline.js writes.
//
// Every test builds its own fixture tree: a fake ~/.claude/projects, a fake
// ~/.codex/sessions, and a BC workspace with a board, an archive and harness
// records — so the attribution rules are pinned against the shapes the real
// transcripts and the real board have.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const u = require('../server/usage.js');
const { recordQuota } = require('../harness/statusline.js');
const { startServer } = require('./helper.js');

function tmp() { return fs.mkdtempSync(path.join(os.tmpdir(), 'bc-usage-')); }
function write(file, text) { fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, text); }
const jl = (...objs) => objs.map((o) => JSON.stringify(o) + '\n').join('');

// one Claude Code assistant line, shaped like the real ones
function cl(o) {
  return {
    type: 'assistant', sessionId: o.sid, cwd: o.cwd, gitBranch: o.branch || 'main', isSidechain: !!o.side,
    timestamp: o.ts || '2026-10-01T12:00:00.000Z', requestId: 'req_' + o.id,
    message: { id: 'msg_' + o.id, model: o.model || 'claude-opus-5-5',
      usage: Object.assign({ input_tokens: 0, output_tokens: 0, cache_read_input_tokens: 0, cache_creation_input_tokens: 0,
        cache_creation: { ephemeral_5m_input_tokens: 0, ephemeral_1h_input_tokens: 0 } }, o.u) },
  };
}
function prompt(sid, cwd, text) {
  return { type: 'user', sessionId: sid, cwd, message: { role: 'user', content: text } };
}

// A workspace on disk: board (lieutenants with prefixes, one live card), an
// archived card, and harness records naming one lieutenant session.
function workspace(root) {
  const ws = path.join(root, 'ws');
  const sd = path.join(ws, '.bridge-commander');
  write(path.join(sd, 'server.log'), '');
  write(path.join(sd, 'board.json'), JSON.stringify({
    lieutenants: [
      { id: 'monica', name: 'Monica', prefix: 'MNC', ref: { session: 'bc-lt-monica', resumeId: 'lt-monica-now' } },
      { id: 'selma', name: 'Selma', prefix: 'SLM', ref: { session: 'bc-lt-selma' } },
    ],
    cards: [{ id: 'MNC-1', title: 'Live card', owner: 'monica', attributes: { repo: 'proj', resumeId: 'w-mnc1', session: 'bc-lt-monica:w-MNC-1' } }],
    workers: [],
  }));
  write(path.join(sd, 'archive.jsonl'), jl({ card: { id: 'SLM-9', title: 'Old card', owner: 'selma', attributes: { repo: 'proj' } } }));
  write(path.join(sd, 'harness', 'bc-lt-selma:lt.session-id'), 'lt-selma-old\n');
  write(path.join(sd, 'harness', 'bc-lt-selma:lt.turnend.jsonl'), jl({ session_id: 'lt-selma-older' }));
  return ws;
}

function index(root, ws, extra) {
  return u.runIndex(Object.assign({ workspace: ws, dir: path.join(root, 'store'),
    claudeRoot: path.join(root, 'claude'), codexRoot: path.join(root, 'codex') }, extra));
}
function summary(root, opts) {
  const st = u.loadStore(path.join(root, 'store'));
  return u.summarize(st.facts, st.ctx, Object.assign({ src: 'claude', prices: st.prices }, opts));
}
const node = (tree, ...ids) => ids.reduce((n, id) => n && (n.kids || []).find((k) => k.id === id), tree);
const sum = (a) => a.reduce((x, y) => x + y, 0);

// ---------- dedupe ----------

test('one response written as several lines counts once, at its final usage', () => {
  const root = tmp(); const ws = workspace(root);
  // Claude Code writes a response per content block; the early lines carry a
  // streaming snapshot (output 1), the last the final count (output 420)
  write(path.join(root, 'claude', 'p', 's1.jsonl'), jl(
    cl({ sid: 's1', cwd: '/elsewhere', id: 'a', u: { input_tokens: 2, output_tokens: 1, cache_creation_input_tokens: 100 } }),
    cl({ sid: 's1', cwd: '/elsewhere', id: 'a', u: { input_tokens: 2, output_tokens: 420, cache_creation_input_tokens: 100 } }),
    cl({ sid: 's1', cwd: '/elsewhere', id: 'b', u: { input_tokens: 3, output_tokens: 7, cache_read_input_tokens: 50 } }),
    cl({ sid: 's1', cwd: '/elsewhere', id: 'z', model: '<synthetic>', u: {} }), // an error stub: no usage at all
  ));
  // a forked subagent's transcript opens with a copy of its parent's last response
  write(path.join(root, 'claude', 'p', 's1', 'subagents', 'agent-x.jsonl'), jl(
    cl({ sid: 's1', cwd: '/elsewhere', id: 'b', side: true, u: { input_tokens: 3, output_tokens: 2, cache_read_input_tokens: 50 } }),
    cl({ sid: 's1', cwd: '/elsewhere', id: 'c', side: true, u: { input_tokens: 1, output_tokens: 5 } }),
  ));
  index(root, ws);
  const t = summary(root).tree;
  assert.deepStrictEqual(t.tok, [6, 432, 50, 100, 0], 'in, out, cache read, cw5m, cw1h');
  assert.strictEqual(t.n, 3, 'three distinct responses');
});

test('the 5m / 1h cache-write split is kept; a bare total prices as 5m', () => {
  const r = u.claudeRecord(cl({ sid: 's', cwd: '/x', id: 'q', u: { cache_creation_input_tokens: 30,
    cache_creation: { ephemeral_5m_input_tokens: 10, ephemeral_1h_input_tokens: 20 } } }));
  assert.deepStrictEqual(r.tok, [0, 0, 0, 10, 20]);
  const old = cl({ sid: 's', cwd: '/x', id: 'q', u: { cache_creation_input_tokens: 30 } });
  delete old.message.usage.cache_creation;
  assert.deepStrictEqual(u.claudeRecord(old).tok, [0, 0, 0, 30, 0]);
});

// ---------- attribution ----------

test('attribution: lieutenant, worker by branch per line, worker before its branch, non-BC', () => {
  const root = tmp(); const ws = workspace(root);
  const slot = path.join(os.homedir(), '.treehouse', 'proj-abc123', '1', 'proj');
  write(path.join(root, 'claude', 'a.jsonl'), jl(
    // lieutenant: session id from the board ref, and from harness records
    cl({ sid: 'lt-monica-now', cwd: ws, id: 1, u: { output_tokens: 1 } }),
    cl({ sid: 'lt-selma-older', cwd: ws, id: 2, u: { output_tokens: 2 } }),
    // one reused treehouse slot, two cards: attributed per line by branch
    cl({ sid: 'w-a', cwd: slot, branch: 'bc/MNC-1', id: 3, u: { output_tokens: 4 } }),
    cl({ sid: 'w-b', cwd: slot, branch: 'bc/SLM-9', id: 4, u: { output_tokens: 8 } }),
    // the worker's first lines, before it cut its branch: its session says who
    cl({ sid: 'w-mnc1', cwd: slot, branch: 'HEAD', id: 5, u: { output_tokens: 16 } }),
    // a suffixed branch resolves to its card; an unknown card finds its owner by prefix
    cl({ sid: 'w-c', cwd: slot, branch: 'bc/MNC-1-retry', id: 6, u: { output_tokens: 32 } }),
    cl({ sid: 'w-d', cwd: slot, branch: 'bc/SLM-404', id: 7, u: { output_tokens: 64 } }),
    // a worker in the workspace's own worktrees dir, by folder
    cl({ sid: 'w-e', cwd: path.join(ws, '.bridge-commander', 'worktrees', 'SLM-9'), branch: 'HEAD', id: 8, u: { output_tokens: 128 } }),
    // the captain working a project clone by hand: non-BC, by project
    cl({ sid: 'cap', cwd: path.join(ws, 'projects', 'proj'), id: 9, u: { output_tokens: 256 } }),
    // anything else: non-BC by repo
    cl({ sid: 'x', cwd: path.join(os.homedir(), 'repos', 'side-thing', 'src'), id: 10, u: { output_tokens: 512 } }),
  ));
  index(root, ws);
  const t = summary(root).tree;
  const out = (...ids) => node(t, ...ids).tok[1];
  assert.strictEqual(out('lt', 'monica'), 1);
  assert.strictEqual(out('lt', 'selma'), 2);
  assert.strictEqual(node(t, 'lt', 'monica').label, 'Monica');
  assert.strictEqual(out('worker', 'monica', 'MNC-1'), 4 + 16 + 32);
  assert.strictEqual(out('worker', 'selma', 'SLM-9'), 8 + 128);
  assert.strictEqual(out('worker', 'selma', 'SLM-404'), 64);
  assert.strictEqual(node(t, 'worker', 'monica', 'MNC-1').label, 'Live card');
  assert.strictEqual(out('worker', 'monica', 'MNC-1', 'w-mnc1'), 16, 'session level under the card');
  assert.strictEqual(out('other', 'proj'), 256);
  assert.strictEqual(out('other', 'side-thing'), 512);
});

test('a lieutenant session the harness never recorded is named by its own doctrine prompt', () => {
  const root = tmp(); const ws = workspace(root);
  write(path.join(root, 'claude', 'b.jsonl'), jl(
    prompt('respawn', ws, 'doctrine…\nYou are lieutenant "Selma" (id: selma) in workspace ' + ws + '.\n'),
    cl({ sid: 'respawn', cwd: ws, id: 1, u: { output_tokens: 9 } }),
    // a worker brief: the card line names it before any branch exists
    prompt('brief', '/tmp/slot', '# A card\n\n- card `SLM-9` · project `proj`\n'),
    cl({ sid: 'brief', cwd: '/tmp/slot', branch: 'HEAD', id: 2, u: { output_tokens: 3 } }),
    // nobody: a workspace session with no name lands in the unclaimed bucket
    cl({ sid: 'anon', cwd: ws, id: 3, u: { output_tokens: 5 } }),
  ));
  index(root, ws);
  const t = summary(root).tree;
  assert.strictEqual(node(t, 'lt', 'selma').tok[1], 9);
  assert.strictEqual(node(t, 'worker', 'selma', 'SLM-9').tok[1], 3);
  assert.strictEqual(node(t, 'lt', '?').tok[1], 5);
  assert.match(node(t, 'lt', '?').label, /unclaimed/);
});

test('a clone of a workspace repo is not a workspace (board.json is tracked in git)', () => {
  const root = tmp();
  const clone = path.join(root, 'clone');
  write(path.join(clone, '.bridge-commander', 'board.json'), '{}');
  write(path.join(root, 'claude', 'c.jsonl'), jl(cl({ sid: 's', cwd: clone, id: 1, u: { output_tokens: 1 } })));
  index(root, null);
  const t = summary(root).tree;
  assert.ok(node(t, 'other'), 'non-BC');
  assert.strictEqual(node(t, 'lt'), undefined);
});

// ---------- incremental ----------

// Dedupe keys are remembered for days after their line's timestamp, so these
// two use fresh lines, like a transcript being written right now.
const NOW = () => new Date().toISOString();
test('incremental: only new bytes are read; a half-written line waits for its newline', () => {
  const root = tmp(); const ws = workspace(root);
  const line = (o) => cl(Object.assign({ ts: NOW() }, o));
  const f = path.join(root, 'claude', 'grow.jsonl');
  write(f, jl(line({ sid: 's', cwd: '/x', id: 1, u: { output_tokens: 10 } })));
  const r1 = index(root, ws);
  assert.strictEqual(r1.records, 1);
  const size1 = fs.statSync(f).size;
  assert.strictEqual(index(root, ws).bytes, 0, 'nothing new: nothing read');
  // a line mid-write (no newline yet) is left for the next run
  const next = JSON.stringify(line({ sid: 's', cwd: '/x', id: 2, u: { output_tokens: 5 } }));
  fs.appendFileSync(f, next.slice(0, 40));
  const r3 = index(root, ws);
  assert.strictEqual(r3.records, 0);
  assert.strictEqual(r3.bytes, 40, 'it read only past the old offset');
  fs.appendFileSync(f, next.slice(40) + '\n');
  const r4 = index(root, ws);
  assert.strictEqual(r4.records, 1);
  assert.strictEqual(r4.bytes, fs.statSync(f).size - size1, 'resumed at the start of the unfinished line');
  // a streaming copy that lands in a LATER run still adds only its delta
  fs.appendFileSync(f, jl(line({ sid: 's', cwd: '/x', id: 2, u: { output_tokens: 50 } })));
  index(root, ws);
  assert.strictEqual(summary(root).tree.tok[1], 60);
});

test('a file that shrank is re-read from the top without double counting', () => {
  const root = tmp(); const ws = workspace(root);
  const line = (o) => cl(Object.assign({ ts: NOW() }, o));
  const f = path.join(root, 'claude', 'r.jsonl');
  write(f, jl(line({ sid: 's', cwd: '/x', id: 1, u: { output_tokens: 10 } }), line({ sid: 's', cwd: '/x', id: 2, u: { output_tokens: 10 } })));
  index(root, ws);
  write(f, jl(line({ sid: 's', cwd: '/x', id: 1, u: { output_tokens: 10 } })));
  index(root, ws);
  assert.strictEqual(summary(root).tree.tok[1], 20);
});

// ---------- codex ----------

test('codex: cumulative totals become deltas, cached input splits out, a fork copy is dropped', () => {
  const root = tmp(); const ws = workspace(root);
  const tc = (ts, input, cached, output, pct) => ({ timestamp: ts, type: 'event_msg', payload: { type: 'token_count',
    info: { total_token_usage: { input_tokens: input, cached_input_tokens: cached, output_tokens: output, total_tokens: input + output } },
    rate_limits: { primary: { used_percent: pct, window_minutes: 10080 } } } });
  const head = [
    { timestamp: 't0', type: 'session_meta', payload: { id: 'cx1', cwd: path.join(ws, '.bridge-commander', 'worktrees', 'MNC-1'), git: {} } },
    { timestamp: 't0', type: 'turn_context', payload: { model: 'gpt-5.5' } },
  ];
  const events = [tc('2026-10-01T10:00:00Z', 100, 40, 10, 20), tc('2026-10-01T10:01:00Z', 100, 40, 10, 20), tc('2026-10-01T10:02:00Z', 300, 140, 30, 21)];
  write(path.join(root, 'codex', '2026', '10', '01', 'rollout-a.jsonl'), jl(...head, ...events));
  // a forked rollout repeats its parent's events verbatim
  write(path.join(root, 'codex', '2026', '10', '01', 'rollout-b.jsonl'), jl(
    Object.assign({}, head[0], { payload: Object.assign({}, head[0].payload, { id: 'cx2' }) }), head[1], ...events));
  index(root, ws);
  const t = summary(root, { src: 'codex' }).tree;
  // 300 input of which 140 cached → 160 fresh + 140 cache read; 30 output
  assert.deepStrictEqual(node(t, 'worker', 'monica', 'MNC-1').tok, [160, 30, 140, 0, 0]);
  const q = u.readQuota(path.join(root, 'store'));
  assert.deepStrictEqual(q.map((s) => s.windows['7d']), [20, 21], 'one quota sample per change');
});

// ---------- $ ----------

test('$ at list price: per field, fast mode doubles, a dated snapshot prices as its family', () => {
  const near = (a, b) => assert.ok(Math.abs(a - b) < 1e-9, a + ' ≈ ' + b);
  // Opus 5.5: $4 in / $20 out / $0.20 cache read / $5 5m write / $8 1h write per MTok
  const c = u.costOf('claude-opus-5-5', 'standard', [1e6, 1e6, 1e6, 1e6, 1e6]);
  [4, 20, 0.2, 5, 8].forEach((v, i) => near(c[i], v));
  near(sum(u.costOf('claude-opus-5-5', 'fast', [0, 1e6, 0, 0, 0])), 40);
  near(sum(u.costOf('claude-fable-5-1', 'standard', [0, 0, 2e6, 0, 0])), 0.5);
  near(sum(u.costOf('claude-haiku-4-5-20251001', 'standard', [1e6, 0, 0, 0, 0])), 1);
  assert.strictEqual(u.costOf('mystery-model', 'standard', [1, 1, 1, 1, 1]), null);
});

test('the summary prices every row and keeps unpriced tokens visible', () => {
  const root = tmp(); const ws = workspace(root);
  write(path.join(root, 'claude', 'p.jsonl'), jl(
    cl({ sid: 's', cwd: '/x', id: 1, model: 'claude-fable-5-1', u: { input_tokens: 1e6, output_tokens: 1e6 } }),
    cl({ sid: 's', cwd: '/x', id: 2, model: 'mystery-model', u: { output_tokens: 7 } }),
  ));
  index(root, ws);
  const t = summary(root).tree;
  assert.ok(Math.abs(sum(t.usd) - 60) < 1e-9, 'fable 5.1: $10 in + $50 out');
  assert.strictEqual(t.unpriced, 7);
});

test('buckets fold to the viewer\'s local day; a focus narrows the tree, not the series', () => {
  const root = tmp(); const ws = workspace(root);
  write(path.join(root, 'claude', 'd.jsonl'), jl(
    cl({ sid: 's', cwd: '/x', id: 1, ts: '2026-10-02T02:00:00Z', u: { output_tokens: 1 } }), // Oct 1, 23:00 at UTC-3
    cl({ sid: 's', cwd: '/x', id: 2, ts: '2026-10-02T12:00:00Z', u: { output_tokens: 2 } }),
  ));
  index(root, ws);
  const s = summary(root, { tz: -180 });
  assert.deepStrictEqual(s.buckets.map((b) => b.key), ['2026-10-01', '2026-10-02']);
  const f = summary(root, { tz: -180, focus: '2026-10-02' });
  assert.strictEqual(f.buckets.length, 2);
  assert.strictEqual(f.tree.tok[1], 2);
  assert.strictEqual(u.bucketOf('2026-10-08T12', 0, 'week'), '2026-10-05', 'weeks start on Monday');
});

// ---------- quota trail from the statusline ----------

test('statusline records the 5h/7d quota once per change', () => {
  const dir = tmp();
  const p = (five, seven) => ({ cwd: '/x', rate_limits: { five_hour: { used_percentage: five }, seven_day: { used_percentage: seven } } });
  assert.strictEqual(recordQuota(p(5, 40), { workspace: dir, usageDir: dir, now: 'a' }), true);
  assert.strictEqual(recordQuota(p(5, 40), { workspace: dir, usageDir: dir, now: 'b' }), false, 'same numbers: no line');
  assert.strictEqual(recordQuota(p(6, 40), { workspace: dir, usageDir: dir, now: 'c' }), true);
  assert.strictEqual(recordQuota({ cwd: '/x' }, { workspace: dir, usageDir: dir }), false, 'no rate limits: nothing');
  const lines = fs.readFileSync(path.join(dir, 'quota.jsonl'), 'utf8').trim().split('\n').map(JSON.parse);
  assert.deepStrictEqual(lines.map((l) => [l.ts, l.windows['5h']]), [['a', 5], ['c', 6]]);
});

// ---------- the route ----------

test('GET /api/usage answers from the index the server builds in a child process', async () => {
  const root = tmp();
  const claude = path.join(root, 'claude');
  const now = new Date().toISOString();
  write(path.join(claude, 'p', 's.jsonl'), jl(cl({ sid: 's', cwd: '/x', id: 1, ts: now, u: { input_tokens: 1e6 } })));
  const srv = await startServer({ env: { BC_USAGE_CLAUDE_DIR: claude, BC_USAGE_CODEX_DIR: path.join(root, 'codex') } });
  try {
    const run = await srv.api('POST', '/api/usage/index?wait=1');
    assert.strictEqual(run.body.last.records, 1);
    const r = await srv.api('GET', '/api/usage?days=7&tz=0');
    assert.strictEqual(r.status, 200);
    assert.strictEqual(r.body.src, 'claude');
    assert.deepStrictEqual(r.body.tree.tok, [1e6, 0, 0, 0, 0]);
    assert.ok(Math.abs(sum(r.body.tree.usd) - 4) < 1e-9, 'opus 5.5 input at $4/MTok');
    assert.deepStrictEqual(r.body.prices['claude-opus-5-5'], [4, 20, 0.2, 5, 8]);
    assert.strictEqual(fs.readFileSync(path.join(srv.dir, '.bridge-commander', 'usage', '.gitignore'), 'utf8').trim().split('\n').pop(), '*');
  } finally { await srv.stop(); }
});
