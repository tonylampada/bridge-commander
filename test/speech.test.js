'use strict';
// ui/js/speech.js — the whole speech path, copied in from chatterbox_server.
// These tests used to cover ui/js/tts/remote.js, the board's own worse copy of
// it; the module answers the same questions, minus the one that is gone: there
// is no fallback under it. When the engine refuses, speak() throws and the board
// is silent — voice.js is what makes that silence visible.
//
// The module keeps ONE AudioContext, ONE <audio> and ONE transport for the life
// of the page (iOS blesses an element once, inside a tap), so the fakes below are
// one set for the whole file, reset between tests rather than rebuilt.
const test = require('node:test');
const assert = require('node:assert');
const path = require('node:path');
const { pathToFileURL } = require('node:url');

let speak, stop, pause, resume;

const tick = (ms) => new Promise((r) => setTimeout(r, ms));

// ── the page ──────────────────────────────────────────────────────────────
// The hidden <audio> the sound leaves through. `refuse` is a browser that will
// not autoplay: the module drops to the speakers rather than to silence.
const sinkEl = {
  tag: 'audio', plays: 0, paused: true, refuse: false, _src: null,
  get srcObject() { return this._src; },
  set srcObject(v) { this._src = v; },
  play() { this.plays++; this.paused = false; return this.refuse ? Promise.reject(new Error('autoplay blocked')) : Promise.resolve(); },
  pause() { this.paused = true; },
};
// The visible transport the module builds for itself. WebKit hands the lock
// screen to a player it can SEE, which is why it lives in the module at all.
const bar = {
  tag: 'div', hidden: true, className: '', innerHTML: '',
  buttons: [{}, {}, {}], what: { textContent: '' },
  querySelectorAll() { return this.buttons; },
  querySelector() { return this.what; },
};
const styles = [];
let session;
function fakePage() {
  // Only what a new test needs fresh: the element itself is the module's, made
  // once and fed once, and resetting its stream would be resetting the module.
  Object.assign(sinkEl, { plays: 0, paused: true, refuse: false });
  bar.hidden = true;
  bar.what.textContent = '';
  global.document = {
    createElement(tag) {
      if (tag === 'audio') return sinkEl;
      if (tag === 'div') return bar;
      return { tag, textContent: '' };
    },
    head: { appendChild: (n) => (styles.push(n), n) },
    body: { appendChild: (n) => n },
  };
  session = {
    playbackState: 'none', handlers: {}, titles: [], _m: null,
    get metadata() { return this._m; },
    set metadata(m) { this._m = m; if (m) this.titles.push(m.title); },
    setActionHandler(a, f) { this.handlers[a] = f; },
  };
  Object.defineProperty(global, 'navigator', { value: { mediaSession: session }, configurable: true });
  return session;
}

// ── the speakers ──────────────────────────────────────────────────────────
// A recording AudioContext: every scheduled buffer, with the time it starts and
// the node it was connected to. The module makes one and keeps it, so
// `scheduled` is emptied between tests rather than the context being rebuilt.
const scheduled = [];
const nodes = {};
let theCtx = null;
class FakeCtx {
  constructor() { this.state = 'running'; nodes.destination = this.destination = {}; theCtx = this; }
  get currentTime() { return 0; }
  resume() { this.state = 'running'; return Promise.resolve(); }
  suspend() { this.state = 'suspended'; return Promise.resolve(); }
  createMediaStreamDestination() { return (nodes.msd = { stream: { id: 'live' } }); }
  createBuffer(ch, len, rate) {
    const data = new Float32Array(len);
    return { length: len, duration: len / rate, getChannelData: () => data };
  }
  createBufferSource() {
    let ended = false, cb = null;
    return {
      connect(n) { this.to = n; },
      start(at) { scheduled.push({ at, buffer: this.buffer, to: this.to }); setTimeout(() => { ended = true; if (cb) cb(); }, 1); },
      set onended(f) { cb = f; if (ended && f) f(); },
      get onended() { return cb; },
    };
  }
}

