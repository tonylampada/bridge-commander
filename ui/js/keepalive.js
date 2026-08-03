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
   uma musiquinha agradável". */
export const KEEPALIVE_VOICES = [
  { key: 'silent', label: 'silent' },
  { key: 'music', label: 'music' },
];
export function keepAliveVoice(raw) {
  return raw === 'music' ? 'music' : 'silent';
}

// The whole question in one place: what should be coming out of the element
// right now. 'none' is the element not playing on the keep-alive's account at
// all — either the switch is off, or the speech has it and the keep-alive is
// out of the way, which are different reasons for the same silence.
export function keepAliveSound({ enabled, speaking, voice } = {}) {
  if (keepAliveState({ enabled, speaking }) !== 'hold') return 'none';
  return keepAliveVoice(voice) === 'music' ? 'music' : 'tone';
}

/* ── the pad ──────────────────────────────────────────────────────────────
   A pad, not a loop: it drifts and never arrives. The notes are the A minor
   pentatonic — A C D E G, the five that cannot make a leading tone or a
   dominant between them, so nothing in here ever asks to resolve — taken from
   the same tempered values sound.js tunes its bells to, across A3 to E5. Under
   them sits a bare fifth on A2, held for as long as the pad is: a third would
   commit the music to major or minor, and it never does.

   The drone is not decoration. It is what makes the stream continuously
   non-silent between one note and the next, and continuously non-silent is the
   whole reason any of this exists. */
export const PAD_POOL = [220, 261.63, 293.66, 329.63, 392, 440, 523.25, 587.33, 659.25];
//                        A3     C4      D4      E4     G4   A4    C5      D5      E5
export const DRONE = [[110, 0.22], [164.81, 0.11]];   // A2 and the fifth above it, E3

// The next note drifts from the one before: somewhere within three steps of it,
// and never itself, so the line wanders instead of leaping about. `r` is a
// number in [0, 1) — the caller's randomness, kept out here so the choice is a
// pure function that can be asked the same question twice.
export function nextNote(prev, r) {
  const i = PAD_POOL.indexOf(prev);
  const pool = i < 0 ? PAD_POOL : PAD_POOL.filter((_, j) => j !== i && Math.abs(j - i) <= 3);
  const at = Math.floor(Math.max(0, Math.min(0.999999, r)) * pool.length);
  return pool[at];
}

// Seconds until the next note starts. Long enough that two or three notes are
// always sounding together over the drone, uneven enough that no bar-line ever
// appears — a pulse is the one thing an ambient pad must not grow.
export function padStep(r) {
  return 4.5 + Math.max(0, Math.min(1, r)) * 4;
}

// The pad follows the notification volume, the way every tone in sound.js does.
// It sits well under them: a notification is meant to be noticed once, and this
// is meant to be tolerated for two hours. A master volume of zero is silence
// here too — the captain who muted the board did not ask for music.
export const PAD_PEAK = 0.055;
export function padGain(volume) {
  const v = Number(volume);
  if (!(v > 0)) return 0;
  return Math.min(1, v) * PAD_PEAK;
}
