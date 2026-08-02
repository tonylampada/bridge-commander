'use strict';
// ui/js/sound.js — surviving the screen going off.
//
// iOS Safari does not suspend an AudioContext when the phone locks, it
// INTERRUPTS it: a WebKit-only state that every `state === 'suspended'` check
// reads as fine, so nothing resumes and the board is silent for the rest of the
// page's life. These tests pin the recovery decision (a pure function, no
// browser) and the two paths that have to still be armed after the lock.
const test = require('node:test');
const assert = require('node:assert');
const path = require('node:path');
const { pathToFileURL } = require('node:url');

let play, needsResume, needsRebuild, setVolume;

// The page's listeners, kept by type so a test can fire a gesture by hand.
const listeners = { window: {}, document: {} };
const add = (bag) => (ev, fn) => (bag[ev] = bag[ev] || []).push(fn);
// A real removeEventListener, because "is the gesture path still armed" is
// exactly what these tests ask — a no-op stub would pass against the bug.
const remove = (bag) => (ev, fn) => { bag[ev] = (bag[ev] || []).filter((f) => f !== fn); };
const fire = (bag, ev) => (listeners[bag][ev] || []).slice().forEach((f) => f());

// An AudioContext that can refuse to resume, the way iOS does without a gesture.
// It also records the graph hung off it, because a rebuilt context that is bare
// is silent just as surely as a corpse.
let theCtx = null;
let resumes = 0, built = 0;
class FakeCtx {
  constructor() {
    this.state = 'running'; this.destination = {};
    this.t0 = performance.now(); this.stopped = null;
    this.refuse = false; this.onstatechange = null; theCtx = this; built++;
  }
  // A real context's clock moves with the world, and a detector that cannot tell
  // "the clock never moved" from "the clock moved and then stopped" is not a
  // detector. freeze() is the corpse an interruption leaves: the clock stops
  // where it was and the state field goes on saying 'running'.
  get currentTime() { return (this.stopped === null ? performance.now() - this.t0 : this.stopped) / 1000; }
  freeze() { this.stopped = performance.now() - this.t0; }
  resume() {
    resumes++;
    if (this.refuse) return Promise.reject(new Error('not allowed without a gesture'));
    this.state = 'running';
    return Promise.resolve();
  }
  close() { this.state = 'closed'; return Promise.resolve(); }
  createGain() {
    const g = { gain: { value: 0, setValueAtTime() {}, linearRampToValueAtTime() {}, exponentialRampToValueAtTime() {} }, connect(to) { g.to = to; } };
    this.master = this.master || g;      // the first gain is master; the rest are envelopes
    return g;
  }
  createDynamicsCompressor() {
    const p = () => ({ value: 0 });
    const c = { threshold: p(), knee: p(), ratio: p(), attack: p(), release: p(), connect(to) { c.to = to; } };
    this.comp = c;
    return c;
  }
  createOscillator() {
    const o = { frequency: { setValueAtTime() {}, exponentialRampToValueAtTime() {} }, connect() {}, start() { played++; }, stop() {} };
    return o;
  }
}
let played = 0;
const tick = () => new Promise((r) => setTimeout(r, 0));
// Real time has to actually pass: the corpse test is "did the clock move while
// the world did", and there is no faking the world half of that from here.
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

test.before(async () => {
  global.window = { AudioContext: FakeCtx, addEventListener: add(listeners.window), removeEventListener: remove(listeners.window) };
  global.document = { hidden: false, addEventListener: add(listeners.document) };
  ({ play, needsResume, needsRebuild, setVolume } = await import(pathToFileURL(path.join(__dirname, '..', 'ui', 'js', 'sound.js')).href));
});
test.beforeEach(() => { resumes = 0; played = 0; if (theCtx) { theCtx.refuse = false; theCtx.state = 'running'; } });

// ── the decision ──────────────────────────────────────────────────────────
test('the recovery decision covers every state a context can be in', () => {
  assert.equal(needsResume('running'), false, 'running: nothing to do');
  assert.equal(needsResume('suspended'), true, 'suspended: Chrome backgrounding the tab');
  assert.equal(needsResume('interrupted'), true, "interrupted: iOS locking the screen — the state that made it silent");
  assert.equal(needsResume('closed'), false, 'closed: dead for good, resume() cannot bring it back');
  assert.equal(needsResume('whatever-webkit-invents-next'), true, 'anything not running is broken until proven otherwise');
});

// The state field is not enough: after an iOS audio-session interruption (the
// microphone taken by a Siri Shortcut) the context can come back reading
// 'running' and never make a sound again. resume() cannot revive that one — only
// a new context can — and the honest signal for it is the clock, not the state.
test('the corpse test asks the clock, not the state field', () => {
  assert.equal(needsRebuild('running', 0.4, 500), false, 'the clock moved: alive');
  assert.equal(needsRebuild('running', 0, 500), true, 'running and frozen: the corpse the interruption leaves');
  assert.equal(needsRebuild('running', 0, 50), false, 'too soon to tell — a healthy clock needs real time to move');
  assert.equal(needsRebuild('suspended', 0, 500), false, 'suspended is SUPPOSED to be frozen; resume() is its cure');
  assert.equal(needsRebuild('interrupted', 0, 500), false, 'same for interrupted — the corpse is the one that claims to be running');
  assert.equal(needsRebuild('closed', 0, 500), false, 'closed: already let go of');
});

