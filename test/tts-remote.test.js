'use strict';
// ui/js/tts/remote.js — the streaming speaker, and the only playback path there
// is: sound starts on the first chunk rather than at the end of synthesis.
// Anything that is not a stream rejects, and withFallback takes it from there.
// Browser code (ES module), loaded via dynamic import; nothing here touches DOM.
const test = require('node:test');
const assert = require('node:assert');
const path = require('node:path');
const { pathToFileURL } = require('node:url');

let remoteSpeaker;
test.before(async () => {
  ({ remoteSpeaker } =
    await import(pathToFileURL(path.join(__dirname, '..', 'ui', 'js', 'tts', 'remote.js')).href));
});

// A recording AudioContext: every scheduled buffer, with the time it starts and
// the node it was connected to. `withStream` is a browser that can route into a
// media element; without it the context is an old one that cannot, which is the
// fallback every other test in this file runs on.
function fakeAudioContext(withStream) {
  const scheduled = [];
  const nodes = {};
  const ctxs = [];
  let closed = false;
  class Ctx {
    constructor(opts) { this.sampleRate = opts && opts.sampleRate; this.state = 'running'; nodes.destination = this.destination = {}; ctxs.push(this); }
    get currentTime() { return 0; }
    resume() { this.state = 'running'; return Promise.resolve(); }
    suspend() { this.state = 'suspended'; this.suspends = (this.suspends || 0) + 1; return Promise.resolve(); }
    close() { closed = true; this.state = 'closed'; return Promise.resolve(); }
    createGain() { return (nodes.gain = { to: null, connect(n) { this.to = n; }, disconnect() { this.to = null; } }); }
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
        set onended(f) { cb = f; if (ended) f(); },
        get onended() { return cb; },
      };
    }
  }
  if (!withStream) { delete Ctx.prototype.createGain; delete Ctx.prototype.createMediaStreamDestination; }
  global.window = { AudioContext: Ctx, MediaMetadata: function (m) { Object.assign(this, m); } };
  return { scheduled, nodes, ctxs, closed: () => closed };
}

// The hidden <audio>. remote.js keeps ONE for the life of the page — iOS blesses
// an element once and only inside a tap — so this is one element for the file.
const sinkEl = {
  plays: 0, paused: true, refuse: false, fed: [], _src: null,
  get srcObject() { return this._src; },
  set srcObject(v) { this._src = v; if (v) this.fed.push(v); },
  play() { this.plays++; this.paused = false; return this.refuse ? Promise.reject(new Error('autoplay blocked')) : Promise.resolve(); },
  pause() { this.paused = true; },
};
// A page with a DOM and a lock screen. Returns the mediaSession, recording every
// title it was ever given — closeSink() clears it, so the last value is not it.
function fakeDom() {
  Object.assign(sinkEl, { plays: 0, paused: true, refuse: false, fed: [], _src: null });
  global.document = { createElement: () => sinkEl, body: { appendChild() {} } };
  const session = {
    playbackState: 'none', handlers: {}, titles: [], _m: null,
    get metadata() { return this._m; },
    set metadata(m) { this._m = m; if (m) this.titles.push(m.title); },
    setActionHandler(a, f) { this.handlers[a] = f; },
  };
  Object.defineProperty(global, 'navigator', { value: { mediaSession: session }, configurable: true });
  return session;
}

// PCM body: signed 16-bit LE, handed over in `chunks` pieces (a chunk may end
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

// Records every speech request (url, body, signal); `answer` decides what each
// one gets. The requests go to the ENGINE now — nothing here is a board route.
function fakeFetch(answer) {
  const posts = [];
  global.fetch = (url, opts) => {
    const body = JSON.parse(opts.body);
    posts.push(Object.assign({ url, signal: opts.signal }, body));
    // A real fetch rejects when its signal fires, however far along it is.
    return Promise.race([
      answer(body, posts.length),
      new Promise((_, rej) => opts.signal.addEventListener('abort',
        () => rej(new DOMException('aborted', 'AbortError')))),
    ]);
  };
  return posts;
}
// The body alone, for the request-shape assertions.
const bodies = (posts) => posts.map(({ url, signal, ...b }) => b);

