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

let play, needsResume;

// The page's listeners, kept by type so a test can fire a gesture by hand.
const listeners = { window: {}, document: {} };
const add = (bag) => (ev, fn) => (bag[ev] = bag[ev] || []).push(fn);
// A real removeEventListener, because "is the gesture path still armed" is
// exactly what these tests ask — a no-op stub would pass against the bug.
const remove = (bag) => (ev, fn) => { bag[ev] = (bag[ev] || []).filter((f) => f !== fn); };
const fire = (bag, ev) => (listeners[bag][ev] || []).slice().forEach((f) => f());

// An AudioContext that can refuse to resume, the way iOS does without a gesture.
let theCtx = null;
let resumes = 0;
class FakeCtx {
  constructor() {
    this.state = 'running'; this.currentTime = 0; this.destination = {};
    this.refuse = false; this.onstatechange = null; theCtx = this;
  }
  resume() {
    resumes++;
    if (this.refuse) return Promise.reject(new Error('not allowed without a gesture'));
    this.state = 'running';
    return Promise.resolve();
  }
  createGain() {
    return { gain: { value: 0, setValueAtTime() {}, linearRampToValueAtTime() {}, exponentialRampToValueAtTime() {} }, connect() {} };
  }
  createDynamicsCompressor() {
    const p = () => ({ value: 0 });
    return { threshold: p(), knee: p(), ratio: p(), attack: p(), release: p(), connect() {} };
  }
  createOscillator() {
    const o = { frequency: { setValueAtTime() {}, exponentialRampToValueAtTime() {} }, connect() {}, start() { played++; }, stop() {} };
    return o;
  }
}
let played = 0;
const tick = () => new Promise((r) => setTimeout(r, 0));

test.before(async () => {
  global.window = { AudioContext: FakeCtx, addEventListener: add(listeners.window), removeEventListener: remove(listeners.window) };
  global.document = { hidden: false, addEventListener: add(listeners.document) };
  ({ play, needsResume } = await import(pathToFileURL(path.join(__dirname, '..', 'ui', 'js', 'sound.js')).href));
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
