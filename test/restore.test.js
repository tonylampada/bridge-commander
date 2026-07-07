'use strict';
// card.restore — resurrection with frozen state: round-trip, 404/409 paths,
// most-recent-record selection, derived status on the restored card, CLI.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const { startServerWithColumns, runCli } = require('./helper');

function archiveRecords(s) {
  return fs.readFileSync(path.join(s.dir, 'boards', s.board + '.archive.jsonl'), 'utf8')
    .split('\n').filter(Boolean).map((l) => JSON.parse(l));
}

test('restore round-trip: frozen state intact, level-1 event appended, archive record kept', async () => {
  const s = await startServerWithColumns();
  try {
    await s.api('POST', '/api/cards', {
      title: 'Revive me', column: 'doing', body: 'the deliverable so far',
      labels: ['blue'], attributes: { type: 'implementation', repo: 'demo-app' },
    });
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

    // frozen state restored in full: body, thread, attributes, column as frozen
    assert.strictEqual(card.column, 'doing');
    assert.strictEqual(card.body, 'the deliverable so far');
    assert.deepStrictEqual(card.labels, ['blue']);
    assert.deepStrictEqual(card.attributes, { type: 'implementation', repo: 'demo-app' });
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
  const s = await startServerWithColumns();
  try {
    let r = await s.api('POST', '/api/cards/ghost/restore', {});
    assert.strictEqual(r.status, 404);

    await s.api('POST', '/api/cards', { title: 'Alive' });
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
  const s = await startServerWithColumns();
  try {
    await s.api('POST', '/api/cards', { title: 'Twice dead', body: 'v1' });
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

test('restored card derives status like any other: worker absent, owed/unread from restored state', async () => {
  const s = await startServerWithColumns();
  try {
    await s.api('POST', '/api/cards', { title: 'Derived' });
    await s.api('POST', '/api/cards/derived/status', { worker: { id: 'task-1', state: 'working' } });
    await s.api('POST', '/api/feedback', { target: 'card:derived', text: 'ping?' }); // last word is the user's
    await s.api('POST', '/api/read', { target: 'card:derived' }); // user has read everything so far
    await s.api('POST', '/api/cards/derived/archive', {});

    await s.api('POST', '/api/cards/derived/restore', {});
    const st = (await s.api('GET', '/api/cards/derived')).body.status;
    assert.deepStrictEqual(st.worker, { id: null, state: 'absent' }); // lease not resurrected
    assert.strictEqual(st.owed, true); // restored thread still ends on the user's message
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

test('cli: bridge-axi restore resurrects with the default event text', async () => {
  const s = await startServerWithColumns();
  try {
    await s.api('POST', '/api/cards', { title: 'Cli card' });
    await s.api('POST', '/api/cards/cli-card/archive', {});
    const args = ['--port', String(s.port), '--board', s.board];
    const r = await runCli(['restore', 'cli-card', ...args], { BRIDGE_DIR: s.dir });
    assert.strictEqual(r.code, 0, r.stderr);
    assert.match(r.stdout, /restored cli-card/);
    const card = (await s.api('GET', '/api/cards/cli-card')).body;
    const ev = card.events[card.events.length - 1];
    assert.strictEqual(ev.text, 'resurrected');
    assert.strictEqual(ev.level, 1);

    const miss = await runCli(['restore', 'nope', ...args], { BRIDGE_DIR: s.dir });
    assert.notStrictEqual(miss.code, 0);
    assert.match(miss.stderr, /404/);
  } finally {
    await s.stop();
  }
});
