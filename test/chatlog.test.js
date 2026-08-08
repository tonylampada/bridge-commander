'use strict';
// Lieutenant main chat lives in an append-only file, not in board.json:
// <state>/chat/<lieutenant>.jsonl, one message per line, the way archive.jsonl
// and the delivery queues are written. board.json carries NO chat at all; the
// server holds the newest CHAT_TAIL per lieutenant in memory (read from the
// file at boot) and that is what GET /api/board ships. Older history pages
// backwards over GET /api/chat. Card threads are untouched — they stay on the
// board and die with their card.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { startServer, startServerWithLieutenant, withOwner, runCli, LT } = require('./helper');

const TAIL = 50;
function stateDir(dir) { return path.join(dir, '.bridge-commander'); }
function chatFile(dir, lt) { return path.join(stateDir(dir), 'chat', lt + '.jsonl'); }
function readLog(dir, lt) {
  return fs.readFileSync(chatFile(dir, lt), 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l));
}
function readBoardFile(dir) {
  return JSON.parse(fs.readFileSync(path.join(stateDir(dir), 'board.json'), 'utf8'));
}
function tmpWorkspace() { return fs.mkdtempSync(path.join(os.tmpdir(), 'bc-chatlog-')); }

// A board.json in the OLD shape: chat inline on the lieutenant.
function seedBoardWithChat(dir, messages) {
  fs.mkdirSync(stateDir(dir), { recursive: true });
  fs.writeFileSync(path.join(stateDir(dir), 'board.json'), JSON.stringify({
    title: 'seeded', seq: 0,
    lieutenants: [{ id: LT, name: 'Ada', color: '#58b6ff', prefix: 'ADA', cardSeq: 0, charter: '', chat: messages, created: '2026-01-01T00:00:00.000Z' }],
    cards: [], events: [], labels: [], reads: {}, kinds: {}, projects: [], workers: [], line: null,
  }, null, 2));
}
function fakeMessages(n, from) {
  const out = [];
  for (let i = 0; i < n; i++) {
    out.push({ author: i % 2 ? 'Ada' : 'user', text: 'msg ' + (i + 1),
      ts: new Date(Date.parse(from || '2026-01-01T00:00:00.000Z') + i * 1000).toISOString() });
  }
  return out;
}

