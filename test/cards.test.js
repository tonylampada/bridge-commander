'use strict';
// Card lifecycle: create (type + owner are first-class) / patch / move / archive.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const { startServer, startServerWithLieutenant, withOwner, runCli, LT } = require('./helper');

function archivePath(s) { return path.join(s.dir, '.bridge-command', 'archive.jsonl'); }

test('card create: defaults, slug ids, created event, owner + type validated', async () => {
  const s = await startServerWithLieutenant();
  try {
    let r = await s.api('POST', '/api/cards', withOwner({ title: 'Fix The Widget!' }));
    assert.strictEqual(r.status, 200);
    const card = r.body.card;
    assert.strictEqual(card.id, 'fix-the-widget'); // slugged from title
    assert.strictEqual(card.column, 'backlog'); // born in Backlog
    assert.strictEqual(card.type, 'implementation'); // default type
    assert.strictEqual(card.owner, LT);
    assert.strictEqual(card.pendingOrder, null);
    assert.deepStrictEqual(card.labels, []);
    assert.deepStrictEqual(card.attributes, {});
    assert.strictEqual(card.body, '');
    assert.strictEqual(card.events.length, 1); // birth event
    assert.strictEqual(card.events[0].level, 2);
    assert.strictEqual(card.events[0].kind, 'created');
    assert.strictEqual(card.events[0].actor, 'agent');
    assert.match(card.events[0].text, /^created in 📋 Backlog$/);

    // the three first-class types
    for (const type of ['plan', 'investigation']) {
      r = await s.api('POST', '/api/cards', withOwner({ title: 'A ' + type, type }));
      assert.strictEqual(r.body.card.type, type);
    }
    r = await s.api('POST', '/api/cards', withOwner({ title: 'Bad type', type: 'chore' }));
    assert.strictEqual(r.status, 400);

    // same title again gets a -2 suffix
    r = await s.api('POST', '/api/cards', withOwner({ title: 'Fix The Widget!' }));
    assert.strictEqual(r.body.card.id, 'fix-the-widget-2');

    // explicit duplicate id conflicts
    r = await s.api('POST', '/api/cards', withOwner({ title: 'Another', id: 'fix-the-widget' }));
    assert.strictEqual(r.status, 409);

    // title required; unknown column rejected
    r = await s.api('POST', '/api/cards', withOwner({ title: '   ' }));
    assert.strictEqual(r.status, 400);
    r = await s.api('POST', '/api/cards', withOwner({ title: 'x', column: 'nope' }));
    assert.strictEqual(r.status, 400);

    // born in Backlog ONLY: review and peer are no birthplace either
    for (const column of ['review', 'peer']) {
      r = await s.api('POST', '/api/cards', withOwner({ title: 'x', column }));
      assert.strictEqual(r.status, 400);
      assert.match(r.body.error, /born in Backlog only/);
    }
    r = await s.api('POST', '/api/cards', withOwner({ title: 'Explicit backlog', column: 'backlog' }));
    assert.strictEqual(r.status, 200);
  } finally {
    await s.stop();
  }
});

test('card create requires an existing owner lieutenant', async () => {
  const s = await startServer();
  try {
    let r = await s.api('POST', '/api/cards', { title: 'Orphan' });
    assert.strictEqual(r.status, 400);
    assert.match(r.body.error, /owner required/);
    r = await s.api('POST', '/api/cards', { title: 'Ghost-owned', owner: 'nobody' });
    assert.strictEqual(r.status, 400);
    assert.match(r.body.error, /unknown lieutenant/);
  } finally {
    await s.stop();
  }
});

