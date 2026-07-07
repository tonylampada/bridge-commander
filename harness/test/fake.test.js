'use strict';
const test = require('node:test');
const assert = require('node:assert');
const fake = require('../fake.js');

function tick() {
  return new Promise((r) => setImmediate(r));
}

test.beforeEach(() => fake.reset());

test('spawn creates a live session and emits a turn end', async () => {
  const ref = await fake.spawn('/tmp/x', 'hello');
  assert.strictEqual(ref.harness, 'fake');
  assert.match(ref.session, /^bc-/);
  assert.strictEqual(await fake.alive(ref), true);
  assert.deepStrictEqual(fake.transcript(ref), ['hello']);
});

test('onTurnEnd fires per turn, only after registration, and unsubscribes', async () => {
  const ref = await fake.spawn('/tmp/x', 'p0');
  await tick(); // spawn's own turn end fires before registration — must not be seen
  const events = [];
  const unsub = fake.onTurnEnd(ref, (e) => events.push(e));
  await fake.send(ref, 'm1');
  await fake.send(ref, 'm2');
  await tick();
  assert.strictEqual(events.length, 2);
  assert.strictEqual(events[0].event, 'Stop');
  assert.strictEqual(events[0].session, ref.session);
  unsub();
  await fake.send(ref, 'm3');
  await tick();
  assert.strictEqual(events.length, 2);
});

test('send throws on a dead session', async () => {
  const ref = await fake.spawn('/tmp/x', 'p');
  fake.kill(ref);
  assert.strictEqual(await fake.alive(ref), false);
  await assert.rejects(() => fake.send(ref, 'hi'), /not alive/);
});

test('resume revives with memory when resumeId matches', async () => {
  const ref = await fake.spawn('/tmp/x', 'remember-me');
  await fake.send(ref, 'more');
  fake.kill(ref);
  const ref2 = await fake.resume(ref);
  assert.strictEqual(await fake.alive(ref2), true);
  assert.strictEqual(ref2.resumeId, ref.resumeId);
  assert.deepStrictEqual(fake.transcript(ref2), ['remember-me', 'more']);
});

test('resume without matching memory starts fresh', async () => {
  const ref = await fake.spawn('/tmp/x', 'p');
  fake.kill(ref);
  const ref2 = await fake.resume({ ...ref, resumeId: 'wrong-id' });
  assert.strictEqual(await fake.alive(ref2), true);
  assert.notStrictEqual(ref2.resumeId, ref.resumeId);
  assert.deepStrictEqual(fake.transcript(ref2), []);
});

test('resume on a live session is a no-op returning an equal ref', async () => {
  const ref = await fake.spawn('/tmp/x', 'p');
  const ref2 = await fake.resume(ref);
  assert.deepStrictEqual(ref2, ref);
});

test('refs are JSON-serializable', async () => {
  const ref = await fake.spawn('/tmp/x', 'p');
  assert.deepStrictEqual(JSON.parse(JSON.stringify(ref)), ref);
});

test('kill ends a session for good; idempotent; file-backed marker removed', async () => {
  const fs = require('node:fs');
  const os = require('node:os');
  const path = require('node:path');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bc-fake-kill-'));
  process.env.BC_FAKE_STATE = dir;
  try {
    const ref = await fake.spawn('/tmp/x', 'hi', { session: 'bc-kill-me' });
    const marker = path.join(dir, 'bc-kill-me.json');
    assert.ok(fs.existsSync(marker), 'spawn wrote the marker');
    fake.kill(ref);
    assert.strictEqual(await fake.alive(ref), false);
    assert.ok(!fs.existsSync(marker), 'kill removed the marker (cross-process alive flips false)');
    fake.kill(ref); // idempotent — dead ref is a no-op
    await assert.rejects(() => fake.send(ref, 'nope'), /not alive/);
  } finally {
    delete process.env.BC_FAKE_STATE;
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
