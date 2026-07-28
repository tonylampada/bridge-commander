// TTS: speak new agent messages when enabled; toggle persists in localStorage.
//
// HOW the sound is made is not here. ./speech.js owns the whole speech path —
// the engine request, the streaming playback, the <audio> the OS can see, the
// lock screen and the visible transport — and it is the module that was proven
// on the captain's phone. This file is the board's policy on top of it: WHICH
// messages get spoken, WHOSE voice speaks them, WHEN — one at a time, in a
// queue — and the on/off toggle.
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
  // another. Nothing at all is a real state, and a loud one — see enqueue.
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
    .replace(/[←-⇿⌀-⏿■-◿☀-➿⬀-⯿]/g, ' ');
}
// Line breaks SURVIVE this. They are not decoration left over from the source:
// a newline and a full stop are the only two things the engine breathes on, so
// throwing them away is throwing away every pause in the message.
function tidy(s) {
  return s
    .replace(/[^\S\n]+/g, ' ')      // runs of space/tab, never the newlines
    .replace(/ ?\n ?/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}
// A line that carried a block mark is a sentence, and it has to end like one —
// otherwise "## Recomendação" runs straight into the paragraph under it and six
// list items come out as one breathless paragraph.
function sentence(s) {
  return /[.!?:;…]\s*$/.test(s) ? s : s.replace(/\s*$/, '.');
}
// Markdown is written to be READ. This is what is left of it when it must be
// HEARD instead. The old version deleted CHARACTERS — which is why a table
// spoke its pipes, `> ` came out as "maior que", `_assim_` kept its
// underscores, and a link said its text and then the word "link" for the URL
// behind it. Marks are structure, so each one is answered by what it means out
// loud: the ones that carry words give the words up, the blocks that cannot be
// spoken at all collapse to the one word that says what was there.
//
// A table becomes the single word "table" rather than sentences. Read aloud,
// even a small one is a chant of column headings repeated per row; the captain
// is being told a table exists in the card, and can look.
//
// This is the ONE function the speech paths call. `code` and `link` are
// unchanged — they were already right.
export function stripForSpeech(text) {
  const t = String(text == null ? '' : text)
    .replace(/```[\s\S]*?```/g, ' code ')                       // a fence is not read out
    .replace(/(?:^[ \t]*\|.*\|[ \t]*\n?)+/gm, '\ntable.\n')     // a whole table, once
    .replace(/^[ \t]*([-*_])(?:[ \t]*\1){2,}[ \t]*$/gm, '')     // --- is a page break, silent
    .replace(/^[ \t]*#{1,6}[ \t]+(.*)$/gm, (m, h) => sentence(h))
    .replace(/^[ \t]*>[ \t]?/gm, '')                            // a quote is just someone talking
    .replace(/^[ \t]*(?:[-*+]|\d+[.)])[ \t]+(.*)$/gm, (m, i) => sentence(i))
    .replace(/!?\[([^\]\n]*)\]\([^)\n]*\)/g, '$1')              // the link's words, never its URL
    .replace(/https?:\S+/g, ' link ')                           // a bare one has no words to say
    // emphasis gives up its delimiters and keeps the word — but only when they
    // really are delimiters, so snake_case survives as one spoken word.
    .replace(/(^|[\s("'])([*_]{1,3}|~~)(?=\S)(.+?)\2(?=[\s.,;:!?)"']|$)/gm, '$1$3')
    .replace(/[`*#\[\]()~]/g, ' ');                             // leftovers, as before
  return tidy(stripEmoji(t));
}

// ---------- the speech queue ----------
// One message at a time, in the order they arrived: the one speaking finishes,
// the next starts. Asking speech.js to speak while it is speaking does not
// queue — it stops what it was saying — so a burst of three used to play only
// the third, with the first two cut mid-sentence. It cost the engine too: an
// aborted request keeps synthesizing until the disconnect lands, so the overlap
// was two generations on one GPU, which is what killed voxcpm2 on 27/07.
//
// The board never asks for a second speech while one is in flight. Stopping —
// and turning the voice off, which stops — empties the queue as well: silence
// means silence, not a pause before the backlog resumes.
const QUEUE_MAX = 3;      // waiting messages, NOT counting the one being spoken
const queue = [];         // [{plain, who, voice}], oldest first
let draining = false;     // a message is being spoken, or is about to be
let session = 0;          // bumped by stopSpeaking: a drain past its session is stale

// A silence the captain can see. Every way this board can fail to speak comes
// through here — no path ends in nothing happening.
function mute(text) {
  toast({ emoji: '🔇', text });
}

// The message is spoken whole. It used to be cut at 1200 characters, from when a
// long message meant half a minute of silence before any sound — the cap bought
// a shorter wait by throwing the rest of the answer away. Streaming removed the
// wait, so the cap only truncated: a 2664-character reply stopped mid-sentence,
// at 45% of itself. Stopping early is the transport's job, not a slice().
function enqueue(plain, who) {
  if (!engine) return mute('no speech engine configured — the board cannot speak');
  // `who` is the author, and it is not decoration: it picks the voice that
  // speaks (each lieutenant may own one) and it is what the phone's lock screen
  // shows, which is where the captain sees WHO is talking while the screen is off.
  const voice = voiceForAuthor(who);
  if (!voice) return mute('no voice chosen — pick one in settings; the board will not guess');
  queue.push({ plain, who, voice });
  // Over the top, the MIDDLE goes and the newest stays. A burst of ten cannot
  // become ten minutes of backlog, and by the time the board is that far behind
  // the newest message is the one worth hearing — the ones it skips over are
  // already answered by the one it keeps.
  if (queue.length > QUEUE_MAX) {
    const n = queue.splice(QUEUE_MAX - 1, queue.length - QUEUE_MAX).length;
    toast({ emoji: '⏭️', text: n + (n > 1 ? ' messages' : ' message') + ' skipped — too many waiting to be spoken' });
  }
  // Straight into drain(), not through a promise: on the paths that ride a real
  // user gesture (the speak button, the voice test) speech.js needs its play()
  // inside the tap, and drain() reaches engineSpeak() before its first await.
  if (!draining) drain();
}

// What is still coming out of the speakers after the engine's last byte. speak()
// resolves when the STREAM ends, not when the sound does: the buffers are
// scheduled ahead, so an engine faster than realtime finishes the request while
// most of the message is still unheard. Starting the next one then would stop
// those buffers — exactly the cut this queue exists to prevent. bytes/rate IS
// the length of the audio, and speech.js hands both back.
function tailMs(said, heardAt) {
  if (!said || said.stopped || !said.bytes || !heardAt) return 0;
  return Math.max(0, (said.bytes / 2 / (said.rate || 24000)) * 1000 - (performance.now() - heardAt));
}
const wait = (ms) => new Promise((r) => setTimeout(r, ms));

async function drain() {
  draining = true;
  try {
    while (queue.length) {
      const { plain, who, voice } = queue.shift();
      const my = session;
      let heardAt = 0;
      try {
        const said = await engineSpeak({
          url: engine.url + '/v1/audio/speech',
          voice,
          input: plain,
          params: engine.params && Object.keys(engine.params).length ? engine.params : undefined,
          title: who || 'Bridge Commander',
          artist: 'Bridge Commander',
          onFirstSound: () => { heardAt = performance.now(); },
        });
        if (my === session) await wait(tailMs(said, heardAt));
      } catch (err) {
        // One message lost, said out loud — and the queue moves on. A refusal in
        // the middle of a burst cannot take the rest of the burst with it.
        if (my === session) mute('speech failed: ' + (err && err.message ? err.message : err));
      }
    }
  } finally { draining = false; }
}
export function speak(text, who) {
  if (!voiceOn) return;
  const plain = stripForSpeech(text);
  if (!plain) return;
  manualSpeakingKey = null;                  // an auto-speak supersedes any manual toggle state
  enqueue(plain, who);
}
export function stopSpeaking() {
  session++;              // whatever the engine still owes us is stale
  queue.length = 0;       // stop stops what is waiting too, not just what is heard
  engineStop();
}

// Manual, on-demand speak for a single message. Independent of the auto-speak
// toggle: this call happens inside a real user gesture (the speak-button click),
// so the speak() it fires is itself the gesture that unlocks audio — no separate
// primer needed. Returns true if it spoke, false if there was nothing to say.
// Clicking again while this message is speaking — or while it waits its turn —
// stops it (cheap toggle), and with it everything else in the queue: stop means
// stop, and there is one stop.
let manualSpeakingKey = null;
export function speakMessage(text, key, who) {
  if (key != null && manualSpeakingKey === key && draining) {
    manualSpeakingKey = null; stopSpeaking(); return false; // toggle off
  }
  const plain = stripForSpeech(text);
  if (!plain) return false;
  manualSpeakingKey = key != null ? key : null;
  enqueue(plain, who);
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
document.getElementById('voice-test').onclick = () => enqueue('Hello, this is my voice.');

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
