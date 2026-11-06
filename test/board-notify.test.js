'use strict';
// A board change goes out on /api/events as a NOTICE — `board-changed {rev,
// boot}` — never the board itself; each tab fetches /api/board (gzipped) and
// boardsync.js decides when (MNC-303). Server half and client half.
const test = require('node:test');
const assert = require('node:assert');
const path = require('node:path');
const { pathToFileURL } = require('node:url');
const { startServerWithLieutenant, withOwner, sleep } = require('./helper');

const syncMod = import(pathToFileURL(path.join(__dirname, '..', 'ui', 'js', 'boardsync.js')).href);

// Every frame on the stream, raw, until `until(frames)` says enough or time runs out.
async function collect(base, act, until, ms = 3000) {
  const ctrl = new AbortController();
  const res = await fetch(base + '/api/events', { signal: ctrl.signal });
  const reader = res.body.getReader();
  const dec = new TextDecoder();
  const frames = [];
  let buf = '';
  await act();
  const deadline = Date.now() + ms;
  try {
    while (Date.now() < deadline && !until(frames)) {
      const r = await Promise.race([reader.read(), sleep(deadline - Date.now()).then(() => null)]);
      if (!r || r.done) break;
      buf += dec.decode(r.value, { stream: true });
      let end;
      while ((end = buf.indexOf('\n\n')) !== -1) {
        const raw = buf.slice(0, end);
        buf = buf.slice(end + 2);
        const event = (/^event: (.*)$/m.exec(raw) || [])[1];
        const data = (/^data: (.*)$/m.exec(raw) || [])[1];
        if (event && event !== 'ping') frames.push({ event, raw, data: data ? JSON.parse(data) : null });
      }
    }
  } finally { ctrl.abort(); }
  return frames;
}

test('a change is announced as board-changed {rev, boot} — a few dozen bytes, never the board', async () => {
  const s = await startServerWithLieutenant();
  try {
    await s.api('POST', '/api/cards', withOwner({ title: 'Noisy' }));
    // make the board big enough that a full push would be unmistakable
    for (let i = 0; i < 40; i++) await s.api('POST', '/api/cards/noisy/events', { text: 'x'.repeat(500) + i });
    const held = (await s.api('GET', '/api/board')).body;
    assert.strictEqual(typeof held.rev, 'number');

    const frames = await collect(s.base,
      () => s.api('POST', '/api/cards/noisy/events', { text: 'one more' }),
      (f) => f.some((x) => x.event === 'board-changed'));
    assert.ok(!frames.some((f) => f.event === 'board'), 'no full board on the stream');
    const n = frames.find((f) => f.event === 'board-changed');
    assert.ok(n, 'the change was announced');
    assert.deepStrictEqual(Object.keys(n.data).sort(), ['boot', 'rev']);
    assert.strictEqual(n.data.boot, held.boot);
    assert.ok(n.data.rev > held.rev, 'a newer rev than the board already held');
    assert.ok(n.raw.length < 120, 'tiny: ' + n.raw.length + ' bytes');

    // the board fetched after the notice reflects it
    const after = (await s.api('GET', '/api/board')).body;
    assert.ok(after.rev >= n.data.rev);
    assert.strictEqual(after.cards.find((c) => c.id === 'noisy').events.at(-1).text, 'one more');
  } finally {
    await s.stop();
  }
});

test('revs climb with every change', async () => {
  const s = await startServerWithLieutenant();
  try {
    await s.api('POST', '/api/cards', withOwner({ title: 'Steps' }));
    const frames = await collect(s.base, async () => {
      for (let i = 0; i < 3; i++) await s.api('POST', '/api/cards/steps/events', { text: 'step ' + i });
    }, (f) => f.filter((x) => x.event === 'board-changed').length >= 3);
    const revs = frames.filter((f) => f.event === 'board-changed').map((f) => f.data.rev);
    assert.strictEqual(revs.length, 3);
    assert.ok(revs[1] > revs[0] && revs[2] > revs[1], revs.join(','));
  } finally {
    await s.stop();
  }
});

// ---------- the client half: boardsync ----------

// A fake server: fetchBoard answers the CURRENT rev after `latency` ms.
function fakeTab({ latency = 20, gapMs = 60 } = {}) {
  const st = { serverRev: 0, boot: 'b1', doc: null, fetches: 0, fail: false };
  return syncMod.then(({ boardSync }) => {
    st.sync = boardSync({
      gapMs,
      fetchBoard: () => {
        st.fetches++;
        const rev = st.serverRev, boot = st.boot, fail = st.fail;
        return sleep(latency).then(() => { if (fail) throw new Error('down'); return { rev, boot }; });
      },
      apply: (doc) => { st.doc = doc; },
      held: () => st.doc,
    });
    st.change = () => { st.serverRev++; st.sync.notify({ rev: st.serverRev, boot: st.boot }); };
    return st;
  });
}

test('boardsync: a notice for the rev already held costs nothing', async () => {
  const t = await fakeTab();
  t.serverRev = 4;
  t.sync.now();
  await sleep(50);
  assert.strictEqual(t.fetches, 1);
  assert.strictEqual(t.doc.rev, 4);
  t.sync.notify({ rev: 4, boot: 'b1' });
  t.sync.notify({ rev: 3, boot: 'b1' });
  await sleep(150);
  assert.strictEqual(t.fetches, 1, 'held rev and older: no fetch');
});

test('boardsync: a burst of notices is one fetch now and one after, ending on the newest rev', async () => {
  const t = await fakeTab({ latency: 20, gapMs: 60 });
  t.sync.now();
  await sleep(100);
  const base = t.fetches;
  for (let i = 0; i < 20; i++) { t.change(); await sleep(2); } // ~40 ms of churn
  await sleep(250);
  assert.ok(t.fetches - base <= 2, 'coalesced: ' + (t.fetches - base) + ' fetches for 20 notices');
  assert.strictEqual(t.doc.rev, t.serverRev, 'the tab ends holding the newest board');
});

test('boardsync: the first notice after a quiet spell fetches at once', async () => {
  const t = await fakeTab({ latency: 5, gapMs: 300 });
  t.sync.now();
  await sleep(350);
  const started = Date.now();
  t.change();
  while (!t.doc || t.doc.rev !== t.serverRev) await sleep(2);
  assert.ok(Date.now() - started < 100, 'no debounce wait on a lone change: ' + (Date.now() - started) + ' ms');
});

test('boardsync: a notice from a restarted server fetches whatever its rev says', async () => {
  const t = await fakeTab();
  t.serverRev = 9;
  t.sync.now();
  await sleep(50);
  t.boot = 'b2';
  t.serverRev = 1; // a new instance counts from the start again
  t.sync.notify({ rev: 1, boot: 'b2' });
  await sleep(150);
  assert.deepStrictEqual(t.doc, { rev: 1, boot: 'b2' });
});

test('boardsync: a failed fetch is not retried in a loop; the next notice asks again', async () => {
  const t = await fakeTab({ gapMs: 20 });
  t.fail = true;
  t.change();
  await sleep(200);
  assert.strictEqual(t.fetches, 1, 'one try while the server is down');
  t.fail = false;
  t.change();
  await sleep(100);
  assert.strictEqual(t.doc.rev, t.serverRev);
});
