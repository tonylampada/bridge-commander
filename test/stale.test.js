'use strict';
// The staleness watchdog — the "alive but hung" gap between the three worker
// end-of-life signals: a worker stuck inside a single turn (infinite tool
// loop) is alive (no worker-died), never ends its turn (no worker-stopped),
// and never reaches done. superviseTick notices a live, unpaused worker on a
// Working card with no activity (spawn / turn-end / signal) for
// BC_WORKER_STALE_SECS and fires ONE worker-stalled card event + QueueItem;
// any real activity re-arms it. Uses the file-backed fake harness: a marker
// file makes the ref alive.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { startServer, sleep } = require('./helper');

const TICK = '150';
function fakeSession(dir, session) {
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, session + '.json'), JSON.stringify({ cwd: '/tmp', resumeId: null }) + '\n');
}
async function until(what, fn, ms = 5000) {
  const deadline = Date.now() + ms;
  for (;;) {
    const v = await fn();
    if (v) return v;
    if (Date.now() > deadline) throw new Error('timeout waiting for: ' + what);
    await sleep(50);
  }
}
function seedBoard(dir, board) {
  const sd = path.join(dir, '.bridge-command');
  fs.mkdirSync(sd, { recursive: true });
  fs.writeFileSync(path.join(sd, 'board.json'), JSON.stringify(Object.assign({
    title: 'seeded', seq: 0, lieutenants: [], cards: [], events: [], labels: [], reads: {}, kinds: {},
    projects: [], workers: [],
  }, board), null, 2));
}
// One lieutenant + one Working card + one worker whose last activity is
// `ageMs` in the past — the minimal stall-shaped board.
function stallSeed(cardId, ageMs) {
  const nowIso = new Date().toISOString();
  const oldIso = new Date(Date.now() - ageMs).toISOString();
  return {
    lieutenants: [{ id: 'ada', name: 'Ada', color: '#58b6ff', charter: '', chat: [], created: nowIso }],
    cards: [{
      id: cardId, title: 'Slow', type: 'implementation', owner: 'ada', column: 'working',
      labels: [], attributes: { repo: 'proj', session: 'bc-lt-ada:w-' + cardId }, body: '',
      created: nowIso, updated: nowIso, threadStart: null, pendingOrder: null, events: [], thread: [],
    }],
    workers: [
      { card: cardId, ref: { harness: 'fake', session: 'bc-lt-ada', window: 'w-' + cardId, cwd: '/tmp', resumeId: 'a' },
        worktree: { path: '/tmp/none', tool: 'git' }, branch: 'bc/' + cardId, project: 'proj', spawnedAt: oldIso, done: false },
    ],
  };
}

test('alive worker silent past the threshold: ONE worker-stalled item + level-1 card event, no duplicates on later ticks', async () => {
  const fdir = fs.mkdtempSync(path.join(os.tmpdir(), 'bc-fake-'));
  const s = await startServer({
    env: { BC_FAKE_STATE: fdir, BC_SUPERVISE_INTERVAL_MS: TICK, BC_PRWATCH_INTERVAL_MS: '0', BC_WORKER_STALE_SECS: '1' },
    seed: (dir) => seedBoard(dir, stallSeed('slug', 10000)),
  });
  try {
    fakeSession(fdir, 'bc-lt-ada:w-slug'); // ALIVE — the whole point: not dead, just silent
    await until('worker-stalled queue item', async () => {
      const items = (await s.api('GET', '/api/feed?lieutenant=ada')).body.items;
      return items.some((i) => i.kind === 'worker-stalled' && i.card === 'slug');
    });
    const card = (await s.api('GET', '/api/cards/slug')).body;
    assert.strictEqual(card.column, 'working', 'the card stays Working — the owner decides');
    const ev = card.events.find((e) => e.kind === 'worker-stalled');
    assert.ok(ev, 'worker-stalled event on the card');
    assert.strictEqual(ev.level, 1, 'a stall rings the bell — actionable, not ambient');
    assert.match(ev.text, /alive but silent for \d+min/);

    await sleep(600); // several more ticks: notified once, no item spam
    const items = (await s.api('GET', '/api/feed?lieutenant=ada')).body.items;
    assert.strictEqual(items.filter((i) => i.kind === 'worker-stalled').length, 1);
    assert.ok(!items.some((i) => i.kind === 'worker-died'), 'an alive worker is never reported dead');
  } finally {
    await s.stop();
    fs.rmSync(fdir, { recursive: true, force: true });
  }
});

