'use strict';
// F3 — the wake half of delivery. The queue write is the ground truth (F1);
// these tests cover the harness.send wake behind every append: coalescing while
// pending-and-nudged, re-nudge after a drain, non-fatal wake failures, and the
// turn-end endpoint (resumeId capture/adoption + the drain-at-turn-start
// re-nudge backstop). Uses the fake harness in file-backed mode
// (BC_FAKE_STATE): a `<session>.json` marker = a live session in another
// process; sends append to `<session>.sends.jsonl`.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { startServer, sleep } = require('./helper');

function sendsFile(dir, session) { return path.join(dir, session + '.sends.jsonl'); }
function readSends(dir, session) {
  try {
    return fs.readFileSync(sendsFile(dir, session), 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l));
  } catch (e) { return []; }
}
async function waitSends(dir, session, n, ms = 3000) {
  const deadline = Date.now() + ms;
  for (;;) {
    const got = readSends(dir, session);
    if (got.length >= n) return got;
    if (Date.now() > deadline) return got;
    await sleep(50);
  }
}
function fakeSession(dir, session) {
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, session + '.json'), JSON.stringify({ cwd: '/tmp', resumeId: null }) + '\n');
}

test('queue append wakes a live-ref lieutenant once; drain re-arms; ack re-arms', async () => {
  const fdir = fs.mkdtempSync(path.join(os.tmpdir(), 'bc-fake-'));
  const s = await startServer({ env: { BC_FAKE_STATE: fdir } });
  try {
    fakeSession(fdir, 'bc-fk1');
    const ref = { harness: 'fake', session: 'bc-fk1', cwd: '/tmp', resumeId: 'uuid-fk1' };
    assert.strictEqual((await s.api('POST', '/api/lieutenants', { name: 'Fake One', id: 'fk1', ref })).status, 200);

    // first captain message: queue write + ONE wake, compact line with the count
    await s.api('POST', '/api/feedback', { target: 'lieutenant:fk1', text: 'hello' });
    let sends = await waitSends(fdir, 'bc-fk1', 1);
    assert.strictEqual(sends.length, 1);
    assert.match(sends[0].text, /^\[bridge-command\] 1 pending item\(s\) — run: bc-axi drain$/);

    // coalescing: more appends while pending-and-nudged do NOT stack wakes
    await s.api('POST', '/api/feedback', { target: 'lieutenant:fk1', text: 'again' });
    await sleep(300);
    assert.strictEqual(readSends(fdir, 'bc-fk1').length, 1, 'no stacked wake while already nudged');

    // a drain clears the flag; the next append nudges again, with the full count
    await s.api('GET', '/api/feed?lieutenant=fk1');
    await s.api('POST', '/api/feedback', { target: 'lieutenant:fk1', text: 'third' });
    sends = await waitSends(fdir, 'bc-fk1', 2);
    assert.strictEqual(sends.length, 2);
    assert.match(sends[1].text, /3 pending item\(s\)/);

    // ack also re-arms
    const items = (await s.api('GET', '/api/feed?lieutenant=fk1')).body.items;
    await s.api('POST', '/api/feed/ack', { seq: items[items.length - 1].seq });
    await s.api('POST', '/api/feedback', { target: 'lieutenant:fk1', text: 'fourth' });
    sends = await waitSends(fdir, 'bc-fk1', 3);
    assert.strictEqual(sends.length, 3);
    assert.match(sends[2].text, /1 pending item\(s\)/);
  } finally {
    await s.stop();
    fs.rmSync(fdir, { recursive: true, force: true });
  }
});

test('wake failure is non-fatal: the queue keeps the item, the server keeps serving', async () => {
  const fdir = fs.mkdtempSync(path.join(os.tmpdir(), 'bc-fake-'));
  const s = await startServer({ env: { BC_FAKE_STATE: fdir } });
  try {
    // ref to a session that does not exist anywhere -> harness.send throws
    const ref = { harness: 'fake', session: 'bc-ghost', cwd: '/tmp', resumeId: 'uuid-ghost' };
    await s.api('POST', '/api/lieutenants', { name: 'Ghost', id: 'ghost', ref });
    const r = await s.api('POST', '/api/feedback', { target: 'lieutenant:ghost', text: 'anyone there?' });
    assert.strictEqual(r.status, 200); // queue is truth; the wake is best-effort
    await sleep(300);
    const feed = (await s.api('GET', '/api/feed?lieutenant=ghost')).body;
    assert.strictEqual(feed.items.length, 1);
    assert.strictEqual((await s.api('GET', '/api/status')).status, 200);
  } finally {
    await s.stop();
    fs.rmSync(fdir, { recursive: true, force: true });
  }
});

