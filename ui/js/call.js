// call.js — call mode: the captain talks to one lieutenant hands-free, like a
// phone call. The microphone stays open; when he stops talking the take goes to
// STT and its words go to the lieutenant marked `via: 'call'`; every message
// the lieutenant sends back during the call is cleaned for the ear, cut into
// sentences and spoken in its own voice, sentence 2 synthesizing while sentence
// 1 plays. He talks over it and it stops.
//
// What the call DECIDES — the cleaner, the splitter, the VAD, the state machine,
// the filler rule — is in callcore.js and is tested there. This file is the
// hardware and the screen around it, and it holds three rules of its own:
//
// · ONE synthesis in flight, ever. Pipelining here means the next sentence is
//   requested when the previous request ENDS, which on voxcpm2 is long before its
//   audio has been heard — never two requests at once. Two concurrent generations
//   on one GPU is what killed the engine before (see speech.js).
// · Everything iOS wants inside the tap happens before the first await in
//   startCall(): the AudioContext is made and resumed, a silent buffer is
//   played. getUserMedia comes after, and its prompt is the permission prompt.
// · No call survives the page being hidden. iOS gives a hidden page no
//   microphone, so a locked screen ENDS the call, and coming back says so.
import { api } from './api.js';
import { lieutenant, lieutenantByActor, lieutenantAvatar, render, USER } from './state.js';
import { avatarHtml } from './avatars.js';
import { esc } from './util.js';
import { addPending } from './pending.js';
import { push as toast } from './toast.js';
import { speechEngine, voiceFor, setAutoSpeakGate, stopSpeaking } from './voice.js';
import {
  cleanForCall, splitSentences, createVad, rmsDb, nextCallState, createFillerPolicy,
  FILLER_PHRASES, turnLegs, encodeWav16k, isPhantom, spokenReply,
} from './callcore.js';

const STT_ROUTE = '/api/stt/transcribe';
const LANG = 'pt';
const PREROLL_MS = 800;     // audio kept from before the VAD said "start" (covers the barge hold)
const TAIL_KEEP_MS = 250;   // trailing silence sent with the take (the rest is dead air)
const FILLERS_CACHED = 3;
// Tuning without a deploy: localStorage['bc-call'] = '{"hangMs":700,"fillerMs":2500}'
// Any VAD_DEFAULTS key, plus fillerMs and debug.
function tuning() {
  try { return JSON.parse(localStorage.getItem('bc-call') || '{}') || {}; } catch (e) { return {}; }
}

let call = null;          // the live call, or null
let endedHidden = false;  // the last call was ended by the page going away
const turns = [];         // every finished turn's legs, newest last (window.bcCallTurns)
if (typeof window !== 'undefined') window.bcCallTurns = turns;

export function callActive() { return !!call; }
export function callWith() { return call ? call.ltId : null; }

