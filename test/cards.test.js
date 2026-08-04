'use strict';
// Card lifecycle: create (type + owner are first-class) / patch / move / archive.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const { startServer, startServerWithLieutenant, withOwner, runCli, LT } = require('./helper');

function archivePath(s) { return path.join(s.dir, '.bridge-commander', 'archive.jsonl'); }

// Card creates in this test pin no id: they go through the mint, so the ids
// asserted here are the owner's (Ada → ADA-n). Everywhere else in the suite
// withOwner() pins a slug id — see the helper.
const mint = (card) => Object.assign({ owner: LT }, card);

test('card create: defaults, minted ids, created event, owner + type validated', async () => {
  const s = await startServerWithLieutenant();
  try {
    let r = await s.api('POST', '/api/cards', mint({ title: 'Fix The Widget!' }));
    assert.strictEqual(r.status, 200);
    const card = r.body.card;
    assert.strictEqual(card.id, 'ADA-1'); // minted by the owner (Ada), not slugged from the title
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
      r = await s.api('POST', '/api/cards', mint({ title: 'A ' + type, type }));
      assert.strictEqual(r.body.card.type, type);
    }
    r = await s.api('POST', '/api/cards', mint({ title: 'Bad type', type: 'chore' }));
    assert.strictEqual(r.status, 400); // refused: the counter did not advance on it

    // the counter counts cards BORN, not creates attempted
    r = await s.api('POST', '/api/cards', mint({ title: 'Fix The Widget!' })); // same title, new id
    assert.strictEqual(r.body.card.id, 'ADA-4');

    // explicit duplicate id conflicts
    r = await s.api('POST', '/api/cards', mint({ title: 'Another', id: 'ADA-1' }));
    assert.strictEqual(r.status, 409);

    // title required; unknown column rejected
    r = await s.api('POST', '/api/cards', mint({ title: '   ' }));
    assert.strictEqual(r.status, 400);
    r = await s.api('POST', '/api/cards', mint({ title: 'x', column: 'nope' }));
    assert.strictEqual(r.status, 400);

    // born in Backlog ONLY: review and peer are no birthplace either
    for (const column of ['review', 'peer']) {
      r = await s.api('POST', '/api/cards', mint({ title: 'x', column }));
      assert.strictEqual(r.status, 400);
      assert.match(r.body.error, /born in Backlog only/);
    }
    r = await s.api('POST', '/api/cards', mint({ title: 'Explicit backlog', column: 'backlog' }));
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

// ---------- minting: the counter, and the duplicate that is an error ----------

test('the counter is the lieutenant\'s: per-owner, persisted, never reissued', async () => {
  const dir = fs.mkdtempSync(require('node:os').tmpdir() + path.sep + 'bc-mint-');
  let s = await startServer({ dir });
  try {
    await s.api('POST', '/api/lieutenants', { name: 'Monica', id: 'monica' });
    await s.api('POST', '/api/lieutenants', { name: 'Waldir', id: 'waldir' });

    // each lieutenant counts its own
    const ids = [];
    for (const owner of ['monica', 'waldir', 'monica']) {
      ids.push((await s.api('POST', '/api/cards', { title: 'Card for ' + owner, owner })).body.card.id);
    }
    assert.deepStrictEqual(ids, ['MON-1', 'WAL-1', 'MON-2']);

    // archiving MON-2 does NOT hand its number back
    await s.api('POST', '/api/cards/MON-2/archive', { reason: 'killed' });
    assert.strictEqual((await s.api('POST', '/api/cards', { title: 'Next', owner: 'monica' })).body.card.id, 'MON-3');

    // the counter is board state, so a restart continues where it left off
    await s.stop();
    s = await startServer({ dir });
    assert.strictEqual((await s.api('POST', '/api/cards', { title: 'After restart', owner: 'monica' })).body.card.id, 'MON-4');
  } finally {
    await s.stop();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('a duplicate id is REFUSED, visibly — no suffix, no retry, no next free number', async () => {
  const s = await startServer();
  try {
    await s.api('POST', '/api/lieutenants', { name: 'Monica', id: 'monica' });
    assert.strictEqual((await s.api('POST', '/api/cards', { title: 'First', owner: 'monica' })).body.card.id, 'MON-1');

    // The shape of the collision this can produce in the wild: a card already
    // sitting on the id its owner would mint next (a prefix outliving the
    // lieutenant that used it, a hand-written id that guessed the same string).
    // No machinery prevents it — what must never happen is a collision created
    // SILENTLY, so the create is refused and the captain settles it.
    await s.api('POST', '/api/cards', { title: 'Squatter', owner: 'monica', id: 'MON-2' });
    let r = await s.api('POST', '/api/cards', { title: 'Colliding', owner: 'monica' });
    assert.strictEqual(r.status, 409);
    assert.match(r.body.error, /card exists: MON-2/);
    assert.match(r.body.error, /explicit free id/, 'the message says what a human can do about it');
    assert.match(r.body.error, /unused prefix/);

    // refused means refused: nothing was created, and the counter did not move
    assert.strictEqual((await s.api('GET', '/api/cards/MON-2')).body.title, 'Squatter');
    const lt = (await s.api('GET', '/api/lieutenants')).body.lieutenants.find((l) => l.id === 'monica');
    assert.strictEqual(lt.cardSeq, 1, 'a refused create leaves the counter alone');

    // and it stays refused — a retry is the same answer, never a quiet next number
    assert.strictEqual((await s.api('POST', '/api/cards', { title: 'Colliding' , owner: 'monica' })).status, 409);

    // the two ways out, both the human\'s: an explicit free id...
    r = await s.api('POST', '/api/cards', { title: 'Colliding', owner: 'monica', id: 'MON-9' });
    assert.strictEqual(r.status, 200);
    // ...or a free prefix, which unwedges the mint for good
    await s.api('PATCH', '/api/lieutenants/monica', { prefix: 'MNC' });
    assert.strictEqual((await s.api('POST', '/api/cards', { title: 'Free again', owner: 'monica' })).body.card.id, 'MNC-2');
  } finally {
    await s.stop();
  }
});

test('CLI: card create refuses a duplicate with the server\'s sentence, not an HTTP envelope', async () => {
  const s = await startServerWithLieutenant();
  const args = ['--workspace', s.dir, '--port', String(s.port)];
  try {
    let r = await runCli(['card', 'create', '--title', 'First', '--owner', LT, ...args]);
    assert.strictEqual(r.code, 0, r.stderr);
    assert.match(r.stdout, /created ADA-1 in backlog/);

    r = await runCli(['card', 'create', '--title', 'Again', '--owner', LT, '--id', 'ADA-1', ...args]);
    assert.strictEqual(r.code, 1, 'a refused create is a failure exit, never a quiet success');
    assert.match(r.stderr, /card create refused: card exists: ADA-1/);
    assert.doesNotMatch(r.stderr, /HTTP 409/);
  } finally {
    await s.stop();
  }
});
