'use strict';
// Board-registered kinds: set/get roundtrip and persistence, level resolution
// from the effective map (registered over built-ins), explicit-level override,
// typed side-effect events, unknown-kind opacity, CLI set/print.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { startServer, startServerWithLieutenant, withOwner, runCli } = require('./helper');

const BUILTINS = {
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
  'worker-paused': { emoji: '💤', level: 2 },
  parked: { emoji: '🅿️', level: 2 },
  respawned: { emoji: '♻️', level: 1 },
  'needs-captain': { emoji: '🚨', level: 1 },
};

test('kinds set/get roundtrip: built-ins under registered, idempotent replace, validation', async () => {
  const s = await startServerWithLieutenant();
  try {
    // fresh board: effective map = the structural built-ins, nothing registered
    let r = await s.api('GET', '/api/kinds');
    assert.strictEqual(r.status, 200);
    assert.deepStrictEqual(r.body.kinds, BUILTINS);
    assert.deepStrictEqual(r.body.registered, {});

    // register a map: new kind + an override of a built-in
    const reg = { deploy: { emoji: '🚀', level: 1 }, handoff: { emoji: '🤝', level: 2 } };
    r = await s.api('PUT', '/api/kinds', reg);
    assert.strictEqual(r.status, 200);
    assert.strictEqual(r.body.kinds, 2);

    r = await s.api('GET', '/api/kinds');
    assert.deepStrictEqual(r.body.registered, reg);
    assert.deepStrictEqual(r.body.kinds.deploy, { emoji: '🚀', level: 1 });
    assert.deepStrictEqual(r.body.kinds.handoff, { emoji: '🤝', level: 2 }); // registered wins
    assert.deepStrictEqual(r.body.kinds.created, { emoji: '🐣', level: 2 }); // built-ins remain under

    // identical map = no-op (idempotent)
    r = await s.api('PUT', '/api/kinds', reg);
    assert.strictEqual(r.body.unchanged, true);

    // the board doc serves the effective map to the client
    const board = (await s.api('GET', '/api/board')).body;
    assert.deepStrictEqual(board.kinds, Object.assign({}, BUILTINS, reg));

    // validation: array, empty emoji, bad level all reject
    assert.strictEqual((await s.api('PUT', '/api/kinds', [])).status, 400);
    assert.strictEqual((await s.api('PUT', '/api/kinds', { x: { emoji: ' ', level: 1 } })).status, 400);
    assert.strictEqual((await s.api('PUT', '/api/kinds', { x: { emoji: '🎉', level: 3 } })).status, 400);
    // a rejected replace leaves the registered map untouched
    assert.deepStrictEqual((await s.api('GET', '/api/kinds')).body.registered, reg);

    // replacing with {} clears the registered map back to built-ins only
    r = await s.api('PUT', '/api/kinds', {});
    assert.strictEqual(r.body.kinds, 0);
    assert.deepStrictEqual((await s.api('GET', '/api/kinds')).body.kinds, BUILTINS);
  } finally {
    await s.stop();
  }
});

