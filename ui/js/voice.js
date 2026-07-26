// TTS: speak new agent messages when enabled; toggle persists in localStorage.
// WHICH speaker does the talking — the browser's speechSynthesis or an external
// engine, with the browser as the fallback under it — is decided once in
// ./tts/index.js. Everything below holds a single `speaker` and never asks.
import { api } from './api.js';
import { speakerFor, pickVoice } from './tts/index.js';
import { lieutenantByActor } from './state.js';

const VOICE_ON_KEY = 'bc-voice-on';
const voiceSelect = document.getElementById('voice-select');
const voiceBtn = document.getElementById('voice-btn');

let voiceOn = false;
let speaker = speakerFor(null);   // browser-only until /api/config answers
let voiceList = [];               // [{id, name, lang}] from speaker.voices()
let voiceFilter = null;           // lowercase substrings from /api/config, or null

// One load, settled once: the lieutenant-settings picker awaits the SAME work
// instead of racing it, so opening settings early still gets the full catalogue.
const voicesReady = api.config().then((cfg) => {
  if (cfg && Array.isArray(cfg.voices) && cfg.voices.length) {
    voiceFilter = cfg.voices.map((s) => String(s).toLowerCase());
  }
  speaker = speakerFor(cfg);
}, () => {})
  .then(() => speaker.voices())
  .then((list) => { voiceList = list; populatePicker(); }, () => {});
// The picker's saved choice is keyed per speaker (speaker.key), so a browser
// voice name can never come back as an engine voice id. The legacy {name,lang}
// shape is still read, so an existing selection survives the upgrade.
function savedVoiceId() {
  let raw = null;
  try { raw = localStorage.getItem(speaker.key); } catch (e) {}
  if (!raw) return '';
  if (raw[0] !== '{') return raw;
  try { const o = JSON.parse(raw); return o.name + '|' + o.lang; } catch (e) { return ''; }
}
function voiceRank(v) {
  if (/^pt[-_]BR/i.test(v.lang)) return 0;
  if (/^pt/i.test(v.lang)) return 1;
  if (/^en/i.test(v.lang)) return 2;
  return 3;
}
// The offered voices, best-language first. `keep` is an id to never filter out —
// whatever is currently chosen stays visible even when the workspace narrows the
// list to a few names.
function sortedVoices(keep) {
  let sorted = voiceList.slice().sort((a, b) =>
    voiceRank(a) - voiceRank(b) || a.lang.localeCompare(b.lang) || a.name.localeCompare(b.name));
  if (voiceFilter) {
    const matches = (v) => voiceFilter.some((f) => v.name.toLowerCase().includes(f));
    if (sorted.some(matches)) sorted = sorted.filter((v) => matches(v) || v.id === keep);
  }
  return sorted;
}
// The same catalogue the settings panel shows, for the per-lieutenant picker.
export function voiceOptions(keep) { return voicesReady.then(() => sortedVoices(keep)); }
function populatePicker() {
  const saved = savedVoiceId();
  const sorted = sortedVoices(saved);
  voiceSelect.textContent = '';
  const def = document.createElement('option');
  def.value = '';
  def.textContent = 'default voice';
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
  try { if (id) localStorage.setItem(speaker.key, id); else localStorage.removeItem(speaker.key); } catch (e) {}
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
// One session at a time: a new message supersedes the old, so the newest is
// always what you hear. speak() settles when the message is done (spoken,
// cancelled, or — after every fallback under it failed — given up on), which is
// also what drives the floating indicator.
let session = 0;
let speaking = false;

// The message is spoken whole. It used to be cut at 1200 characters, from when a
// long message meant half a minute of silence before any sound — the cap bought
// a shorter wait by throwing the rest of the answer away. Streaming removed the
// wait, so the cap only truncated: a 2664-character reply stopped mid-sentence,
// at 45% of itself. Stopping early is the bubble's job, not a slice().
function speakPlain(plain, who) {
  const my = ++session;
  speaker.cancel();
  speaking = true;
  speakingBubble.show(who);
  // `who` is the author, and it is not decoration: it picks the voice that
  // speaks (each lieutenant may own one), and the remote speaker puts it on the
  // phone's lock screen, which is where the captain sees WHO is talking to him
  // while the screen is off. Nothing here knows that — it just carries it.
  speaker.speak(plain, { voice: voiceForAuthor(who), who })
    .catch(() => {})
    .then(() => { if (my !== session) return; speaking = false; speakingBubble.hide(); });
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
  speaker.cancel();
  speakingBubble.hide();
}

// ---------- floating transport ----------
// A small fixed transport shown ONLY while a speech session is live: up when one
// starts, down when the speaker settles it (natural end, error, or cancel).
// Three buttons — play, pause, stop — and a label saying WHO is speaking.
//
// It used to be a pill with four animated wave bars, and that is exactly what
// broke the phone: the lock screen goes deaf behind a page that shows no player.
// WebKit wants a transport it can SEE, so this is one — plain on purpose, here to
// be seen and pressed by a thumb, not admired.
const speakingBubble = (() => {
  let el = null;
  function ensureEl() {
    if (el) return el;
    el = document.createElement('div');
    el.id = 'tts-bubble';
    el.hidden = true;
    el.innerHTML = '<span class="lbl"></span>'
      + '<button type="button" class="t-play" title="play" aria-label="play">▶</button>'
      + '<button type="button" class="t-pause" title="pause" aria-label="pause">❚❚</button>'
      + '<button type="button" class="t-stop" title="stop" aria-label="stop">■</button>';
    el.querySelector('.t-play').onclick = () => speaker.resume();
    el.querySelector('.t-pause').onclick = () => speaker.pause();
    el.querySelector('.t-stop').onclick = () => stopSpeaking();
    document.body.appendChild(el);
    return el;
  }
  return {
    show(who) {
      const e = ensureEl();
      e.querySelector('.lbl').textContent = who || 'speaking…';
      e.hidden = false;
    },
    hide() { if (el) el.hidden = true; },
  };
})();

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
