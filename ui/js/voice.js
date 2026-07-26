// TTS: speak new agent messages when enabled; toggle persists in localStorage.
//
// HOW the sound is made is not here. ./speech.js owns the whole speech path —
// the engine request, the streaming playback, the <audio> the OS can see, the
// lock screen and the visible transport — and it is the module that was proven
// on the captain's phone. This file is the board's policy on top of it: WHICH
// messages get spoken, WHOSE voice speaks them, and the on/off toggle.
//
// There is no second way to speak. When the engine refuses, or no voice is
// chosen, the board is silent AND says so on screen. It used to fall through to
// the browser voice without a word, which is how it spoke English in a
// Portuguese room for an afternoon while the bug was hunted somewhere else.
import { api } from './api.js';
import { speak as engineSpeak, stop as engineStop } from './speech.js';
import { push as toast } from './toast.js';
import { fetchVoices, sortedVoices, pickVoice } from './voices.js';
import { lieutenantByActor } from './state.js';

const VOICE_ON_KEY = 'bc-voice-on';
const VOICE_KEY = 'bc-tts-voice';   // the board's voice, an engine id
const voiceSelect = document.getElementById('voice-select');
const voiceBtn = document.getElementById('voice-btn');

let voiceOn = false;
let engine = null;                // /api/config's tts block, or null if none
let voiceList = [];               // [{id, name, lang}] from the engine
let voiceFilter = null;           // lowercase substrings from /api/config, or null

// One load, settled once: the lieutenant-settings picker awaits the SAME work
// instead of racing it, so opening settings early still gets the full catalogue.
const voicesReady = api.config().then((cfg) => {
  if (cfg && Array.isArray(cfg.voices) && cfg.voices.length) {
    voiceFilter = cfg.voices.map((s) => String(s).toLowerCase());
  }
  const tts = cfg && cfg.tts;
  if (tts && tts.enabled && tts.url) engine = tts;
  return engine ? fetchVoices(engine.url, engine.lang) : [];
}, () => [])
  .then((list) => { voiceList = list; populatePicker(); }, () => {});

