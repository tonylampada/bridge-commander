// keepalivesettings.js — the switch behind ui/js/keepalive.js: the settings
// toggle, the choice of what it holds with, their persistence, and the wiring.
//
// The decision lives in keepalive.js and is tested there without a browser;
// this file is the wiring, the way notifysettings.js is the wiring under
// notifypolicy.js. Three consumers, one switch:
//   · speech.js hold()          — keeps the audio session alive through a Siri
//                                 Shortcut by never letting the element go
//                                 quiet, through the same element the speech
//                                 leaves through (never a second one).
//   · pad.js startPad()         — what it holds WITH, when the captain wants
//                                 music instead of the inaudible tone.
//   · sound.js setCorpseWatch() — the 500ms heartbeat that catches the context
//                                 the Shortcut leaves for dead.
// Off by default, and off means none of them run.
import { hold } from './speech.js';
import { setCorpseWatch, getVolume, onVolume } from './sound.js';
import { startPad } from './pad.js';
import { KEEPALIVE_VOICES, corpseWatchRuns, enabledFromStorage, keepAliveVoice, padGain } from './keepalive.js';

const KEY = 'bc-audio-keepalive';
const VOICE_KEY = 'bc-audio-keepalive-voice';
const btn = document.getElementById('ka-btn');
const sel = document.getElementById('ka-voice');

let on = false;
let voice = 'silent';
let pad = null;                 // the pad while it is playing, for the volume slider

// hold() compares sources by identity, so this is built ONCE per voice: the
// gesture primer below hands the same function over on every tap, and handing
// the same one over means nothing changes. Only a real change of voice swaps
// what is playing. `silent` is not a source at all — it is speech.js's own
// inaudible tone, which is what ?hum=loud makes audible.
const music = (ctx, dest) => (pad = startPad(ctx, dest, padGain(getVolume())));
const sourceFor = (v) => (v === 'music' ? music : null);

function apply() {
  btn.classList.toggle('on', on);
  btn.textContent = on ? '🎧 on' : '🎧 off';
  sel.classList.toggle('dim', !on);
  sel.value = voice;
  setCorpseWatch(corpseWatchRuns(on));
  hold(on, sourceFor(voice));
  if (!on) pad = null;
}

function set(next, persist) {
  on = !!next;
  if (persist) { try { on ? localStorage.setItem(KEY, '1') : localStorage.removeItem(KEY); } catch (e) {} }
  apply();
}

for (const v of KEEPALIVE_VOICES) {
  const o = document.createElement('option');
  o.value = v.key;
  o.textContent = v.label;
  sel.appendChild(o);
}
btn.onclick = () => set(!on, true);
sel.onchange = () => {
  voice = keepAliveVoice(sel.value);
  try { voice === 'silent' ? localStorage.removeItem(VOICE_KEY) : localStorage.setItem(VOICE_KEY, voice); } catch (e) {}
  apply();                      // held already → hold() swaps the source under it
};
// The pad is one long sound, so it follows the slider while it is being
// dragged instead of at the next note. A stopped pad ignores this.
onVolume((v) => { if (pad) pad.setLevel(padGain(v)); });

// Restoring across a reload is only half a restore: iOS wants a gesture behind
// the element's first play(), and a page that has just loaded has none. So the
// switch comes back on immediately (the heartbeat needs no permission) and what
// holds the session starts on the first gesture that lands anywhere on the page
// — the same capture-phase primer sound.js and speech.js already use. hold() is
// re-called rather than toggled: with the same source it is a no-op once
// something is already playing.
try { voice = keepAliveVoice(localStorage.getItem(VOICE_KEY)); } catch (e) {}
try { if (enabledFromStorage(localStorage.getItem(KEY))) set(true, false); } catch (e) {}
sel.value = voice;
sel.classList.toggle('dim', !on);
for (const ev of ['click', 'keydown', 'pointerdown', 'touchstart'])
  window.addEventListener(ev, () => { if (on) hold(true, sourceFor(voice)); }, { capture: true, passive: true });
