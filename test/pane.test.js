'use strict';
// 👁 peek — the pane hub: a worker's / lieutenant's pane streamed over a
// dedicated per-target SSE, through the harness port's OPTIONAL openPane
// capability. Ref-counted (N viewers share ONE harness feed; the last
// disconnect releases it), capability-checked (no openPane → `unsupported`),
// guarded (`no-pane`, `busy`) — every guard a clean SSE event, never a 500.
// Uses the file-backed fake harness: opens/closes land in <key>.pane.jsonl so
// this process can assert refcounting across the server process boundary.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const { startServerWithLieutenant, withOwner, sleep, LT } = require('./helper');
const { lieutenantSession, workerWindow } = require('../server/names.js');

function git(dir, ...args) {
  return execFileSync('git', ['-C', dir, ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
}
function makeRepo(root, name = 'srcrepo') {
  const repo = path.join(root, name);
  fs.mkdirSync(repo, { recursive: true });
  execFileSync('git', ['init', '-q', '-b', 'main', repo], { stdio: ['ignore', 'pipe', 'pipe'] });
  fs.writeFileSync(path.join(repo, 'README.md'), 'hello\n');
  git(repo, 'add', '.');
  git(repo, '-c', 'user.email=t@t', '-c', 'user.name=t', 'commit', '-q', '-m', 'init');
  return repo;
}

// One temp tree per boot: fake-harness state + source repo + workspace.
// BC_FAKE_PANE_MS keeps fake frames fast so tests never wait a real second.
async function boot(extraEnv = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'bc-pane-'));
  const repo = makeRepo(root);
  const fdir = path.join(root, 'fake');
  const s = await startServerWithLieutenant({
    env: Object.assign({
      BC_FAKE_STATE: fdir, BC_WORKTREE_TOOL: 'git', BC_FAKE_PANE_MS: '25',
      BC_SUPERVISE_INTERVAL_MS: '0', BC_PRWATCH_INTERVAL_MS: '0',
    }, extraEnv),
  });
  const r = await s.api('POST', '/api/projects', { source: repo, name: 'proj', mode: 'local-only' });
  assert.strictEqual(r.status, 200, JSON.stringify(r.body));
  const teardown = async () => { await s.stop(); fs.rmSync(root, { recursive: true, force: true }); };
  return { s, root, repo, fdir, teardown };
}

// Start a fake worker on a fresh card and return its harness pane key.
async function startWorker(s, dir, id) {
  let r = await s.api('POST', '/api/cards', withOwner({ title: id, id, attributes: { repo: 'proj' } }));
  assert.strictEqual(r.status, 200, JSON.stringify(r.body));
  r = await s.api('POST', '/api/cards/' + id + '/start', { harness: 'fake' });
  assert.strictEqual(r.status, 200, JSON.stringify(r.body));
  return lieutenantSession(dir, LT) + ':' + workerWindow(id);
}

// A minimal SSE client over fetch: collects {event, data} frames as they land;
// waitFor(event) resolves with the first matching event; close() drops the
// connection (what the server sees as the subscriber leaving).
async function sseOpen(url) {
  const ctrl = new AbortController();
  const res = await fetch(url, { signal: ctrl.signal });
  assert.strictEqual(res.status, 200);
  assert.match(res.headers.get('content-type'), /text\/event-stream/);
  const events = [];
  const waiters = [];
  const reader = res.body.getReader();
  const dec = new TextDecoder();
  let buf = '';
  (async () => {
    try {
      for (;;) {
        const { value, done } = await reader.read();
        if (done) break;
        buf += dec.decode(value, { stream: true });
        for (;;) {
          const end = buf.indexOf('\n\n');
          if (end === -1) break;
          const frame = buf.slice(0, end);
          buf = buf.slice(end + 2);
          const event = (/^event: (.*)$/m.exec(frame) || [])[1] || 'message';
          const raw = (/^data: (.*)$/m.exec(frame) || [])[1];
          let data = null;
          try { data = raw === undefined ? null : JSON.parse(raw); } catch (e) { data = raw; }
          const ev = { event, data };
          events.push(ev);
          for (const w of [...waiters]) {
            if (w.match(ev)) { waiters.splice(waiters.indexOf(w), 1); w.resolve(ev); }
          }
        }
      }
    } catch (e) { /* aborted / closed */ }
    for (const w of [...waiters]) w.reject(new Error('stream ended before event: ' + w.name));
  })();
  return {
    events,
    waitFor(name, timeoutMs = 4000, extra) {
      const match = (ev) => ev.event === name && (!extra || extra(ev));
      const hit = events.find(match);
      if (hit) return Promise.resolve(hit);
      return new Promise((resolve, reject) => {
        const w = { name, match, resolve, reject };
        waiters.push(w);
        setTimeout(() => {
          const i = waiters.indexOf(w);
          if (i !== -1) { waiters.splice(i, 1); reject(new Error('timeout waiting for event: ' + name)); }
        }, timeoutMs).unref();
      });
    },
    close() { ctrl.abort(); },
  };
}

function paneLog(fdir, key) {
  try {
    return fs.readFileSync(path.join(fdir, key + '.pane.jsonl'), 'utf8')
      .split('\n').filter(Boolean).map((l) => JSON.parse(l));
  } catch (e) { return []; }
}
async function waitLog(fdir, key, pred, timeoutMs = 4000) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const log = paneLog(fdir, key);
    if (pred(log)) return log;
    if (Date.now() > deadline) return log;
    await sleep(30);
  }
}