// ── the speaker ─────────────────────────────────────────────────────────────
// A queue of sentences, synthesized one request at a time, each chunk scheduled
// on the context clock right behind the last one: gapless across sentences,
// because the next request starts while the previous audio is still playing.
function createPlayer(ctx, out) {
  const P = {
    queue: [],        // [{text, voice, onFirst}]
    srcs: new Set(),
    nextAt: 0,
    ac: null,         // the request in flight
    gen: 0,           // bumped by stop(): anything older is stale
    held: false,      // he is talking: nothing new starts
    pumping: false,
    onIdle: null,
  };
  P.busy = () => P.pumping || P.srcs.size > 0;

  function schedule(f32, rate, gen) {
    if (gen !== P.gen || !f32.length) return null;
    const b = ctx.createBuffer(1, f32.length, rate);
    b.getChannelData(0).set(f32);
    const src = ctx.createBufferSource();
    src.buffer = b;
    src.connect(out);
    const at = Math.max(ctx.currentTime + 0.03, P.nextAt);
    src.start(at);
    P.nextAt = at + b.duration;
    P.srcs.add(src);
    src.onended = () => { P.srcs.delete(src); idleCheck(); };
    return at;
  }
  function idleCheck() {
    if (!P.pumping && !P.srcs.size && !(P.queue.length && !P.held) && P.onIdle) P.onIdle();
  }

  // One sentence: stream the PCM in, schedule each chunk as it lands.
  async function playOne(item, gen) {
    const ac = P.ac = new AbortController();
    let first = true;
    await pcm(item.text, item.voice, ac.signal, (f32, rate) => {
      const at = schedule(f32, rate, gen);
      if (at != null && first) {
        first = false;
        if (item.onFirst) {
          const wait = Math.max(0, (at - ctx.currentTime) * 1000);
          setTimeout(() => { if (gen === P.gen) item.onFirst(performance.now()); }, wait);
        }
      }
    });
    if (P.ac === ac) P.ac = null;
  }

  async function pump() {
    if (P.pumping) return;
    P.pumping = true;
    const gen = P.gen;
    try {
      while (P.queue.length && !P.held && gen === P.gen) {
        const item = P.queue.shift();
        try { await playOne(item, gen); }
        catch (e) {
          if (gen !== P.gen || (e && e.name === 'AbortError')) break;
          call && call.note('speech failed: ' + why(e));
        }
      }
    } finally {
      P.pumping = false;
      if (gen !== P.gen && P.queue.length && !P.held) pump();   // stop() then say() raced us
      else idleCheck();
    }
  }

  P.say = (sentences, voice, onFirst) => {
    sentences.forEach((text, i) => P.queue.push({ text, voice, onFirst: i === 0 ? onFirst : null }));
    if (!P.held) pump();
  };
  // A buffer already in hand (a filler): straight onto the clock.
  P.playBuffer = (buf) => {
    const src = ctx.createBufferSource();
    src.buffer = buf;
    src.connect(out);
    const at = Math.max(ctx.currentTime + 0.02, P.nextAt);
    src.start(at);
    P.nextAt = at + buf.duration;
    P.srcs.add(src);
    src.onended = () => { P.srcs.delete(src); idleCheck(); };
  };
  // Barge-in: silence now, drop everything queued, abort the synthesis.
  P.stop = () => {
    P.gen++;
    P.queue.length = 0;
    if (P.ac) { try { P.ac.abort(); } catch (e) {} P.ac = null; }
    for (const s of P.srcs) { s.onended = null; try { s.stop(); } catch (e) {} }
    P.srcs.clear();
    P.nextAt = 0;
  };
  P.hold = (on) => { P.held = !!on; if (!on && P.queue.length) pump(); };
  return P;
}

// One synthesis, streamed: onChunk(Float32Array, rate) per piece. Serialized
// across the whole call by `lock` — the one-request rule.
let lock = Promise.resolve();
function pcm(text, voice, signal, onChunk) {
  const run = lock.then(() => pcmNow(text, voice, signal, onChunk));
  lock = run.catch(() => {});
  return run;
}
async function pcmNow(text, voice, signal, onChunk) {
  if (signal && signal.aborted) throw Object.assign(new Error('aborted'), { name: 'AbortError' });
  const eng = call && call.engine;
  if (!eng) throw new Error('no speech engine');
  const r = await fetch(eng.url + '/v1/audio/speech', {
    method: 'POST', signal, headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(Object.assign({ input: text, voice, stream: true },
      eng.params && Object.keys(eng.params).length ? { params: eng.params } : {})),
  });
  if (!r.ok) throw new Error('TTS HTTP ' + r.status);
  const rate = parseInt(r.headers.get('x-sample-rate'), 10) || 24000;
  const reader = r.body.getReader();
  let carry = null;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    if (!value || !value.length) continue;
    let b = value;
    if (carry) { b = new Uint8Array(carry.length + value.length); b.set(carry); b.set(value, carry.length); carry = null; }
    const even = b.length & ~1;
    if (b.length > even) carry = b.slice(even);
    if (!even) continue;
    const i16 = new Int16Array(b.slice(0, even).buffer);
    const f = new Float32Array(i16.length);
    for (let i = 0; i < i16.length; i++) f[i] = i16[i] / 32768;
    onChunk(f, rate);
  }
}