test('card patch: title, body, type, attribute merge and delete, labels', async () => {
  const s = await startServerWithLieutenant();
  try {
    await s.api('POST', '/api/cards', withOwner({ title: 'Patch me', attributes: { repo: 'alpha', branch: 'old' } }));
    let r = await s.api('PATCH', '/api/cards/patch-me', {
      title: 'Patched',
      body: 'the deliverable',
      type: 'investigation',
      attributes: { repo: 'beta', extra: 'yes', branch: null }, // null deletes
      labels: ['blue', 'green'],
    });
    assert.strictEqual(r.status, 200);
    const card = (await s.api('GET', '/api/cards/patch-me')).body;
    assert.strictEqual(card.title, 'Patched');
    assert.strictEqual(card.body, 'the deliverable');
    assert.strictEqual(card.type, 'investigation');
    assert.deepStrictEqual(card.attributes, { repo: 'beta', extra: 'yes' }); // merged, branch gone
    assert.deepStrictEqual(card.labels, ['blue', 'green']);

    // patching an unknown card is a 404
    r = await s.api('PATCH', '/api/cards/ghost', { title: 'x' });
    assert.strictEqual(r.status, 404);
  } finally {
    await s.stop();
  }
});

test('card owner change: applies when no worker bound, timeline event; unknown lieutenant refused', async () => {
  const s = await startServerWithLieutenant();
  try {
    await s.api('POST', '/api/lieutenants', { name: 'Grace', id: 'grace' });
    await s.api('POST', '/api/cards', withOwner({ title: 'Held' }));

    // no worker bound -> owner change applies, other fields patch alongside
    let r = await s.api('PATCH', '/api/cards/held', { owner: 'grace', title: 'Renamed' });
    assert.strictEqual(r.status, 200);
    let card = (await s.api('GET', '/api/cards/held')).body;
    assert.strictEqual(card.owner, 'grace');
    assert.strictEqual(card.title, 'Renamed');
    assert.ok(card.events.some((e) => e.text === 'owner: ' + LT + ' → grace'),
      'owner change lands on the timeline');

    // unknown lieutenant -> refused, nothing applied
    r = await s.api('PATCH', '/api/cards/held', { owner: 'nobody', title: 'Ghosted' });
    assert.strictEqual(r.status, 400);
    assert.match(r.body.error, /unknown lieutenant/);
    card = (await s.api('GET', '/api/cards/held')).body;
    assert.strictEqual(card.owner, 'grace');
    assert.strictEqual(card.title, 'Renamed', 'a refused patch applies nothing');

    // CLI path round-trips back to the original owner
    const cli = await runCli(['card', 'patch', 'held', '--owner', LT,
      '--workspace', s.dir, '--port', String(s.port)]);
    assert.strictEqual(cli.code, 0);
    assert.strictEqual((await s.api('GET', '/api/cards/held')).body.owner, LT);
  } finally {
    await s.stop();
  }
});

test('card move: lieutenant handoff to review only; captain moves elsewhere apply', async () => {
  const s = await startServerWithLieutenant();
  try {
    await s.api('POST', '/api/cards', withOwner({ title: 'Mover' }));

    // lieutenant move -> review = the handoff, level-1 event
    let r = await s.api('POST', '/api/cards/mover/move', { column: 'review' });
    assert.strictEqual(r.status, 200);
    assert.strictEqual(r.body.event.level, 1);
    assert.strictEqual(r.body.event.kind, 'handoff');
    assert.strictEqual(r.body.event.text, '📋 Backlog → 👀 Your review');

    // same-column move is a no-op
    r = await s.api('POST', '/api/cards/mover/move', { column: 'review' });
    assert.strictEqual(r.body.unchanged, true);

    // lieutenant move anywhere else is rejected
    r = await s.api('POST', '/api/cards/mover/move', { column: 'peer' });
    assert.strictEqual(r.status, 400);
    assert.match(r.body.error, /only to review/);

    // captain move (parking in peer) applies -> level-2 `moved` event + queue item
    r = await s.api('POST', '/api/cards/mover/move', { column: 'peer', actor: 'user' });
    assert.strictEqual(r.body.event.level, 2);
    assert.strictEqual(r.body.event.kind, 'moved');
    const feed = await s.api('GET', '/api/feed');
    const moved = feed.body.items.filter((e) => e.kind === 'card-moved');
    assert.strictEqual(moved.length, 1);
    assert.strictEqual(moved[0].lieutenant, LT);
    assert.strictEqual(moved[0].card, 'mover');
    assert.strictEqual(moved[0].from, 'review');
    assert.strictEqual(moved[0].to, 'peer');

    // unknown column rejected
    r = await s.api('POST', '/api/cards/mover/move', { column: 'nope' });
    assert.strictEqual(r.status, 400);
  } finally {
    await s.stop();
  }
});

