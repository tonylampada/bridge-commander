'use strict';
// card.restore — resurrection with frozen state: round-trip, 404/409 paths,
// most-recent-record selection, derived status on the restored card, CLI.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const { startServerWithLieutenant, withOwner, LT, runCli } = require('./helper');

function archiveRecords(s) {
  return fs.readFileSync(path.join(s.dir, '.bridge-commander', 'archive.jsonl'), 'utf8')
    .split('\n').filter(Boolean).map((l) => JSON.parse(l));
}

test('restore round-trip: frozen state intact, level-1 event appended, archive record kept', async () => {
  const s = await startServerWithLieutenant();
  try {
    await s.api('POST', '/api/cards', withOwner({
      title: 'Revive me', type: 'implementation', body: 'the deliverable so far',
      labels: ['blue'], attributes: { repo: 'demo-app', branch: 'bc/revive-me' },
    }));
    await s.api('POST', '/api/cards/revive-me/move', { column: 'peer', actor: 'user' }); // parked on the captain's shelf
    await s.api('POST', '/api/cards/revive-me/events', { text: 'made progress', level: 2 });
    await s.api('POST', '/api/feedback', { target: 'card:revive-me', text: 'how is it going?' });
    await s.api('POST', '/api/message', { target: 'card:revive-me', text: 'halfway there' });
    const frozen = (await s.api('GET', '/api/cards/revive-me')).body;

    await s.api('POST', '/api/cards/revive-me/archive', { reason: 'killed', actor: 'user' });
    assert.strictEqual((await s.api('GET', '/api/cards/revive-me')).status, 404);

    const r = await s.api('POST', '/api/cards/revive-me/restore', {
      actor: 'user', text: 'resurrected — killed by mistake',
    });
    assert.strictEqual(r.status, 200);
    const card = (await s.api('GET', '/api/cards/revive-me')).body;

    // frozen state restored in full: body, thread, attributes, type, owner, column
    assert.strictEqual(card.column, 'peer');
    assert.strictEqual(card.type, 'implementation');
    assert.strictEqual(card.owner, LT);
    assert.strictEqual(card.body, 'the deliverable so far');
    assert.deepStrictEqual(card.labels, ['blue']);
    assert.deepStrictEqual(card.attributes, { repo: 'demo-app', branch: 'bc/revive-me' });
    assert.deepStrictEqual(card.thread, frozen.thread);
    // all frozen events kept, plus exactly one loud resurrection event on top
    assert.deepStrictEqual(card.events.slice(0, frozen.events.length), frozen.events);
    assert.strictEqual(card.events.length, frozen.events.length + 1);
    const ev = card.events[card.events.length - 1];
    assert.strictEqual(ev.level, 1);
    assert.strictEqual(ev.actor, 'user');
    assert.strictEqual(ev.text, 'resurrected — killed by mistake');
    assert.ok(ev.seq > frozen.events[frozen.events.length - 1].seq); // fresh global seq

    // the archive log stays append-only: the kill record remains for a live card
    const recs = archiveRecords(s);
    assert.strictEqual(recs.length, 1);
    assert.strictEqual(recs[0].card.id, 'revive-me');
    assert.strictEqual(recs[0].reason, 'killed');
  } finally {
    await s.stop();
  }
});

test('restore 404 when never archived, 409 when already on the board', async () => {
  const s = await startServerWithLieutenant();
  try {
    let r = await s.api('POST', '/api/cards/ghost/restore', {});
    assert.strictEqual(r.status, 404);

    await s.api('POST', '/api/cards', withOwner({ title: 'Alive' }));
    r = await s.api('POST', '/api/cards/alive/restore', {});
    assert.strictEqual(r.status, 409); // on the board: conflict wins over never-archived

    await s.api('POST', '/api/cards/alive/archive', {});
    await s.api('POST', '/api/cards/alive/restore', {});
    r = await s.api('POST', '/api/cards/alive/restore', {});
    assert.strictEqual(r.status, 409); // already back on the board
  } finally {
    await s.stop();
  }
});

