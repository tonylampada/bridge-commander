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
let keepAliveVoice, keepAliveSound, KEEPALIVE_VOICES;
let MUSIC_TRACKS, MUSIC_DIR, LEAD, musicTrack, trackUrl, musicGain, MUSIC_PEAK;
test.before(async () => {
  ({ keepAliveState, corpseWatchRuns, enabledFromStorage,
     keepAliveVoice, keepAliveSound, KEEPALIVE_VOICES,
     MUSIC_TRACKS, MUSIC_DIR, LEAD, musicTrack, trackUrl, musicGain, MUSIC_PEAK } =
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
  assert.equal(keepAliveVoice('mozart'), 'silent', 'anything unrecognised falls back to what was tested');
  for (const t of MUSIC_TRACKS) assert.equal(keepAliveVoice(t.key), t.key, `${t.key} is choosable`);
  assert.equal(KEEPALIVE_VOICES[0].key, 'silent', 'silent first: it is the default');
  assert.deepEqual(KEEPALIVE_VOICES.map((v) => v.key), ['silent', ...MUSIC_TRACKS.map((t) => t.key)],
    'and the tracks after it, in the order they are declared');
});

// The pad was persisted as `music` while it was the only one. His phone still
// has that string in localStorage, and it does not mean silence.
test('the pad’s old setting comes back as a track, not as silence', () => {
  assert.equal(keepAliveVoice('music'), MUSIC_TRACKS[0].key,
    'he asked for music and the pad is gone: the nearest thing is a track');
  assert.notEqual(keepAliveVoice('music'), 'silent', 'never the setting he chose against');
});

test('what is coming out of the element, in one answer', () => {
  const q = (enabled, speaking, voice) => keepAliveSound({ enabled, speaking, voice });
  const one = MUSIC_TRACKS[0].key;
  assert.equal(q(false, false, one), 'none', 'off is off, whatever was chosen');
  assert.equal(q(true, true, one), 'none', 'and speech is speech: the music is OUT, not ducked');
  assert.equal(q(true, true, 'silent'), 'none');
  assert.equal(q(true, false, 'silent'), 'tone', 'holding, inaudibly — the mode that was tested');
  assert.equal(q(true, false, one), 'music', 'holding, audibly, because he asked for it');
  assert.equal(q(true, false, 'music'), 'music', 'including through the pad’s old setting');
  assert.equal(q(true, false, undefined), 'tone', 'a page that never chose gets the tone');
});

// ── the tracks ────────────────────────────────────────────────────────────
// Five files, shipped. The manifest is the contract between this module and
// music.js: a key to persist, a file to fetch, and the LOOP's length — which
// is not the file's length, because each file carries a second of its own loop
// at either end so the loop points never sit on the codec's ragged edges.
test('five tracks, each with a key, a file and a loop length', () => {
  assert.equal(MUSIC_TRACKS.length, 5, 'five: enough to choose from, few enough to carry');
  const keys = new Set();
  for (const t of MUSIC_TRACKS) {
    assert.match(t.key, /^[a-z][a-z0-9-]*$/, `${t.key} survives being a localStorage value`);
    assert.ok(!keys.has(t.key), `${t.key} appears once`);
    keys.add(t.key);
    assert.ok(t.label && t.label.length <= 12, 'a label that fits in a select on a phone');
    assert.match(t.file, /^[\w-]+\.m4a$/, `${t.file} is one of ours, not a path`);
    assert.ok(t.seconds >= 15, `${t.key} loops every ${t.seconds}s — shorter than that is a jingle`);
    assert.ok(t.seconds <= 120, 'and longer is page weight he pays for once per pass');
  }
  assert.ok(!keys.has('silent'), 'no track can shadow the default');
  assert.ok(!keys.has('music'), 'nor the pad’s old setting, which has to keep meaning "the first one"');
});

test('a voice names a track, and everything else names none', () => {
  for (const t of MUSIC_TRACKS) {
    assert.equal(musicTrack(t.key), t, `${t.key}`);
    assert.equal(trackUrl(t), MUSIC_DIR + t.file, 'served from the one directory they live in');
  }
  assert.equal(musicTrack('silent'), null, 'silent is not a track: it is speech.js’s own tone');
  assert.equal(musicTrack(null), null);
  assert.equal(musicTrack('mozart'), null);
  assert.equal(musicTrack('music'), MUSIC_TRACKS[0], 'the pad’s old setting still names one');
  assert.ok(MUSIC_DIR.startsWith('/'), 'absolute: bridge3d.html is not served from the same depth');
  assert.ok(LEAD > 0 && LEAD <= 2, 'a second of lead either side is context for the codec, not content');
});

// It is background for two hours, not a notification heard once.
test('the music follows the notification volume, and a muted board is silent', () => {
  assert.equal(musicGain(0), 0, 'muted is muted — he did not ask for music, he asked for quiet');
  assert.equal(musicGain(1), MUSIC_PEAK);
  assert.equal(musicGain(0.5), MUSIC_PEAK / 2, 'and tracks the slider in between');
  assert.equal(musicGain(2), MUSIC_PEAK, 'nothing above the top of the slider');
  assert.equal(musicGain(-1), 0);
  assert.equal(musicGain(undefined), 0, 'and no volume at all is not full volume');
  assert.ok(MUSIC_PEAK < 1, 'the tracks are levelled to -20 LUFS; this only ever brings them down');
});