test('a fresh worker.signal re-arms the watchdog: lastSignalAt resets the clock, then a second stall fires AGAIN', async () => {
  const fdir = fs.mkdtempSync(path.join(os.tmpdir(), 'bc-fake-'));
  const s = await startServer({
    env: { BC_FAKE_STATE: fdir, BC_SUPERVISE_INTERVAL_MS: TICK, BC_PRWATCH_INTERVAL_MS: '0', BC_WORKER_STALE_SECS: '1' },
    seed: (dir) => seedBoard(dir, stallSeed('slug', 10000)),
  });
  try {
    fakeSession(fdir, 'bc-lt-ada:w-slug');
    await until('first worker-stalled item', async () => {
      const items = (await s.api('GET', '/api/feed?lieutenant=ada')).body.items;
      return items.filter((i) => i.kind === 'worker-stalled').length === 1;
    });
    // a real milestone: clears staleNotified AND stamps lastSignalAt
    const r = await s.api('POST', '/api/cards/slug/worker/signal', { text: 'still alive, honest' });
    assert.strictEqual(r.status, 200);
    const w = (await s.api('GET', '/api/board')).body.workers[0];
    assert.ok(!w.staleNotified, 'signal cleared staleNotified');
    assert.ok(w.lastSignalAt, 'signal stamped lastSignalAt');
    // silence resumes: after another full threshold the watchdog fires again
    await until('second worker-stalled item (re-armed)', async () => {
      const items = (await s.api('GET', '/api/feed?lieutenant=ada')).body.items;
      return items.filter((i) => i.kind === 'worker-stalled').length === 2;
    });
  } finally {
    await s.stop();
    fs.rmSync(fdir, { recursive: true, force: true });
  }
});

test('a worker within the threshold is left alone', async () => {
  const fdir = fs.mkdtempSync(path.join(os.tmpdir(), 'bc-fake-'));
  const s = await startServer({
    env: { BC_FAKE_STATE: fdir, BC_SUPERVISE_INTERVAL_MS: TICK, BC_PRWATCH_INTERVAL_MS: '0', BC_WORKER_STALE_SECS: '3600' },
    seed: (dir) => seedBoard(dir, stallSeed('slug', 0)),
  });
  try {
    fakeSession(fdir, 'bc-lt-ada:w-slug');
    await sleep(600); // several ticks
    const items = (await s.api('GET', '/api/feed?lieutenant=ada')).body.items;
    assert.strictEqual(items.filter((i) => i.kind === 'worker-stalled').length, 0);
  } finally {
    await s.stop();
    fs.rmSync(fdir, { recursive: true, force: true });
  }
});

test('a DEAD silent worker takes the worker-died path, never worker-stalled (mutual exclusion)', async () => {
  const fdir = fs.mkdtempSync(path.join(os.tmpdir(), 'bc-fake-'));
  const s = await startServer({
    env: { BC_FAKE_STATE: fdir, BC_SUPERVISE_INTERVAL_MS: TICK, BC_PRWATCH_INTERVAL_MS: '0', BC_WORKER_STALE_SECS: '1' },
    seed: (dir) => seedBoard(dir, stallSeed('slug', 10000)),
    // no fakeSession marker: the window is dead
  });
  try {
    await until('worker-died queue item', async () => {
      const items = (await s.api('GET', '/api/feed?lieutenant=ada')).body.items;
      return items.some((i) => i.kind === 'worker-died' && i.card === 'slug');
    });
    await sleep(600);
    const items = (await s.api('GET', '/api/feed?lieutenant=ada')).body.items;
    assert.strictEqual(items.filter((i) => i.kind === 'worker-stalled').length, 0, 'dead is dead — not stalled');
  } finally {
    await s.stop();
    fs.rmSync(fdir, { recursive: true, force: true });
  }
});

test('leaving Working clears staleNotified (mirrors the stopNotified lifecycle)', async () => {
  const fdir = fs.mkdtempSync(path.join(os.tmpdir(), 'bc-fake-'));
  const s = await startServer({
    env: { BC_FAKE_STATE: fdir, BC_SUPERVISE_INTERVAL_MS: TICK, BC_PRWATCH_INTERVAL_MS: '0', BC_WORKER_STALE_SECS: '1' },
    seed: (dir) => seedBoard(dir, stallSeed('slug', 10000)),
  });
  try {
    fakeSession(fdir, 'bc-lt-ada:w-slug');
    await until('worker-stalled fired (flag set)', async () => {
      const b = (await s.api('GET', '/api/board')).body;
      return b.workers[0] && b.workers[0].staleNotified;
    });
    const r = await s.api('POST', '/api/cards/slug/move', { column: 'review', actor: 'agent' });
    assert.strictEqual(r.status, 200);
    const w = (await s.api('GET', '/api/board')).body.workers[0];
    assert.ok(!w.staleNotified, 'the handoff out of Working ends the stale-state');
  } finally {
    await s.stop();
    fs.rmSync(fdir, { recursive: true, force: true });
  }
});