test('a streaming engine: chunks play back to back, and speak() resolves at the end', async () => {
  const audio = fakeAudioContext();
  const posts = fakeFetch(() => pcmResponse([0, 16384, -16384, 32767, -32768, 0, 100, -100], 5, 24000));
  await remoteSpeaker({ url: 'http://127.0.0.1:8883' }).speak('olá, capitão', {});
  assert.deepEqual(bodies(posts), [{ input: 'olá, capitão', stream: true }], 'one request, streaming');
  assert.equal(posts[0].url, 'http://127.0.0.1:8883/v1/audio/speech', 'straight to the engine');
  const total = audio.scheduled.reduce((n, s) => n + s.buffer.length, 0);
  assert.equal(total, 8, 'every sample played, including the one split across a chunk boundary');
  // Back to back: each buffer starts exactly where the previous one ended.
  let at = audio.scheduled[0].at;
  for (const s of audio.scheduled) {
    assert.ok(Math.abs(s.at - at) < 1e-9, 'gap or overlap at a chunk seam');
    at += s.buffer.length / 24000;
  }
  assert.ok(audio.closed(), 'the context is closed when the message is done');
});

test('a voice the engine cannot use: retried once on its own default, same engine', async () => {
  const audio = fakeAudioContext();
  const posts = fakeFetch((body) => (body.voice
    ? new Response(JSON.stringify({ detail: 'unknown voice' }), { status: 400 })
    : pcmResponse([0, 100, -100, 0], 8, 24000)));
  await remoteSpeaker({ lang: 'pt' }).speak('olá', { voice: 'ana' });
  assert.deepEqual(bodies(posts), [
    { input: 'olá', stream: true, voice: 'ana' },
    { input: 'olá', stream: true, lang: 'pt' },   // the catalogue is shared: try the language
  ]);
  assert.ok(audio.scheduled.length, 'and it spoke');
});

// What the proxy used to fill in on the way past. voice implies lang for the
// engine, so they are never sent together.
test('the workspace defaults are filled in here now', async () => {
  fakeAudioContext();
  const cfg = { url: 'http://e', lang: 'pt', voice: 'cfg-voice', params: { speed: 1.2 } };
  let posts = fakeFetch(() => pcmResponse([0, 100], 4, 24000));
  await remoteSpeaker(cfg).speak('olá', {});
  assert.deepEqual(bodies(posts), [{ input: 'olá', stream: true, voice: 'cfg-voice', params: { speed: 1.2 } }]);

  posts = fakeFetch(() => pcmResponse([0, 100], 4, 24000));
  await remoteSpeaker(cfg).speak('olá', { voice: 'picked' });
  assert.deepEqual(bodies(posts), [{ input: 'olá', stream: true, voice: 'picked', params: { speed: 1.2 } }],
    'a picked voice wins over the workspace default');

  posts = fakeFetch(() => pcmResponse([0, 100], 4, 24000));
  await remoteSpeaker({ url: 'http://e', lang: 'pt' }).speak('olá', {});
  assert.deepEqual(bodies(posts), [{ input: 'olá', stream: true, lang: 'pt' }],
    'no voice anywhere: the language goes instead, never both');
});

// An engine that cannot stream is deliberately NOT handled: it rejects, and
// withFallback hands the message to the browser voice.
test('an engine that cannot stream rejects instead of growing a second playback path', async () => {
  fakeAudioContext();
  fakeFetch(() => new Response(JSON.stringify({ detail: 'this engine cannot stream' }), { status: 400 }));
  await assert.rejects(() => remoteSpeaker({}).speak('olá', {}));
});

test('a 200 without x-sample-rate is not audio we can play: reject, do not guess', async () => {
  fakeAudioContext();
  fakeFetch(() => new Response(Buffer.from('RIFFfake'), { status: 200, headers: { 'content-type': 'audio/wav' } }));
  await assert.rejects(() => remoteSpeaker({}).speak('olá', {}), /did not stream/);
});

test('a stream that dies mid-message rejects, so the fallback speaks the rest', async () => {
  fakeAudioContext();
  fakeFetch(() => new Response(new ReadableStream({
    start(c) { c.enqueue(new Uint8Array([0, 1, 0, 1])); c.error(new Error('engine crashed')); },
  }), { status: 200, headers: { 'x-sample-rate': '24000' } }));
  await assert.rejects(() => remoteSpeaker({}).speak('olá', {}), 'silence is not an outcome');
});

