'use strict';
// ui/js/music.js — the music the keep-alive holds the session with, now that it
// is a file instead of a synthesiser.
//
// Which tracks there are and how loud they play is keepalive.js's and is pinned
// there. What is pinned HERE is the wiring, and three properties in particular:
//
//   · it starts SYNCHRONOUSLY and non-silently. humOn() calls this and calls
//     the element's play() on the very next line, inside the gesture iOS
//     insists on — so nothing may wait for a fetch, and the stream may not be
//     digitally silent while one is in flight. A silent stream is a session iOS
//     is free to take back, which is the whole reason any of this exists.
//   · it loops the INTERIOR of the file. An AAC encoder has nothing before its
//     first frame and nothing after its last, and hands back tens of
//     milliseconds of wrong samples at both ends; each file therefore carries a
//     second of its own loop either side of the loop proper.
//   · stop() leaves nothing behind — not the loop, not the tone under it, and
//     not a decode that was still in the air when the switch was thrown.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const { pathToFileURL } = require('node:url');

let startMusic, loopPoints, fetchTrack, MUSIC_TRACKS, LEAD;

const UI = path.join(__dirname, '..', 'ui');
const load = (f) => import(pathToFileURL(path.join(UI, 'js', f)).href);

// A recording AudioContext, in the shape pad.test.js used before it: enough of
// the WebAudio surface to see what was built, and a settable clock.
class FakeCtx {
  constructor() { this.clock = 0; this.made = []; this.decoded = []; }
  get currentTime() { return this.clock; }
  createGain() {
    const g = { kind: 'gain', ramps: [], sets: [], to: null, disconnected: 0,
      gain: { value: 1,
        setValueAtTime(v, t) { g.sets.push([v, t]); },
        linearRampToValueAtTime(v, t) { g.ramps.push(['lin', v, t]); },
        exponentialRampToValueAtTime(v, t) { g.ramps.push(['exp', v, t]); } },
      connect(n) { g.to = n; }, disconnect() { g.disconnected++; g.to = null; } };
    this.made.push(g);
    return g;
  }
  createOscillator() {
    const o = { kind: 'osc', frequency: { value: 0 }, to: null, started: null,
      stopAt: null, stopped: false, disconnected: 0,
      connect(n) { o.to = n; }, disconnect() { o.disconnected++; o.to = null; },
      start(t) { o.started = t === undefined ? 0 : t; },
      stop(t) { o.stopAt = t === undefined ? this.startedAt : t; o.stopped = true; } };
    this.made.push(o);
    return o;
  }
  createBufferSource() {
    const s = { kind: 'src', buffer: null, loop: false, loopStart: 0, loopEnd: 0,
      to: null, started: null, offset: null, stopped: false, disconnected: 0,
      connect(n) { s.to = n; }, disconnect() { s.disconnected++; s.to = null; },
      start(t, off) { s.started = t; s.offset = off; },
      stop() { s.stopped = true; } };
    this.made.push(s);
    return s;
  }
  decodeAudioData(bytes, ok) {
    this.decoded.push(bytes);
    const buf = { duration: this.duration ?? 77, sampleRate: 44100 };
    return Promise.resolve().then(() => { ok(buf); return buf; });
  }
}
const of = (ctx, kind) => ctx.made.filter((n) => n.kind === kind);
const flush = () => new Promise((r) => setTimeout(r, 0));

// One fetch, answered with bytes. Counted, because "fetched once per page" is
// a promise about the captain's mobile data.
let fetched;
function fakeFetch(ok = true) {
  fetched = [];
  global.fetch = (url) => {
    fetched.push(url);
    return Promise.resolve(ok
      ? { ok: true, arrayBuffer: () => Promise.resolve(new ArrayBuffer(32)) }
      : { ok: false, status: 404 });
  };
}

test.before(async () => {
  ({ startMusic, loopPoints, fetchTrack } = await load('music.js'));
  ({ MUSIC_TRACKS, LEAD } = await load('keepalive.js'));
});

test('everything goes through the sink it was given, and nowhere else', async () => {
  fakeFetch();
  const ctx = new FakeCtx();
  const dest = { kind: 'sink' };
  const m = startMusic(ctx, dest, 0.2, '/ui/audio/warm.m4a', 75);
  await flush(); await flush();
  const reach = (n) => { let hops = 0; while (n && hops++ < 5) { if (n === dest) return true; n = n.to; } return false; };
  for (const n of ctx.made) assert.ok(reach(n.to), `${n.kind} reaches the sink it was handed`);
  assert.equal(ctx.made[0].to, dest, 'the level gain hangs off the sink, never a second one');
  assert.equal(ctx.made[0].gain.value, 0.2, 'at the level it was handed');
  m.stop();
});

