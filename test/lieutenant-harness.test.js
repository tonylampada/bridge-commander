'use strict';
// lieutenant.patch { harness, model } — the front door to the relaunch the
// supervisor already performs. A lieutenant that owns cards cannot be retired,
// so before this the captain's only route from claude to codex was hand-editing
// board.json under a running server.
//
// Fake harnesses stand in for claude and codex: the builtin `fake`, plus
// `recfake` and `recfake2` (test/recording-harness.js, preloaded into the
// SERVER process via NODE_OPTIONS) — the same fake plus a JSONL log of every
// spawn/resume and the extraArgs it was handed, which is how --model is
// observed. Two of them, because a switch needs somewhere observable to go.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { startServer, runCli, sleep } = require('./helper');
const { writeCharter } = require('../server/charter.js');

const PRELOAD = path.join(__dirname, 'recording-harness.js');

function seedBoard(dir, board) {
  const sd = path.join(dir, '.bridge-commander');
  fs.mkdirSync(sd, { recursive: true });
  fs.writeFileSync(path.join(sd, 'board.json'), JSON.stringify(Object.assign({
    title: 'seeded', seq: 0, lieutenants: [], cards: [], events: [], labels: [], reads: {}, kinds: {},
    projects: [], workers: [],
  }, board), null, 2));
}
// A fake session that is ALIVE across the process boundary: the marker file is
// the window (see harness/fake.js).
function fakeSession(fdir, key) {
  fs.mkdirSync(fdir, { recursive: true });
  fs.writeFileSync(path.join(fdir, key + '.json'),
    JSON.stringify({ cwd: '/tmp', resumeId: 'uuid-old' }) + '\n');
}
function marker(fdir, key) {
  return JSON.parse(fs.readFileSync(path.join(fdir, key + '.json'), 'utf8'));
}
function launches(logFile) {
  try {
    return fs.readFileSync(logFile, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l));
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

const LT_ADA = (extra) => Object.assign({
  id: 'ada', name: 'Ada', color: '#58b6ff', prefix: 'ADA', cardSeq: 0,
  chat: [], created: new Date().toISOString(),
  ref: { harness: 'fake', session: 'bc-lt-ada', window: 'lt', cwd: '/tmp', resumeId: 'uuid-old' },
}, extra || {});

// boot({ lieutenant?, cards?, env?, seed? }) — a server with the recording
// harness preloaded, a scratch fake-state dir, and supervision OFF unless the
// caller asks for it (a tick landing mid-test is a second relaunch).
async function boot(o = {}) {
  const fdir = fs.mkdtempSync(path.join(os.tmpdir(), 'bc-fake-'));
  const logFile = path.join(fdir, 'launches.jsonl');
  const s = await startServer({
    env: Object.assign({
      NODE_OPTIONS: '--require ' + PRELOAD,
      BC_FAKE_STATE: fdir,
      BC_REC_LOG: logFile,
      BC_SUPERVISE_INTERVAL_MS: '0',
      BC_PRWATCH_INTERVAL_MS: '0',
    }, o.env || {}),
    seed: (dir) => {
      seedBoard(dir, { lieutenants: [o.lieutenant || LT_ADA()], cards: o.cards || [] });
      writeCharter(dir, 'ada', 'guard the port domain');
      if (o.seed) o.seed(dir, fdir);
    },
  });
  return {
    s,
    fdir,
    logFile,
    launches: () => launches(logFile),
    lt: async () => (await s.api('GET', '/api/board')).body.lieutenants.find((l) => l.id === 'ada'),
    teardown: async () => { await s.stop(); fs.rmSync(fdir, { recursive: true, force: true }); },
  };
}

test('a harness switch respawns the lieutenant on the new harness, on the digest prompt and with no resumeId', async () => {
  const b = await boot({
    cards: [{
      id: 'ADA-1', title: 'Port work', type: 'implementation', owner: 'ada', column: 'working',
      labels: [], attributes: {}, body: '', created: new Date().toISOString(), updated: new Date().toISOString(),
      threadStart: null, pendingOrder: null, events: [], thread: [],
    }],
    seed: (dir, fdir) => fakeSession(fdir, 'bc-lt-ada:lt'),
  });
  try {
    const r = await b.s.api('PATCH', '/api/lieutenants/ada', { harness: 'recfake', actor: 'user' });
    assert.strictEqual(r.status, 200, JSON.stringify(r.body));
    assert.strictEqual(r.body.switched, true);

    const lt = await b.lt();
    // The ref is rewritten WHOLE: new harness, same session name (an
    // incarnation, not a new entity), its own window, and NO resumeId — an id
    // one harness minted means nothing to the other.
    assert.deepStrictEqual(lt.ref, {
      harness: 'recfake', session: 'bc-lt-ada', cwd: '/tmp', window: 'lt',
    });

    // It came back on the SAME from-nothing prompt /reset and supervision use.
    const rec = marker(b.fdir, 'bc-lt-ada:lt');
    assert.match(rec.prompt, /Respawned without memory/);
    assert.match(rec.prompt, /guard the port domain/, 'the charter is carried');
    assert.match(rec.prompt, /- ADA-1 \[working\] Port work/, 'and what it owns');

    // exactly one launch, and it was the new harness spawning
    assert.deepStrictEqual(b.launches().map((l) => l.verb), ['spawn']);

    const ev = (await b.s.api('GET', '/api/board')).body.events.filter((e) => e.kind === 'harness-switch');
    assert.strictEqual(ev.length, 1);
    assert.strictEqual(ev[0].level, 1, 'the captain does not learn this from a session name changing');
    assert.match(ev[0].text, /lieutenant Ada moved to recfake — respawned as bc-lt-ada/);
  } finally { await b.teardown(); }
});

test('switching to the harness it is already on is a no-op: nothing killed, nothing spawned', async () => {
  const b = await boot({ seed: (dir, fdir) => fakeSession(fdir, 'bc-lt-ada:lt') });
  try {
    const before = await b.lt();
    const r = await b.s.api('PATCH', '/api/lieutenants/ada', { harness: 'fake' });
    assert.strictEqual(r.status, 200, JSON.stringify(r.body));
    assert.strictEqual(r.body.switched, false);

    const after = await b.lt();
    assert.deepStrictEqual(after.ref, before.ref, 'the live session — resumeId included — is left alone');
    assert.strictEqual(fs.existsSync(path.join(b.fdir, 'bc-lt-ada:lt.json')), true, 'its window still stands');
    const board = (await b.s.api('GET', '/api/board')).body;
    assert.ok(!board.events.some((e) => e.kind === 'harness-switch'), 'and nothing is announced');
  } finally { await b.teardown(); }
});

test('a lieutenant with no session is refused — a harness is a property of the session', async () => {
  const b = await boot({ lieutenant: LT_ADA({ ref: undefined }) });
  try {
    const r = await b.s.api('PATCH', '/api/lieutenants/ada', { harness: 'recfake' });
    assert.strictEqual(r.status, 409, JSON.stringify(r.body));
    assert.match(r.body.error, /no session/);
    assert.deepStrictEqual(b.launches(), []);
  } finally { await b.teardown(); }
});

test('an unknown harness is refused before the live session is touched', async () => {
  const b = await boot({ seed: (dir, fdir) => fakeSession(fdir, 'bc-lt-ada:lt') });
  try {
    const r = await b.s.api('PATCH', '/api/lieutenants/ada', { harness: 'no-such-harness' });
    assert.strictEqual(r.status, 400, JSON.stringify(r.body));
    assert.match(r.body.error, /unknown harness/);
    assert.strictEqual(fs.existsSync(path.join(b.fdir, 'bc-lt-ada:lt.json')), true);
  } finally { await b.teardown(); }
});

test('the model is stored, rides --model on the switch spawn, and clears with null', async () => {
  const b = await boot({ seed: (dir, fdir) => fakeSession(fdir, 'bc-lt-ada:lt') });
  try {
    // model alone: stored, nothing relaunched — it applies to the next launch
    let r = await b.s.api('PATCH', '/api/lieutenants/ada', { model: 'gpt-6-astra' });
    assert.strictEqual(r.status, 200, JSON.stringify(r.body));
    assert.strictEqual((await b.lt()).model, 'gpt-6-astra');
    assert.deepStrictEqual(b.launches(), [], 'a model change costs nobody their conversation');

    // and it is on the very next spawn, which here is the harness switch
    r = await b.s.api('PATCH', '/api/lieutenants/ada', { harness: 'recfake' });
    assert.strictEqual(r.status, 200, JSON.stringify(r.body));
    assert.deepStrictEqual(b.launches().map((l) => l.extraArgs), [['--model', 'gpt-6-astra']]);
    const ev = (await b.s.api('GET', '/api/board')).body.events.find((e) => e.kind === 'harness-switch');
    assert.match(ev.text, /moved to recfake:gpt-6-astra/, 'the event names the model it moved onto');

    // null clears it back to the harness's own default
    r = await b.s.api('PATCH', '/api/lieutenants/ada', { model: null });
    assert.strictEqual(r.status, 200, JSON.stringify(r.body));
    assert.strictEqual((await b.lt()).model, undefined);
    // …proved by the next launch carrying no --model at all
    r = await b.s.api('PATCH', '/api/lieutenants/ada', { harness: 'recfake2' });
    assert.strictEqual(r.status, 200, JSON.stringify(r.body));
    assert.deepStrictEqual(b.launches().map((l) => l.extraArgs), [['--model', 'gpt-6-astra'], []]);
  } finally { await b.teardown(); }
});

test('a model that is not one argv token is refused, and the stored one survives the refusal', async () => {
  const b = await boot({ seed: (dir, fdir) => fakeSession(fdir, 'bc-lt-ada:lt') });
  try {
    assert.strictEqual((await b.s.api('PATCH', '/api/lieutenants/ada', { model: 'gpt-6-astra' })).status, 200);
    const r = await b.s.api('PATCH', '/api/lieutenants/ada', { model: 'gpt 6 astra --and-a-flag' });
    assert.strictEqual(r.status, 400, JSON.stringify(r.body));
    assert.match(r.body.error, /bad model/);
    assert.strictEqual((await b.lt()).model, 'gpt-6-astra');
  } finally { await b.teardown(); }
});

// The whole point of storing the model on the LIEUTENANT rather than on the
// spawn: a session dies at 3am, the supervisor brings it back, and it comes
// back on the model the captain pinned instead of the harness default.
test('the model survives a supervisor respawn', async () => {
  const b = await boot({
    lieutenant: LT_ADA({
      model: 'gpt-6-astra',
      ref: { harness: 'recfake', session: 'bc-lt-ada', window: 'lt', cwd: '/tmp', resumeId: 'uuid-lost' },
    }),
    env: { BC_SUPERVISE_INTERVAL_MS: '150' },
    // no marker file: the session is dead, which is what the tick reacts to
  });
  try {
    await until('respawned event', async () => {
      const board = (await b.s.api('GET', '/api/board')).body;
      return board.events.some((e) => e.kind === 'respawned');
    });
    const seen = b.launches();
    assert.ok(seen.length >= 1, 'the supervisor relaunched it');
    assert.deepStrictEqual(seen[0].extraArgs, ['--model', 'gpt-6-astra']);
    assert.strictEqual((await b.lt()).model, 'gpt-6-astra', 'and the pin outlives the session that had it');
  } finally { await b.teardown(); }
});

// The respawn prompt lists what the lieutenant owns; a handoff artifact on one
// of its PLAN cards is the note its predecessor left for whoever picks the work
// up. Paths only — the fresh session reads what it decides it needs.
test('handoff artifacts on plan cards come back as read-these-first pointers', async () => {
  const nowIso = new Date().toISOString();
  const card = (o) => Object.assign({
    labels: [], body: '', created: nowIso, updated: nowIso,
    threadStart: null, pendingOrder: null, events: [], thread: [], owner: 'ada', column: 'backlog',
  }, o);
  const b = await boot({
    cards: [
      card({
        id: 'ADA-1', title: 'The port plan', type: 'plan',
        attributes: { artifacts: [
          { uri: 'file:///tmp/ada/handoff-2026-09.md', label: 'handoff notes' },
          { uri: 'file:///tmp/ada/design.md', label: 'design' },
        ] },
      }),
      card({
        id: 'ADA-2', title: 'Build it', type: 'implementation',
        attributes: { artifacts: [{ uri: 'file:///tmp/ada/impl-handoff.md', label: 'handoff' }] },
      }),
    ],
    seed: (dir, fdir) => fakeSession(fdir, 'bc-lt-ada:lt'),
  });
  try {
    assert.strictEqual((await b.s.api('PATCH', '/api/lieutenants/ada', { harness: 'recfake' })).status, 200);
    const { prompt } = marker(b.fdir, 'bc-lt-ada:lt');
    assert.match(prompt, /read these first/i);
    assert.match(prompt, /- ADA-1 \(handoff notes\): \/tmp\/ada\/handoff-2026-09\.md/);
    assert.doesNotMatch(prompt, /design\.md/, 'only artifacts labelled handoff*');
    assert.doesNotMatch(prompt, /impl-handoff\.md/, 'and only on PLAN cards');
  } finally { await b.teardown(); }
});

// ---------- the CLI door (this is the one the captain actually types) ----------

test('bc-axi lieutenant patch moves the harness and pins the model; list shows both', async () => {
  const b = await boot({ seed: (dir, fdir) => fakeSession(fdir, 'bc-lt-ada:lt') });
  const cli = (...args) => runCli([...args, '--workspace', b.s.dir]);
  try {
    let r = await cli('lieutenant', 'patch', 'ada', '--harness', 'recfake', '--model', 'gpt-6-astra');
    assert.strictEqual(r.code, 0, r.stderr);
    assert.match(r.stdout, /harness=recfake model=gpt-6-astra/);
    assert.match(r.stdout, /respawned on recfake — session bc-lt-ada/);
    assert.deepStrictEqual(b.launches().map((l) => l.extraArgs), [['--model', 'gpt-6-astra']],
      'the model set in the same call is on the spawn the switch performs');

    r = await cli('lieutenant', 'list');
    assert.strictEqual(r.code, 0, r.stderr);
    assert.match(r.stdout, /recfake:gpt-6-astra/);

    r = await cli('lieutenant', 'patch', 'ada', '--model', 'none');
    assert.strictEqual(r.code, 0, r.stderr);
    assert.match(r.stdout, /model=default/);
    assert.match(r.stdout, /applies to the NEXT spawn or resume/);

    r = await cli('lieutenant', 'list');
    assert.match(r.stdout, /\trecfake\t/, 'no model pinned, so the harness stands alone');
  } finally { await b.teardown(); }
});

test('bc-axi lieutenant patch with nothing to change prints the usage', async () => {
  const b = await boot({ seed: (dir, fdir) => fakeSession(fdir, 'bc-lt-ada:lt') });
  try {
    const r = await runCli(['lieutenant', 'patch', 'ada', '--workspace', b.s.dir]);
    assert.notStrictEqual(r.code, 0);
    assert.match(r.stderr, /--harness claude\|codex/);
    assert.match(r.stderr, /--model m\|none/);
  } finally { await b.teardown(); }
});