test('multiple archive records for one id: the most recent snapshot wins', async () => {
  const s = await startServerWithLieutenant();
  try {
    await s.api('POST', '/api/cards', withOwner({ title: 'Twice dead', body: 'v1' }));
    await s.api('POST', '/api/cards/twice-dead/archive', {});
    await s.api('POST', '/api/cards/twice-dead/restore', {});
    await s.api('PATCH', '/api/cards/twice-dead', { body: 'v2' });
    await s.api('POST', '/api/cards/twice-dead/move', { column: 'review' });
    await s.api('POST', '/api/cards/twice-dead/archive', {});
    assert.strictEqual(archiveRecords(s).length, 2); // both kill records remain

    await s.api('POST', '/api/cards/twice-dead/restore', {});
    const card = (await s.api('GET', '/api/cards/twice-dead')).body;
    assert.strictEqual(card.body, 'v2'); // latest frozen state, not the first
    assert.strictEqual(card.column, 'review');
    assert.strictEqual(archiveRecords(s).length, 2); // restore never rewrites the log
  } finally {
    await s.stop();
  }
});

test('a snapshot frozen in Working restores into Backlog (never workerless Working)', async () => {
  const nowIso = new Date().toISOString();
  const s = await startServerWithLieutenant({
    seed(dir) {
      const sd = path.join(dir, '.bridge-commander');
      fs.mkdirSync(sd, { recursive: true });
      fs.writeFileSync(path.join(sd, 'archive.jsonl'), JSON.stringify({
        ts: nowIso, actor: 'user', reason: 'killed',
        card: {
          id: 'was-working', title: 'Was working', type: 'implementation', owner: LT, column: 'working',
          labels: [], attributes: {}, body: '', created: nowIso, updated: nowIso,
          threadStart: null, pendingOrder: null, events: [], thread: [],
        },
      }) + '\n');
    },
  });
  try {
    const r = await s.api('POST', '/api/cards/was-working/restore', {});
    assert.strictEqual(r.status, 200);
    assert.strictEqual(r.body.card.column, 'backlog');
    const ev = r.body.card.events[r.body.card.events.length - 1];
    assert.strictEqual(ev.level, 1);
    assert.match(ev.text, /restored to backlog \(was working\)/);
    assert.strictEqual((await s.api('GET', '/api/cards/was-working')).body.column, 'backlog');
  } finally {
    await s.stop();
  }
});

test('restored card derives status like any other: worker absent, owed/unread from restored state', async () => {
  const s = await startServerWithLieutenant();
  try {
    await s.api('POST', '/api/cards', withOwner({ title: 'Derived' }));
    await s.api('POST', '/api/cards/derived/status', { worker: { id: 'task-1', state: 'working' } });
    await s.api('POST', '/api/feedback', { target: 'card:derived', text: 'ping?' }); // last word is the captain's
    await s.api('POST', '/api/read', { target: 'card:derived' }); // captain has read everything so far
    await s.api('POST', '/api/cards/derived/archive', {});

    await s.api('POST', '/api/cards/derived/restore', {});
    const st = (await s.api('GET', '/api/cards/derived')).body.status;
    assert.deepStrictEqual(st.worker, { id: null, state: 'absent' }); // lease not resurrected
    assert.strictEqual(st.owed, true); // restored thread still ends on the captain's message
    assert.strictEqual(st.unread, true); // the level-1 resurrection event landed after the read

    // status.set works on the restored card as usual
    await s.api('POST', '/api/cards/derived/status', { worker: { id: 'task-2', state: 'working' } });
    const st2 = (await s.api('GET', '/api/cards/derived')).body.status;
    assert.strictEqual(st2.worker.state, 'working');
    assert.strictEqual(st2.worker.id, 'task-2');
  } finally {
    await s.stop();
  }
});

test('cli: bc-axi card restore resurrects with the default event text', async () => {
  const s = await startServerWithLieutenant();
  try {
    await s.api('POST', '/api/cards', withOwner({ title: 'Cli card' }));
    await s.api('POST', '/api/cards/cli-card/archive', {});
    const args = ['--workspace', s.dir, '--port', String(s.port)];
    const r = await runCli(['card', 'restore', 'cli-card', ...args]);
    assert.strictEqual(r.code, 0, r.stderr);
    assert.match(r.stdout, /restored cli-card/);
    const card = (await s.api('GET', '/api/cards/cli-card')).body;
    const ev = card.events[card.events.length - 1];
    assert.strictEqual(ev.text, 'resurrected');
    assert.strictEqual(ev.level, 1);

    const miss = await runCli(['card', 'restore', 'nope', ...args]);
    assert.notStrictEqual(miss.code, 0);
    assert.match(miss.stderr, /404/);
  } finally {
    await s.stop();
  }
});