// PCM body: signed 16-bit LE, handed over in `chunkBytes` pieces (a chunk may end
// mid-sample, which is exactly what the engine does).
function pcmResponse(samples, chunkBytes, rate) {
  const buf = Buffer.alloc(samples.length * 2);
  samples.forEach((v, i) => buf.writeInt16LE(v, i * 2));
  const stream = new ReadableStream({
    start(c) {
      for (let i = 0; i < buf.length; i += chunkBytes) c.enqueue(new Uint8Array(buf.subarray(i, i + chunkBytes)));
      c.close();
    },
  });
  return new Response(stream, { status: 200, headers: { 'x-sample-rate': String(rate) } });
}
// A stream that never closes on its own — a synthesis still running. It takes
// the request's signal because a real fetch tears the BODY down when the request
// is aborted, and "the reader stops too" is half of what stop() is being tested for.
function openStream(signal, onController) {
  return new Response(new ReadableStream({
    start(c) {
      c.enqueue(new Uint8Array([0, 1, 0, 1]));
      if (onController) onController(c);
      signal.addEventListener('abort', () => {
        try { c.error(new DOMException('aborted', 'AbortError')); } catch (e) {}
      });
    },
  }), { status: 200, headers: { 'x-sample-rate': '24000' } });
}

// Records every speech request (url, body, signal); `answer` decides what each
// one gets. The requests go to the ENGINE — nothing here is a board route.
function fakeFetch(answer) {
  const posts = [];
  global.fetch = (url, opts) => {
    const body = JSON.parse(opts.body);
    posts.push(Object.assign({ url, signal: opts.signal }, body));
    // A real fetch rejects when its signal fires, however far along it is.
    return Promise.race([
      answer(body, opts.signal, posts.length),
      new Promise((_, rej) => opts.signal.addEventListener('abort',
        () => rej(new DOMException('aborted', 'AbortError')))),
    ]);
  };
  return posts;
}
const bodies = (posts) => posts.map(({ url, signal, ...b }) => b);

// The engine and the voice are arguments with no defaults, so every call carries
// both. `input` is what changes.
const ASK = { url: 'http://127.0.0.1:8883/v1/audio/speech', voice: 'ana' };

test.before(async () => {
  // `MediaMetadata` is guarded on window and then called bare, the way a browser
  // sees it — it is the same global in both places.
  global.MediaMetadata = function (m) { Object.assign(this, m); };
  global.window = { AudioContext: FakeCtx, MediaMetadata: global.MediaMetadata };
  fakePage();
  ({ speak, stop, pause, resume } =
    await import(pathToFileURL(path.join(__dirname, '..', 'ui', 'js', 'speech.js')).href));
});
test.beforeEach(() => { scheduled.length = 0; fakePage(); });

test('a streaming engine: chunks play back to back, and speak() resolves at the end', async () => {
  const posts = fakeFetch(() => pcmResponse([0, 16384, -16384, 32767, -32768, 0, 100, -100], 5, 24000));
  const out = await speak({ ...ASK, input: 'olá, capitão' });
  assert.deepEqual(bodies(posts), [{ input: 'olá, capitão', voice: 'ana', stream: true }], 'one request, streaming');
  assert.equal(posts[0].url, 'http://127.0.0.1:8883/v1/audio/speech', 'straight to the engine');
  const total = scheduled.reduce((n, s) => n + s.buffer.length, 0);
  assert.equal(total, 8, 'every sample played, including the one split across a chunk boundary');
  // Back to back: each buffer starts exactly where the previous one ended.
  let at = scheduled[0].at;
  for (const s of scheduled) {
    assert.ok(Math.abs(s.at - at) < 1e-9, 'gap or overlap at a chunk seam');
    at += s.buffer.length / 24000;
  }
  assert.equal(out.bytes, 16);
  assert.equal(out.rate, 24000);
  assert.equal(out.stopped, false);
  assert.ok(out.blob, 'the same audio comes back as a replayable WAV');
});

// Both are required, on purpose. An empty voice means "whatever the engine feels
// like", which is how a board ends up speaking English in a Portuguese room.
test('no voice and no url are refusals, not defaults', async () => {
  const posts = fakeFetch(() => pcmResponse([0, 100], 4, 24000));
  await assert.rejects(() => speak({ url: ASK.url, input: 'olá' }), /needs a voice/);
  await assert.rejects(() => speak({ voice: 'ana', input: 'olá' }), /needs the engine url/);
  assert.equal(posts.length, 0, 'and nothing was asked of the engine');
});