test('turn-end: resumeId adoption + capture, turn bookkeeping, foreign sessions ignored', async () => {
  const s = await startServer();
  try {
    // founding-style lieutenant: ref without resumeId (the teleport does not know its claude id yet)
    const ref = { harness: 'fake', session: 'my-tmux', cwd: '/tmp' };
    await s.api('POST', '/api/lieutenants', { name: 'Founder', id: 'founder', ref });

    // adoption: the single resumeId-less ref learns its claude id from the hook payload
    let r = await s.api('POST', '/api/turn-end', { session: 'ws', session_id: 'uuid-adopted', cwd: '/tmp', event: 'Stop' });
    assert.strictEqual(r.body.lieutenant, 'founder');
    let lt = (await s.api('GET', '/api/lieutenants')).body.lieutenants[0];
    assert.strictEqual(lt.ref.resumeId, 'uuid-adopted');
    assert.strictEqual(lt.turns, 1);
    assert.ok(lt.lastTurnEnd);

    // match by resumeId; a CHANGED session_id for the same lieutenant is ground truth
    r = await s.api('POST', '/api/turn-end', { session: 'ws', session_id: 'uuid-adopted' });
    assert.strictEqual(r.body.lieutenant, 'founder');
    assert.strictEqual((await s.api('GET', '/api/lieutenants')).body.lieutenants[0].turns, 2);

    // match by hook session name updates a stale resumeId
    r = await s.api('POST', '/api/turn-end', { session: 'my-tmux', session_id: 'uuid-v2' });
    assert.strictEqual(r.body.lieutenant, 'founder');
    assert.strictEqual((await s.api('GET', '/api/lieutenants')).body.lieutenants[0].ref.resumeId, 'uuid-v2');

    // a foreign claude in the workspace: acknowledged, attributed to nobody
    r = await s.api('POST', '/api/turn-end', { session: 'ws', session_id: 'uuid-stranger' });
    assert.strictEqual(r.status, 200);
    assert.strictEqual(r.body.lieutenant, null);
    assert.strictEqual((await s.api('GET', '/api/lieutenants')).body.lieutenants[0].turns, 3);
  } finally {
    await s.stop();
  }
});

test('turn-end with pending unacked items re-nudges (drain-at-turn-start backstop)', async () => {
  const fdir = fs.mkdtempSync(path.join(os.tmpdir(), 'bc-fake-'));
  const s = await startServer({ env: { BC_FAKE_STATE: fdir } });
  try {
    // session is DOWN at append time: the wake fails (non-fatal, flag re-armed)
    const ref = { harness: 'fake', session: 'bc-fk2', cwd: '/tmp', resumeId: 'uuid-fk2' };
    await s.api('POST', '/api/lieutenants', { name: 'Late Riser', id: 'fk2', ref });
    await s.api('POST', '/api/feedback', { target: 'lieutenant:fk2', text: 'missed wake' });
    await sleep(300);
    assert.strictEqual(readSends(fdir, 'bc-fk2').length, 0);

    // the session comes up, its turn ends with items still unacked -> re-nudge
    fakeSession(fdir, 'bc-fk2');
    const r = await s.api('POST', '/api/turn-end', { session: 'ws', session_id: 'uuid-fk2' });
    assert.strictEqual(r.body.lieutenant, 'fk2');
    assert.strictEqual(r.body.pending, 1);
    const sends = await waitSends(fdir, 'bc-fk2', 1);
    assert.strictEqual(sends.length, 1);
    assert.match(sends[0].text, /1 pending item\(s\) — run: bc-axi drain/);

    // ...but an OUTSTANDING wake does not loop: another turn-end sends nothing new
    await s.api('POST', '/api/turn-end', { session: 'ws', session_id: 'uuid-fk2' });
    await sleep(300);
    assert.strictEqual(readSends(fdir, 'bc-fk2').length, 1);
  } finally {
    await s.stop();
    fs.rmSync(fdir, { recursive: true, force: true });
  }
});

test('lieutenant.create with spawn: real harness.spawn in the workspace root, ref persisted, doctrine+charter prompt', async () => {
  const fdir = fs.mkdtempSync(path.join(os.tmpdir(), 'bc-fake-'));
  const s = await startServer({ env: { BC_FAKE_STATE: fdir } });
  try {
    const r = await s.api('POST', '/api/lieutenants', {
      name: 'Spawn Bot', charter: 'guard the gate', spawn: true, harness: 'fake', actor: 'user',
    });
    assert.strictEqual(r.status, 200, JSON.stringify(r.body));
    const lt = r.body.lieutenant;
    assert.strictEqual(lt.id, 'spawn-bot');
    assert.strictEqual(lt.ref.harness, 'fake');
    assert.strictEqual(lt.ref.session, 'bc-lt-spawn-bot');
    assert.strictEqual(lt.ref.cwd, path.resolve(s.dir)); // spawned in the workspace root
    assert.ok(lt.ref.resumeId, 'resumeId known at birth');

    // launch prompt = doctrine + charter + situating line (recorded by the fake's spawn marker)
    const rec = JSON.parse(fs.readFileSync(path.join(fdir, 'bc-lt-spawn-bot.json'), 'utf8'));
    assert.match(rec.prompt, /Lieutenant doctrine/);
    assert.match(rec.prompt, /guard the gate/);
    assert.match(rec.prompt, /lieutenant "Spawn Bot" \(id: spawn-bot\)/);
    assert.match(rec.prompt, /bc-axi drain/);

    // the ref survives a restart (board is truth) and receives wakes
    await s.api('POST', '/api/feedback', { target: 'lieutenant:spawn-bot', text: 'welcome aboard' });
    const sends = await waitSends(fdir, 'bc-lt-spawn-bot', 1);
    assert.strictEqual(sends.length, 1);
    assert.match(sends[0].text, /\[bridge-command\] 1 pending item\(s\)/);

    // spawn failure = clean error, no lieutenant registered
    const bad = await s.api('POST', '/api/lieutenants', { name: 'Spawn Bot', spawn: true, harness: 'fake' });
    assert.strictEqual(bad.status, 409);
    const dup = await s.api('POST', '/api/lieutenants', { name: 'No Such', spawn: true, harness: 'nope' });
    assert.strictEqual(dup.status, 400);
    assert.strictEqual((await s.api('GET', '/api/lieutenants')).body.lieutenants.length, 1);
  } finally {
    await s.stop();
    fs.rmSync(fdir, { recursive: true, force: true });
  }
});
