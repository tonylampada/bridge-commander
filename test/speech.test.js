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

let speak, stop, pause, resume, hold, holding;

const tick = (ms) => new Promise((r) => setTimeout(r, ms));

// ── the page ──────────────────────────────────────────────────────────────
// The hidden <audio> the sound leaves through. `refuse` is a browser that will
// not autoplay: the module drops to the speakers rather than to silence.
// `fed` counts how many times it was handed a stream, because "was it armed for
// THIS message" is a different question from "does it hold a stream".
const sinkEl = {
  tag: 'audio', plays: 0, fed: 0, paused: true, refuse: false, _src: null,
  get srcObject() { return this._src; },
  set srcObject(v) { this._src = v; if (v) this.fed++; },
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
  // Only what a new test needs fresh. The element itself is the module's, made
  // once for the life of the page — but it is re-fed the stream every session,
  // so the counters reset and `_src` does not: what it holds between messages is
  // the module's business, and one of the tests below is exactly about that.
  Object.assign(sinkEl, { plays: 0, fed: 0, paused: true, refuse: false });
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
const oscs = [];                                   // every keep-alive source ever started
const humming = () => oscs.filter((o) => o.started && !o.stopped);
let theCtx = null, built = 0;
class FakeCtx {
  constructor() { this.state = 'running'; this.clock = 0; nodes.destination = this.destination = {}; theCtx = this; built++; }
  // Settable, because "the clock never moved" and "the clock moved and then
  // stopped" have to be two different fakes: only the second is the corpse an
  // interruption leaves, and a detector that cannot tell them apart is not one.
  // It stays put during a message so the seam assertions stay about the seams.
  get currentTime() { return this.clock; }
  resume() { this.state = 'running'; return Promise.resolve(); }
  close() { this.state = 'closed'; return Promise.resolve(); }
  suspend() { this.state = 'suspended'; return Promise.resolve(); }
  createMediaStreamDestination() { return (nodes.msd = { stream: { id: 'live' } }); }
  // The keep-alive's two nodes. They record enough to answer the only questions
  // asked of them: is something actually RUNNING (a stopped source holds no
  // session), at what level (a muted one holds none either), and into what.
  createOscillator() {
    const o = { frequency: { value: 0 }, connect(n) { o.to = n; }, disconnect() { o.to = null; },
      start() { o.started = true; oscs.push(o); }, stop() { o.stopped = true; } };
    return o;
  }
  createGain() {
    const g = { gain: { value: 1 }, connect(n) { g.to = n; }, disconnect() { g.to = null; } };
    return g;
  }
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
  ({ speak, stop, pause, resume, hold, holding } =
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

// ── the SECOND message ────────────────────────────────────────────────────
// The bug these two are here for: the board spoke once per page load and then
// went quiet, with nothing to show for it — no toast, no console error, the
// element still holding its stream, still in the document, at readyState 4. An
// element WebKit has stopped does not play the stream it is already holding, and
// says so nowhere: play() resolves, the context renders the whole message into a
// sink nobody is listening to, and speak() reports a clean success over silence.
// So neither test may settle for "it spoke" — each asserts the element was
// ARMED AGAIN for the second message, which is the part that was missing.
test('a second message re-arms the element — a stream the element already holds is not enough', async () => {
  fakeFetch(() => pcmResponse([0, 100, -100, 0], 4, 24000));
  // The stream being read is over before the SOUND is: the last buffer still has
  // to be heard, and that is what closes the sink. Every await below is for that
  // beat, not for the fetch.
  const said = async (input, title) => { await speak({ ...ASK, input, title }); await tick(10); };

  await said('first', 'Ana');
  assert.equal(sinkEl.srcObject, null, 'the element lets the stream go when the speech is over');

  const fed = sinkEl.fed, plays = sinkEl.plays;
  await said('second', 'Bea');
  assert.ok(sinkEl.fed > fed, 'the second message feeds the element the stream again');
  assert.equal(sinkEl.srcObject, null, 'and lets it go again at the end');
  assert.ok(sinkEl.plays > plays, 'and it played — silence here is the whole bug');

  // Third, because "works twice" was never the claim: it has to keep working.
  const fed2 = sinkEl.fed;
  await said('third', 'Cida');
  assert.ok(sinkEl.fed > fed2, 'and the one after that, and the one after that');
  assert.deepEqual(session.titles, ['Ana', 'Bea', 'Cida']);
});

// The captain's own path to it: speak, press stop, ask again. stop() is the
// destructive verb, so it is the one most likely to leave the element unusable.
test('a message after stop() re-arms the element too', async () => {
  fakeFetch((b, sig) => (b.input === 'stopped mid-word'
    ? openStream(sig)
    : pcmResponse([0, 100, -100, 0], 4, 24000)));
  const cut = speak({ ...ASK, input: 'stopped mid-word', title: 'Ana' });
  await tick(10);
  assert.ok(!sinkEl.paused, 'playing before the stop');
  stop();
  assert.equal((await cut).stopped, true);
  assert.equal(sinkEl.srcObject, null, 'stop lets the element go');

  const fed = sinkEl.fed, plays = sinkEl.plays;
  await speak({ ...ASK, input: 'and again', title: 'Bea' });
  assert.ok(sinkEl.fed > fed, 're-armed after a stop, not left holding the old stream');
  assert.ok(sinkEl.plays > plays, 'and speaking again — no refresh needed');
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

// ── the interruption that kills the context ───────────────────────────────
// A Siri Shortcut takes the microphone; coming back, the AudioContext can read
// 'running' with a clock that never moves again. No resume() revives that one,
// and everything hanging off it — the sink, the stream the element holds — is
// dead with it. The next message has to build all of it again.
//
// The clock RUNS before it stops, which is the whole difficulty: this module
// only ever looked at it inside speak(), so the baseline was "the previous
// message" and a death in the gap between two messages read as "it moved, it is
// alive". The first message after a dictation was deterministically silent.
test('a message after a dictation replaces the context, sink and element with it', async () => {
  fakeFetch(() => pcmResponse([0, 100, -100, 0], 4, 24000));
  await speak({ ...ASK, input: 'first', title: 'Ana' });
  const corpse = theCtx, oldSink = nodes.msd;
  corpse.clock = 5;                // it went on running healthily for a while…
  await tick(1300);                // …and the Shortcut froze it here, still 'running'
  built = 0;
  scheduled.length = 0;
  Object.assign(sinkEl, { plays: 0, fed: 0 });
  await speak({ ...ASK, input: 'second', title: 'Ana' });

  assert.equal(built, 1, 'one replacement — not a fresh context per message');
  assert.notEqual(theCtx, corpse, 'the dead one is gone');
  assert.equal(corpse.state, 'closed', 'and was let go of');
  assert.notEqual(nodes.msd, oldSink, 'the sink belonged to the corpse; a new one took over');
  assert.equal(sinkEl.srcObject, nodes.msd.stream, 'the element was handed the new stream');
  assert.ok(sinkEl.plays >= 1, 'and played again — the interruption paused it too');
  assert.ok(scheduled.length, 'the second message was heard');
  for (const s of scheduled) assert.equal(s.to, nodes.msd, 'through the new sink');
});

// ── holding the session open ──────────────────────────────────────────────
// The Shortcut takes the audio session from a locked phone and hands back a
// context that never makes another sample; iOS wants a gesture to repair it and
// a locked screen has none. The session that survived was the one already
// PLAYING when the Shortcut arrived, so hold() keeps this element playing — the
// same element, never a second one competing with it, because that element is
// the only reason the page is alive with the screen off at all.
test('holding plays: the same element, a live stream, and a source actually running', async () => {
  await tick(10);                      // let the previous test's last buffer finish
  oscs.length = 0;
  hold(true);
  assert.equal(holding(), true);
  assert.equal(sinkEl.srcObject, nodes.msd.stream, 'the element speech leaves through, fed the same way');
  assert.ok(!sinkEl.paused, 'genuinely playing — a paused element is not playback to the OS');
  const on = humming();
  assert.equal(on.length, 1, 'exactly one source is holding the session');
  assert.equal(on[0].to.to, nodes.msd, 'and it reaches the element’s stream, not the bare speakers');
  assert.ok(on[0].to.gain.value > 0, 'at a level above zero — a muted source buys nothing');
  assert.ok(on[0].to.gain.value < 0.01, 'and far below anything audible');
  hold(false);
});

// The one property that is not negotiable: speech sounds exactly as it does
// today. Nothing races it for the element, nothing is mixed under it, and the
// element is never paused between the tone and the first word.
test('speech takes the element back, and the keep-alive is silent for the whole message', async () => {
  await tick(10);
  oscs.length = 0;
  hold(true);
  const humBefore = humming()[0];
  fakeFetch((b, sig) => openStream(sig));
  const done = speak({ ...ASK, input: 'olá', title: 'Ana' });
  await tick(10);
  assert.ok(humBefore.stopped, 'the tone stopped before the first buffer was queued');
  assert.equal(humming().length, 0, 'nothing of the keep-alive is left running under the speech');
  assert.ok(!sinkEl.paused, 'and the element never paused in between — no gap, no clipped first word');
  for (const s of scheduled) assert.equal(s.to, nodes.msd, 'every buffer still goes through the element');

  stop();
  await done;
  assert.equal(bar.hidden, true, 'the transport goes away when the speech is over…');
  assert.ok(!sinkEl.paused, '…but the element keeps playing: the session is still his');
  assert.equal(humming().length, 1, 'and the tone is back holding it');
  hold(false);
});

// Turning it off has to leave NOTHING behind: not a source still running, not an
// element still playing, not a stream still held.
test('turning it off leaves no residue', async () => {
  await tick(10);
  oscs.length = 0;
  hold(true);
  const on = humming()[0];
  hold(false);
  assert.equal(holding(), false);
  assert.ok(on.stopped, 'the source was stopped');
  assert.equal(on.to, null, 'and disconnected — not left hanging off the graph');
  assert.equal(humming().length, 0);
  assert.ok(sinkEl.paused, 'the element is not playing on its own account any more');
  assert.equal(sinkEl.srcObject, null, 'and holds no stream');

  // And the page is the page it always was: the next message re-arms the
  // element and lets it go at the end, exactly as it does with the switch off.
  fakeFetch(() => pcmResponse([0, 100, -100, 0], 4, 24000));
  const fed = sinkEl.fed;
  await speak({ ...ASK, input: 'olá', title: 'Ana' });
  await tick(10);
  assert.ok(sinkEl.fed > fed, 're-armed for the message');
  assert.equal(sinkEl.srcObject, null, 'and let go of at the end, the way it always was');
  assert.ok(sinkEl.paused);
  assert.equal(humming().length, 0, 'nothing started itself back up');
});

// The switch comes back on at page load with no gesture behind it, and iOS
// wants one. A refused start must leave nothing standing — a tone into an
// element that is not playing holds nothing open, and a keep-alive that
// believes it is running is one no later gesture would ever retry.
test('a refused start lets go, so the next gesture can take it', async () => {
  await tick(10);
  oscs.length = 0;
  sinkEl.refuse = true;                  // the page just loaded; nothing has been tapped
  hold(true);
  await tick(10);
  assert.equal(humming().length, 0, 'it did not go on believing it holds the session');
  assert.equal(holding(), true, 'but the switch is still on — it is armed, not off');

  sinkEl.refuse = false;                 // the captain taps the board
  hold(true);                            // (keepalivesettings.js re-calls it on any gesture)
  assert.equal(humming().length, 1, 'and this time it took');
  assert.ok(!sinkEl.paused);
  hold(false);
});

// What holds the session is the caller's to choose — "the session must never go
// quiet" is this module's business, "what quiet sounds like" is the board's. The
// board hands over an ambient pad when the captain wants one (ui/js/pad.js).
test('the caller can say what holds the session, and swapping it never leaves a gap', async () => {
  await tick(10);
  oscs.length = 0;
  const made = [];
  const src = (name) => (ctx, dest) => {
    const it = { name, dest, stopped: false, stop() { it.stopped = true; } };
    made.push(it);
    return it;
  };
  const music = src('music'), other = src('other');

  hold(true, music);
  assert.equal(made.length, 1, 'the source was asked for exactly one thing to play');
  assert.equal(made[0].dest, nodes.msd, 'and it plays into the element’s stream, like everything else here');
  assert.equal(oscs.length, 0, 'the module’s own tone stayed out of the way');
  assert.ok(!sinkEl.paused, 'the element is playing, which is the point of all of it');

  hold(true, music);                   // the gesture primer, over and over
  assert.equal(made.length, 1, 'the same source handed over again changes nothing');
  assert.equal(made[0].stopped, false);

  hold(true, other);                   // the captain picks another
  assert.equal(made.length, 2, 'a different one takes over');
  assert.ok(made[0].stopped, 'and the one before it was stopped');
  assert.ok(!sinkEl.paused, 'without the element ever going quiet in between');

  hold(false);
  assert.ok(made[1].stopped, 'off stops it');
  assert.ok(sinkEl.paused, 'and lets the element go, exactly as the tone does');

  // …and with no source at all it is the module's own tone again.
  hold(true);
  assert.equal(made.length, 2, 'nobody else was asked');
  assert.equal(humming().length, 1, 'the inaudible tone is back — this is what ?hum=loud makes audible');
  hold(false);
});

// A page that never turns it on is the page that is on main today: every other
// test in this file runs with the switch off, and this one says so out loud.
test('a page that never asks for it never plays anything of its own', async () => {
  await tick(10);
  oscs.length = 0;
  assert.equal(holding(), false, 'off by default — a desktop tab pays nothing');
  fakeFetch(() => pcmResponse([0, 100, -100, 0], 4, 24000));
  await speak({ ...ASK, input: 'olá', title: 'Ana' });
  await tick(10);
  assert.equal(oscs.length, 0, 'no keep-alive source was ever made');
  assert.ok(sinkEl.paused, 'and the element is paused between messages, as it always has been');
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