// The proxy used to abort the engine when the listener hung up. With the proxy
// gone the browser's own AbortController is the only thing that can: an
// abandoned synthesis keeps the GPU busy for another half-minute, and voxcpm2
// dies for good when that overlaps the next request.
test('cancel() mid-stream aborts the ENGINE request, and settles speak()', async () => {
  fakeAudioContext();
  let stall;
  const posts = fakeFetch(() => new Response(new ReadableStream({
    start(c) { c.enqueue(new Uint8Array([0, 1, 0, 1])); stall = c; },   // never closes on its own
  }), { status: 200, headers: { 'x-sample-rate': '24000' } }));
  const s = remoteSpeaker({ url: 'http://e' });
  const done = s.speak('olá', {});
  await new Promise((r) => setTimeout(r, 10));
  assert.equal(posts[0].signal.aborted, false, 'still synthesizing');
  s.cancel();
  await done;                                       // cancelled is finished, not failed
  assert.ok(stall, 'the body was still open when cancel() cut it');
  assert.ok(posts[0].signal.aborted, 'the abort has to reach the GPU, not just the speaker');
});

// Same reason, one beat earlier: cancelled before the first byte, while the
// engine is still synthesizing and there is no body to read yet.
test('cancel() before the first chunk aborts too, and does not wake the fallback', async () => {
  fakeAudioContext();
  const posts = fakeFetch(() => new Promise(() => {}));   // the engine never answers
  const s = remoteSpeaker({ url: 'http://e' });
  const done = s.speak('olá', {});
  await new Promise((r) => setTimeout(r, 10));
  s.cancel();
  await done;                                       // must NOT reject: withFallback would speak it again
  assert.ok(posts[0].signal.aborted);
});

// A superseding message is the same shape as the stop button, and the one that
// kills voxcpm2 in practice: the old synthesis has to die before the new one runs.
test('a new message aborts the one it supersedes', async () => {
  fakeAudioContext();
  const posts = fakeFetch((body) => (body.input === 'first'
    ? new Promise(() => {})
    : pcmResponse([0, 100], 4, 24000)));
  const s = remoteSpeaker({ url: 'http://e' });
  const first = s.speak('first', {});
  await new Promise((r) => setTimeout(r, 10));
  await s.speak('second', {});
  await first;
  assert.ok(posts[0].signal.aborted, 'the superseded request was cut at the engine');
  assert.equal(posts[1].signal.aborted, false);
});

// ── the screen going off ──────────────────────────────────────────────────
// Straight out of the AudioContext the sound dies the moment the phone locks:
// the OS suspends the page and the context with it. Through a media element that
// is playing it is real playback to the OS and keeps going.
test('the sound leaves through a media element, and the lock screen says who is speaking', async () => {
  const audio = fakeAudioContext(true);
  const session = fakeDom();
  fakeFetch(() => pcmResponse([0, 100, -100, 0, 50, -50], 4, 24000));
  await remoteSpeaker({ url: 'http://e' }).speak('olá', { who: 'Ana' });
  assert.ok(audio.scheduled.length, 'it spoke');
  assert.deepEqual(sinkEl.fed, [audio.nodes.msd.stream], 'the element is fed the context’s own stream');
  assert.ok(sinkEl.plays >= 1, 'and is actually playing — a paused element is not playback to the OS');
  for (const s of audio.scheduled) assert.equal(s.to, audio.nodes.gain, 'no buffer goes straight to the speakers');
  assert.equal(audio.nodes.gain.to, audio.nodes.msd, 'and the bus feeds the element');
  assert.deepEqual(session.titles, ['Ana'], 'the lock screen names the lieutenant, not the message');
  // Over means over: a dead player must not sit on the lock screen afterwards.
  assert.equal(sinkEl.srcObject, null, 'the element was released');
  assert.ok(sinkEl.paused);
  assert.equal(session.playbackState, 'none');
});

