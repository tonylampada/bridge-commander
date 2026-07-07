'use strict';
// F5/F6 — the supervision loop (invariant 8: supervision is infrastructure).
// The server, on an interval, runs harness.alive over every lieutenant and
// worker ref: dead lieutenants are respawned via harness.resume (level-1 event,
// drain nudge; 3 failed attempts → needs-captain); dead workers without a done
// report flag the owner with a worker-died QueueItem while the card STAYS
// Working. Uses the file-backed fake harness: a ref with no marker file and no
// in-process session is dead; seeded board state exercises the loop directly.
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
function readSends(dir, session) {
  try {
    return fs.readFileSync(path.join(dir, session + '.sends.jsonl'), 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l));
  } catch (e) { return []; }
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

test('dead lieutenant is respawned: ref updated, level-1 respawned event, drain nudge', async () => {
  const fdir = fs.mkdtempSync(path.join(os.tmpdir(), 'bc-fake-'));
  const s = await startServer({
    env: { BC_FAKE_STATE: fdir, BC_SUPERVISE_INTERVAL_MS: TICK, BC_PRWATCH_INTERVAL_MS: '0' },
    seed: (dir) => seedBoard(dir, {
      lieutenants: [{
        id: 'ada', name: 'Ada', color: '#58b6ff', charter: '', chat: [], created: new Date().toISOString(),
        ref: { harness: 'fake', session: 'bc-lt-ada', cwd: '/tmp', resumeId: 'uuid-old' },
      }],
    }),
  });
  try {
    // no marker, no in-process session -> dead -> the loop resumes it
    await until('respawned event', async () => {
      const b = (await s.api('GET', '/api/board')).body;
      return b.events.some((e) => e.kind === 'respawned' && e.level === 1 && /Ada/.test(e.text));
    });
    const lt = (await s.api('GET', '/api/lieutenants')).body.lieutenants[0];
    assert.strictEqual(lt.ref.session, 'bc-lt-ada'); // same session name — an incarnation, not a new entity
    assert.notStrictEqual(lt.ref.resumeId, 'uuid-old'); // fake had no matching memory: fresh id
    // exactly ONE respawn (alive afterwards — attempts reset, no churn) + the drain nudge landed
    await sleep(500);
    const b = (await s.api('GET', '/api/board')).body;
    assert.strictEqual(b.events.filter((e) => e.kind === 'respawned').length, 1);
    const sends = readSends(fdir, 'bc-lt-ada');
    assert.strictEqual(sends.length, 1);
    assert.match(sends[0].text, /respawned — run: bc-axi drain/);
    // no recoverable memory (fake resumable=false) → relaunched with the
    // rebuilt doctrine+charter prompt instead of a bare session
    const rec = JSON.parse(fs.readFileSync(path.join(fdir, 'bc-lt-ada.json'), 'utf8'));
    assert.match(rec.prompt, /Respawned without memory/);
    assert.match(rec.prompt, /bc-axi drain/);
  } finally {
    await s.stop();
    fs.rmSync(fdir, { recursive: true, force: true });
  }
});

test('non-resumable respawn relaunches with charter + owned cards + pending queue digest', async () => {
  const fdir = fs.mkdtempSync(path.join(os.tmpdir(), 'bc-fake-'));
  const nowIso = new Date().toISOString();
  const s = await startServer({
    env: { BC_FAKE_STATE: fdir, BC_SUPERVISE_INTERVAL_MS: TICK, BC_PRWATCH_INTERVAL_MS: '0' },
    seed: (dir) => {
      seedBoard(dir, {
        lieutenants: [{
          id: 'ada', name: 'Ada', color: '#58b6ff', charter: 'guard the port domain',
          chat: [], created: nowIso,
          ref: { harness: 'fake', session: 'bc-lt-ada', cwd: '/tmp', resumeId: 'uuid-lost' },
        }],
        cards: [{
          id: 'fix-1', title: 'Fix one', type: 'implementation', owner: 'ada', column: 'backlog',
          labels: [], attributes: {}, body: '', created: nowIso, updated: nowIso,
          threadStart: null, pendingOrder: null, events: [], thread: [],
        }, {
          id: 'probe-2', title: 'Probe two', type: 'investigation', owner: 'ada', column: 'review',
          labels: [], attributes: {}, body: '', created: nowIso, updated: nowIso,
          threadStart: null, pendingOrder: null, events: [], thread: [],
        }],
      });
      const qdir = path.join(dir, '.bridge-command', 'queue');
      fs.mkdirSync(qdir, { recursive: true });
      fs.writeFileSync(path.join(qdir, 'ada.jsonl'),
        JSON.stringify({ seq: 1, ts: nowIso, lieutenant: 'ada', kind: 'message', text: 'pending one' }) + '\n');
    },
  });
  try {
    await until('respawned event', async () => {
      const b = (await s.api('GET', '/api/board')).body;
      return b.events.some((e) => e.kind === 'respawned');
    });
    const rec = JSON.parse(fs.readFileSync(path.join(fdir, 'bc-lt-ada.json'), 'utf8'));
    assert.match(rec.prompt, /guard the port domain/, 'charter carried');
    assert.match(rec.prompt, /Your cards \(2\)/);
    assert.match(rec.prompt, /- fix-1 \[backlog\] Fix one/);
    assert.match(rec.prompt, /- probe-2 \[review\] Probe two/);
    assert.match(rec.prompt, /Pending queue: 1 item/);
    assert.match(rec.prompt, /Your first act: `bc-axi drain`/);
    // the session name is an incarnation, not a new entity
    const lt = (await s.api('GET', '/api/lieutenants')).body.lieutenants[0];
    assert.strictEqual(lt.ref.session, 'bc-lt-ada');
  } finally {
    await s.stop();
    fs.rmSync(fdir, { recursive: true, force: true });
  }
});