// ── the screen ──────────────────────────────────────────────────────────────
const LABEL = {
  listening: 'listening', capturing: 'hearing you', sending: 'sending', thinking: 'thinking',
  speaking: 'speaking', ended: 'call ended',
};
function buildView(lt) {
  const v = document.createElement('div');
  v.id = 'call-view';
  v.className = 'call-view';
  v.setAttribute('role', 'dialog');
  v.setAttribute('aria-label', 'call with ' + (lt.name || lt.id));
  const av = avatarHtml(lieutenantAvatar(lt.id), 'call-avatar');
  v.innerHTML =
    '<div class="call-top"><span class="call-clock">00:00</span><span class="call-tag">📞 call</span></div>' +
    '<div class="call-who">' + (av || '<span class="call-avatar call-avatar-none">' + esc((lt.name || lt.id).slice(0, 1).toUpperCase()) + '</span>') +
    '<div class="call-name">' + esc(lt.name || lt.id) + '</div></div>' +
    '<div class="call-state" aria-live="polite"><span class="call-dot"></span><span class="call-label">connecting…</span></div>' +
    '<div class="call-meter" aria-hidden="true"><span></span></div>' +
    '<div class="call-lines"><div class="call-heard"></div><div class="call-said"></div></div>' +
    '<div class="call-note" hidden></div>' +
    '<div class="call-stats"></div>' +
    '<button type="button" class="call-hangup" title="hang up">✕</button>';
  document.body.appendChild(v);
  return {
    root: v,
    clock: v.querySelector('.call-clock'),
    label: v.querySelector('.call-label'),
    meter: v.querySelector('.call-meter span'),
    heard: v.querySelector('.call-heard'),
    said: v.querySelector('.call-said'),
    note: v.querySelector('.call-note'),
    stats: v.querySelector('.call-stats'),
    hangup: v.querySelector('.call-hangup'),
  };
}

// ── the call ────────────────────────────────────────────────────────────────

// Called from the 📞 tap. Synchronous up to getUserMedia, on purpose.
export function startCall(ltId) {
  if (call) return endCall('hangup');
  const lt = lieutenant(ltId);
  if (!lt) return;
  const AC = window.AudioContext || window.webkitAudioContext;
  if (!AC) return toast({ emoji: '📞', text: 'this browser has no Web Audio — no calls here' });
  // iOS: the session must be play-and-record BEFORE the mic opens, or the
  // speaker drops to the earpiece and the reply is a whisper.
  try { if (navigator.audioSession) navigator.audioSession.type = 'play-and-record'; } catch (e) {}
  const ctx = new AC();
  try { ctx.resume(); } catch (e) {}
  // a silent buffer inside the gesture: the unlock iOS wants for later playback
  try {
    const s = ctx.createBufferSource();
    s.buffer = ctx.createBuffer(1, 1, 22050);
    s.connect(ctx.destination);
    s.start(0);
  } catch (e) {}
  endedHidden = false;
  stopSpeaking();     // the board's own reader goes quiet for the call

  const tune = tuning();
  const out = ctx.createGain();
  out.connect(ctx.destination);
  const c = call = {
    ltId, target: 'lieutenant:' + ltId, ctx, out, state: 'idle',
    view: buildView(lt),
    vad: createVad(tune),
    filler: createFillerPolicy({ delayMs: tune.fillerMs || 3000 }),
    fillers: [],          // decoded AudioBuffers
    player: null,
    engine: null, voice: '',
    stream: null, src: null, proc: null, sink: null,
    pre: [], take: null,  // pre-roll frames; the take being captured
    awaiting: false,
    turn: null,           // the turn being timed
    nth: 0,               // replies seen in this turn
    seen: new Set(), started: Date.now(), timer: null,
    debug: !!tune.debug,
    note(msg) { c.view.note.textContent = msg || ''; c.view.note.hidden = !msg; },
  };
  c.player = createPlayer(ctx, out);
  c.player.onIdle = () => { if (call === c && c.state === 'speaking') go('done'); };
  c.view.hangup.onclick = () => endCall('hangup');
  c.timer = setInterval(() => {
    const s = Math.floor((Date.now() - c.started) / 1000);
    c.view.clock.textContent = String(Math.floor(s / 60)).padStart(2, '0') + ':' + String(s % 60).padStart(2, '0');
    tickFiller();
  }, 250);
  // everything already in the chat is history, not something to say
  for (const m of lt.chat || []) c.seen.add(msgKey(m));
  setAutoSpeakGate((who) => call === c && isFrom(who, c.ltId));
  document.body.classList.add('in-call');
  syncButton();
  open(c);
}

