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
//   · music.js startMusic()     — what it holds WITH, when the captain wants
//                                 one of the loops instead of the inaudible
//                                 tone.
//   · sound.js setCorpseWatch() — the 500ms heartbeat that catches the context
//                                 the Shortcut leaves for dead.
// Off by default, and off means none of them run.
import { hold } from './speech.js';
import { setCorpseWatch, getVolume, onVolume } from './sound.js';
import { startMusic } from './music.js';
import { KEEPALIVE_VOICES, corpseWatchRuns, enabledFromStorage, keepAliveVoice,
         musicTrack, trackUrl, musicGain } from './keepalive.js';
import { push as toast } from './toast.js';

const KEY = 'bc-audio-keepalive';
const VOICE_KEY = 'bc-audio-keepalive-voice';
const btn = document.getElementById('ka-btn');
const sel = document.getElementById('ka-voice');

let on = false;
let voice = 'silent';
let playing = null;             // the loop while it is playing, for the volume slider

// hold() compares sources by identity, so these are built ONCE per track: the
// gesture primer below hands the same function over on every tap, and handing
// the same one over means nothing changes. Only a real change of voice swaps
// what is playing. `silent` is not a source at all — it is speech.js's own
// inaudible tone, which is what ?hum=loud makes audible.
const sources = new Map();
function sourceFor(v) {
  const track = musicTrack(v);
  if (!track) return null;
  let src = sources.get(track.key);
  if (!src) {
    src = (ctx, dest) => {
      playing = startMusic(ctx, dest, musicGain(getVolume()), trackUrl(track), track.seconds);
      // A track that will not load still holds the session — music.js's tone is
      // under it and does not depend on the file — so this is not an error, it
      // is the keep-alive being silent when he asked for it not to be. Say so
      // rather than leave him watching a switch that looks on and sounds off.
      playing.ready.catch(() => toast({ emoji: '🎵', text: `${track.label} could not be loaded — the keep-alive is holding silently` }));
      return playing;
    };
    sources.set(track.key, src);
  }
  return src;
}

function apply() {
  btn.classList.toggle('on', on);
  btn.textContent = on ? '🎧 on' : '🎧 off';
  sel.classList.toggle('dim', !on);
  sel.value = voice;
  setCorpseWatch(corpseWatchRuns(on));
  hold(on, sourceFor(voice));
  if (!on) playing = null;
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
// The loop is one long sound, so it follows the slider while it is being
// dragged instead of at the next pass. A stopped loop ignores this.
onVolume((v) => { if (playing) playing.setLevel(musicGain(v)); });

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