function savedVoiceId() {
  try { return localStorage.getItem(VOICE_KEY) || ''; } catch (e) { return ''; }
}
// The same catalogue the settings panel shows, for the per-lieutenant picker.
export function voiceOptions(keep) {
  return voicesReady.then(() => sortedVoices(voiceList, voiceFilter, keep));
}
function populatePicker() {
  // The workspace may name a voice; that is the board's until the captain picks
  // another. Nothing at all is a real state, and a loud one — see speakPlain.
  const saved = savedVoiceId() || (engine && engine.voice) || '';
  const sorted = sortedVoices(voiceList, voiceFilter, saved);
  voiceSelect.textContent = '';
  const def = document.createElement('option');
  def.value = '';
  def.textContent = 'no voice — the board stays silent';
  voiceSelect.appendChild(def);
  for (const v of sorted) {
    const o = document.createElement('option');
    o.value = v.id;
    o.textContent = v.name + (v.lang ? ' (' + v.lang + ')' : '');
    voiceSelect.appendChild(o);
  }
  if (saved && sorted.some((v) => v.id === saved)) voiceSelect.value = saved;
}
voiceSelect.onchange = () => {
  const id = voiceSelect.value;
  try { if (id) localStorage.setItem(VOICE_KEY, id); else localStorage.removeItem(VOICE_KEY); } catch (e) {}
};
// The voice for what `who` said: their own if they have one, else the board's.
// pickVoice owns the rule (and the "must be in the catalogue" guard); this only
// looks the author up. A `who` that is nobody — the voice test, a worker — is
// simply the board's voice.
function voiceForAuthor(who) {
  return pickVoice((lieutenantByActor(who) || {}).voice, voiceSelect.value, voiceList);
}
function stripEmoji(s) { // spoken text only
  return s
    .replace(/[\u{1F1E6}-\u{1F1FF}]/gu, ' ')
    .replace(/\p{Extended_Pictographic}/gu, ' ')
    .replace(/[\u{FE00}-\u{FE0F}\u{200D}\u{1F3FB}-\u{1F3FF}\u{20E3}]/gu, '')
    .replace(/[←-⇿⌀-⏿■-◿☀-➿⬀-⯿]/g, ' ')
    .replace(/\s{2,}/g, ' ').trim();
}
function stripForSpeech(text) {
  return stripEmoji(text.replace(/```[\s\S]*?```/g, ' code ').replace(/[`*#\[\]()]/g, ' ').replace(/https?:\S+/g, ' link '));
}

// ---------- speech sessions ----------
// One session at a time: a new message supersedes the old (speech.js stops the
// previous one itself), so the newest is always what you hear. `speaking` is
// what the per-message speak button toggles against.
let session = 0;
let speaking = false;

// A silence the captain can see. Every way this board can fail to speak comes
// through here — no path ends in nothing happening.
function mute(text) {
  speaking = false;
  toast({ emoji: '🔇', text });
}

// The message is spoken whole. It used to be cut at 1200 characters, from when a
// long message meant half a minute of silence before any sound — the cap bought
// a shorter wait by throwing the rest of the answer away. Streaming removed the
// wait, so the cap only truncated: a 2664-character reply stopped mid-sentence,
// at 45% of itself. Stopping early is the transport's job, not a slice().
function speakPlain(plain, who) {
  const my = ++session;
  if (!engine) return mute('no speech engine configured — the board cannot speak');
  const voice = voiceForAuthor(who);
  if (!voice) return mute('no voice chosen — pick one in settings; the board will not guess');
  speaking = true;
  // `who` is the author, and it is not decoration: it picks the voice that
  // speaks (each lieutenant may own one) and it is what the phone's lock screen
  // shows, which is where the captain sees WHO is talking while the screen is off.
  engineSpeak({
    url: engine.url + '/v1/audio/speech',
    voice,
    input: plain,
    params: engine.params && Object.keys(engine.params).length ? engine.params : undefined,
    title: who || 'Bridge Commander',
    artist: 'Bridge Commander',
  }).then(
    () => { if (my === session) speaking = false; },
    (err) => { if (my === session) mute('speech failed: ' + (err && err.message ? err.message : err)); },
  );
}
export function speak(text, who) {
  if (!voiceOn) return;
  const plain = stripForSpeech(text);
  if (!plain) return;
  manualSpeakingKey = null;                  // an auto-speak supersedes any manual toggle state
  speakPlain(plain, who);
}
export function stopSpeaking() {
  session++;
  speaking = false;
  engineStop();
}

// Manual, on-demand speak for a single message. Independent of the auto-speak
// toggle: this call happens inside a real user gesture (the speak-button click),
// so the speak() it fires is itself the gesture that unlocks audio — no separate
// primer needed. Returns true if it spoke, false if there was nothing to say.
// Clicking again while this message is speaking stops it (cheap toggle).
let manualSpeakingKey = null;
export function speakMessage(text, key, who) {
  if (key != null && manualSpeakingKey === key && speaking) {
    manualSpeakingKey = null; stopSpeaking(); return false; // toggle off
  }
  const plain = stripForSpeech(text);
  if (!plain) return false;
  manualSpeakingKey = key != null ? key : null;
  speakPlain(plain, who);
  return true;
}
function setVoiceOn(on) {
  voiceOn = on;
  voiceBtn.classList.toggle('on', on);
  voiceBtn.textContent = on ? '🔊 on' : '🔊 off';
  document.getElementById('voice-tools').classList.toggle('dim', !on);
  if (!on) stopSpeaking(); // turning voice off silences anything mid-utterance
  try { if (on) localStorage.setItem(VOICE_ON_KEY, '1'); else localStorage.removeItem(VOICE_ON_KEY); } catch (e) {}
}
// No gesture-primer: nothing is ever spoken except real content and the
// deliberate voice-test greeting. Audio is gesture-gated, but every speak path
// already rides a genuine user gesture — a card's Speak button click
// (speakMessage) and the voice-test button both speak inside the click, and that
// real in-gesture utterance is itself the unlock.
voiceBtn.onclick = () => setVoiceOn(!voiceOn);
try { if (localStorage.getItem(VOICE_ON_KEY) === '1') setVoiceOn(true); } catch (e) {} // restore toggle
document.getElementById('voice-test').onclick = () => speakPlain('Hello, this is my voice.');

// ---------- speak only NEW lieutenant messages ----------
let firstLoad = true;
const seenMsgs = new Set();
export function trackMessages(doc) {
  if (!doc) return;
  const all = [];
  (doc.lieutenants || []).forEach((l) => (l.chat || []).forEach((m) => all.push(['lieutenant:' + l.id, m])));
  (doc.cards || []).forEach((c) => (c.thread || []).forEach((m) => all.push(['card:' + c.id, m])));
  for (const [scope, m] of all) {
    const k = scope + '|' + m.ts + '|' + m.author + '|' + m.text;
    if (!seenMsgs.has(k)) {
      seenMsgs.add(k);
      if (!firstLoad && m.author !== 'user') speak(m.text, m.author);
    }
  }
  firstLoad = false;
}