async function open(c) {
  const md = navigator.mediaDevices;
  if (!md || !md.getUserMedia) {
    return fail(c, typeof isSecureContext !== 'undefined' && !isSecureContext
      ? 'no microphone outside https — open the board over https to call'
      : 'this browser gives no microphone here — open the board in Safari to call');
  }
  c.view.label.textContent = 'allow the microphone…';
  let stream;
  try {
    stream = await md.getUserMedia({ audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true, channelCount: 1 } });
  } catch (e) {
    return fail(c, e && e.name === 'NotAllowedError'
      ? 'microphone permission refused — allow it for this site, then call again'
      : 'no microphone: ' + why(e));
  }
  if (call !== c) { stream.getTracks().forEach((t) => t.stop()); return; }
  c.stream = stream;
  const [eng, voice] = await Promise.all([speechEngine(), voiceFor(c.ltId)]);
  if (call !== c) return;
  c.engine = eng;
  c.voice = voice;
  if (!eng) c.note('no speech engine — replies will not be spoken');
  else if (!voice) c.note('no voice chosen for this lieutenant — pick one in settings');
  try { await c.ctx.resume(); } catch (e) {}

  c.src = c.ctx.createMediaStreamSource(stream);
  // ScriptProcessor, not a worklet: deprecated, but it is the one that runs on
  // every Safari the captain might have, and 1024 frames is ~21ms of VAD grain.
  c.proc = c.ctx.createScriptProcessor(1024, 1, 1);
  c.sink = c.ctx.createGain();
  c.sink.gain.value = 0;
  c.src.connect(c.proc);
  c.proc.connect(c.sink);
  c.sink.connect(c.ctx.destination);   // a processor nobody listens to is never run
  const frameMs = 1024 / c.ctx.sampleRate * 1000;
  const preMax = Math.ceil(PREROLL_MS / frameMs);
  c.proc.onaudioprocess = (e) => {
    if (call !== c) return;
    const f = new Float32Array(e.inputBuffer.getChannelData(0));
    const db = rmsDb(f);
    meter(c, db);
    if (c.take) c.take.frames.push(f);
    else { c.pre.push(f); if (c.pre.length > preMax) c.pre.shift(); }
    c.vad.setBarge(c.player.busy());
    const ev = c.vad.frame(db, performance.now());
    if (ev) onVad(c, ev, frameMs);
  };
  go('start');
  if (voice && eng) cacheFillers(c);
}

function fail(c, msg) {
  if (call !== c) return;
  c.view.label.textContent = 'cannot call';
  c.view.root.dataset.state = 'ended';
  c.note(msg);
}

function go(ev) {
  const c = call;
  if (!c) return;
  const was = c.state;
  c.state = nextCallState(c.state, ev, { awaiting: c.awaiting });
  if (c.state === was) return;
  c.view.root.dataset.state = c.state;
  c.view.label.textContent = LABEL[c.state] || c.state;
  // a reply that landed while he was talking (held) starts when he stops
  c.player.hold(c.state === 'capturing' || c.state === 'sending');
  if ((c.state === 'listening' || c.state === 'thinking') && c.player.queue.length) go('reply');
  if (c.debug) console.info('[call]', was, '--' + ev + '->', c.state);
}