test('card pane stream: frames flow; two subscribers share ONE pane; last close tears it down', async () => {
  const { s, fdir, teardown } = await boot();
  try {
    const key = await startWorker(s, s.dir, 'peek-me');
    const url = s.base + '/api/cards/peek-me/pane/stream';

    const a = await sseOpen(url);
    const f1 = await a.waitFor('frame');
    assert.match(String(f1.data), /fake pane .*w-peek-me/);

    // frames keep flowing (fake counter frames change every tick)
    await a.waitFor('frame', 4000, (ev) => ev !== f1 && ev.data !== f1.data);

    // a second subscriber shares the pane: immediate paint, still ONE open
    const b = await sseOpen(url);
    await b.waitFor('frame');
    let log = await waitLog(fdir, key, (l) => l.some((e) => e.event === 'open'));
    assert.strictEqual(log.filter((e) => e.event === 'open').length, 1, 'refcount: one open for two subscribers');
    assert.strictEqual(log.filter((e) => e.event === 'close').length, 0);

    // first leaves — the pane stays (b still watching)
    a.close();
    await sleep(150);
    log = paneLog(fdir, key);
    assert.strictEqual(log.filter((e) => e.event === 'close').length, 0, 'pane survives while a subscriber remains');
    await b.waitFor('frame', 4000, (ev) => ev.data !== f1.data); // b still receives

    // last leaves — close() exactly once
    b.close();
    log = await waitLog(fdir, key, (l) => l.some((e) => e.event === 'close'));
    assert.strictEqual(log.filter((e) => e.event === 'close').length, 1, 'last disconnect closes the pane once');

    // a fresh subscriber reopens (open #2): the hub was really gone
    const c = await sseOpen(url);
    await c.waitFor('frame');
    log = await waitLog(fdir, key, (l) => l.filter((e) => e.event === 'open').length === 2);
    assert.strictEqual(log.filter((e) => e.event === 'open').length, 2);
    c.close();
  } finally { await teardown(); }
});

test('lieutenant pane stream: resolves the lieutenant ref', async () => {
  const { s, teardown } = await boot();
  try {
    // bind a fake ref to the lieutenant (like a spawned one would carry)
    const r = await s.api('PATCH', '/api/lieutenants/' + LT,
      { ref: { harness: 'fake', session: 'bc-lt-pane', cwd: '/tmp' } });
    assert.strictEqual(r.status, 200);
    const c = await sseOpen(s.base + '/api/lieutenants/' + LT + '/pane/stream');
    const f = await c.waitFor('frame');
    assert.match(String(f.data), /fake pane bc-lt-pane/);
    c.close();
  } finally { await teardown(); }
});

test('capability absent (harness without openPane) → unsupported, clean close', async () => {
  const { s, teardown } = await boot({ BC_FAKE_NO_PANE: '1' });
  try {
    await startWorker(s, s.dir, 'no-cap');
    const c = await sseOpen(s.base + '/api/cards/no-cap/pane/stream');
    const ev = await c.waitFor('unsupported');
    assert.strictEqual(ev.data.harness, 'fake');
    assert.ok(!c.events.some((e) => e.event === 'frame'), 'no frames from an unsupported harness');
    c.close();
  } finally { await teardown(); }
});

test('no live worker / card not Working / unknown targets → no-pane', async () => {
  const { s, teardown } = await boot();
  try {
    // a card sitting in Backlog: not Working, no worker
    await s.api('POST', '/api/cards', withOwner({ title: 'Parked idea', id: 'parked-idea' }));
    let c = await sseOpen(s.base + '/api/cards/parked-idea/pane/stream');
    let ev = await c.waitFor('no-pane');
    assert.match(ev.data.reason, /not Working/);
    c.close();

    c = await sseOpen(s.base + '/api/cards/never-was/pane/stream');
    ev = await c.waitFor('no-pane');
    assert.match(ev.data.reason, /unknown card/);
    c.close();

    c = await sseOpen(s.base + '/api/lieutenants/nobody/pane/stream');
    ev = await c.waitFor('no-pane');
    assert.match(ev.data.reason, /unknown lieutenant/);
    c.close();

    // a lieutenant with no session ref
    c = await sseOpen(s.base + '/api/lieutenants/' + LT + '/pane/stream');
    ev = await c.waitFor('no-pane');
    assert.match(ev.data.reason, /no live session/);
    c.close();
  } finally { await teardown(); }
});

test('concurrent-pane cap → busy (existing streams unaffected)', async () => {
  const { s, teardown } = await boot({ BC_PANE_MAX: '1' });
  try {
    await startWorker(s, s.dir, 'first-pane');
    await startWorker(s, s.dir, 'second-pane');
    const a = await sseOpen(s.base + '/api/cards/first-pane/pane/stream');
    await a.waitFor('frame');

    // a DIFFERENT pane key over the cap → busy; the same key still shares
    const b = await sseOpen(s.base + '/api/cards/second-pane/pane/stream');
    const ev = await b.waitFor('busy');
    assert.strictEqual(ev.data.max, 1);
    b.close();

    const c = await sseOpen(s.base + '/api/cards/first-pane/pane/stream');
    await c.waitFor('frame'); // sharing the one open pane never counts against the cap
    a.close();
    c.close();
  } finally { await teardown(); }
});
