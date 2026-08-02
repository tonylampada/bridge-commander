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
test.before(async () => {
  ({ keepAliveState, corpseWatchRuns, enabledFromStorage } =
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
