// callcore.js — everything a call DECIDES, with nothing it touches. call.js is
// the microphone, the speakers and the screen; this is the part of a phone call
// that can be wrong without anything looking wrong: what gets said out loud,
// where a sentence ends, when he has stopped talking, which state the call is
// in, and whether this wait deserves an "um momento…".
//
// **It imports nothing and reads no clock.** Every function takes the time it
// is asked about, so a test drives a call frame by frame instead of racing one.

// ── what is said out loud ───────────────────────────────────────────────────
// A call reply is HEARD. stripForSpeech (voice.js) turns a message into speech
// faithfully, a table into the word "table"; on a call the captain is not going
// to look at the screen, so everything that needs eyes collapses to a pointer at
// the chat, said once, in English like the reply around it.
const IN_CHAT = { code: 'code in the chat', link: 'link in the chat', table: 'table in the chat', path: 'path in the chat' };

function sentenceEnd(s) { return /[.!?:;…]\s*$/.test(s) ? s : s.replace(/\s*$/, '.'); }

export function cleanForCall(text) {
  let t = String(text == null ? '' : text).replace(/\r\n?/g, '\n');
  t = t
    .replace(/```[\s\S]*?(?:```|$)/g, '\n' + IN_CHAT.code + '.\n')       // a fence, even an unclosed one
    .replace(/(?:^[ \t]*\|.*\|[ \t]*(?:\n|$))+/gm, '\n' + IN_CHAT.table + '.\n')
    .replace(/^[ \t]*([-*_])(?:[ \t]*\1){2,}[ \t]*$/gm, '')               // --- rule
    .replace(/^[ \t]*#{1,6}[ \t]+(.*)$/gm, (m, h) => sentenceEnd(h))
    .replace(/^[ \t]*>[ \t]?/gm, '')
    .replace(/^[ \t]*(?:[-*+]|\d+[.)])[ \t]+(?:\[[ xX]\][ \t]+)?(.*)$/gm, (m, i) => sentenceEnd(i))
    .replace(/!\[[^\]\n]*\]\([^)\n]*\)/g, ' ')                              // an image has nothing to say
    .replace(/\[([^\]\n]+)\]\([^)\n]*\)/g, '$1')                            // the link's words
    .replace(/<?\bhttps?:\/\/[^\s>)]+>?/g, ' ' + IN_CHAT.link + ' ')
    .replace(/`([^`\n]+)`/g, (m, c) => (/[\/\\]/.test(c) || c.length > 40 ? IN_CHAT.code : c))
    .replace(/(^|\s)~?(?:\/[\w.@-]+){2,}\/?/g, '$1' + IN_CHAT.path)         // /home/ai/x/y
    .replace(/(^|[\s("'])([*_]{1,3}|~~)(?=\S)(.+?)\2(?=[\s.,;:!?)"']|$)/gm, '$1$3')
    .replace(/[*#`~\[\]|<>{}]/g, ' ')
    // emoji and pictographs are read as their names by some engines and as
    // nothing by others; neither is a word he wanted
    .replace(/[\u{1F1E6}-\u{1F1FF}]/gu, ' ')
    .replace(/\p{Extended_Pictographic}/gu, ' ')
    .replace(/[\u{FE00}-\u{FE0F}\u{200D}\u{1F3FB}-\u{1F3FF}\u{20E3}]/gu, '')
    .replace(/[←-⇿⌀-⏿■-◿☀-➿⬀-⯿]/g, ' ');
  // the same pointer twice in a row is said once ("link in the chat. link in the chat")
  for (const p of Object.values(IN_CHAT)) {
    const re = new RegExp('(' + p + ')(?:[\\s.,;]+(?:(?:and|or|e|ou)\\s+)?' + p + ')+', 'g');
    t = t.replace(re, '$1');
  }
  return t
    .replace(/[^\S\n]+/g, ' ')
    .replace(/ ?\n ?/g, '\n')
    .replace(/\n{2,}/g, '\n')
    .replace(/ ([.,;:!?])/g, '$1')
    .trim();
}