function onVad(c, ev, frameMs) {
  if (ev.type === 'start') {
    // barge-in: whatever is playing stops now and what is queued is dropped
    if (c.player.busy()) c.player.stop();
    c.filler.cancel();
    const keep = Math.ceil((performance.now() - ev.at) / frameMs) + Math.ceil(150 / frameMs);
    c.take = { frames: c.pre.slice(-keep), rate: c.ctx.sampleRate };
    c.pre = [];
    go('speech');
    return;
  }
  const take = c.take;
  c.take = null;
  if (!take) return;
  if (ev.type === 'drop') { go('drop'); return; }
  // end: cut the dead air the VAD had to wait through, keep a breath of it
  const extra = Math.floor((performance.now() - ev.lastVoice - TAIL_KEEP_MS) / frameMs);
  if (extra > 0) take.frames.splice(Math.max(0, take.frames.length - extra), extra);
  c.turn = { lastVoice: ev.lastVoice, vadEnd: performance.now() };
  go('end');
  deliver(c, take, ev.voicedMs, c.turn);
}

async function deliver(c, take, voicedMs, turn) {
  let text = '';
  try {
    const wav = encodeWav16k(take.frames, take.rate);
    const fd = new FormData();
    fd.append('file', new Blob([wav], { type: 'audio/wav' }), 'call.wav');
    fd.append('language', LANG);
    const r = await fetch(STT_ROUTE, { method: 'POST', body: fd });
    if (!r.ok) throw new Error('HTTP ' + r.status);
    const d = await r.json();
    text = typeof d.text === 'string' ? d.text.trim() : '';
  } catch (e) {
    if (call !== c) return;
    c.note('transcription failed: ' + why(e));
    return go('failed');
  }
  if (call !== c) return;
  turn.sttDone = performance.now();
  if (isPhantom(text, voicedMs)) {
    if (c.debug) console.info('[call] dropped phantom', JSON.stringify(text));
    return go('failed');
  }
  c.view.heard.textContent = '“' + text + '”';
  c.note('');
  try {
    await api.feedback(c.target, text, [], 'call');
  } catch (e) {
    if (call !== c) return;
    c.note('not delivered — ' + why(e));
    return go('failed');
  }
  if (call !== c) return;
  turn.posted = performance.now();
  addPending(c.target, text, []);
  render();
  c.awaiting = true;
  c.nth = 0;
  c.filler.sent(performance.now());
  if (c.state === 'sending') go('sent');
}

function tickFiller() {
  const c = call;
  if (!c || c.state !== 'thinking' || !c.fillers.length) return;
  if (!c.filler.due(performance.now())) return;
  if (c.player.busy()) return;
  c.player.playBuffer(c.fillers[c.filler.pick(c.fillers.length)]);
  if (c.debug) console.info('[call] filler played');
}

// A few fillers, synthesized at call start in the lieutenant's voice. One at a
// time and only while nothing else wants the engine, so a real reply never
// queues behind "deixa eu ver".
async function cacheFillers(c) {
  const pool = FILLER_PHRASES.slice().sort(() => Math.random() - 0.5).slice(0, FILLERS_CACHED);
  for (const text of pool) {
    while (call === c && (c.awaiting || c.player.busy() || c.state === 'capturing' || c.state === 'sending')) {
      await new Promise((r) => setTimeout(r, 400));
    }
    if (call !== c) return;
    const parts = [];
    let rate = 24000;
    try {
      await pcm(text, c.voice, null, (f, r) => { parts.push(f); rate = r; });
    } catch (e) { if (c.debug) console.info('[call] filler synthesis failed', why(e)); return; }
    if (call !== c) return;
    const n = parts.reduce((a, p) => a + p.length, 0);
    if (!n) continue;
    const buf = c.ctx.createBuffer(1, n, rate);
    const ch = buf.getChannelData(0);
    let o = 0;
    for (const p of parts) { ch.set(p, o); o += p.length; }
    c.fillers.push(buf);
    if (c.debug) console.info('[call] filler cached', text, buf.duration.toFixed(2) + 's');
  }
}

function meter(c, db) {
  const pct = Math.max(0, Math.min(100, (db + 70) * (100 / 55)));
  c.view.meter.style.width = pct.toFixed(0) + '%';
}

// ── the lieutenant answering ────────────────────────────────────────────────
function msgKey(m) { return m.ts + '|' + m.author + '|' + m.text; }
function isFrom(who, ltId) {
  if (!who || who === USER) return false;
  if (who === ltId || who === 'lieutenant:' + ltId) return true;
  const l = lieutenantByActor(who);
  return !!l && l.id === ltId;
}