test('registered kinds persist with the board and survive a restart', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bc-test-'));
  const reg = { deploy: { emoji: '🚀', level: 1 } };
  const s1 = await startServer({ dir });
  try {
    await s1.api('PUT', '/api/kinds', reg);
    const onDisk = JSON.parse(fs.readFileSync(path.join(dir, '.bridge-command', 'board.json'), 'utf8'));
    assert.deepStrictEqual(onDisk.kinds, reg); // only the registered map is stored
  } finally {
    await s1.stop();
  }
  const s2 = await startServer({ dir });
  try {
    const r = await s2.api('GET', '/api/kinds');
    assert.deepStrictEqual(r.body.registered, reg);
    assert.deepStrictEqual(r.body.kinds.deploy, { emoji: '🚀', level: 1 });
  } finally {
    await s2.stop();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('event level resolves from the effective map; explicit level always wins', async () => {
  const s = await startServerWithLieutenant();
  try {
    await s.api('POST', '/api/cards', withOwner({ title: 'Leveled' }));
    await s.api('PUT', '/api/kinds', { deploy: { emoji: '🚀', level: 1 }, question: { emoji: '❔', level: 2 } });

    // registered kind: level from the map
    let r = await s.api('POST', '/api/cards/leveled/events', { text: 'went out', kind: 'deploy' });
    assert.strictEqual(r.body.event.level, 1);
    // explicit level beats the map
    r = await s.api('POST', '/api/cards/leveled/events', { text: 'quiet deploy', kind: 'deploy', level: 2 });
    assert.strictEqual(r.body.event.level, 2);
    // built-in kind: level from the built-in default
    r = await s.api('POST', '/api/cards/leveled/events', { text: 'created twin', kind: 'created' });
    assert.strictEqual(r.body.event.level, 2);
    // registered entry overrides a built-in's level
    r = await s.api('POST', '/api/cards/leveled/events', { text: 'hush', kind: 'question' });
    assert.strictEqual(r.body.event.level, 2);
  } finally {
    await s.stop();
  }
});

test('unknown kinds are opaque: stored as-is, defaulted level', async () => {
  const s = await startServerWithLieutenant();
  try {
    await s.api('POST', '/api/cards', withOwner({ title: 'Opaque' }));
    // card event: unknown kind, level falls back to 2
    let r = await s.api('POST', '/api/cards/opaque/events', { text: 'custom', kind: 'totally-custom' });
    assert.strictEqual(r.body.event.kind, 'totally-custom');
    assert.strictEqual(r.body.event.level, 2);
    // board event: unknown kind, board default level 1 still applies
    r = await s.api('POST', '/api/events', { text: 'board-wide', kind: 'legacy-info' });
    assert.strictEqual(r.body.event.kind, 'legacy-info');
    assert.strictEqual(r.body.event.level, 1);
  } finally {
    await s.stop();
  }
});

test('side effects are typed: created, handoff/moved/ordered, landed, killed, resurrected', async () => {
  const s = await startServerWithLieutenant();
  try {
    // create -> created (level 2)
    let r = await s.api('POST', '/api/cards', withOwner({ title: 'Typed' }));
    assert.strictEqual(r.body.card.events[0].kind, 'created');
    assert.strictEqual(r.body.card.events[0].level, 2);

    // lieutenant handoff -> review = handoff (level 1: notifies the captain)
    r = await s.api('POST', '/api/cards/typed/move', { column: 'review' });
    assert.strictEqual(r.body.event.kind, 'handoff');
    assert.strictEqual(r.body.event.level, 1);

    // captain drag review -> backlog is an ORDER, typed `ordered` (level 2)
    r = await s.api('POST', '/api/cards/typed/move', { column: 'backlog', actor: 'user' });
    assert.strictEqual(r.body.ordered, 'rework-order');
    assert.strictEqual(r.body.event.kind, 'ordered');
    assert.strictEqual(r.body.event.level, 2);

    // captain drag review -> peer applies -> moved (level 2) + queue item
    r = await s.api('POST', '/api/cards/typed/move', { column: 'peer', actor: 'user' });
    assert.strictEqual(r.body.event.kind, 'moved');
    assert.strictEqual(r.body.event.level, 2);
    const feed = await s.api('GET', '/api/feed');
    assert.strictEqual(feed.body.items.filter((e) => e.kind === 'card-moved').length, 1);

    // lieutenant move with kind override -> moved (level 2 from the map: quiet)
    await s.api('POST', '/api/cards/typed/move', { column: 'backlog', actor: 'user' }); // peer→backlog applies
    r = await s.api('POST', '/api/cards/typed/move', { column: 'review', kind: 'moved' });
    assert.strictEqual(r.body.event.kind, 'moved');
    assert.strictEqual(r.body.event.level, 2);

    // archive reason merged -> landed (level 1)
    r = await s.api('POST', '/api/cards/typed/archive', { reason: 'merged' });
    assert.strictEqual(r.body.event.kind, 'landed');
    assert.strictEqual(r.body.event.level, 1);

    // archive reason killed -> killed (level 2: the captain's own act, no bell)
    await s.api('POST', '/api/cards', withOwner({ title: 'Doomed' }));
    r = await s.api('POST', '/api/cards/doomed/archive', { reason: 'killed', actor: 'user' });
    assert.strictEqual(r.body.event.kind, 'killed');
    assert.strictEqual(r.body.event.level, 2);

    // restore -> resurrected (level 1, loud)
    r = await s.api('POST', '/api/cards/doomed/restore', {});
    assert.strictEqual(r.body.event.kind, 'resurrected');
    assert.strictEqual(r.body.event.level, 1);
  } finally {
    await s.stop();
  }
});

test('side-effect levels follow a registered override of a built-in kind', async () => {
  const s = await startServerWithLieutenant();
  try {
    await s.api('PUT', '/api/kinds', {
      handoff: { emoji: '👀', level: 2 }, // handoffs go quiet on this board
      killed: { emoji: '🪦', level: 1 },  // kills ring the bell on this board
    });
    await s.api('POST', '/api/cards', withOwner({ title: 'Overridden' }));
    let r = await s.api('POST', '/api/cards/overridden/move', { column: 'review' });
    assert.strictEqual(r.body.event.kind, 'handoff');
    assert.strictEqual(r.body.event.level, 2);
    r = await s.api('POST', '/api/cards/overridden/archive', { reason: 'killed' });
    assert.strictEqual(r.body.event.kind, 'killed');
    assert.strictEqual(r.body.event.level, 1);
  } finally {
    await s.stop();
  }
});

test('cli: bc-axi kinds sets from a file and prints the effective map', async () => {
  const s = await startServerWithLieutenant();
  const args = ['--workspace', s.dir, '--port', String(s.port)];
  try {
    const file = path.join(s.dir, 'kinds.json');
    fs.writeFileSync(file, JSON.stringify({ deploy: { emoji: '🚀', level: 1 } }));
    let r = await runCli(['kinds', file, ...args]);
    assert.strictEqual(r.code, 0, r.stderr);
    assert.match(r.stdout, /kinds=1/);
    r = await runCli(['kinds', file, ...args]);
    assert.match(r.stdout, /kinds=1 \(unchanged\)/);

    r = await runCli(['kinds', ...args]);
    assert.strictEqual(r.code, 0, r.stderr);
    assert.match(r.stdout, /deploy\t🚀\tL1\tregistered/);
    assert.match(r.stdout, /handoff\t👀\tL1\tbuilt-in/);

    r = await runCli(['kinds', '--json', ...args]);
    const parsed = JSON.parse(r.stdout);
    assert.deepStrictEqual(parsed.registered, { deploy: { emoji: '🚀', level: 1 } });
    assert.deepStrictEqual(parsed.kinds.deploy, { emoji: '🚀', level: 1 });
  } finally {
    await s.stop();
  }
});

test('hand-edited board json (kindless events, foreign columns) loads and serves', async () => {
  const s = await startServer({
    seed(dir) {
      const stateDir = path.join(dir, '.bridge-command');
      fs.mkdirSync(stateDir, { recursive: true });
      fs.writeFileSync(path.join(stateDir, 'board.json'), JSON.stringify({
        title: 'legacy', seq: 3,
        lieutenants: [{ id: 'ada', name: 'Ada', color: '#58b6ff', charter: '', chat: [] }],
        cards: [{
          id: 'old-card', title: 'Old card', column: 'todo', owner: 'ada',
          events: [
            { seq: 1, ts: '2025-01-01T00:00:00.000Z', level: 2, kind: 'info', text: 'created', actor: 'agent' },
            { seq: 2, ts: '2025-01-02T00:00:00.000Z', level: 1, kind: 'success', text: 'shipped', actor: 'agent' },
            { seq: 3, ts: '2025-01-03T00:00:00.000Z', level: 2, text: 'no kind at all', actor: 'agent' },
          ],
        }],
      }));
    },
  });
  try {
    const board = (await s.api('GET', '/api/board')).body;
    assert.strictEqual(board.cards.length, 1);
    const card = board.cards[0];
    assert.strictEqual(card.column, 'backlog'); // foreign column collapses into the fixed frame
    assert.strictEqual(card.type, 'implementation'); // missing type defaults
    const evs = card.events;
    assert.strictEqual(evs[0].kind, 'info'); // stored kinds preserved as opaque tokens
    assert.strictEqual(evs[1].kind, 'success');
    assert.strictEqual(evs[2].kind, undefined); // kindless event survives
    assert.deepStrictEqual(board.kinds, BUILTINS); // effective map served even for hand-edited files
    // notifications still derive from levels regardless of kind
    const notif = (await s.api('GET', '/api/notifications')).body;
    assert.strictEqual(notif.items.length, 1);
    assert.strictEqual(notif.items[0].text, 'shipped');
    // and new mutations on the old board work
    const r = await s.api('POST', '/api/cards/old-card/move', { column: 'backlog' });
    assert.strictEqual(r.body.unchanged, true);
  } finally {
    await s.stop();
  }
});
