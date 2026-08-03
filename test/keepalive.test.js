'use strict';
// ui/js/keepalive.js — the decision behind holding the audio session open.
//
// The captain sends from a locked phone through a Siri Shortcut. The Shortcut
// takes the audio session and gives back a context that reads 'running' and
// never makes another sample; iOS only accepts a gesture as the repair, and a
// locked screen has none to give. The one session observed to survive was the
// one already PLAYING when the Shortcut arrived — so the answer is a keep-alive
// that never lets the page be idle, behind a switch, because holding a session
// open costs battery and a desktop tab has no Shortcut to survive.
//
// This file pins WHAT the switch decides. The mechanism it drives — the tone
// through the element speech leaves through — is pinned in speech.test.js, and
// the heartbeat it gates in sound.test.js. No DOM and no WebAudio here.
const test = require('node:test');
const assert = require('node:assert');
const path = require('node:path');
const { pathToFileURL } = require('node:url');

let keepAliveState, corpseWatchRuns, enabledFromStorage;
let keepAliveVoice, keepAliveSound, KEEPALIVE_VOICES, PAD_POOL, DRONE, nextNote, padStep, padGain, PAD_PEAK;
test.before(async () => {
  ({ keepAliveState, corpseWatchRuns, enabledFromStorage,
     keepAliveVoice, keepAliveSound, KEEPALIVE_VOICES, PAD_POOL, DRONE, nextNote, padStep, padGain, PAD_PEAK } =
    await import(pathToFileURL(path.join(__dirname, '..', 'ui', 'js', 'keepalive.js')).href));
});

// ── the switch is the whole of the first question ─────────────────────────
test('off is off: nothing holds the session, whatever else is going on', () => {
  for (const speaking of [false, true]) {
    for (const hidden of [false, true]) {
      assert.equal(keepAliveState({ enabled: false, speaking, hidden }), 'off',
        `enabled:false speaking:${speaking} hidden:${hidden}`);
    }
  }
  assert.equal(keepAliveState({}), 'off', 'and a page that never asked is off too');
  assert.equal(keepAliveState(), 'off', 'including one that asks nothing at all');
});

test('on and quiet: the keep-alive holds — an idle session is the one that dies', () => {
  assert.equal(keepAliveState({ enabled: true, speaking: false, hidden: false }), 'hold');
});

// The one property that must not break is that speech sounds exactly as it does
// today: no ducking, no gap at the start, no clipped first word. So the
// keep-alive is not "quieter" while the board talks, it is OUT — the element is
// the speech's alone for as long as there is speech.
test('on and speaking: the keep-alive yields, it does not mix', () => {
  assert.equal(keepAliveState({ enabled: true, speaking: true, hidden: false }), 'yield');
  assert.equal(keepAliveState({ enabled: true, speaking: true, hidden: true }), 'yield',
    'and a locked screen mid-message is still the speech’s');
});

// The trap worth a test of its own: standing down on a hidden page would stand
// down at the exact moment this exists for — screen off, phone in a pocket.
test('a hidden page changes nothing: hidden is the case this was built for', () => {
  assert.equal(keepAliveState({ enabled: true, speaking: false, hidden: true }), 'hold',
    'the screen going off is not a reason to stop holding — it is the reason to hold');
  assert.equal(
    keepAliveState({ enabled: true, speaking: false, hidden: true }),
    keepAliveState({ enabled: true, speaking: false, hidden: false }),
    'visible and hidden answer the same');
});

// ── the same switch gates the heartbeat ───────────────────────────────────
test('the corpse watch runs when the switch is on, and only then', () => {
  assert.equal(corpseWatchRuns(true), true, 'on: the corpse a Shortcut leaves is found within a beat');
  assert.equal(corpseWatchRuns(false), false, 'off means NEITHER runs — no tone, no timer');
  assert.equal(corpseWatchRuns(undefined), false, 'a page that never set it pays nothing');
});

// ── what comes back across a reload ───────────────────────────────────────
test('the toggle survives a reload, and anything unrecognised is off', () => {
  assert.equal(enabledFromStorage('1'), true);
  assert.equal(enabledFromStorage(null), false, 'never set: off, like every desktop tab');
  assert.equal(enabledFromStorage(''), false);
  assert.equal(enabledFromStorage('0'), false);
  assert.equal(enabledFromStorage('true'), false, 'off is the safe answer to anything else');
});

