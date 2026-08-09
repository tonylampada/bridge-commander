'use strict';
// `bc-axi event --key` and `--source` — twenty lines that make every future
// polling hook cheap.
//
// A hook that polls `gh` every five minutes sees the same red check sixty
// times. Without a key it wakes its lieutenant sixty times. With --key, the
// second and later events carrying that key FOR THAT CARD are a no-op that
// exits 0 and says it was a duplicate: no timeline entry, no queue item. Keys
// are scoped per card and kept 7 days.
//
// --source rides along onto BOTH the timeline entry and the queue item, so a
// drain at 2am says who woke you.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const { startServerWithLieutenant, withOwner, runCli, LT } = require('./helper');

const events = async (s, id) => (await s.api('GET', '/api/cards/' + id)).body.events;
const feed = async (s) => (await s.api('GET', '/api/feed?lieutenant=' + LT)).body.items;

async function boot() {
  const s = await startServerWithLieutenant();
  await s.api('POST', '/api/cards', withOwner({ title: 'Watched', id: 'watched' }));
  await s.api('POST', '/api/cards', withOwner({ title: 'Other', id: 'other' }));
  return s;
}

test('the same key twice on one card writes ONE timeline entry and ONE queue item', async () => {
  const s = await boot();
  try {
    const body = { text: 'CI is red on abc123', wakeOwner: true, key: 'ci:abc123', kind: 'ci' };
    const first = await s.api('POST', '/api/cards/watched/events', body);
    assert.strictEqual(first.status, 200);
    assert.ok(first.body.event, 'the first one is a real event');

    for (let i = 0; i < 5; i++) {
      const again = await s.api('POST', '/api/cards/watched/events', body);
      assert.strictEqual(again.status, 200, 'a duplicate is not an error — the poller is not wrong');
      assert.strictEqual(again.body.duplicate, true);
      assert.strictEqual(again.body.key, 'ci:abc123');
      assert.ok(!again.body.event, 'and nothing was appended');
    }

    const evs = (await events(s, 'watched')).filter((e) => e.kind === 'ci');
    assert.strictEqual(evs.length, 1, 'one timeline entry for six calls');
    assert.strictEqual((await feed(s)).filter((i) => i.kind === 'card-event').length, 1, 'and one queue item');
  } finally { await s.stop(); }
});

test('the same key on a DIFFERENT card is not a collision — keys are scoped per card', async () => {
  const s = await boot();
  try {
    const body = { text: 'CI is red', wakeOwner: true, key: 'ci:abc123', kind: 'ci' };
    await s.api('POST', '/api/cards/watched/events', body);
    const other = await s.api('POST', '/api/cards/other/events', body);
    assert.ok(other.body.event, 'the other card gets its own event');
    assert.ok(!other.body.duplicate);
    assert.strictEqual((await events(s, 'other')).filter((e) => e.kind === 'ci').length, 1);
    assert.strictEqual((await feed(s)).filter((i) => i.kind === 'card-event').length, 2);
  } finally { await s.stop(); }
});

test('a different key on the same card is a different thing that happened', async () => {
  const s = await boot();
  try {
    await s.api('POST', '/api/cards/watched/events', { text: 'red on abc', key: 'ci:abc', kind: 'ci' });
    await s.api('POST', '/api/cards/watched/events', { text: 'red on def', key: 'ci:def', kind: 'ci' });
    assert.strictEqual((await events(s, 'watched')).filter((e) => e.kind === 'ci').length, 2);
  } finally { await s.stop(); }
});

test('no key means no deduping — every call still lands, exactly as it always did', async () => {
  const s = await boot();
  try {
    for (let i = 0; i < 3; i++) {
      await s.api('POST', '/api/cards/watched/events', { text: 'tick ' + i, wakeOwner: true, kind: 'ci' });
    }
    assert.strictEqual((await events(s, 'watched')).filter((e) => e.kind === 'ci').length, 3);
    assert.strictEqual((await feed(s)).filter((i) => i.kind === 'card-event').length, 3);
  } finally { await s.stop(); }
});

test('a key past its 7 days is gone — the same check lands again next week', async () => {
  const s = await boot();
  try {
    await s.api('POST', '/api/cards/watched/events', { text: 'red', key: 'ci:abc', kind: 'ci' });
    // age the store by hand: the only thing that expires a key is its timestamp
    const file = path.join(s.dir, '.bridge-commander', 'eventkeys.json');
    const doc = JSON.parse(fs.readFileSync(file, 'utf8'));
    assert.ok(doc.watched && doc.watched['ci:abc'], 'the key is on record, scoped to the card');
    doc.watched['ci:abc'] = Date.now() - 8 * 24 * 60 * 60 * 1000;
    fs.writeFileSync(file, JSON.stringify(doc));

    const again = await s.api('POST', '/api/cards/watched/events', { text: 'red', key: 'ci:abc', kind: 'ci' });
    assert.ok(again.body.event, 'a stale key is not a duplicate');
    assert.strictEqual((await events(s, 'watched')).filter((e) => e.kind === 'ci').length, 2);
    // and the prune took the dead entry with it
    assert.strictEqual(Object.keys(JSON.parse(fs.readFileSync(file, 'utf8')).watched).length, 1);
  } finally { await s.stop(); }
});

test('--source is on the timeline entry AND the queue item, and bc-axi drain says it', async () => {
  const s = await boot();
  try {
    const ws = ['--workspace', s.dir, '--port', String(s.port)];
    const f = path.join(s.dir, 'msg.txt');
    fs.writeFileSync(f, 'CI went red on main');
    const r = await runCli(['event', 'watched', '--wake-owner', '--source', 'gh-watch',
      '--kind', 'ci', '--text-file', f, ...ws]);
    assert.strictEqual(r.code, 0, r.stderr);

    const ev = (await events(s, 'watched')).find((e) => e.kind === 'ci');
    assert.strictEqual(ev.source, 'gh-watch');
    const item = (await feed(s)).find((i) => i.kind === 'card-event');
    assert.strictEqual(item.source, 'gh-watch');

    const drain = await runCli(['drain', '--lieutenant', LT, ...ws]);
    assert.match(drain.stdout, /CARD EVENT \[ci\].*\(from gh-watch\)/);
  } finally { await s.stop(); }
});

test('bc-axi event --key: the repeat exits 0 and says duplicate, and it is the SAME command either way', async () => {
  const s = await boot();
  try {
    const ws = ['--workspace', s.dir, '--port', String(s.port)];
    const f = path.join(s.dir, 'msg.txt');
    fs.writeFileSync(f, 'CI went red on main');
    const args = ['event', 'watched', '--wake-owner', '--key', 'ci:abc123',
      '--source', 'gh-watch', '--text-file', f, ...ws];

    const first = await runCli(args);
    assert.strictEqual(first.code, 0, first.stderr);
    assert.match(first.stdout, /event #\d+ L2 -> watched \(owner woken\)/);

    const second = await runCli(args);
    assert.strictEqual(second.code, 0, 'a duplicate is a SUCCESS — nothing happened twice');
    assert.match(second.stdout, /duplicate key "ci:abc123" on watched — nothing written, nobody woken/);

    assert.strictEqual((await events(s, 'watched')).filter((e) => e.source === 'gh-watch').length, 1);
    assert.strictEqual((await feed(s)).filter((i) => i.kind === 'card-event').length, 1);
  } finally { await s.stop(); }
});