// The one that matters. iOS allows the element's play() only inside the tap, so
// humOn() calls it on the line after this returns — before any file could have
// arrived. Whatever holds the session in that gap has to already be sounding.
test('a tone is sounding before the fetch is even issued, and never stops', async () => {
  fakeFetch();
  const ctx = new FakeCtx();
  const dest = { kind: 'sink' };
  const m = startMusic(ctx, dest, 0.2, '/ui/audio/warm.m4a', 75);
  const [osc] = of(ctx, 'osc');
  assert.ok(osc, 'an oscillator exists before this call returned');
  assert.equal(osc.started, 0, 'and is already running');
  assert.equal(osc.stopAt, null, 'with no end scheduled: the stream is never quiet');
  assert.ok(osc.frequency.value > 0 && osc.frequency.value <= 40,
    'under the low end of a phone speaker — samples, not sound');
  assert.equal(of(ctx, 'src').length, 0, 'and no buffer is playing yet, because none has arrived');
  const level = ctx.made[0];
  assert.notEqual(osc.to, level, 'the tone does not run through the volume gain…');
  await flush(); await flush();
  assert.equal(osc.stopped, false, '…and it is still there once the loop is playing: a muted');
  m.setLevel(0);                                  // …board is a promise not to be
  assert.equal(osc.stopped, false, 'HEARD, not a promise to let the session go');
  m.stop();
});

test('the loop points are interior, so the codec’s ragged edges are never played', async () => {
  fakeFetch();
  const ctx = new FakeCtx();
  ctx.duration = 77;                              // 75s of loop, 1s either side
  const m = startMusic(ctx, {}, 0.2, '/ui/audio/void.m4a', 75);
  await flush(); await flush();
  const [src] = of(ctx, 'src');
  assert.ok(src, 'the buffer is playing once it has decoded');
  assert.equal(src.loop, true);
  assert.equal(src.loopStart, 1, 'a second in…');
  assert.equal(src.loopEnd, 76, '…and a second from the end');
  assert.equal(src.offset, src.loopStart, 'and it starts where the loop starts, not at the file’s edge');
  assert.equal(src.loopEnd - src.loopStart, 75, 'exactly one period, which is what makes it join');
  m.stop();
});

// The file is periodic over its whole length, which is the point: a decoder
// that hands back the encoder's priming as leading silence shifts WHERE the
// loop sits and cannot change whether it joins.
test('a decoder that pads the file still gets a whole period', () => {
  assert.deepEqual(loopPoints(77, 75), { start: 1, end: 76 }, 'no padding: the lead is the lead');
  const padded = loopPoints(77.05, 75);
  assert.equal(padded.end - padded.start, 75, 'padded: still exactly one period');
  assert.ok(padded.start >= 0 && padded.end <= 77.05, 'and still inside the buffer');
  const short = loopPoints(74, 75);
  assert.equal(short.start, 0, 'a file shorter than its manifest says loops whole…');
  assert.equal(short.end, 74, '…rather than looping a region that is not there');
  assert.deepEqual(loopPoints(77, 0), { start: 0, end: 77 }, 'and a track with no length declared');
  assert.ok(LEAD > 0, 'the lead is real, or none of the above means anything');
});

test('the loop arrives rather than begins', async () => {
  fakeFetch();
  const ctx = new FakeCtx();
  ctx.clock = 12;
  const m = startMusic(ctx, {}, 0.2, '/ui/audio/drift.m4a', 75);
  await flush(); await flush();
  const fade = ctx.made.find((n) => n.kind === 'gain' && n.ramps.length);
  assert.ok(fade, 'something ramps');
  assert.equal(fade.sets[fade.sets.length - 1][0], 0.0001, 'from silence…');
  assert.equal(fade.ramps[0][1], 1, '…up to itself…');
  assert.ok(fade.ramps[0][2] - 12 > 1, '…over seconds, so switching the music on is not a click');
  assert.notEqual(fade, ctx.made[0], 'and the fade is not the gain the slider writes: they would fight');
  m.stop();
});

test('the volume slider reaches it while it is playing', async () => {
  fakeFetch();
  const ctx = new FakeCtx();
  const m = startMusic(ctx, {}, 0.2, '/ui/audio/deep.m4a', 70);
  await flush(); await flush();
  const level = ctx.made[0];
  m.setLevel(0.05);
  assert.equal(level.gain.value, 0.05, 'live, not at the next pass — the slider is being dragged');
  m.stop();
  m.setLevel(0.2);
  assert.equal(level.gain.value, 0.05, 'and a stopped loop does not come back to life on a slider move');
});

