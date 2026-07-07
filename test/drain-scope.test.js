'use strict';
// Multi-lieutenant queue isolation: a lieutenant drains ONLY its own queue.
// Regression for the cross-drain bug where a second lieutenant's startup drain
// received another lieutenant's captain message and replied into its chat.
// Identity is the caller's tmux session (ref.session); the CLI passes it as
// ?session=, the server resolves it to that one lieutenant.
const test = require('node:test');
const assert = require('node:assert');
const { startServer } = require('./helper');

test('session-scoped drain isolates each lieutenant to its own queue', async () => {
  const s = await startServer();
  try {
    const cmd = { harness: 'fake', session: 'bc-cmd', cwd: '/tmp' };
    const mon = { harness: 'fake', session: 'bc-mon', cwd: '/tmp' };
    assert.strictEqual((await s.api('POST', '/api/lieutenants', { name: 'commander', id: 'commander', ref: cmd })).status, 200);
    assert.strictEqual((await s.api('POST', '/api/lieutenants', { name: 'Monica', id: 'monica', ref: mon })).status, 200);

    // captain messages ONLY commander's main chat
    assert.strictEqual((await s.api('POST', '/api/feedback', { target: 'lieutenant:commander', text: 'Oi' })).status, 200);

    // Monica's drain (by her session) sees nothing — not commander's item
    const monDrain = await s.api('GET', '/api/feed?session=bc-mon');
    assert.strictEqual(monDrain.status, 200);
    assert.strictEqual(monDrain.body.items.length, 0, 'Monica must not drain commander\'s queue');

    // commander's drain (by its session) gets exactly its own item
    const cmdDrain = await s.api('GET', '/api/feed?session=bc-cmd');
    assert.strictEqual(cmdDrain.status, 200);
    assert.strictEqual(cmdDrain.body.items.length, 1);
    assert.strictEqual(cmdDrain.body.items[0].text, 'Oi');
    assert.strictEqual(cmdDrain.body.items[0].lieutenant, 'commander');

    // an unresolved session (non-lieutenant caller / stale ref) drains NOTHING,
    // never every queue — draining-all here is what enabled cross-lieutenant
    // ack wipes
    const ghost = await s.api('GET', '/api/feed?session=bc-ghost');
    assert.strictEqual(ghost.status, 200);
    assert.strictEqual(ghost.body.items.length, 0);

    // explicit --lieutenant still scopes
    const byId = await s.api('GET', '/api/feed?lieutenant=monica');
    assert.strictEqual(byId.body.items.length, 0);

    // raw API with no identity at all keeps draining all queues (tooling/back-compat)
    const all = await s.api('GET', '/api/feed');
    assert.strictEqual(all.body.items.length, 1);

    // ack ownership: Monica (by session) must NOT be able to commit commander's seq
    const seq = cmdDrain.body.items[0].seq;
    const steal = await s.api('POST', '/api/feed/ack', { seq, session: 'bc-mon' });
    assert.strictEqual(steal.status, 409, 'a lieutenant must not ack another\'s queue');
    // commander's item is still pending — nothing was discarded
    const stillThere = await s.api('GET', '/api/feed?session=bc-cmd');
    assert.strictEqual(stillThere.body.items.length, 1);
    // commander acks its own seq — that works
    const own = await s.api('POST', '/api/feed/ack', { seq, session: 'bc-cmd' });
    assert.strictEqual(own.status, 200);
    assert.strictEqual(own.body.lieutenant, 'commander');
    const drained = await s.api('GET', '/api/feed?session=bc-cmd');
    assert.strictEqual(drained.body.items.length, 0);
  } finally {
    await s.stop();
  }
});