test('3 failed respawn attempts flag needs-captain (level 1), then stop retrying', async () => {
  const fdir = fs.mkdtempSync(path.join(os.tmpdir(), 'bc-fake-'));
  const s = await startServer({
    env: { BC_FAKE_STATE: fdir, BC_SUPERVISE_INTERVAL_MS: TICK, BC_PRWATCH_INTERVAL_MS: '0' },
    seed: (dir) => seedBoard(dir, {
      lieutenants: [{
        id: 'ghost', name: 'Ghost', color: '#58b6ff', charter: '', chat: [], created: new Date().toISOString(),
        // an unregistered harness: alive and resume both throw -> every attempt fails
        ref: { harness: 'no-such-harness', session: 'bc-lt-ghost', cwd: '/tmp', resumeId: 'x' },
      }],
    }),
  });
  try {
    await until('needs-captain event', async () => {
      const b = (await s.api('GET', '/api/board')).body;
      return b.events.some((e) => e.kind === 'needs-captain' && e.level === 1 && /3 respawn attempts failed/.test(e.text));
    });
    await sleep(600); // several more ticks: flagged once, no event spam
    const b = (await s.api('GET', '/api/board')).body;
    assert.strictEqual(b.events.filter((e) => e.kind === 'needs-captain').length, 1);
    assert.strictEqual(b.events.filter((e) => e.kind === 'respawned').length, 0);
  } finally {
    await s.stop();
    fs.rmSync(fdir, { recursive: true, force: true });
  }
});

test('dead worker without done: worker-died QueueItem + card event, card stays Working, flagged once', async () => {
  const fdir = fs.mkdtempSync(path.join(os.tmpdir(), 'bc-fake-'));
  const nowIso = new Date().toISOString();
  const s = await startServer({
    env: { BC_FAKE_STATE: fdir, BC_SUPERVISE_INTERVAL_MS: TICK, BC_PRWATCH_INTERVAL_MS: '0' },
    seed: (dir) => seedBoard(dir, {
      lieutenants: [{ id: 'ada', name: 'Ada', color: '#58b6ff', charter: '', chat: [], created: nowIso }],
      cards: [{
        id: 'doomed', title: 'Doomed', type: 'implementation', owner: 'ada', column: 'working',
        labels: [], attributes: { repo: 'proj', session: 'bc-w-doomed' }, body: '',
        created: nowIso, updated: nowIso, threadStart: null, pendingOrder: null, events: [], thread: [],
      }, {
        id: 'fine', title: 'Fine', type: 'implementation', owner: 'ada', column: 'working',
        labels: [], attributes: { repo: 'proj', session: 'bc-w-fine' }, body: '',
        created: nowIso, updated: nowIso, threadStart: null, pendingOrder: null, events: [], thread: [],
      }, {
        id: 'finished', title: 'Finished', type: 'implementation', owner: 'ada', column: 'working',
        labels: [], attributes: {}, body: '',
        created: nowIso, updated: nowIso, threadStart: null, pendingOrder: null, events: [], thread: [],
      }],
      workers: [
        { card: 'doomed', ref: { harness: 'fake', session: 'bc-w-doomed', cwd: '/tmp', resumeId: 'a' },
          worktree: { path: '/tmp/none', tool: 'git' }, branch: 'bc/doomed', project: 'proj', spawnedAt: nowIso, done: false },
        { card: 'fine', ref: { harness: 'fake', session: 'bc-w-fine', cwd: '/tmp', resumeId: 'b' },
          worktree: { path: '/tmp/none2', tool: 'git' }, branch: 'bc/fine', project: 'proj', spawnedAt: nowIso, done: false },
        // done long ago and its session gone — supervision must NOT nag about it
        { card: 'finished', ref: { harness: 'fake', session: 'bc-w-finished', cwd: '/tmp', resumeId: 'c' },
          worktree: { path: '/tmp/none3', tool: 'git' }, branch: 'bc/finished', project: 'proj', spawnedAt: nowIso,
          done: true, outcome: 'shipped' },
      ],
    }),
  });
  try {
    fakeSession(fdir, 'bc-w-fine'); // alive via marker; bc-w-doomed and bc-w-finished are dead
    await until('worker-died queue item', async () => {
      const items = (await s.api('GET', '/api/feed?lieutenant=ada')).body.items;
      return items.some((i) => i.kind === 'worker-died' && i.card === 'doomed');
    });
    const card = (await s.api('GET', '/api/cards/doomed')).body;
    assert.strictEqual(card.column, 'working', 'the card STAYS Working — the owner decides');
    const ev = card.events.find((e) => e.kind === 'worker-died');
    assert.ok(ev, 'worker-died event on the card');
    assert.strictEqual(ev.level, 2);

    await sleep(600); // several more ticks: flagged once, no item spam
    const items = (await s.api('GET', '/api/feed?lieutenant=ada')).body.items;
    assert.strictEqual(items.filter((i) => i.kind === 'worker-died').length, 1);
    assert.ok(!items.some((i) => i.card === 'fine'), 'live worker untouched');
    assert.ok(!items.some((i) => i.card === 'finished'), 'done worker never nagged about');
  } finally {
    await s.stop();
    fs.rmSync(fdir, { recursive: true, force: true });
  }
});