test('card archive: appended to archive jsonl, removed from board, board-level event', async () => {
  const s = await startServerWithLieutenant();
  try {
    await s.api('POST', '/api/cards', withOwner({ title: 'Shipped thing' }));
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
    const lines = fs.readFileSync(archivePath(s), 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l));
    assert.strictEqual(lines.length, 1);
    assert.strictEqual(lines[0].reason, 'merged');
    assert.strictEqual('note' in lines[0], false); // exact enum value: no note needed
    assert.strictEqual(lines[0].actor, 'agent');
    assert.strictEqual(lines[0].card.id, 'shipped-thing');
    assert.strictEqual(lines[0].card.title, 'Shipped thing');
    assert.strictEqual(lines[0].card.owner, LT);

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
  const s = await startServerWithLieutenant();
  try {
    await s.api('POST', '/api/cards', withOwner({ title: 'A' }));
    await s.api('POST', '/api/cards', withOwner({ title: 'B' }));
    await s.api('POST', '/api/cards', withOwner({ title: 'C' }));

    // a free-string reason is rejected, and rejects without archiving
    let r = await s.api('POST', '/api/cards/b/archive', { reason: 'PR merged upstream' });
    assert.strictEqual(r.status, 400);
    assert.strictEqual((await s.api('GET', '/api/cards/b')).status, 200); // still on the board

    r = await s.api('POST', '/api/cards/a/archive', { reason: 'merged', note: 'https://example.test/pr/7' });
    assert.strictEqual(r.status, 200);
    await s.api('POST', '/api/cards/b/archive', { reason: 'killed', note: 'not needed anymore' });
    await s.api('POST', '/api/cards/c/archive', {}); // no reason given: dismissed

    const recs = fs.readFileSync(archivePath(s), 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l));
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
  const s = await startServerWithLieutenant();
  const activity = async (id) => (await s.api('GET', '/api/cards/' + id)).body.activity;
  try {
    await s.api('POST', '/api/cards', withOwner({ title: 'Task' })); // pushes a created event
    const t0 = await activity('task');
    assert.ok(t0, 'activity is present and derived from the created event');

    // A status-lease refresh bumps the mutable `updated` but is NOT real activity.
    await new Promise((r) => setTimeout(r, 5));
    let r = await s.api('POST', '/api/cards/task/status', { worker: { id: 'w1', state: 'working' } });
    assert.strictEqual(r.status, 200);
    const afterStatus = await s.api('GET', '/api/cards/task');
    assert.strictEqual(afterStatus.body.activity, t0, 'status.set does not advance activity');
    assert.notStrictEqual(afterStatus.body.updated, t0, 'but updated IS bumped (unchanged semantics)');

    // An attribute patch likewise is not real activity.
    await new Promise((r) => setTimeout(r, 5));
    await s.api('PATCH', '/api/cards/task', { attributes: { branch: 'bc/task' } });
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

test('captain-created card queues card-created to the owner; lieutenant-created does not', async () => {
  const s = await startServerWithLieutenant();
  try {
    await s.api('POST', '/api/cards', withOwner({ title: 'By lieutenant' })); // default actor: agent
    await s.api('POST', '/api/cards', withOwner({ title: 'By captain', actor: 'user' }));
    const feed = await s.api('GET', '/api/feed');
    const created = feed.body.items.filter((e) => e.kind === 'card-created');
    assert.strictEqual(created.length, 1);
    assert.strictEqual(created[0].lieutenant, LT);
    assert.strictEqual(created[0].card, 'by-captain');
    assert.strictEqual(created[0].text, 'By captain');
  } finally {
    await s.stop();
  }
});
