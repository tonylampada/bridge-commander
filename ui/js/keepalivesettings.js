// keepalivesettings.js — the switch behind ui/js/keepalive.js: the settings
// toggle, its persistence, and the two things it drives.
//
// The decision lives in keepalive.js and is tested there without a browser;
// this file is the wiring, the way notifysettings.js is the wiring under
// notifypolicy.js. Two consumers, one switch:
//   · speech.js hold()          — the inaudible tone that keeps the audio
//                                 session alive through a Siri Shortcut, played
//                                 through the same element the speech leaves
//                                 through (never a second one).
//   · sound.js setCorpseWatch() — the 500ms heartbeat that catches the context
//                                 the Shortcut leaves for dead.
// Off by default, and off means neither runs.
import { hold } from './speech.js';
import { setCorpseWatch } from './sound.js';
import { corpseWatchRuns, enabledFromStorage } from './keepalive.js';

const KEY = 'bc-audio-keepalive';
const btn = document.getElementById('ka-btn');

let on = false;

function apply() {
  btn.classList.toggle('on', on);
  btn.textContent = on ? '🎧 on' : '🎧 off';
  setCorpseWatch(corpseWatchRuns(on));
  hold(on);
}

function set(next, persist) {
  on = !!next;
  if (persist) { try { on ? localStorage.setItem(KEY, '1') : localStorage.removeItem(KEY); } catch (e) {} }
  apply();
}

btn.onclick = () => set(!on, true);

// Restoring it across a reload is only half a restore: iOS wants a gesture
// behind the element's first play(), and a page that has just loaded has none.
// So the switch comes back on immediately (the heartbeat needs no permission)
// and the tone starts on the first gesture that lands anywhere on the page —
// the same capture-phase primer sound.js and speech.js already use. hold() is
// re-called rather than toggled: it is a no-op once the tone is running.
try { if (enabledFromStorage(localStorage.getItem(KEY))) set(true, false); } catch (e) {}
for (const ev of ['click', 'keydown', 'pointerdown', 'touchstart'])
  window.addEventListener(ev, () => { if (on) hold(true); }, { capture: true, passive: true });
