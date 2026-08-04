// keepalive.js — what the audio keep-alive should be doing, and when.
//
// The captain talks to the board from a locked phone through a Siri Shortcut.
// The Shortcut takes the audio session; what it hands back is an AudioContext
// that reads 'running' and never produces another sample, and the only repair
// iOS accepts is a user gesture — which a locked screen cannot give. The one
// session that survives is the one that was PLAYING when the Shortcut arrived:
// he heard the next reply exactly once, by sending while the previous one was
// still speaking.
//
// So the cure is to never be idle. This module holds only the decision — no
// DOM, no WebAudio — the way notifypolicy.js holds the notification decision:
// speech.js owns the element the tone leaves through (hold()), sound.js owns
// the corpse watch (setCorpseWatch()), and keepalivesettings.js is the switch
// that drives both from here.
//
// It is a switch and not a heuristic on purpose. Holding a session open costs
// battery and puts a player on the lock screen for as long as it runs, and a
// desktop tab — which no Shortcut ever interrupts — has no reason to pay it.

// The three states the keep-alive can be in:
//   'off'   nothing playing, nothing beating: the page behaves as it always has
//   'hold'  the inaudible tone is playing, and the session is his to keep
//   'yield' there is real speech; the keep-alive is silent and out of its way
//
// `hidden` is an argument and changes NOTHING, deliberately: a hidden page is
// precisely the case this exists for (screen off, phone in a pocket), so
// standing down when the page goes away would stand down at the only moment
// that matters. It is named here so that stays a decision rather than an
// oversight.
export function keepAliveState({ enabled, speaking, hidden } = {}) {
  if (!enabled) return 'off';
  if (speaking) return 'yield';
  return 'hold';
}

// The same switch gates the corpse watch in sound.js — the heartbeat that asks
// every 500ms whether the notification context's clock is still moving. It was
// written for this phone and this Shortcut, and its own comment says so: on a
// page that is nearly always fine it is a timer beating for the life of the
// page, and on a phone it is battery. Off means neither this nor the tone runs.
export function corpseWatchRuns(enabled) {
  return enabled === true;
}

// Persisted the way voice.js persists its toggle: the key is present or it is
// not. Anything else that ever ends up in that slot is off — the safe answer,
// since off is what every page that never asked for this gets.
export function enabledFromStorage(raw) {
  return raw === '1';
}

/* ── what it sounds like ──────────────────────────────────────────────────
   The switch stays binary — held or not — and the CHARACTER of the holding is a
   separate choice beside it. Silent is the default and always will be: it is
   what was tested on the captain's phone, and it is what a desktop tab should
   get if it ever turns this on at all. The music is the opt-in, for the hours
   the phone spends in a pocket: "não precisa ser zumbido, a gente pode colocar
   uma musiquinha agradável".

   Five of them, and they are files rather than a synthesiser (ui/js/pad.js,
   which they replaced) because decoding once and looping is what a phone's
   audio hardware is built for, and generating notes forever is not. All five
   are CC0 — no attribution, shippable in a public repo — and where each came
   from is recorded in ui/audio/README.md, beside them.

   `seconds` is the LOOP's length, which is two seconds shorter than the file:
   each one carries a second of its own loop before it and a second after it,
   so the loop points never sit on the codec's ragged edges. music.js's
   loopPoints() is the other half of that, and dev/build-loops.sh is why. */
export const MUSIC_DIR = '/ui/audio/';
export const LEAD = 1;              // seconds of the loop either side of it
export const MUSIC_TRACKS = [
  //                                         a held chord, warm, close
  { key: 'warm',   label: 'warm',   file: 'warm.m4a',   seconds: 18 },
  //                                         a slow synth drift, wide
  { key: 'drift',  label: 'drift',  file: 'drift.m4a',  seconds: 75 },
  //                                         airy, high, almost weather
  { key: 'void',   label: 'void',   file: 'void.m4a',   seconds: 75 },
  //                                         a room with stone in it
  { key: 'cavern', label: 'cavern', file: 'cavern.m4a', seconds: 75 },
  //                                         the low one; nearly all bass
  { key: 'deep',   label: 'deep',   file: 'deep.m4a',   seconds: 70 },
];
export const KEEPALIVE_VOICES = [
  { key: 'silent', label: 'silent' },
  ...MUSIC_TRACKS.map(({ key, label }) => ({ key, label })),
];

// `music` is what the pad was persisted as while there was only one of them.
// It comes back as the first track rather than as silence: he asked for music
// and the pad is gone, so the nearest thing to what he chose is a track, not
// the thing he chose against.
export function keepAliveVoice(raw) {
  if (raw === 'music') return MUSIC_TRACKS[0].key;
  return MUSIC_TRACKS.some((t) => t.key === raw) ? raw : 'silent';
}
export function musicTrack(voice) {
  return MUSIC_TRACKS.find((t) => t.key === keepAliveVoice(voice)) || null;
}
export function trackUrl(track) { return MUSIC_DIR + track.file; }

// The whole question in one place: what should be coming out of the element
// right now. 'none' is the element not playing on the keep-alive's account at
// all — either the switch is off, or the speech has it and the keep-alive is
// out of the way, which are different reasons for the same silence.
export function keepAliveSound({ enabled, speaking, voice } = {}) {
  if (keepAliveState({ enabled, speaking }) !== 'hold') return 'none';
  return keepAliveVoice(voice) === 'silent' ? 'tone' : 'music';
}

// The music follows the notification volume, the way every tone in sound.js
// does. It sits well under them: a notification is meant to be noticed once,
// and this is meant to be tolerated for two hours. The tracks are all levelled
// to the same -20 LUFS so the choice of track is a choice of character and
// never a jump in loudness.
//
// A master volume of zero is silence here too — the captain who muted the board
// did not ask for music. It is not silence in the STREAM: music.js keeps its
// inaudible tone under the loop whatever this returns, so a muted board still
// holds the session. Muted is a promise not to be heard, not a promise to let
// the session go.
export const MUSIC_PEAK = 0.2;
export function musicGain(volume) {
  const v = Number(volume);
  if (!(v > 0)) return 0;
  return Math.min(1, v) * MUSIC_PEAK;
}
