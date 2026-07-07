'use strict';
// Board-registered kinds: set/get roundtrip and persistence, level resolution
// from the effective map (registered over built-ins), explicit-level override,
// typed side-effect events, unknown-kind opacity, CLI set/print.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { startServer, startServerWithColumns, runCli } = require('./helper');

const BUILTINS = {
  created: { emoji: '🐣', level: 2 },
  moved: { emoji: '🔁', level: 2 },
  handoff: { emoji: '👀', level: 1 },
  landed: { emoji: '🏁', level: 1 },
  killed: { emoji: '🪦', level: 2 },
  resurrected: { emoji: '🧟', level: 1 },
  question: { emoji: '🙋', level: 1 },
};

test('kinds set/get roundtrip: built-ins under registered, idempotent replace, validation', async () => {
  const s = await startServerWithColumns();
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

    // identical map = no-op (idempotent, like the columns frame)
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
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bridge-test-'));
  const reg = { deploy: { emoji: '🚀', level: 1 } };
  const s1 = await startServerWithColumns({ dir });
  try {
    await s1.api('PUT', '/api/kinds', reg);
    const onDisk = JSON.parse(fs.readFileSync(path.join(dir, 'boards', s1.board + '.json'), 'utf8'));
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
  const s = await startServerWithColumns();
  try {
    await s.api('POST', '/api/cards', { title: 'Leveled' });
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

test('unknown kinds are opaque: stored as-is, defaulted level, no crash on legacy kinds', async () => {
  const s = await startServerWithColumns();
  try {
    await s.api('POST', '/api/cards', { title: 'Opaque' });
    // card event: unknown kind, level falls back to 2
    let r = await s.api('POST', '/api/cards/opaque/events', { text: 'custom', kind: 'totally-custom' });
    assert.strictEqual(r.body.event.kind, 'totally-custom');
    assert.strictEqual(r.body.event.level, 2);
    // board event: unknown kind, board default level 1 still applies
    r = await s.api('POST', '/api/events', { text: 'board-wide', kind: 'legacy-info' });
    assert.strictEqual(r.body.event.kind, 'legacy-info');
    assert.strictEqual(r.body.event.level, 1);
    // legacy stored kinds (info/success/alert) round-trip through the API unchanged
    r = await s.api('POST', '/api/cards/opaque/events', { text: 'old data', kind: 'success' });
    assert.strictEqual(r.body.event.kind, 'success');
  } finally {
    await s.stop();
  }
});

test('side effects are typed: created, handoff/moved (+override), landed, killed, resurrected', async () => {
  const s = await startServerWithColumns();
  try {
    // create -> created (level 2)
    let r = await s.api('POST', '/api/cards', { title: 'Typed' });
    assert.strictEqual(r.body.card.events[0].kind, 'created');
    assert.strictEqual(r.body.card.events[0].level, 2);

    // agent move -> handoff (level 1: agent move notifies)
    r = await s.api('POST', '/api/cards/typed/move', { column: 'doing' });
    assert.strictEqual(r.body.event.kind, 'handoff');
    assert.strictEqual(r.body.event.level, 1);

    // agent move with kind override -> moved (level 2 from the map: quiet)
    r = await s.api('POST', '/api/cards/typed/move', { column: 'review', kind: 'moved' });
    assert.strictEqual(r.body.event.kind, 'moved');
    assert.strictEqual(r.body.event.level, 2);

    // user move -> moved (level 2), and the feedback push is unchanged
    r = await s.api('POST', '/api/cards/typed/move', { column: 'todo', actor: 'user' });
    assert.strictEqual(r.body.event.kind, 'moved');
    assert.strictEqual(r.body.event.level, 2);
    const poll = await s.api('GET', '/api/poll?nowait=1');
    assert.strictEqual(poll.body.events.filter((e) => e.kind === 'card-moved').length, 1);

    // archive reason merged -> landed (level 1)
    r = await s.api('POST', '/api/cards/typed/archive', { reason: 'merged' });
    assert.strictEqual(r.body.event.kind, 'landed');
    assert.strictEqual(r.body.event.level, 1);

    // archive reason killed -> killed (level 2: the human's own act, no bell)
    await s.api('POST', '/api/cards', { title: 'Doomed' });
    r = await s.api('POST', '/api/cards/doomed/archive', { reason: 'killed', actor: 'user' });
    assert.strictEqual(r.body.event.kind, 'killed');
    assert.strictEqual(r.body.event.level, 2);

    // restore -> resurrected (level 1, loud as before)
    r = await s.api('POST', '/api/cards/doomed/restore', {});
    assert.strictEqual(r.body.event.kind, 'resurrected');
    assert.strictEqual(r.body.event.level, 1);
  } finally {
    await s.stop();
  }
});

test('side-effect levels follow a registered override of a built-in kind', async () => {
  const s = await startServerWithColumns();
  try {
    await s.api('PUT', '/api/kinds', {
      handoff: { emoji: '👀', level: 2 }, // agent moves go quiet
      killed: { emoji: '🪦', level: 1 },  // kills ring the bell on this board
    });
    await s.api('POST', '/api/cards', { title: 'Overridden' });
    let r = await s.api('POST', '/api/cards/overridden/move', { column: 'doing' });
    assert.strictEqual(r.body.event.kind, 'handoff');
    assert.strictEqual(r.body.event.level, 2);
    r = await s.api('POST', '/api/cards/overridden/archive', { reason: 'killed' });
    assert.strictEqual(r.body.event.kind, 'killed');
    assert.strictEqual(r.body.event.level, 1);
  } finally {
    await s.stop();
  }
});

test('cli: bridge-axi kinds sets from a file and prints the effective map', async () => {
  const s = await startServerWithColumns();
  const portArgs = ['--port', String(s.port), '--board', s.board];
  const env = { BRIDGE_DIR: s.dir };
  try {
    const file = path.join(s.dir, 'kinds.json');
    fs.writeFileSync(file, JSON.stringify({ deploy: { emoji: '🚀', level: 1 } }));
    let r = await runCli(['kinds', file, ...portArgs], env);
    assert.strictEqual(r.code, 0, r.stderr);
    assert.match(r.stdout, /kinds=1/);
    r = await runCli(['kinds', file, ...portArgs], env);
    assert.match(r.stdout, /kinds=1 \(unchanged\)/);

    r = await runCli(['kinds', ...portArgs], env);
    assert.strictEqual(r.code, 0, r.stderr);
    assert.match(r.stdout, /deploy\t🚀\tL1\tregistered/);
    assert.match(r.stdout, /handoff\t👀\tL1\tbuilt-in/);

    r = await runCli(['kinds', '--json', ...portArgs], env);
    const parsed = JSON.parse(r.stdout);
    assert.deepStrictEqual(parsed.registered, { deploy: { emoji: '🚀', level: 1 } });
    assert.deepStrictEqual(parsed.kinds.deploy, { emoji: '🚀', level: 1 });
  } finally {
    await s.stop();
  }
});

test('back-compat: old board json (kindless and legacy-kind events, no kinds field) loads and serves', async () => {
  const s = await startServer({
    board: 'legacy',
    seed(dir) {
      fs.mkdirSync(path.join(dir, 'boards'), { recursive: true });
      fs.writeFileSync(path.join(dir, 'boards', 'legacy.json'), JSON.stringify({
        title: 'legacy', seq: 3,
        columns: [{ id: 'todo', title: 'To do' }],
        cards: [{
          id: 'old-card', title: 'Old card', column: 'todo',
          events: [
            { seq: 1, ts: '2025-01-01T00:00:00.000Z', level: 2, kind: 'info', text: 'created in To do', actor: 'agent' },
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
    const evs = board.cards[0].events;
    assert.strictEqual(evs[0].kind, 'info'); // legacy kinds preserved as opaque tokens
    assert.strictEqual(evs[1].kind, 'success');
    assert.strictEqual(evs[2].kind, undefined); // kindless event survives
    assert.deepStrictEqual(board.kinds, BUILTINS); // effective map served even for old files
    // notifications still derive from levels regardless of kind
    const notif = (await s.api('GET', '/api/notifications')).body;
    assert.strictEqual(notif.items.length, 1);
    assert.strictEqual(notif.items[0].text, 'shipped');
    // and new mutations on the old board work
    const r = await s.api('POST', '/api/cards/old-card/move', { column: 'todo' });
    assert.strictEqual(r.body.unchanged, true);
  } finally {
    await s.stop();
  }
});