// ── where a sentence ends ───────────────────────────────────────────────────
// The unit of synthesis. The first one is what he waits for, so it is cut as
// early as the text allows; a sentence too long to start quickly is cut again at
// a comma. "Sr." and "1.5" are not ends.
const ABBR = /(?:^|\s)(?:sr|sra|dr|dra|prof|ex|etc|obs|vs|nº|n|p|pág|fig|aprox|min|máx|mín|eg|ie|e\.g|i\.e)\.$/i;
export function splitSentences(text, { min = 12, max = 220 } = {}) {
  const src = String(text == null ? '' : text).trim();
  if (!src) return [];
  const raw = [];
  let cur = '';
  for (let i = 0; i < src.length; i++) {
    const ch = src[i];
    if (ch === '\n') { if (cur.trim()) raw.push(cur.trim()); cur = ''; continue; }
    cur += ch;
    if (!/[.!?…]/.test(ch)) continue;
    // a run of marks ("?!", "...") ends together
    while (i + 1 < src.length && /[.!?…"')\]]/.test(src[i + 1])) cur += src[++i];
    const nxt = src[i + 1];
    if (nxt !== undefined && !/\s/.test(nxt)) continue;                   // 1.5, v2.0, e.g.x
    if (ch === '.' && ABBR.test(cur)) continue;
    raw.push(cur.trim());
    cur = '';
  }
  if (cur.trim()) raw.push(cur.trim());

  // too short to be worth a request on its own: rides with the next one
  const merged = [];
  for (const s of raw) {
    if (merged.length && merged[merged.length - 1].length < min) merged[merged.length - 1] += ' ' + s;
    else merged.push(s);
  }
  if (merged.length > 1 && merged[merged.length - 1].length < min) {
    const last = merged.pop();
    merged[merged.length - 1] += ' ' + last;
  }
  // too long to start fast: cut at the last comma (or space) before max
  const out = [];
  for (let s of merged) {
    while (s.length > max) {
      let cut = s.lastIndexOf(', ', max);
      if (cut < min) cut = s.lastIndexOf(' ', max);
      if (cut < min) cut = max;
      out.push(s.slice(0, cut + (s[cut] === ',' ? 1 : 0)).trim());
      s = s.slice(cut + 1).trim();
    }
    if (s) out.push(s);
  }
  return out;
}

// ── when he has stopped talking ─────────────────────────────────────────────
// Energy VAD over ~20ms frames, in dBFS. The noise floor follows the room down
// fast and up slowly, so a fan or a car is learned and a voice is not. Speech is
// "margin dB over the floor, and over an absolute minimum"; an utterance starts
// after minSpeechMs of it and ends after hangMs of anything else.
//
// While the lieutenant is speaking the bar is higher and longer (`barge`): the
// phone's own speaker leaks into the microphone even with echo cancellation on,
// and his voice must cut the reply without the reply cutting itself.
export const VAD_DEFAULTS = {
  hangMs: 800,          // trailing silence that ends an utterance (pt-BR pauses mid-phrase run ~400-600ms)
  minSpeechMs: 120,     // voiced time before an utterance counts as started
  minUtteranceMs: 350,  // voiced total under this is a cough, a click, a door: dropped
  marginDb: 12,         // over the noise floor
  minDb: -50,           // and never quieter than this, whatever the floor says
  bargeMarginDb: 24,    // while the reply plays
  bargeMinDb: -36,
  bargeHoldMs: 450,     // sustained, so a plosive in the echo or a passing voice is not him
  gapMs: 120,           // a gap this short inside a run is a consonant, not the end of the run
  floorInit: -60,
  calibrateMs: 300,     // the first stretch of the call IS the floor; nothing starts inside it
  floorRiseDbPerS: 3,   // the floor climbs slowly…
  floorFallDbPerS: 40,  // …and drops at once
  floorCreepDbPerS: 0.4, // and creeps up even under "speech", so a fan switched on mid-call is learned
  maxUtteranceMs: 30000, // a monologue is cut and sent rather than held forever
};

export function createVad(opts = {}) {
  const o = Object.assign({}, VAD_DEFAULTS, opts);
  let floor = o.floorInit;
  let last = null;          // time of the previous frame
  let voicedSince = null;   // start of the current voiced run
  let inUtt = false;
  let uttStart = 0, lastVoice = 0, voicedMs = 0;
  let barge = false;
  let t0 = null, calSum = 0, calN = 0;

  function isVoiced(db) {
    const margin = barge ? o.bargeMarginDb : o.marginDb;
    const min = barge ? o.bargeMinDb : o.minDb;
    return db > floor + margin && db > min;
  }

  // One frame: its level and the time it ends at. Returns null, or an event:
  //   {type:'start', at}                    an utterance began (at = first voiced frame)
  //   {type:'end', at, lastVoice, voicedMs} he stopped; lastVoice is when
  //   {type:'drop', voicedMs}               it was not an utterance after all
  function frame(db, now) {
    const dt = last == null ? 20 : Math.max(0, now - last);
    last = now;
    if (t0 == null) t0 = now - dt;
    if (now - t0 <= o.calibrateMs) {
      calSum += db; calN++;
      floor = Math.max(o.floorInit, calSum / calN);
      return null;
    }
    const voiced = isVoiced(db);
    // the floor learns only from what is not speech
    if (!voiced) {
      if (db < floor) floor = Math.max(db, floor - o.floorFallDbPerS * dt / 1000);
      else floor = Math.min(db, floor + o.floorRiseDbPerS * dt / 1000);
    } else {
      floor += o.floorCreepDbPerS * dt / 1000;
    }
    if (voiced) {
      if (voicedSince == null) voicedSince = now - dt;
      lastVoice = now;
      if (inUtt) voicedMs += dt;
      const need = barge ? Math.max(o.minSpeechMs, o.bargeHoldMs) : o.minSpeechMs;
      if (!inUtt && now - voicedSince >= need) {
        inUtt = true;
        uttStart = voicedSince;
        voicedMs = now - voicedSince;
        return { type: 'start', at: uttStart };
      }
      if (inUtt && now - uttStart >= o.maxUtteranceMs) {
        inUtt = false; voicedSince = null;
        return { type: 'end', at: now, start: uttStart, lastVoice, voicedMs, cut: true };
      }
      return null;
    }
    if (!inUtt) {
      if (voicedSince != null && now - lastVoice > o.gapMs) voicedSince = null;
      return null;
    }
    if (now - lastVoice >= o.hangMs) {
      inUtt = false;
      voicedSince = null;
      if (voicedMs < o.minUtteranceMs) return { type: 'drop', voicedMs };
      return { type: 'end', at: now, start: uttStart, lastVoice, voicedMs };
    }
    return null;
  }

  return {
    frame,
    // Send tapped: the utterance he is in ends now, as if hangMs of silence had
    // just run out — the same 'end' (or 'drop', under minUtteranceMs) frame()
    // would give. Outside an utterance there is nothing to end: null. Silence
    // stays the fallback; this is the "I'm done" he says with a thumb.
    flush(now) {
      const was = inUtt;
      inUtt = false; voicedSince = null;
      if (!was) return null;
      if (voicedMs < o.minUtteranceMs) return { type: 'drop', voicedMs };
      return { type: 'end', at: now, start: uttStart, lastVoice, voicedMs, flushed: true };
    },
    setBarge(on) { barge = !!on; },
    // a gap in the frames (mute, pause, a new mic) is not time spent in any state
    reset() { inUtt = false; voicedSince = null; voicedMs = 0; last = null; },
    get floor() { return floor; },
    get speaking() { return inUtt; },
    options: o,
  };
}

// dBFS of a frame of float samples, for the VAD and the meter.
export function rmsDb(samples) {
  let s = 0;
  for (let i = 0; i < samples.length; i++) s += samples[i] * samples[i];
  const rms = Math.sqrt(s / Math.max(1, samples.length));
  return rms > 0 ? 20 * Math.log10(rms) : -100;
}

// ── which state the call is in ──────────────────────────────────────────────
//
//   idle ─start→ listening ─speech→ capturing ─end→ sending ─sent→ thinking ─reply→ speaking ─done→ listening
//                                     │  ↖───────────── speech (barge-in, or a follow-up) ──────────┘
//                                     └─drop→ listening, or thinking if an answer is still owed
//   any ─hangup→ ended
//
// Keyword mode: a chunk ending is 'drop' (back to listening while it
// transcribes), and the keyword arriving later is 'commit' → sending. A commit
// that lands while he is already talking again leaves 'capturing' alone.
//
// A pure reducer. `awaiting` says whether the lieutenant still owes an answer;
// it decides where a dropped utterance or a finished reply lands. Events that
// mean nothing in a state leave it where it is.
export const CALL_STATES = ['idle', 'listening', 'capturing', 'sending', 'thinking', 'speaking', 'ended'];

export function nextCallState(state, event, { awaiting = false } = {}) {
  if (state === 'ended') return 'ended';
  if (event === 'hangup' || event === 'hidden') return state === 'idle' ? 'idle' : 'ended';
  const rest = awaiting ? 'thinking' : 'listening';
  switch (state) {
    case 'idle': return event === 'start' ? 'listening' : state;
    case 'listening':
      if (event === 'speech') return 'capturing';
      if (event === 'reply') return 'speaking';
      if (event === 'commit') return 'sending';
      return state;
    case 'capturing':
      if (event === 'end') return 'sending';
      if (event === 'drop') return rest;
      return state;              // a reply arriving now waits until he stops
    case 'sending':
      if (event === 'sent') return 'thinking';
      if (event === 'failed') return rest;
      if (event === 'speech') return 'capturing';
      return state;
    case 'thinking':
      if (event === 'speech') return 'capturing';
      if (event === 'commit') return 'sending';
      if (event === 'reply') return 'speaking';
      return state;
    case 'speaking':
      if (event === 'speech') return 'capturing';    // barge-in
      if (event === 'done') return rest;
      return state;
    default: return state;
  }
}

// ── "um momento…" ───────────────────────────────────────────────────────────
// Once per wait, never if the answer is already here, never the same phrase
// twice running. A wait opens when an utterance is delivered and closes when a
// reply arrives (or he speaks again, which is a new wait).
export const FILLER_PHRASES = ['One moment…', 'Let me check…', 'Hang on…', 'Hmm, checking…', 'Just a second…'];

// ── spoken status: a long turn says what it is doing ────────────────────────
// The filler covers the first seconds. Past firstMs, the lieutenant's live
// activity (activity.js: the tool in flight, by kind) is said out loud — at
// most one line per gapMs, only into silence (quiet: nothing playing, he is not
// talking), and never once the reply is in. The same kind twice in a row takes
// the next phrase, so a long command is not announced in the same words.
// 'reply' (the answer is being written) says nothing: it is about to be heard.
export const STATUS_PHRASES = {
  bash: ['Still running a command.', 'That command is still going.'],
  read: ['Reading some files.', 'Still reading.'],
  edit: ['Editing a file.', 'Still making changes.'],
  search: ['Searching the code.', 'Still searching.'],
  agent: ['Waiting on a subagent.', 'The subagent is still on it.'],
  web: ['Searching the web.', 'Still looking online.'],
  think: ['Still thinking.', 'Still working on it.'],
  other: ['Still working on it.', 'Still at it.'],
};
export function spokenStatus(kind, n = 0) {
  if (!kind || kind === 'reply') return '';
  const list = STATUS_PHRASES[kind] || STATUS_PHRASES.other;
  return list[n % list.length];
}
export function createStatusPolicy({ firstMs = 15000, gapMs = 20000 } = {}) {
  let start = null, last = null, prevKind = null, run = 0;
  return {
    sent(now) { start = now; last = null; prevKind = null; run = 0; },
    replied() { start = null; },
    // the line to say now, or '' — asking changes nothing
    due(now, kind, quiet) {
      if (start == null || !quiet || !kind) return '';
      if (now - start < firstMs) return '';
      if (last != null && now - last < gapMs) return '';
      return spokenStatus(kind, kind === prevKind ? run : 0);
    },
    // a line was committed to (synthesis started): the clock restarts
    spoke(now, kind) {
      run = kind === prevKind ? run + 1 : 1;
      prevKind = kind;
      last = now;
    },
    get waiting() { return start != null; },
  };
}

export function createFillerPolicy({ delayMs = 3000, rand = Math.random } = {}) {
  let waitStart = null, used = false, lastPick = -1;
  return {
    sent(now) { waitStart = now; used = false; },
    replied() { waitStart = null; },
    cancel() { waitStart = null; },
    // true exactly once per wait, from delayMs after it opened
    due(now) {
      if (waitStart == null || used || now - waitStart < delayMs) return false;
      used = true;
      return true;
    },
    pick(n) {
      if (n <= 0) return -1;
      if (n === 1) return (lastPick = 0);
      let i = Math.floor(rand() * (n - 1));
      if (i >= lastPick && lastPick >= 0) i++;
      return (lastPick = Math.min(i, n - 1));
    },
    get waiting() { return waitStart != null; },
  };
}

// ── where the time went ─────────────────────────────────────────────────────
// One turn's timestamps (ms) → the four legs he asked to see. lieutenant is the
// think time and is reported, but excluded from `ours`, which is the target.
export function turnLegs(t) {
  const d = (a, b) => (t[a] != null && t[b] != null ? Math.round(t[b] - t[a]) : null);
  const legs = {
    vad: d('lastVoice', 'vadEnd'),
    stt: d('vadEnd', 'sttDone'),
    post: d('sttDone', 'posted'),
    lieutenant: d('posted', 'reply'),
    tts: d('reply', 'firstAudio'),
  };
  const parts = [legs.vad, legs.stt, legs.post, legs.tts];
  legs.ours = parts.every((x) => x != null) ? parts.reduce((a, b) => a + b, 0) : null;
  return legs;
}

// ── the utterance, as a file the STT engine takes ───────────────────────────
// Float samples at the context's rate → 16 kHz mono 16-bit WAV bytes. Whisper
// resamples to 16k anyway; sending 48k is three times the upload for nothing.
export function encodeWav16k(chunks, rate) {
  const total = chunks.reduce((a, c) => a + c.length, 0);
  const ratio = rate / 16000;
  const n = Math.max(0, Math.floor(total / ratio));
  const buf = new ArrayBuffer(44 + n * 2);
  const v = new DataView(buf);
  const w = (o, s) => { for (let i = 0; i < s.length; i++) v.setUint8(o + i, s.charCodeAt(i)); };
  w(0, 'RIFF'); v.setUint32(4, 36 + n * 2, true); w(8, 'WAVEfmt ');
  v.setUint32(16, 16, true); v.setUint16(20, 1, true); v.setUint16(22, 1, true);
  v.setUint32(24, 16000, true); v.setUint32(28, 32000, true);
  v.setUint16(32, 2, true); v.setUint16(34, 16, true);
  w(36, 'data'); v.setUint32(40, n * 2, true);
  // box-filter decimation: average the source samples each output sample covers
  let ci = 0, si = 0;
  const next = () => {
    while (ci < chunks.length && si >= chunks[ci].length) { ci++; si = 0; }
    return ci < chunks.length ? chunks[ci][si++] : 0;
  };
  let acc = 0;   // source samples consumed
  for (let k = 0; k < n; k++) {
    const until = (k + 1) * ratio;
    let sum = 0, cnt = 0;
    while (acc < until) { sum += next(); cnt++; acc++; }
    const x = Math.max(-1, Math.min(1, cnt ? sum / cnt : 0));
    v.setInt16(44 + k * 2, x < 0 ? x * 0x8000 : x * 0x7fff, true);
  }
  return new Uint8Array(buf);
}

// ── what the engine made up ─────────────────────────────────────────────────
// Whisper, handed a breath or a chair creak, answers with the sign-off of the
// subtitles it was trained on. A short take that comes back as one of those is
// noise and is not sent to the lieutenant; a long one is taken at its word.
const PHANTOMS = /^(?:obrigad[oa]s?(?: (?:por assistir|pela aten[cç][aã]o))?|tchau|legendas?\b.*|amara\.org.*|inscreva-se.*|thank you|you|\.+|…+)[.!…]*$/i;
export function isPhantom(text, voicedMs) {
  const t = String(text || '').trim();
  if (!t) return true;
  return voicedMs < 1500 && PHANTOMS.test(t);
}

// ── which replies are spoken whole ──────────────────────────────────────────
// The doctrine asks a lieutenant on a call for a short spoken answer first and
// the eyes-only detail in a second message. The first reply after he speaks is
// read whole; a later one in the same turn is read only if it is short, and
// otherwise announced, so a wall of detail is not recited down the phone.
export function spokenReply(cleaned, nth, { maxLater = 300 } = {}) {
  if (!cleaned) return '';
  if (nth === 0 || cleaned.length <= maxLater) return cleaned;
  return 'More details in the chat.';
}

// ── "câmbio": the end of his turn, said out loud ────────────────────────────
// In a noisy place silence never comes, so the turn ends on a WORD. The VAD
// only chunks; each chunk's transcript is appended to a buffer, and nothing is
// sent until the buffer ends with the keyword. Matching is on letters only,
// accent- and case-blind, over the last few words joined — so "Câmbio.",
// "cambio", "câmbio, câmbio" and a chunk boundary through it ("…cam" + "bio")
// all count. A multi-word keyword works the same way.
export function letters(s) {
  return String(s || '').normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase().replace(/[^a-z0-9]/g, '');
}

// The text with the keyword (repeated any number of times) taken off its end:
// {hit, text}. hit=false leaves the text alone.
const DANGLING = new Set(['o', 'a', 'os', 'as', 'um', 'uma', 'e', 'ou', 'entao', 'dai']);
// A keyword, or a list of them: their letters, empties dropped.
function keywordSet(keyword) {
  return (Array.isArray(keyword) ? keyword : [keyword]).map(letters).filter(Boolean);
}
// The last n words (n ≤ 4) ending at index i are one of the keywords: n, else 0.
function keywordAt(words, i, kws) {
  for (let n = 1; n <= Math.min(4, i + 1); n++) {
    if (kws.includes(letters(words.slice(i - n + 1, i + 1).join('')))) return n;
  }
  return 0;
}

export function takeKeyword(text, keyword) {
  const kws = keywordSet(keyword);
  const words = String(text || '').trim().split(/\s+/).filter(Boolean);
  if (!kws.length) return { hit: false, text: words.join(' ') };
  let hit = false;
  for (;;) {
    while (words.length && !letters(words[words.length - 1])) words.pop();   // a lone "." or "—"
    const took = words.length ? keywordAt(words, words.length - 1, kws) : 0;
    if (!took) break;
    words.splice(words.length - took, took);
    hit = true;
    // "…isso, o câmbio": the article or connector he said on the way to the
    // keyword belongs to it, not to the message
    while (words.length && DANGLING.has(letters(words[words.length - 1]))) words.pop();
  }
  const rest = words.join(' ').replace(/[\s,;:–—-]+$/, '').trim();
  return { hit, text: hit ? rest : words.join(' ') };
}

// The whole turn is heard again at every chunk, so the transcript can run past
// the keyword: "…se isso funciona, câmbio, contou até o sete". The turn ends at
// the LAST keyword that closes a phrase — at the very end, or with punctuation
// after it (Whisper writes the sign-off as "câmbio," / "câmbio."; "o câmbio do
// dólar" has none and is just a word). {hit, text, rest}: text is what is sent,
// rest what he said after it, which opens the next turn.
export function splitAtKeyword(text, keyword) {
  const kws = keywordSet(keyword);
  const words = String(text || '').trim().split(/\s+/).filter(Boolean);
  let last = words.length - 1;
  while (last >= 0 && !letters(words[last])) last--;
  if (kws.length) {
    for (let i = last; i >= 0; i--) {
      if (i !== last && !/[.,!?;:…]$/.test(words[i])) continue;
      if (!keywordAt(words, i, kws)) continue;
      const before = takeKeyword(words.slice(0, i + 1).join(' '), keyword);
      const rest = words.slice(i + 1).join(' ').replace(/^[\s.,;:!?…–—-]+/, '').trim();
      return { hit: true, text: before.text, rest: hasWords(rest) ? rest : '' };
    }
  }
  return { hit: false, text: words.join(' '), rest: '' };
}

// Something with words in it, as opposed to noise the engine wrote down.
export function hasWords(text) {
  return /\p{L}{2,}/u.test(String(text || ''));
}

// ── mute ────────────────────────────────────────────────────────────────────
// He mutes himself: nothing he says from then on is heard, and nothing heard
// before the press but not yet a whole utterance survives it. The replies keep
// playing. The microphone frames go through here on their way to the VAD; a
// muted call drops them, and every flip of the switch resets the VAD, so an
// utterance open at the press never ends (never sent) and the one after the
// unmute starts clean. The track is a plain object here: `apply` sets its
// `enabled`, and is called again on every fresh stream (remic), so mute
// outlives a device change. A new call makes a new one: it starts unmuted.
export function createMute(vad) {
  let muted = false;
  const M = {
    get muted() { return muted; },
    // true when it changed
    set(on, track) {
      on = !!on;
      if (on === muted) return false;
      muted = on;
      if (vad) vad.reset();
      M.apply(track);
      return true;
    },
    toggle(track) { return M.set(!muted, track); },
    apply(track) { if (track) track.enabled = !muted; },
    // one microphone frame: the VAD's event, or null (always null while muted)
    frame(db, now) { return muted || !vad ? null : vad.frame(db, now); },
  };
  return M;
}
