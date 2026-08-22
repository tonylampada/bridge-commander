'use strict';
// /reset — start a lieutenant over on the launch prompt, with no memory of the
// conversation and every bit of its identity intact.
//
// It is a BOARD command, not a harness one: the harness has no idea what a
// lieutenant is, and the launch prompt is doctrine + charter + what it owns.
const test = require('node:test');
const assert = require('node:assert');
const { startServerWithLieutenant, sleep, LT } = require('./helper');

async function commands(s, target) {
  const r = await fetch(s.base + '/api/commands?target=' + encodeURIComponent(target));
  return (await r.json()).commands || [];
}

test('/reset is offered on a lieutenant, and never on a card', async () => {
  const s = await startServerWithLieutenant();
  try {
    const lt = await commands(s, 'lieutenant:' + LT);
    assert.ok(lt.some((c) => c.name === '/reset'), 'a lieutenant can be started over');

    const made = await s.api('POST', '/api/cards', { title: 'c', owner: LT, actor: 'user' });
    assert.strictEqual(made.status, 200);
    const card = await commands(s, 'card:' + made.body.card.id);
    assert.ok(!card.some((c) => c.name === '/reset'),
      "a worker's session belongs to its card — resetting it would hand it a lieutenant's doctrine");
  } finally { await s.stop(); }
});

test('/reset is still offered when the session is dead — that is when it is needed', async () => {
  const s = await startServerWithLieutenant();
  try {
    // The fixture lieutenant is registered without a real agent session, which
    // is the same shape as one whose session died.
    const lt = await commands(s, 'lieutenant:' + LT);
    assert.deepStrictEqual(lt.map((c) => c.name), ['/reset'],
      'the harness offers nothing without a session; the board still offers this');
  } finally { await s.stop(); }
});

test('a lieutenant with nothing to respawn FROM is told so, in the thread', async () => {
  const s = await startServerWithLieutenant();
  try {
    const r = await s.api('POST', '/api/feedback',
      { actor: 'user', target: 'lieutenant:' + LT, text: '/reset' });
    assert.strictEqual(r.status, 200);
    const board = (await s.api('GET', '/api/board')).body;
    const chat = board.lieutenants.find((l) => l.id === LT).chat;
    const last = chat[chat.length - 1];
    assert.match(last.text, /no session to reset/i);
    assert.strictEqual(last.cmd.name, '/reset');
    assert.ok(last.cmd.reply, 'the refusal is a command reply in the thread, not an HTTP error');
  } finally { await s.stop(); }
});

test('the command and its reply both land in the thread', async () => {
  const s = await startServerWithLieutenant();
  try {
    await s.api('POST', '/api/feedback', { actor: 'user', target: 'lieutenant:' + LT, text: '/reset' });
    const board = (await s.api('GET', '/api/board')).body;
    const chat = board.lieutenants.find((l) => l.id === LT).chat;
    const asked = chat[chat.length - 2];
    assert.strictEqual(asked.author, 'user');
    assert.strictEqual(asked.text, '/reset');
    assert.ok(!asked.cmd.reply);
  } finally { await s.stop(); }
});

// /reset kills the lieutenant's session and spawns a fresh one on its launch
// prompt. Between those two halves the lieutenant is legitimately down, and
// supervision's rule for a lieutenant that is down is to respawn it — which
// here means a second spawn racing this one for the same pane, and a captain
// told his lieutenant "died" while he was the one who restarted it. The window
// is a whole spawn, brief delivery included.
//
// BC_FAKE_SPAWN_MS holds the fake's spawn open so ticks land inside it, the way
// they would against a real launch-settle.
test('/reset does not race supervision: the restart it performs is not a death', async () => {
  const s = await startServerWithLieutenant({
    env: {
      BC_SUPERVISE_INTERVAL_MS: '60', BC_PRWATCH_INTERVAL_MS: '0',
      BC_FAKE_SPAWN_MS: '500',
    },
  });
  try {
    const ref = { harness: 'fake', session: 'bc-lt-' + LT, window: 'lt', cwd: '/tmp', resumeId: 'uuid-live' };
    assert.strictEqual((await s.api('PATCH', '/api/lieutenants/' + LT, { ref })).status, 200);

    const r = await s.api('POST', '/api/feedback', { actor: 'user', target: 'lieutenant:' + LT, text: '/reset' });
    assert.strictEqual(r.status, 200);

    let board = (await s.api('GET', '/api/board')).body;
    const chat = board.lieutenants.find((l) => l.id === LT).chat;
    assert.match(chat[chat.length - 1].text, /new session on the launch prompt/);
    assert.ok(!board.events.some((e) => e.kind === 'respawned'),
      'a captain-ordered reset is not a crash supervision recovered from: '
      + JSON.stringify(board.events.map((e) => e.kind)));
    assert.ok(!board.events.some((e) => e.kind === 'needs-captain'));

    // and released afterwards — a guard left on would make this lieutenant
    // unsupervised for good, which is worse than the race it was closing.
    await sleep(400);
    board = (await s.api('GET', '/api/board')).body;
    assert.ok(!board.events.some((e) => e.kind === 'respawned'),
      'the reset session is alive, so unguarded ticks stay quiet too');
  } finally { await s.stop(); }
});