// ── the gesture path ──────────────────────────────────────────────────────
test('a gesture still unlocks the context long after the first one fired', async () => {
  fire('window', 'click');              // first gesture ever: makes the context
  await tick();
  assert.ok(theCtx, 'the first gesture built the context');
  assert.equal(theCtx.state, 'running');

  theCtx.state = 'interrupted';          // the phone locks, and is unlocked
  resumes = 0;
  fire('window', 'click');               // the captain taps the board again
  await tick();
  assert.equal(resumes, 1, 'the gesture listener was still attached');
  assert.equal(theCtx.state, 'running', 'and it woke the context back up');
});

test('a refused resume leaves the gesture path armed for the next try', async () => {
  fire('window', 'click');
  await tick();
  theCtx.state = 'interrupted'; theCtx.refuse = true; resumes = 0;
  fire('window', 'click');               // iOS says no
  await tick();
  assert.equal(resumes, 1);
  assert.equal(theCtx.state, 'interrupted', 'still broken');

  theCtx.refuse = false;
  fire('window', 'click');               // and the next tap gets it back
  await tick();
  assert.equal(resumes, 2, 'not disarmed by the rejection');
  assert.equal(theCtx.state, 'running');
});

// ── the other two paths ───────────────────────────────────────────────────
test('the context recovers on its own statechange, not at the next tone', async () => {
  fire('window', 'click');
  await tick();
  theCtx.state = 'interrupted'; resumes = 0;
  theCtx.onstatechange();
  await tick();
  assert.equal(theCtx.state, 'running', 'iOS said it changed; the module asked to resume');
});

test('returning to the page resumes an interrupted context', async () => {
  fire('window', 'click');
  await tick();
  theCtx.state = 'interrupted'; resumes = 0;
  fire('document', 'visibilitychange');
  await tick();
  assert.equal(resumes, 1);
  assert.equal(theCtx.state, 'running');
});

test('a notification resumes an interrupted context and then sounds', async () => {
  fire('window', 'click');
  await tick();
  theCtx.state = 'interrupted'; played = 0;
  play('ding');
  await tick();
  assert.equal(theCtx.state, 'running', 'resumed before scheduling');
  assert.ok(played > 0, 'and the tone was actually scheduled');
});

// ── the corpse, end to end ────────────────────────────────────────────────
// These two spend real milliseconds on purpose (see sleep above) and so they
// come last: they leave gaps in the clock that earlier tests do not expect.
test('a healthy context is never replaced, however many gestures land on it', async () => {
  fire('window', 'click');
  await tick();
  const c = theCtx;
  built = 0;
  for (let i = 0; i < 3; i++) {          // several heartbeats' worth of an idle page
    await sleep(250);
    fire('window', 'click');
    await tick();
  }
  assert.equal(built, 0, 'a rebuild on every gesture is its own bug');
  assert.equal(theCtx, c, 'same context throughout');
});

test('a dead context is replaced by one with the whole graph and the volume on it', async () => {
  fire('window', 'click');
  await tick();
  setVolume(0.42);
  const corpse = theCtx;
  await sleep(300);                      // the page is used; the clock runs
  corpse.freeze();                       // the Shortcut takes the microphone
  await sleep(1200);                     // long enough for the beat to see it stop
  built = 0;
  fire('window', 'click');               // the captain taps ▶ in settings
  await tick();

  assert.equal(built, 1, 'exactly one replacement');
  assert.notEqual(theCtx, corpse, 'the tap got a new context');
  assert.equal(corpse.state, 'closed', 'and the old one was let go of');
  assert.equal(theCtx.master.gain.value, 0.42, 'the volume came across');
  assert.equal(theCtx.master.to, theCtx.comp, 'master → compressor');
  assert.equal(theCtx.comp.to, theCtx.destination, 'compressor → the speakers');
  assert.equal(theCtx.comp.threshold.value, -14, 'a rebuilt graph, not a bare context');

  played = 0;
  play('ding');
  await tick();
  assert.ok(played > 0, 'and the ▶ makes a sound');
});

// The captain's actual morning, and the one a stale baseline gets wrong: the
// context is healthy and sampled, runs on for a moment, and only THEN dies. A
// detector comparing against the last time anyone looked sees a clock that moved
// and calls it alive. One tap is four events inside a tenth of a second, so
// there is no second chance inside the tap either — the ▶ is simply silent.
test('the tap after a dictation: the context RAN, then died', async () => {
  fire('window', 'click');               // first gesture: the context is made
  await tick();
  const corpse = theCtx;

  await sleep(300);                      // the board is used normally for a while
  fire('window', 'click');
  await tick();

  corpse.freeze();                       // the Siri Shortcut takes the microphone
  await sleep(1500);                     // the dictation

  built = 0; played = 0;
  // One tap: pointerdown, touchstart, click, and then the button's own play().
  fire('window', 'pointerdown');
  fire('window', 'touchstart');
  await sleep(80);
  fire('window', 'click');
  play('ding');
  await tick();

  assert.equal(built, 1, 'the tap should have replaced the corpse');
  assert.notEqual(theCtx, corpse, 'and played into the new context');
  assert.ok(played > 0, 'so the ▶ was heard, on the FIRST tap');
});
