'use strict';
// The line: the captain's voice channel. One holder at a time, held SERVER-side
// (his phone is not the only client), reached by the target `line` — the voice
// shortcut names nobody. It follows whoever last spoke to him in a main chat,
// and `line.pass` hands it over as a real delivery carrying the note.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { startServer, startServerWithLieutenant, withOwner, runCli, LT } = require('./helper');

// Two lieutenants, registration order = ada (founding), then rex.
async function twoLieutenants(opts) {
  const s = await startServerWithLieutenant(opts);
  const r = await s.api('POST', '/api/lieutenants', { name: 'Rex', id: 'rex' });
  if (r.status !== 200) { await s.stop(); throw new Error('setup: ' + JSON.stringify(r.body)); }
  return s;
}

test('a board that never had a conversation still answers: the founding lieutenant holds the line', async () => {
  const s = await twoLieutenants();
  try {
    const r = await s.api('GET', '/api/line');
    assert.strictEqual(r.status, 200);
    assert.strictEqual(r.body.lieutenant, LT); // first registered — the teleport
    assert.strictEqual(r.body.name, 'Ada');
    assert.strictEqual(r.body.source, 'default'); // nobody has spoken yet, and it says so
    // the resolved holder rides the board payload, never the raw stored null
    assert.strictEqual((await s.api('GET', '/api/board')).body.line, LT);
  } finally {
    await s.stop();
  }
});

test('no lieutenant at all: nobody is on the line, and a line post is refused, not misrouted', async () => {
  const s = await startServer();
  try {
    const r = await s.api('GET', '/api/line');
    assert.strictEqual(r.body.lieutenant, null);
    assert.strictEqual(r.body.source, 'none');
    const post = await s.api('POST', '/api/feedback', { target: 'line', text: 'anybody?' });
    assert.strictEqual(post.status, 404);
    assert.match(post.body.error, /nobody is on the line/);
  } finally {
    await s.stop();
  }
});

test('target "line" reaches the holder: the message lands in their main chat and wakes them', async () => {
  const s = await twoLieutenants();
  try {
    const r = await s.api('POST', '/api/feedback', { target: 'line', text: 'como estamos?' });
    assert.strictEqual(r.status, 200);
    assert.strictEqual(r.body.target, 'lieutenant:' + LT); // resolved server-side
    assert.strictEqual(r.body.via, 'line');

    const board = (await s.api('GET', '/api/board')).body;
    const ada = board.lieutenants.find((l) => l.id === LT);
    assert.deepStrictEqual(ada.chat.map((m) => [m.author, m.text]), [['user', 'como estamos?']]);

    const items = (await s.api('GET', '/api/feed?lieutenant=' + LT)).body.items;
    assert.strictEqual(items.length, 1);
    assert.strictEqual(items[0].kind, 'message');
    assert.strictEqual(items[0].via, 'line');
    assert.strictEqual(items[0].target, 'lieutenant:' + LT);
    // the captain's text is NEVER edited — no channel information glued in
    assert.strictEqual(items[0].text, 'como estamos?');

    // and nobody else was disturbed
    assert.deepStrictEqual((await s.api('GET', '/api/feed?lieutenant=rex')).body.items, []);
  } finally {
    await s.stop();
  }
});

test('the line follows the last voice the captain heard in a main chat; card threads never move it', async () => {
  const s = await twoLieutenants();
  try {
    await s.api('POST', '/api/message', { target: 'lieutenant:rex', text_md: 'PR is up' });
    assert.strictEqual((await s.api('GET', '/api/line')).body.lieutenant, 'rex');
    assert.strictEqual((await s.api('GET', '/api/line')).body.source, 'held');

    // a captain post with no target now reaches Rex, without anyone maintaining it
    await s.api('POST', '/api/feedback', { target: 'line', text: 'manda ver' });
    const rexItems = (await s.api('GET', '/api/feed?lieutenant=rex')).body.items;
    assert.strictEqual(rexItems.length, 1);
    assert.strictEqual(rexItems[0].text, 'manda ver');

    // a card-thread say is a board surface with a picker — it does not take the line
    await s.api('POST', '/api/cards', withOwner({ title: 'Thing' }));
    await s.api('POST', '/api/message', { target: 'card:thing', text: 'progress note' });
    assert.strictEqual((await s.api('GET', '/api/line')).body.lieutenant, 'rex');
  } finally {
    await s.stop();
  }
});