// Every board payload, from main.js. New messages from the lieutenant on the
// call are spoken; everything else is the board's business.
export function callBoard(doc) {
  const c = call;
  if (!c || !doc) return;
  const lt = (doc.lieutenants || []).find((l) => l.id === c.ltId);
  if (!lt) return endCall('gone');
  for (const m of lt.chat || []) {
    const k = msgKey(m);
    if (c.seen.has(k)) continue;
    c.seen.add(k);
    if (!isFrom(m.author, c.ltId) || (m.cmd && typeof m.cmd === 'object')) continue;
    onReply(c, m);
  }
}

function onReply(c, m) {
  const now = performance.now();
  const turn = c.turn;
  if (turn && turn.reply == null && turn.posted != null) turn.reply = now;
  c.awaiting = false;
  c.filler.replied();
  const text = spokenReply(cleanForCall(m.text), c.nth++);
  c.view.said.textContent = text;
  if (!text || !c.engine || !c.voice) return;
  const sentences = splitSentences(text);
  c.player.say(sentences, c.voice, (t) => {
    if (!turn || turn.firstAudio != null || turn.reply == null) return;
    turn.firstAudio = t;
    report(c, turn);
  });
  go('reply');
}

function report(c, turn) {
  const legs = turnLegs(turn);
  turns.push(legs);
  if (turns.length > 50) turns.shift();
  const f = (x) => (x == null ? '–' : (x / 1000).toFixed(2) + 's');
  c.view.stats.textContent = 'VAD ' + f(legs.vad) + ' · STT ' + f(legs.stt) + ' · send ' + f(legs.post) +
    ' · lieutenant ' + f(legs.lieutenant) + ' · TTS ' + f(legs.tts) + ' — ours ' + f(legs.ours);
  console.info('[call] turn', legs);
}

// ── hanging up ──────────────────────────────────────────────────────────────
export function endCall(reason) {
  const c = call;
  if (!c) return;
  call = null;
  c.state = 'ended';
  clearInterval(c.timer);
  try { c.player.stop(); } catch (e) {}
  if (c.proc) { c.proc.onaudioprocess = null; try { c.proc.disconnect(); } catch (e) {} }
  try { c.src && c.src.disconnect(); } catch (e) {}
  if (c.stream) c.stream.getTracks().forEach((t) => { try { t.stop(); } catch (e) {} });
  try { c.ctx.close(); } catch (e) {}
  c.view.root.remove();
  document.body.classList.remove('in-call');
  setAutoSpeakGate(null);
  endedHidden = reason === 'hidden';
  syncButton();
}

// iOS gives a hidden page no microphone. End the call rather than sit on a
// dead one, and say why the moment he is back.
if (typeof document !== 'undefined' && document.addEventListener) {
  document.addEventListener('visibilitychange', () => {
    if (document.hidden) { if (call) endCall('hidden'); return; }
    if (endedHidden) {
      endedHidden = false;
      toast({ emoji: '📞', text: 'the call ended when the screen locked — tap 📞 to call again' });
    }
  });
  window.addEventListener('pagehide', () => { if (call) endCall('hidden'); });
}

// ── the header button ───────────────────────────────────────────────────────
let btn = null;
let ready = false;
api.config().then((cfg) => { ready = !!(cfg && cfg.stt && cfg.tts); syncButton(); }, () => {});
// chat.js hands over the button and the lieutenant the header is showing.
export function mountCallButton(el, currentLt) {
  btn = el;
  btn.onclick = () => {
    const lt = currentLt();
    if (call) endCall('hangup'); else if (lt) startCall(lt.id);
  };
  syncButton();
}
export function syncButton(show) {
  if (!btn) return;
  if (show !== undefined) btn.dataset.show = show ? '1' : '';
  btn.hidden = !ready || !btn.dataset.show;
  btn.textContent = call ? '✕' : '📞';
  btn.title = call ? 'hang up' : 'call this lieutenant (hands-free)';
  btn.classList.toggle('live', !!call);
}

function why(e) { return String((e && e.message) || e); }