// The lock-screen stop has to be the stop BUTTON — same path, same abort. One
// that only mutes the page leaves the GPU synthesizing into the next message,
// which is the overlap that kills voxcpm2's CUDA context.
test('the lock screen stop aborts the ENGINE, not just this page’s speakers', async () => {
  fakeAudioContext(true);
  const session = fakeDom();
  const posts = fakeFetch(() => new Response(new ReadableStream({
    start(c) { c.enqueue(new Uint8Array([0, 1, 0, 1])); },      // never closes on its own
  }), { status: 200, headers: { 'x-sample-rate': '24000' } }));
  const done = remoteSpeaker({ url: 'http://e' }).speak('olá', { who: 'Ana' });
  await new Promise((r) => setTimeout(r, 10));
  assert.equal(posts[0].signal.aborted, false, 'still synthesizing');
  session.handlers.stop();
  await done;                                    // stopped is finished, not failed
  assert.ok(posts[0].signal.aborted, 'the abort has to reach the GPU');
  assert.ok(sinkEl.paused, 'and the lock screen player goes away with it');
});

// Pause used to be wired to the same cancel() as stop: it aborted the request,
// closed the context and dropped the buffers, so play never brought the message
// back. Pause suspends instead — and it has to stop BOTH halves, element first:
// a suspended context with the element still pulling on the stream chews the
// last fragment over and over, which is a syllable repeating mid-word.
test('the lock screen pause freezes the message, and play brings it back', async () => {
  const audio = fakeAudioContext(true);
  const session = fakeDom();
  let feed;
  const posts = fakeFetch(() => new Response(new ReadableStream({
    start(c) { c.enqueue(new Uint8Array([0, 1, 0, 1])); feed = c; },   // more to come
  }), { status: 200, headers: { 'x-sample-rate': '24000' } }));
  const done = remoteSpeaker({ url: 'http://e' }).speak('olá', { who: 'Ana' });
  await new Promise((r) => setTimeout(r, 10));
  const ctx = audio.ctxs[0];
  assert.equal(session.playbackState, 'playing');

  session.handlers.pause();
  assert.ok(sinkEl.paused, 'the element stops pulling — otherwise it repeats the last fragment');
  assert.equal(ctx.state, 'suspended', 'and the clock freezes');
  assert.equal(session.playbackState, 'paused', 'or the lock screen offers the wrong button');
  assert.equal(posts[0].signal.aborted, false, 'pause is NOT destructive: the engine keeps synthesizing');

  // Chunks arriving during the pause queue against a stopped clock: nothing lost.
  const queued = audio.scheduled.length;
  feed.enqueue(new Uint8Array([0, 2, 0, 2]));
  await new Promise((r) => setTimeout(r, 10));
  assert.ok(audio.scheduled.length > queued, 'what arrived while paused was queued, not dropped');

  const plays = sinkEl.plays;
  session.handlers.play();
  assert.equal(ctx.state, 'running', 'the clock first');
  assert.ok(sinkEl.plays > plays, 'then the element');
  assert.equal(session.playbackState, 'playing');

  session.handlers.stop();
  await done;
  assert.ok(posts[0].signal.aborted, 'stop stays the only destructive verb, and reaches the GPU');
});

// The board's own transport presses the SAME two verbs the lock screen does —
// they are on the speaker interface, not private to the media-session handlers.
// That is what makes a visible player possible, and a visible player is what
// keeps WebKit answering the lock screen at all.
test('the page transport pauses and resumes the same message the lock screen does', async () => {
  const audio = fakeAudioContext(true);
  const session = fakeDom();
  const posts = fakeFetch(() => new Response(new ReadableStream({
    start(c) { c.enqueue(new Uint8Array([0, 1, 0, 1])); },        // never closes on its own
  }), { status: 200, headers: { 'x-sample-rate': '24000' } }));
  const s = remoteSpeaker({ url: 'http://e' });
  const done = s.speak('olá', { who: 'Ana' });
  await new Promise((r) => setTimeout(r, 10));
  const ctx = audio.ctxs[0];

  s.pause();
  assert.ok(sinkEl.paused);
  assert.equal(ctx.state, 'suspended');
  assert.equal(posts[0].signal.aborted, false, 'the page pause is no more destructive than the lock screen one');

  const plays = sinkEl.plays;
  s.resume();
  assert.equal(ctx.state, 'running');
  assert.ok(sinkEl.plays > plays);

  s.cancel();
  await done;
  assert.ok(posts[0].signal.aborted, 'and the transport stop is still the cancel that reaches the engine');
});