test('line.pass moves the line AND wakes the receiver with the note (a delivery, not a quiet flag)', async () => {
  const s = await twoLieutenants();
  try {
    const r = await s.api('POST', '/api/line', { lieutenant: 'rex', note: 'he wants the deploy status' });
    assert.strictEqual(r.status, 200);
    assert.strictEqual(r.body.lieutenant, 'rex');

    assert.strictEqual((await s.api('GET', '/api/line')).body.lieutenant, 'rex');

    const items = (await s.api('GET', '/api/feed?lieutenant=rex')).body.items;
    assert.strictEqual(items.length, 1);
    assert.strictEqual(items[0].kind, 'line-passed');
    assert.strictEqual(items[0].text, 'he wants the deploy status'); // the note carries the intent
    assert.strictEqual(items[0].from, 'user');

    // the board timeline records the handoff
    const ev = (await s.api('GET', '/api/board')).body.events.filter((e) => e.kind === 'line');
    assert.strictEqual(ev.length, 1);
    assert.match(ev[0].text, /the line passed to Rex: he wants the deploy status/);

    // an unknown lieutenant is a 404 and moves nothing
    const bad = await s.api('POST', '/api/line', { lieutenant: 'ghost', note: 'x' });
    assert.strictEqual(bad.status, 404);
    assert.strictEqual((await s.api('GET', '/api/line')).body.lieutenant, 'rex');
  } finally {
    await s.stop();
  }
});

test('the holder survives a restart, and a retired holder falls back instead of pointing at a ghost', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bc-line-')); // survives the first stop()
  const s = await twoLieutenants({ dir });
  try {
    await s.api('POST', '/api/line', { lieutenant: 'rex' });
  } finally {
    await s.stop();
  }
  const s2 = await startServer({ dir });
  try {
    assert.strictEqual((await s2.api('GET', '/api/line')).body.lieutenant, 'rex'); // server memory, not the client's
    assert.strictEqual((await s2.api('DELETE', '/api/lieutenants/rex')).status, 200);
    const after = await s2.api('GET', '/api/line');
    assert.strictEqual(after.body.lieutenant, LT);
    assert.strictEqual(after.body.source, 'default');
  } finally {
    await s2.stop();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('CLI: bc-axi line names the holder, line pass hands it over, drain marks the channel', async () => {
  const s = await twoLieutenants();
  try {
    const args = ['--workspace', s.dir, '--port', String(s.port)];
    let r = await runCli(['line', ...args]);
    assert.strictEqual(r.code, 0, r.stderr);
    assert.match(r.stdout, /on the line: Ada \(ada\)/);
    assert.match(r.stdout, /default/);

    r = await runCli(['line', 'pass', 'rex', '--note', 'the deploy status', ...args]);
    assert.strictEqual(r.code, 0, r.stderr);
    assert.match(r.stdout, /the line is with Rex \(rex\)/);

    r = await runCli(['line', ...args]);
    assert.match(r.stdout, /on the line: Rex \(rex\)/);
    assert.doesNotMatch(r.stdout, /default/);

    // a message over the line and the handoff both show their channel in drain
    await s.api('POST', '/api/feedback', { target: 'line', text: 'e aí' });
    r = await runCli(['drain', '--lieutenant', 'rex', ...args]);
    assert.strictEqual(r.code, 0, r.stderr);
    assert.match(r.stdout, /YOU ARE ON THE LINE — passed by user/);
    assert.match(r.stdout, /the deploy status/);
    assert.match(r.stdout, /captain message \(over the line\)/);
    assert.match(r.stdout, /e aí/);
    assert.doesNotMatch(r.stdout, /captain message \(your main chat\)/);
  } finally {
    await s.stop();
  }
});