// This is the one the old layer got wrong: the refusal was swallowed and an
// English browser voice spoke instead, without saying so.
test('an engine that refuses throws to the caller — there is no second way to speak', async () => {
  fakeFetch(() => new Response(JSON.stringify({ detail: 'no such voice' }), { status: 400 }));
  await assert.rejects(() => speak({ ...ASK, input: 'olá' }), (e) => {
    assert.equal(e.message, 'no such voice', 'the engine\'s own words reach the caller');
    assert.equal(e.status, 400);
    return true;
  });
  assert.equal(bar.hidden, true, 'and no transport is left up over a message that never played');
});

test('a network that is not there throws too', async () => {
  fakeFetch(() => Promise.reject(new Error('connection refused')));
  await assert.rejects(() => speak({ ...ASK, input: 'olá' }), /connection refused/);
  assert.equal(bar.hidden, true);
});

// ── the screen going off ──────────────────────────────────────────────────
// Straight out of the AudioContext the sound dies the moment the phone locks:
// the OS suspends the page and the context with it. Through a media element that
// is playing it is real playback to the OS and keeps going. And WebKit only
// hands over the lock screen while it can SEE a player.
test('the sound leaves through a media element, behind a transport the captain can see', async () => {
  fakeFetch((b, sig) => openStream(sig));
  const done = speak({ ...ASK, input: 'olá', title: 'Ana', artist: 'Bridge Commander' });
  await tick(10);
  assert.equal(sinkEl.srcObject, nodes.msd.stream, 'the element is fed the context’s own stream');
  assert.ok(sinkEl.plays >= 1, 'and is actually playing — a paused element is not playback to the OS');
  for (const s of scheduled) assert.equal(s.to, nodes.msd, 'no buffer goes straight to the speakers');
  assert.deepEqual(session.titles, ['Ana'], 'the lock screen names the author, not the message');
  assert.equal(bar.hidden, false, 'the transport is up while the board speaks');
  assert.equal(bar.what.textContent, 'Ana');

  stop();
  await done;
  assert.equal(bar.hidden, true, 'and gone when it stops');
  assert.ok(sinkEl.paused);
  assert.equal(session.playbackState, 'none');
});

// An abandoned synthesis keeps the GPU busy for another half-minute, and voxcpm2
// dies outright when that overlaps the next request — which is the exact shape of
// the stop button and of a superseding message. The abort has to reach the
// ENGINE, not just this page's speakers.
test('stop() mid-message aborts the ENGINE request, and settles speak() rather than rejecting it', async () => {
  let held;
  const posts = fakeFetch((b, sig) => openStream(sig, (c) => { held = c; }));
  const done = speak({ ...ASK, input: 'olá', title: 'Ana' });
  await tick(10);
  assert.equal(posts[0].signal.aborted, false, 'still synthesizing');
  stop();
  const out = await done;                     // stopped is finished, not failed
  assert.ok(held, 'the body was still open when stop() cut it');
  assert.ok(posts[0].signal.aborted, 'the abort has to reach the GPU');
  assert.equal(out.stopped, true, 'and the caller is told, with no rejection to swallow');
});

// Same reason, one beat earlier: stopped before the first byte, while the engine
// is still synthesizing and there is no body to read yet.
test('stop() before the first chunk aborts too', async () => {
  const posts = fakeFetch(() => new Promise(() => {}));   // the engine never answers
  const done = speak({ ...ASK, input: 'olá' });
  await tick(10);
  stop();
  const out = await done;
  assert.ok(posts[0].signal.aborted);
  assert.equal(out.stopped, true);
});

test('the lock screen stop is the same stop, and reaches the engine', async () => {
  const posts = fakeFetch((b, sig) => openStream(sig));
  const done = speak({ ...ASK, input: 'olá', title: 'Ana' });
  await tick(10);
  session.handlers.stop();
  await done;
  assert.ok(posts[0].signal.aborted, 'the abort has to reach the GPU');
  assert.ok(sinkEl.paused, 'and the lock screen player goes away with it');
  assert.equal(bar.hidden, true);
});

