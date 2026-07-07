'use strict';
// Card lifecycle: create / patch / move / archive (current behavior).
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const { startServerWithColumns, startServer } = require('./helper');

test('card create: defaults, slug ids, created event', async () => {
  const s = await startServerWithColumns();
  try {
    let r = await s.api('POST', '/api/cards', { title: 'Fix The Widget!' });
    assert.strictEqual(r.status, 200);
    const card = r.body.card;
    assert.strictEqual(card.id, 'fix-the-widget'); // slugged from title
    assert.strictEqual(card.column, 'todo'); // defaults to first column
    assert.deepStrictEqual(card.labels, []);
    assert.deepStrictEqual(card.attributes, {});
    assert.strictEqual(card.body, '');
    assert.strictEqual(card.events.length, 1); // birth event
    assert.strictEqual(card.events[0].level, 2);
    assert.strictEqual(card.events[0].kind, 'created');
    assert.strictEqual(card.events[0].actor, 'agent');
    assert.match(card.events[0].text, /^created in To do$/);

    // same title again gets a -2 suffix
    r = await s.api('POST', '/api/cards', { title: 'Fix The Widget!' });
    assert.strictEqual(r.body.card.id, 'fix-the-widget-2');

    // explicit duplicate id conflicts
    r = await s.api('POST', '/api/cards', { title: 'Another', id: 'fix-the-widget' });
    assert.strictEqual(r.status, 409);

    // title required; unknown column rejected
    r = await s.api('POST', '/api/cards', { title: '   ' });
    assert.strictEqual(r.status, 400);
    r = await s.api('POST', '/api/cards', { title: 'x', column: 'nope' });
    assert.strictEqual(r.status, 400);
  } finally {
    await s.stop();
  }
});

test('card create with no columns configured is rejected', async () => {
  const s = await startServer();
  try {
    const r = await s.api('POST', '/api/cards', { title: 'Homeless card' });
    assert.strictEqual(r.status, 400);
    assert.match(r.body.error, /unknown column/);
  } finally {
    await s.stop();
  }
});

test('card patch: title, body, attribute merge and delete, labels', async () => {
  const s = await startServerWithColumns();
  try {
    await s.api('POST', '/api/cards', { title: 'Patch me', attributes: { repo: 'alpha', owner: 'agent-1' } });
    let r = await s.api('PATCH', '/api/cards/patch-me', {
      title: 'Patched',
      body: 'the deliverable',
      attributes: { repo: 'beta', extra: 'yes', owner: null }, // null deletes
      labels: ['blue', 'green'],
    });
    assert.strictEqual(r.status, 200);
    const card = (await s.api('GET', '/api/cards/patch-me')).body;
    assert.strictEqual(card.title, 'Patched');
    assert.strictEqual(card.body, 'the deliverable');
    assert.deepStrictEqual(card.attributes, { repo: 'beta', extra: 'yes' }); // merged, owner gone
    assert.deepStrictEqual(card.labels, ['blue', 'green']);

    // patching an unknown card is a 404
    r = await s.api('PATCH', '/api/cards/ghost', { title: 'x' });
    assert.strictEqual(r.status, 404);
  } finally {
    await s.stop();
  }
});

test('card move: deliberate act, event levels by actor, unchanged when same column', async () => {
  const s = await startServerWithColumns();
  try {
    await s.api('POST', '/api/cards', { title: 'Mover' });

    // agent move -> level-1 handoff event
    let r = await s.api('POST', '/api/cards/mover/move', { column: 'doing' });
    assert.strictEqual(r.status, 200);
    assert.strictEqual(r.body.event.level, 1);
    assert.strictEqual(r.body.event.kind, 'handoff');
    assert.strictEqual(r.body.event.text, 'To do → Doing');

    // same-column move is a no-op
    r = await s.api('POST', '/api/cards/mover/move', { column: 'doing' });
    assert.strictEqual(r.body.unchanged, true);

    // user move -> level-2 `moved` event and a card-moved feedback line
    r = await s.api('POST', '/api/cards/mover/move', { column: 'review', actor: 'user' });
    assert.strictEqual(r.body.event.level, 2);
    assert.strictEqual(r.body.event.kind, 'moved');
    const poll = await s.api('GET', '/api/poll?nowait=1');
    const moved = poll.body.events.filter((e) => e.kind === 'card-moved');
    assert.strictEqual(moved.length, 1);
    assert.strictEqual(moved[0].target, 'card:mover');
    assert.strictEqual(moved[0].from, 'doing');
    assert.strictEqual(moved[0].column, 'review');

    // unknown column rejected
    r = await s.api('POST', '/api/cards/mover/move', { column: 'nope' });
    assert.strictEqual(r.status, 400);
  } finally {
    await s.stop();
  }
});