// Stop while paused has to abort too — a frozen message left synthesizing on the
// GPU is exactly the abandoned synthesis that kills voxcpm2 on the next request.
test('stop while paused aborts the engine as well', async () => {
  fakeAudioContext(true);
  const session = fakeDom();
  const posts = fakeFetch(() => new Response(new ReadableStream({
    start(c) { c.enqueue(new Uint8Array([0, 1, 0, 1])); },
  }), { status: 200, headers: { 'x-sample-rate': '24000' } }));
  const done = remoteSpeaker({ url: 'http://e' }).speak('olá', { who: 'Ana' });
  await new Promise((r) => setTimeout(r, 10));
  session.handlers.pause();
  session.handlers.stop();
  await done;
  assert.ok(posts[0].signal.aborted);
  assert.equal(session.playbackState, 'none', 'and the lock screen player goes away');
});

// A paused message must not survive the one that replaces it: the captain hears
// the new message, never a resumed middle of the old one.
test('a new message while paused supersedes it and speaks', async () => {
  const audio = fakeAudioContext(true);
  const session = fakeDom();
  const posts = fakeFetch((body) => (body.input === 'first'
    ? new Response(new ReadableStream({ start(c) { c.enqueue(new Uint8Array([0, 1, 0, 1])); } }),
      { status: 200, headers: { 'x-sample-rate': '24000' } })
    : pcmResponse([0, 100, -100, 0], 4, 24000)));
  const s = remoteSpeaker({ url: 'http://e' });
  const first = s.speak('first', { who: 'Ana' });
  await new Promise((r) => setTimeout(r, 10));
  session.handlers.pause();
  const before = audio.scheduled.length;

  await s.speak('second', { who: 'Bea' });
  await first;
  assert.ok(posts[0].signal.aborted, 'the paused one was cut at the engine');
  assert.ok(audio.scheduled.length > before, 'and the new one actually played');
  assert.notEqual(audio.ctxs[1], audio.ctxs[0], 'on its own context — never resumed into the frozen one');
  assert.ok(!audio.ctxs[1].suspends, 'and that one was never frozen');
  assert.deepEqual(session.titles, ['Ana', 'Bea']);
});

// Everything is scheduled onto a bus rather than onto a node picked per chunk,
// so a refusal moves what is ALREADY playing — not just what comes after it.
test('an element that is not allowed to play falls back to the speakers, never to silence', async () => {
  const audio = fakeAudioContext(true);
  const session = fakeDom();
  sinkEl.refuse = true;
  fakeFetch(() => pcmResponse([0, 100, -100, 0, 50, -50], 4, 24000));
  await remoteSpeaker({ url: 'http://e' }).speak('olá', { who: 'Ana' });
  assert.ok(audio.scheduled.length, 'it still spoke');
  assert.equal(audio.nodes.gain.to, audio.nodes.destination, 'the whole bus moved to the speakers');
  for (const s of audio.scheduled) assert.equal(s.to, audio.nodes.gain, 'including buffers already scheduled');
  assert.deepEqual(session.titles, [], 'nothing is playing on the lock screen, so nothing is announced');
});

// The catalogue is not filtered by the workspace language: voxcpm2 clones from
// any reference clip, so an `en` voice speaking Portuguese is a choice with an
// accent, not an error. Hiding two thirds of the catalogue was the bug.
test('voices(): the whole catalogue comes back, whatever the workspace language', async () => {
  let asked = null;
  global.fetch = (u) => (asked = u) && Promise.resolve(new Response(JSON.stringify({ voices: [
    { id: 'a', name: 'Ana', langs: ['pt'] },
    { id: 'b', name: 'Bell', langs: ['en'] },
    { id: 'c', name: 'Chen', langs: ['zh'] },
    { id: 'd', name: 'Dee' },
  ] }), { status: 200 }));
  const list = await remoteSpeaker({ url: 'http://127.0.0.1:8883', lang: 'pt' }).voices();
  assert.equal(asked, 'http://127.0.0.1:8883/v1/voices', 'the engine, not the board');
  assert.deepEqual(list, [
    { id: 'a', name: 'Ana', lang: 'pt' },
    { id: 'b', name: 'Bell', lang: 'en' },
    { id: 'c', name: 'Chen', lang: 'zh' },
    { id: 'd', name: 'Dee', lang: 'pt' },     // no langs at all: labelled with the default
  ]);
});