// Pause is the reversible one, and it has to stop BOTH halves, element first: a
// suspended context with the element still pulling on the stream chews the last
// fragment over and over, which is a syllable repeating mid-word.
test('pause freezes the message without touching the engine, and play brings it back', async () => {
  let feed;
  const posts = fakeFetch((b, sig) => openStream(sig, (c) => { feed = c; }));
  const done = speak({ ...ASK, input: 'olá', title: 'Ana' });
  await tick(10);
  assert.equal(session.playbackState, 'playing');

  session.handlers.pause();
  assert.ok(sinkEl.paused, 'the element stops pulling — otherwise it repeats the last fragment');
  assert.equal(theCtx.state, 'suspended', 'and the clock freezes');
  assert.equal(session.playbackState, 'paused', 'or the lock screen offers the wrong button');
  assert.equal(posts[0].signal.aborted, false, 'pause is NOT destructive: the engine keeps synthesizing');

  // Chunks arriving during the pause queue against a stopped clock: nothing lost.
  const queued = scheduled.length;
  feed.enqueue(new Uint8Array([0, 2, 0, 2]));
  await tick(10);
  assert.ok(scheduled.length > queued, 'what arrived while paused was queued, not dropped');

  const plays = sinkEl.plays;
  session.handlers.play();
  assert.equal(theCtx.state, 'running', 'the clock first');
  assert.ok(sinkEl.plays > plays, 'then the element');
  assert.equal(session.playbackState, 'playing');

  stop();
  await done;
  assert.equal(theCtx.state, 'running', 'stopped while paused leaves no frozen clock behind');
});

// The page transport presses the same three functions the lock screen does —
// pressing them on screen and pressing them on the lock screen are one act.
test('the page transport is wired to the same three verbs', async () => {
  const posts = fakeFetch((b, sig) => openStream(sig));
  const done = speak({ ...ASK, input: 'olá', title: 'Ana' });
  await tick(10);
  const [play, pause_, stop_] = bar.buttons;
  assert.equal(pause_.onclick, pause);
  assert.equal(play.onclick, resume);
  assert.equal(stop_.onclick, stop);

  pause_.onclick();
  assert.ok(sinkEl.paused);
  assert.equal(posts[0].signal.aborted, false, 'the page pause is no more destructive than the lock screen one');
  play.onclick();
  assert.equal(theCtx.state, 'running');
  stop_.onclick();
  await done;
  assert.ok(posts[0].signal.aborted, 'and the transport stop still reaches the engine');
});

// A superseding message is the same shape as the stop button, and the one that
// kills voxcpm2 in practice: the old synthesis has to die before the new one runs.
test('a new message aborts the one it supersedes', async () => {
  const posts = fakeFetch((body, sig) => (body.input === 'first'
    ? openStream(sig)
    : pcmResponse([0, 100, -100, 0], 4, 24000)));
  const first = speak({ ...ASK, input: 'first', title: 'Ana' });
  await tick(10);
  const before = scheduled.length;
  await speak({ ...ASK, input: 'second', title: 'Bea' });
  await first;
  assert.ok(posts[0].signal.aborted, 'the superseded request was cut at the engine');
  assert.equal(posts[1].signal.aborted, false);
  assert.ok(scheduled.length > before, 'and the new one actually played');
  assert.deepEqual(session.titles, ['Ana', 'Bea']);
});

// LAST, deliberately: a refusal is remembered for the life of the page, so every
// test after this one would run without the element.
test('an element that is not allowed to play falls back to the speakers, never to silence', async () => {
  sinkEl.refuse = true;
  fakeFetch(() => pcmResponse([0, 100, -100, 0, 50, -50], 4, 24000));
  await speak({ ...ASK, input: 'olá', title: 'Ana' });
  assert.ok(scheduled.length, 'it still spoke');
  for (const s of scheduled) assert.equal(s.to, nodes.destination, 'straight out to the speakers');
});