test('stop() takes back everything, tone included', async () => {
  fakeFetch();
  const ctx = new FakeCtx();
  const m = startMusic(ctx, {}, 0.2, '/ui/audio/cavern.m4a', 75);
  await flush(); await flush();
  m.stop();
  for (const o of of(ctx, 'osc')) {
    assert.ok(o.stopped, 'the tone is stopped, not left holding a session nobody asked for');
    assert.ok(o.disconnected > 0, 'and disconnected');
  }
  for (const s of of(ctx, 'src')) {
    assert.ok(s.stopped, 'the loop is stopped');
    assert.ok(s.disconnected > 0);
  }
  assert.ok(ctx.made[0].disconnected > 0, 'and the whole thing is off the sink');
});

// The switch can be thrown while six hundred kilobytes are still in the air.
test('a decode that lands after stop() is not played', async () => {
  fakeFetch();
  const ctx = new FakeCtx();
  const m = startMusic(ctx, {}, 0.2, '/ui/audio/warm.m4a', 18);
  m.stop();                                       // before the fetch resolves
  await flush(); await flush(); await flush();
  assert.equal(of(ctx, 'src').length, 0, 'nothing started after the switch went off');
});

test('the bytes are fetched once a page and decoded per context', async () => {
  fakeFetch();
  const url = '/ui/audio/fetched-once.m4a';
  const a = new FakeCtx(), b = new FakeCtx();
  const m1 = startMusic(a, {}, 0.2, url, 75);
  await flush(); await flush();
  const m2 = startMusic(b, {}, 0.2, url, 75);     // a Shortcut replaced the context
  await flush(); await flush();
  assert.equal(fetched.filter((u) => u === url).length, 1,
    'his phone pays for the file once, not once per switch-on');
  assert.equal(a.decoded.length, 1);
  assert.equal(b.decoded.length, 1, 'and a fresh context decodes for itself: a buffer belongs to one');
  assert.notEqual(a.decoded[0], b.decoded[0],
    'from a COPY each time — decodeAudioData detaches what it is handed');
  m1.stop(); m2.stop();
});

// The failure mode is the switch's other setting, not a lost session.
test('a track that will not load leaves the tone holding, and says so', async () => {
  fakeFetch(false);
  const ctx = new FakeCtx();
  const m = startMusic(ctx, {}, 0.2, '/ui/audio/missing.m4a', 75);
  await assert.rejects(() => m.ready, 'the caller is told, so it can toast');
  const [osc] = of(ctx, 'osc');
  assert.ok(osc && !osc.stopped, 'and the session is still held, inaudibly');
  assert.equal(of(ctx, 'src').length, 0);
  m.stop();
  // A refusal is not cached: the next attempt is allowed to be a network that
  // came back rather than the same rejection forever.
  fakeFetch(true);
  const ctx2 = new FakeCtx();
  const m2 = startMusic(ctx2, {}, 0.2, '/ui/audio/missing.m4a', 75);
  await m2.ready;
  assert.equal(of(ctx2, 'src').length, 1, 'the retry played');
  m2.stop();
});

/* ── the files themselves ─────────────────────────────────────────────────
   The manifest is a promise about bytes on disk: this is the test that goes
   and looks. It is the only one here that shells out, and it skips rather than
   fails where there is no ffprobe, because a machine without ffmpeg is a
   machine that could not have built these files either. */
test('every track in the manifest is a file, and is as long as it says', () => {
  let probe;
  try { probe = (f) => Number(execFileSync('ffprobe',
    ['-v', 'error', '-show_entries', 'format=duration', '-of', 'csv=p=0', f], { encoding: 'utf8' }).trim()); }
  catch (e) { return; }
  let total = 0;
  for (const t of MUSIC_TRACKS) {
    const f = path.join(UI, 'audio', t.file);
    assert.ok(fs.existsSync(f), `${t.file} is shipped`);
    total += fs.statSync(f).size;
    let dur;
    try { dur = probe(f); } catch (e) { return; }   // no ffprobe here: nothing to say
    assert.ok(Math.abs(dur - (t.seconds + 2 * LEAD)) < 0.05,
      `${t.file} is ${dur}s: one ${t.seconds}s loop with ${LEAD}s of it either side`);
  }
  assert.ok(total < 4e6, `${(total / 1e6).toFixed(1)}MB of audio — five tracks are not worth ten`);
});