test('card archive: appended to archive jsonl, removed from board, board-level event', async () => {
  const s = await startServerWithColumns();
  try {
    await s.api('POST', '/api/cards', { title: 'Shipped thing' });
    const r = await s.api('POST', '/api/cards/shipped-thing/archive', { reason: 'merged', actor: 'agent' });
    assert.strictEqual(r.status, 200);
    assert.strictEqual(r.body.event.level, 1); // reason merged -> landed, level 1 from the kinds map
    assert.strictEqual(r.body.event.kind, 'landed');
    assert.strictEqual(r.body.event.card, 'shipped-thing');
    assert.strictEqual(r.body.event.archived, true);

    // gone from the board
    const board = (await s.api('GET', '/api/board')).body;
    assert.deepStrictEqual(board.cards, []);
    // the archive event lives on the board-level stream
    assert.ok(board.events.some((e) => e.card === 'shipped-thing' && e.archived));

    // append-only jsonl record with the frozen card snapshot
    const lines = fs
      .readFileSync(path.join(s.dir, 'boards', s.board + '.archive.jsonl'), 'utf8')
      .split('\n')
      .filter(Boolean)
      .map((l) => JSON.parse(l));
    assert.strictEqual(lines.length, 1);
    assert.strictEqual(lines[0].reason, 'merged');
    assert.strictEqual('note' in lines[0], false); // exact enum value: no note needed
    assert.strictEqual(lines[0].actor, 'agent');
    assert.strictEqual(lines[0].card.id, 'shipped-thing');
    assert.strictEqual(lines[0].card.title, 'Shipped thing');

    // GET /api/archive serves it back, newest first
    const arch = await s.api('GET', '/api/archive');
    assert.strictEqual(arch.body.archive.length, 1);
    assert.strictEqual(arch.body.archive[0].card.id, 'shipped-thing');

    // archiving an unknown card is a 404
    const bad = await s.api('POST', '/api/cards/ghost/archive', {});
    assert.strictEqual(bad.status, 404);
  } finally {
    await s.stop();
  }
});

test('archive reason is the validated merged|killed enum; free text rides only as note', async () => {
  const s = await startServerWithColumns();
  try {
    await s.api('POST', '/api/cards', { title: 'A' });
    await s.api('POST', '/api/cards', { title: 'B' });
    await s.api('POST', '/api/cards', { title: 'C' });

    // a free-string reason is rejected, and rejects without archiving
    let r = await s.api('POST', '/api/cards/b/archive', { reason: 'PR merged upstream' });
    assert.strictEqual(r.status, 400);
    assert.strictEqual((await s.api('GET', '/api/cards/b')).status, 200); // still on the board

    r = await s.api('POST', '/api/cards/a/archive', { reason: 'merged', note: 'https://example.test/pr/7' });
    assert.strictEqual(r.status, 200);
    await s.api('POST', '/api/cards/b/archive', { reason: 'killed', note: 'not needed anymore' });
    await s.api('POST', '/api/cards/c/archive', {}); // no reason given: dismissed

    const recs = fs
      .readFileSync(path.join(s.dir, 'boards', s.board + '.archive.jsonl'), 'utf8')
      .split('\n').filter(Boolean).map((l) => JSON.parse(l));
    const by = (id) => recs.find((r) => r.card.id === id);
    assert.strictEqual(by('a').reason, 'merged');
    assert.strictEqual(by('a').note, 'https://example.test/pr/7');
    assert.strictEqual(by('b').reason, 'killed');
    assert.strictEqual(by('b').note, 'not needed anymore');
    assert.strictEqual(by('c').reason, 'killed');
    assert.strictEqual('note' in by('c'), false);
    // the human-readable event carries "reason: note" (or the title with no note)
    const board = (await s.api('GET', '/api/board')).body;
    assert.ok(board.events.some((e) => e.card === 'a' && e.text === 'merged: https://example.test/pr/7'));
    assert.ok(board.events.some((e) => e.card === 'c' && e.text === 'killed: C'));
  } finally {
    await s.stop();
  }
});

test('card.activity reflects last real activity, not incidental status/patch writes', async () => {
  const s = await startServerWithColumns();
  const activity = async (id) => (await s.api('GET', '/api/cards/' + id)).body.activity;
  try {
    await s.api('POST', '/api/cards', { title: 'Task' }); // pushes a created event
    const t0 = await activity('task');
    assert.ok(t0, 'activity is present and derived from the created event');

    // A status-lease refresh bumps the mutable `updated` but is NOT real activity.
    await new Promise((r) => setTimeout(r, 5));
    let r = await s.api('POST', '/api/cards/task/status', { worker: { id: 'w1', state: 'working' } });
    assert.strictEqual(r.status, 200);
    const afterStatus = await s.api('GET', '/api/cards/task');
    assert.strictEqual(afterStatus.body.activity, t0, 'status.set does not advance activity');
    assert.notStrictEqual(afterStatus.body.updated, t0, 'but updated IS bumped (unchanged semantics)');

    // An attribute patch (the feeder's periodic sync) likewise is not real activity.
    await new Promise((r) => setTimeout(r, 5));
    await s.api('PATCH', '/api/cards/task', { attributes: { owner: 'alice' } });
    assert.strictEqual(await activity('task'), t0, 'attribute patch does not advance activity');

    // A genuine event DOES advance it.
    await new Promise((r) => setTimeout(r, 5));
    r = await s.api('POST', '/api/cards/task/events', { text: 'did a thing' });
    assert.strictEqual(r.status, 200);
    const t1 = await activity('task');
    assert.ok(t1 > t0, 'a real event advances activity');

    // As does a chat message on the card thread.
    await new Promise((r) => setTimeout(r, 5));
    await s.api('POST', '/api/feedback', { target: 'card:task', text: 'hi' });
    assert.ok((await activity('task')) > t1, 'a thread message advances activity');
  } finally {
    await s.stop();
  }
});

test('user-created card queues card-created feedback; agent-created card does not', async () => {
  const s = await startServerWithColumns();
  try {
    await s.api('POST', '/api/cards', { title: 'By agent' }); // default actor: agent
    await s.api('POST', '/api/cards', { title: 'By user', actor: 'user' });
    const poll = await s.api('GET', '/api/poll?nowait=1');
    const created = poll.body.events.filter((e) => e.kind === 'card-created');
    assert.strictEqual(created.length, 1);
    assert.strictEqual(created[0].target, 'card:by-user');
    assert.strictEqual(created[0].text, 'By user');
  } finally {
    await s.stop();
  }
});
