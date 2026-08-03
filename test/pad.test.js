'use strict';
// ui/js/pad.js — the music the keep-alive can hold the session with.
//
// The decisions it plays (the notes, the spacing, the level) are keepalive.js's
// and are pinned there. What is pinned HERE is the wiring, and one property in
// particular: the stream must never go digitally silent, because a stream that
// goes silent is a session iOS is free to take back — which is the whole reason
// any of this exists. So: a drone that never stops, notes queued far enough
// ahead to outlast the timer throttling a locked phone does, and a stop() that
// leaves nothing behind.
const test = require('node:test');
const assert = require('node:assert');
const path = require('node:path');
const { pathToFileURL } = require('node:url');

let startPad, DRONE, PAD_POOL;

// A recording AudioContext. Its clock is settable, because "what is queued an
// hour from now" is a question that has to be asked without waiting an hour.
class FakeCtx {
  constructor() { this.clock = 0; this.made = []; }
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
    const o = { kind: 'osc', type: '', frequency: { value: 0 }, to: null,
      started: null, stopAt: null, stopped: false, onended: null, disconnected: 0,
      connect(n) { o.to = n; }, disconnect() { o.disconnected++; o.to = null; },
      start(t) { o.started = t; }, stop(t) { o.stopAt = t; o.stopped = true; } };
    this.made.push(o);
    return o;
  }
}
const oscs = (ctx) => ctx.made.filter((n) => n.kind === 'osc');

test.before(async () => {
  ({ startPad } = await import(pathToFileURL(path.join(__dirname, '..', 'ui', 'js', 'pad.js')).href));
  ({ DRONE, PAD_POOL } = await import(pathToFileURL(path.join(__dirname, '..', 'ui', 'js', 'keepalive.js')).href));
});

test('everything goes through the one gain it was given, and nowhere else', () => {
  const ctx = new FakeCtx();
  const dest = { kind: 'sink' };
  const pad = startPad(ctx, dest, 0.055);
  const out = ctx.made[0];
  assert.equal(out.to, dest, 'the pad hangs off the sink it was handed — never a second one');
  assert.equal(out.gain.value, 0.055, 'at the level it was handed');
  for (const n of ctx.made.slice(1)) {
    assert.ok(n.to === out || n.to.to === out || n.to === null || n.to.kind === 'gain',
      'nothing reaches the destination except through that gain');
  }
  pad.stop();
});

// The drone is not decoration: it is what makes the stream continuously
// non-silent between one note and the next.
test('the drone starts at once, never stops, and fades in rather than clicking', () => {
  const ctx = new FakeCtx();
  const pad = startPad(ctx, {}, 0.055);
  const drone = oscs(ctx).filter((o) => DRONE.some(([hz]) => Math.abs(o.frequency.value - hz) < 0.01));
  assert.equal(drone.length, DRONE.length, 'one oscillator per drone voice');
  for (const o of drone) {
    assert.equal(o.started, 0, 'started now, not at the first note');
    assert.equal(o.stopAt, null, 'and never scheduled to stop: the stream is never quiet');
  }
  const fades = ctx.made.filter((n) => n.kind === 'gain' && n.ramps.some(([k, v]) => k === 'lin' && v > 0));
  assert.ok(fades.length >= DRONE.length, 'each comes up from nothing');
  for (const g of fades.slice(0, DRONE.length)) {
    assert.equal(g.sets[0][0], 0.0001, 'from silence…');
    assert.ok(g.ramps[0][2] > 1, '…over seconds, so switching the music on is not a click');
  }
  pad.stop();
});

// iOS starves a locked phone's JS timers, and the top-up runs on a timer. The
// audio clock is not starved, so what is already queued goes on playing: the
// queue has to be deep enough to cover a throttled minute.
test('a minute of music is queued ahead, so a throttled timer is not a gap', () => {
  const ctx = new FakeCtx();
  const pad = startPad(ctx, {}, 0.055);
  const notes = oscs(ctx).filter((o) => o.stopAt !== null);
  assert.ok(notes.length >= 12, `${notes.length} notes queued up front, not one at a time`);
  const last = Math.max(...notes.map((o) => o.started));
  assert.ok(last >= 55, `music scheduled ${last.toFixed(0)}s ahead of the clock`);
  const first = Math.min(...notes.map((o) => o.started));
  assert.ok(first > 0 && first < 3, 'and the first one is not an hour away');

  // Every note is one of the pool's, doubled by a detuned twin — and nothing is
  // ever left sounding forever except the drone.
  for (const o of notes) {
    assert.ok(o.stopAt > o.started, 'each note ends');
    const near = PAD_POOL.some((f) => Math.abs(o.frequency.value / f - 1) < 0.005);
    assert.ok(near, `${o.frequency.value.toFixed(2)} is a pool note or its twin`);
  }
  pad.stop();
});

test('notes overlap: two or three are always sounding, so there is no seam', () => {
  const ctx = new FakeCtx();
  const pad = startPad(ctx, {}, 0.055);
  const notes = oscs(ctx).filter((o) => o.stopAt !== null).sort((a, b) => a.started - b.started);
  const at = (t) => notes.filter((o) => o.started <= t && o.stopAt > t).length;
  for (let t = 15; t < 45; t += 1.5) assert.ok(at(t) >= 2, `nothing sounding at ${t}s`);
  pad.stop();
});

test('the volume slider reaches it while it is playing', () => {
  const ctx = new FakeCtx();
  const pad = startPad(ctx, {}, 0.055);
  const out = ctx.made[0];
  pad.setLevel(0.02);
  assert.equal(out.gain.value, 0.02, 'live, not at the next note — the slider is being dragged');
  pad.stop();
  pad.setLevel(0.05);
  assert.equal(out.gain.value, 0.02, 'and a stopped pad does not come back to life on a slider move');
});

// Off is off. A minute of music is queued in the context, and every second of
// it would go on sounding after the switch was thrown if stop() only stopped
// the scheduler.
test('stop() takes back everything that was queued, drone included', () => {
  const ctx = new FakeCtx();
  const pad = startPad(ctx, {}, 0.055);
  ctx.clock = 3;
  pad.stop();
  for (const o of oscs(ctx)) {
    assert.ok(o.stopped, 'every oscillator was stopped, not just the ones already sounding');
    assert.ok(o.disconnected > 0, 'and disconnected');
    assert.equal(o.onended, null, 'with nothing left to fire later');
  }
  assert.ok(ctx.made[0].disconnected > 0, 'and the pad itself is off the sink');
});