// ── what it holds WITH ────────────────────────────────────────────────────
// The switch stays binary; the character is a separate choice beside it. Silent
// is the default because silent is what passed on the captain's phone.
test('silent is the default, and stays the default for anything unrecognised', () => {
  assert.equal(keepAliveVoice(null), 'silent', 'never chosen');
  assert.equal(keepAliveVoice(''), 'silent');
  assert.equal(keepAliveVoice('music'), 'music', 'the one opt-in there is');
  assert.equal(keepAliveVoice('mozart'), 'silent', 'and anything else falls back to what was tested');
  assert.deepEqual(KEEPALIVE_VOICES.map((v) => v.key), ['silent', 'music'], 'silent first: it is the default');
});

test('what is coming out of the element, in one answer', () => {
  const q = (enabled, speaking, voice) => keepAliveSound({ enabled, speaking, voice });
  assert.equal(q(false, false, 'music'), 'none', 'off is off, whatever was chosen');
  assert.equal(q(true, true, 'music'), 'none', 'and speech is speech: the pad is OUT, not ducked');
  assert.equal(q(true, true, 'silent'), 'none');
  assert.equal(q(true, false, 'silent'), 'tone', 'holding, inaudibly — the mode that was tested');
  assert.equal(q(true, false, 'music'), 'music', 'holding, audibly, because he asked for it');
  assert.equal(q(true, false, undefined), 'tone', 'a page that never chose gets the tone');
});

// ── the pad ───────────────────────────────────────────────────────────────
// A pad that drifts and never arrives: five notes that cannot make a leading
// tone or a dominant between them, over a fifth with no third in it.
test('the notes are the A minor pentatonic, and the drone under them has no third', () => {
  assert.deepEqual(PAD_POOL, [220, 261.63, 293.66, 329.63, 392, 440, 523.25, 587.33, 659.25],
    'A3 C4 D4 E4 G4 A4 C5 D5 E5 — the same tempered values sound.js tunes its bells to');
  assert.equal(DRONE.length, 2, 'a bare fifth');
  assert.ok(Math.abs(DRONE[1][0] / DRONE[0][0] - 1.5) < 0.005, 'A2 and the fifth above it, and nothing else');
  assert.ok(DRONE.every(([, amp]) => amp > 0 && amp < 0.3), 'both under the notes they sit beneath');
});

test('a note drifts from the one before it: never a repeat, never a leap', () => {
  for (let i = 0; i < PAD_POOL.length; i++) {
    const prev = PAD_POOL[i];
    for (const r of [0, 0.1, 0.5, 0.9, 0.999]) {
      const next = nextNote(prev, r);
      assert.ok(PAD_POOL.includes(next), `${next} is in the pool`);
      assert.notEqual(next, prev, 'the same note twice running is a pulse, not a drift');
      assert.ok(Math.abs(PAD_POOL.indexOf(next) - i) <= 3, 'and it stays near where it was');
    }
  }
});

test('the first note can be any of them, and r is only ever asked for [0,1)', () => {
  assert.equal(nextNote(null, 0), PAD_POOL[0], 'nothing to drift from yet: the whole pool');
  assert.equal(nextNote(null, 0.999), PAD_POOL[PAD_POOL.length - 1]);
  assert.ok(PAD_POOL.includes(nextNote(null, 1)), 'a stray 1 lands on a note, not off the end');
  assert.ok(PAD_POOL.includes(nextNote(220, -1)), 'and so does a stray negative');
});

// Uneven on purpose: a fixed gap is a bar-line, and a bar-line is a pulse.
test('the spacing is slow and never the same twice', () => {
  assert.equal(padStep(0), 4.5, 'the closest two notes ever come');
  assert.equal(padStep(1), 8.5, 'and the furthest');
  assert.ok(padStep(0.5) > 6 && padStep(0.5) < 7);
  assert.ok(padStep(0) > 2 * 1.5, 'nothing here is fast enough to be counted along with');
});

// It is background for two hours, not a notification heard once.
test('the pad follows the notification volume, and a muted board is silent', () => {
  assert.equal(padGain(0), 0, 'muted is muted — he did not ask for music, he asked for quiet');
  assert.equal(padGain(1), PAD_PEAK);
  assert.equal(padGain(0.5), PAD_PEAK / 2, 'and tracks the slider in between');
  assert.equal(padGain(2), PAD_PEAK, 'nothing above the top of the slider');
  assert.equal(padGain(-1), 0);
  assert.equal(padGain(undefined), 0, 'and no volume at all is not full volume');
  assert.ok(PAD_PEAK < 0.3 / 3, 'well under a notification tone: this one has to be tolerable for hours');
});