test('boot migration: chat leaves board.json for the file, in order', async () => {
  const dir = tmpWorkspace();
  const msgs = fakeMessages(120);
  seedBoardWithChat(dir, msgs);
  const s = await startServer({ dir });
  try {
    const stored = readBoardFile(dir);
    assert.ok(!('chat' in stored.lieutenants[0]), 'no lieutenant on the stored board carries a chat key');
    assert.deepStrictEqual(readLog(dir, LT).map((m) => m.text), msgs.map((m) => m.text),
      'every message that was on the board is in the log, in the original order');
  } finally {
    await s.stop();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('booting twice appends nothing the second time', async () => {
  const dir = tmpWorkspace();
  seedBoardWithChat(dir, fakeMessages(7));
  let s = await startServer({ dir });
  await s.stop();
  const afterFirst = fs.readFileSync(chatFile(dir, LT));
  s = await startServer({ dir });
  try {
    assert.deepStrictEqual(fs.readFileSync(chatFile(dir, LT)), afterFirst,
      'a second boot doubles nobody\'s history');
  } finally {
    await s.stop();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('GET /api/board ships at most the newest 50, newest last', async () => {
  const dir = tmpWorkspace();
  const msgs = fakeMessages(120);
  seedBoardWithChat(dir, msgs);
  const s = await startServer({ dir });
  try {
    const chat = (await s.api('GET', '/api/board')).body.lieutenants[0].chat;
    assert.strictEqual(chat.length, TAIL);
    assert.strictEqual(chat[0].text, 'msg 71');
    assert.strictEqual(chat[chat.length - 1].text, 'msg 120', 'newest last — the order the pane renders');
  } finally {
    await s.stop();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('sending a message appends exactly one line and rewrites none of the bytes before it', async () => {
  const dir = tmpWorkspace();
  seedBoardWithChat(dir, fakeMessages(60));
  const s = await startServer({ dir });
  try {
    const before = fs.readFileSync(chatFile(dir, LT));
    const r = await s.api('POST', '/api/feedback', { target: 'lieutenant:' + LT, text: 'and now this' });
    assert.strictEqual(r.status, 200);
    const after = fs.readFileSync(chatFile(dir, LT));
    assert.deepStrictEqual(after.subarray(0, before.length), before, 'the bytes before are byte-identical');
    const lines = readLog(dir, LT);
    assert.strictEqual(lines.length, 61, 'exactly one line more');
    assert.strictEqual(lines[60].text, 'and now this');
    // …and the board still carries no chat
    assert.ok(!('chat' in readBoardFile(dir).lieutenants[0]));
  } finally {
    await s.stop();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('a message survives a crash before the next saveBoard — the file is truth', async () => {
  const dir = tmpWorkspace();
  seedBoardWithChat(dir, fakeMessages(3));
  let s = await startServer({ dir });
  await s.api('POST', '/api/message', { target: 'lieutenant:' + LT, text: 'said it, then died' });
  s.child.kill('SIGKILL'); // no clean shutdown, no final save
  await new Promise((r) => s.child.once('exit', r));
  s = await startServer({ dir });
  try {
    const chat = (await s.api('GET', '/api/board')).body.lieutenants[0].chat;
    assert.strictEqual(chat[chat.length - 1].text, 'said it, then died');
  } finally {
    await s.stop();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('a torn last line costs that line, not the conversation', async () => {
  const dir = tmpWorkspace();
  const msgs = fakeMessages(4);
  seedBoardWithChat(dir, msgs);
  let s = await startServer({ dir }); // migrates the seeded chat into the file
  await s.stop();
  const raw = fs.readFileSync(chatFile(dir, LT), 'utf8');
  fs.writeFileSync(chatFile(dir, LT), raw + JSON.stringify(msgs[0]).slice(0, 20)); // crash mid-append
  s = await startServer({ dir });
  try {
    const chat = (await s.api('GET', '/api/board')).body.lieutenants[0].chat;
    assert.deepStrictEqual(chat.map((m) => m.text), msgs.map((m) => m.text), 'every whole line still reads');
    const page = await s.api('GET', '/api/chat?limit=0&target=' + encodeURIComponent('lieutenant:' + LT));
    assert.strictEqual(page.body.messages.length, 4);
    // the file is never repaired — append-only means append-only
    assert.ok(fs.readFileSync(chatFile(dir, LT), 'utf8').startsWith(raw));
  } finally {
    await s.stop();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('GET /api/chat pages backwards, and answers past the beginning with an empty list and a 200', async () => {
  const dir = tmpWorkspace();
  const msgs = fakeMessages(120);
  seedBoardWithChat(dir, msgs);
  const s = await startServer({ dir });
  try {
    const target = 'lieutenant:' + LT;
    const page = async (before, limit) => s.api('GET', '/api/chat?target=' + encodeURIComponent(target)
      + (before ? '&before=' + encodeURIComponent(before) : '') + (limit == null ? '' : '&limit=' + limit));

    const first = await page(msgs[70].ts, 20); // the page before what the board shipped
    assert.strictEqual(first.status, 200);
    assert.deepStrictEqual(first.body.messages.map((m) => m.text),
      msgs.slice(50, 70).map((m) => m.text), 'oldest-first, strictly older than the cursor');

    // walk the rest of the way back
    let cursor = first.body.messages[0].ts;
    let seen = first.body.messages.length;
    for (;;) {
      const r = await page(cursor, 20);
      assert.strictEqual(r.status, 200);
      if (!r.body.messages.length) break; // past the beginning: empty, never an error
      seen += r.body.messages.length;
      cursor = r.body.messages[0].ts;
    }
    assert.strictEqual(seen, 70, 'the whole history before the board tail, once each');

    // the very first message has nothing before it
    const none = await page(msgs[0].ts, 20);
    assert.strictEqual(none.status, 200);
    assert.deepStrictEqual(none.body.messages, []);

    // limit=0 is the whole conversation; a card target has nothing to page
    const all = await page('', 0);
    assert.strictEqual(all.body.messages.length, 120);
    // ...but only an explicit 0. A limit that does not parse falls back to the
    // default page instead of shipping the entire log.
    for (const bad of ['abc', '']) {
      const r = await page('', bad);
      assert.strictEqual(r.body.messages.length, TAIL, 'limit=' + JSON.stringify(bad) + ' is not "everything"');
    }
    assert.strictEqual((await s.api('GET', '/api/chat?target=card:x')).status, 400);
    assert.strictEqual((await s.api('GET', '/api/chat?target=lieutenant:ghost')).status, 404);
  } finally {
    await s.stop();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('bc-axi thread lieutenant:<id> prints the full conversation, not just the board tail', async () => {
  const dir = tmpWorkspace();
  const msgs = fakeMessages(120);
  seedBoardWithChat(dir, msgs);
  const s = await startServer({ dir });
  try {
    const r = await runCli(['thread', 'lieutenant:' + LT, '--workspace', s.dir, '--port', String(s.port)]);
    assert.strictEqual(r.code, 0, r.stderr);
    assert.match(r.stdout, /msg 1$/m, 'the first message is there');
    assert.match(r.stdout, /msg 120$/m);
    assert.strictEqual(r.stdout.split('\n').filter((l) => /msg \d+$/.test(l)).length, 120);
  } finally {
    await s.stop();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('a captain message leaves unread / owed / queued exactly as they were', async () => {
  const s = await startServerWithLieutenant();
  try {
    const target = 'lieutenant:' + LT;
    const ltOf = async () => (await s.api('GET', '/api/board')).body.lieutenants.find((l) => l.id === LT);
    const before = await ltOf();
    assert.strictEqual(before.chatOwed, false);
    assert.strictEqual(before.chatQueued, false);

    await s.api('POST', '/api/feedback', { target, text: 'status?' });
    const after = await ltOf();
    assert.strictEqual(after.chatOwed, true, 'the captain is owed a reply');
    assert.strictEqual(after.chatQueued, true, 'and it is sitting undrained in the queue');
    assert.strictEqual(after.chat[after.chat.length - 1].text, 'status?');

    // the lieutenant answers and acks: owed clears on the ACK, as it always did
    const pending = (await s.api('GET', '/api/feed?lieutenant=' + LT)).body.items;
    await s.api('POST', '/api/message', { target, text_md: 'all good' });
    await s.api('POST', '/api/feed/ack', { seq: pending[pending.length - 1].seq });
    const done = await ltOf();
    assert.strictEqual(done.chatOwed, false);
    assert.strictEqual(done.chatQueued, false);
    assert.strictEqual(done.chat[done.chat.length - 1].text, 'all good');
  } finally { await s.stop(); }
});

test('card threads stay on the board, chat file and all', async () => {
  const s = await startServerWithLieutenant();
  try {
    await s.api('POST', '/api/cards', withOwner({ title: 'Chatty' }));
    await s.api('POST', '/api/message', { target: 'card:chatty', text: 'in the thread' });
    const stored = readBoardFile(s.dir);
    assert.deepStrictEqual(stored.cards[0].thread.map((m) => m.text), ['in the thread'],
      'a card thread is still stored on the card — it dies with the card');
    assert.ok(!fs.existsSync(chatFile(s.dir, LT)), 'and it never touches the lieutenant log');
  } finally { await s.stop(); }
});
