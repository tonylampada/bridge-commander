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
  FILLER_PHRASES, turnLegs, encodeWav16k, isPhantom, spokenReply, takeKeyword, hasWords,
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
let endedAway = false;    // the last call was ended by a long absence
const AWAY_MAX_MS = 60000; // hidden longer than this ends the call; shorter pauses and resumes
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
  // Turned down, not off: a barge-in on probation (see onVad).
  P.duck = (on) => {
    try { out.gain.setTargetAtTime(on ? 0.15 : 1, ctx.currentTime, 0.03); } catch (e) { out.gain.value = on ? 0.15 : 1; }
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
    '<div class="call-top"><span class="call-clock">00:00</span><span class="call-mic"></span><span class="call-tag">📞 call</span></div>' +
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
    mic: v.querySelector('.call-mic'),
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
  endedAway = false;
  stopSpeaking();     // the board's own reader goes quiet for the call

  const tune = tuning();
  // How his turn ends. 'keyword' (default): the VAD only chunks, and the turn
  // is over when what he said ends with the keyword. 'silence': the VAD's
  // trailing silence ends it, as in the first version — useless in a noisy room.
  const mode = tune.endMode === 'silence' ? 'silence' : 'keyword';
  // Keyword mode chunks short and never holds a chunk long, so in a room the
  // VAD can never call quiet the keyword still gets transcribed within seconds.
  const vadOpts = Object.assign(mode === 'keyword' ? { hangMs: 600, maxUtteranceMs: 6000 } : {}, tune);
  const out = ctx.createGain();
  out.connect(ctx.destination);
  const c = call = {
    ltId, target: 'lieutenant:' + ltId, ctx, out, state: 'idle',
    mode,
    keyword: tune.keyword || 'câmbio',
    cancelWord: tune.cancelWord || 'cancela',
    buffer: '',           // keyword mode: what he has said this turn, not yet sent
    turnFrames: [], turnVoiced: 0, frozen: '', turnGen: 0,   // …and the audio it was heard from
    chain: Promise.resolve(),   // segment transcripts are handled in the order spoken
    view: buildView(lt),
    vad: createVad(vadOpts),
    filler: createFillerPolicy({ delayMs: tune.fillerMs || 3000 }),
    fillers: [],          // decoded AudioBuffers
    player: null,
    engine: null, voice: '',
    stream: null, src: null, proc: null, sink: null, frameMs: 21,
    pre: [], take: null,  // pre-roll frames; the take being captured
    awaiting: false,
    turn: null,           // the turn being timed
    nth: 0,               // replies seen in this turn
    seen: new Set(), started: Date.now(), timer: null,
    paused: false, hiddenAt: 0, awayTimer: null,
    debug: !!tune.debug,
    note(msg) { c.view.note.textContent = msg || ''; c.view.note.hidden = !msg; },
  };
  c.player = createPlayer(ctx, out);
  c.player.onIdle = () => { if (call === c && c.state === 'speaking') go('done'); };
  c.view.hangup.onclick = (e) => { e.stopPropagation(); endCall('hangup'); };
  // the buffered transcript is his to throw away with a tap
  c.view.heard.onclick = (e) => { e.stopPropagation(); if (c.mode === 'keyword') clearBuffer(c, 'cleared'); };
  // any tap on the call view also wakes an audio session iOS left interrupted
  c.view.root.addEventListener('click', () => { try { c.ctx.resume(); } catch (e) {} });
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
  showBuffer(c);
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
  try {
    await attachMic(c);
  } catch (e) {
    return fail(c, e && e.name === 'NotAllowedError'
      ? 'microphone permission refused — allow it for this site, then call again'
      : 'no microphone: ' + why(e));
  }
  if (call !== c) return;
  const [eng, voice] = await Promise.all([speechEngine(), voiceFor(c.ltId)]);
  if (call !== c) return;
  c.engine = eng;
  c.voice = voice;
  if (!eng) c.note('no speech engine — replies will not be spoken');
  else if (!voice) c.note('no voice chosen for this lieutenant — pick one in settings');
  try { await c.ctx.resume(); } catch (e) {}
  if (md.addEventListener) md.addEventListener('devicechange', c.onDevices = () => deviceChanged(c));
  go('start');
  if (voice && eng) cacheFillers(c);
}

// The microphone into the graph. Called again whenever the input may have
// changed under us (AirPods put in, the track ended, back from a screen-off):
// a new stream, the old one let go, the processor kept.
async function attachMic(c) {
  const stream = await navigator.mediaDevices.getUserMedia({
    audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true, channelCount: 1 },
  });
  if (call !== c) { stream.getTracks().forEach((t) => t.stop()); return; }
  const old = c.stream, oldSrc = c.src;
  c.stream = stream;
  c.src = c.ctx.createMediaStreamSource(stream);
  if (!c.proc) {
    // ScriptProcessor, not a worklet: deprecated, but it is the one that runs on
    // every Safari the captain might have, and 1024 frames is ~21ms of VAD grain.
    c.proc = c.ctx.createScriptProcessor(1024, 1, 1);
    c.sink = c.ctx.createGain();
    c.sink.gain.value = 0;
    c.proc.connect(c.sink);
    c.sink.connect(c.ctx.destination);   // a processor nobody listens to is never run
    c.frameMs = 1024 / c.ctx.sampleRate * 1000;
    const preMax = Math.ceil(PREROLL_MS / c.frameMs);
    c.proc.onaudioprocess = (e) => {
      if (call !== c || c.paused) return;
      const f = new Float32Array(e.inputBuffer.getChannelData(0));
      const db = rmsDb(f);
      meter(c, db);
      if (c.take) c.take.frames.push(f);
      else { c.pre.push(f); if (c.pre.length > preMax) c.pre.shift(); }
      c.vad.setBarge(c.player.busy() && !(c.take && c.take.confirmed));
      const ev = c.vad.frame(db, performance.now());
      if (ev) onVad(c, ev);
    };
  }
  c.src.connect(c.proc);
  if (oldSrc) { try { oldSrc.disconnect(); } catch (e) {} }
  if (old) old.getTracks().forEach((t) => { try { t.stop(); } catch (e) {} });
  const track = stream.getAudioTracks()[0];
  if (track) track.addEventListener('ended', () => { if (call === c && c.stream === stream) remic(c, 'the microphone went away'); });
  c.view.mic.textContent = track && track.label ? '🎙 ' + track.label : '';
  c.take = null; c.pre = [];
  c.vad.reset();
}

let remicking = null;
async function remic(c, why_) {
  if (remicking) return remicking;
  remicking = attachMic(c).then(
    () => { if (c.debug) console.info('[call] mic re-acquired:', why_); },
    (e) => { if (call === c) c.note('microphone lost: ' + why(e)); },
  ).finally(() => { remicking = null; });
  return remicking;
}

// AirPods in or out: the OS moves the default input, but a stream already open
// keeps the old one. Settle for a moment (a Bluetooth handover fires several
// events), then take a fresh stream if the default input is not the one we hold.
function deviceChanged(c) {
  clearTimeout(c.devTimer);
  c.devTimer = setTimeout(async () => {
    if (call !== c || c.paused) return;
    const held = c.stream && c.stream.getAudioTracks()[0];
    let label = '';
    try {
      const ins = (await navigator.mediaDevices.enumerateDevices()).filter((d) => d.kind === 'audioinput');
      const def = ins.find((d) => d.deviceId === 'default') || ins[0];
      label = def ? def.label : '';
    } catch (e) {}
    const heldLabel = held ? held.label : '';
    if (held && held.readyState === 'live' && label && (label === heldLabel || label.endsWith(heldLabel))) return;
    remic(c, 'input device changed');
  }, 600);
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
  c.view.label.textContent = c.paused ? 'paused' : LABEL[c.state] || c.state;
  // a reply that landed while he was talking (held) starts when he stops
  c.player.hold(c.state === 'capturing' || c.state === 'sending');
  if ((c.state === 'listening' || c.state === 'thinking') && c.player.queue.length) go('reply');
  if (c.debug) console.info('[call]', was, '--' + ev + '->', c.state);
}

function onVad(c, ev) {
  const frameMs = c.frameMs;
  if (ev.type === 'start') {
    c.filler.cancel();
    const keep = Math.ceil((performance.now() - ev.at) / frameMs) + Math.ceil(150 / frameMs);
    c.take = { frames: c.pre.slice(-keep), rate: c.ctx.sampleRate, barge: false, confirmed: false };
    c.pre = [];
    if (c.player.busy()) {
      // Barge-in, on probation: in a noisy room a burst of sound is not him.
      // The reply ducks at once, and only words stop it — a quick STT of the
      // first second confirms, or the whole segment does if it ends first.
      c.take.barge = true;
      c.player.duck(true);
      if (c.debug) console.info('[call] barge-in on probation: ducked');
      const take = c.take;
      take.probe = setTimeout(() => probeBarge(c, take), BARGE_PROBE_MS);
    } else {
      go('speech');
    }
    return;
  }
  const take = c.take;
  c.take = null;
  if (!take) return;
  clearTimeout(take.probe);
  // a barge still on probation never left 'speaking'; words decide later
  take.probation = take.barge && !take.confirmed;
  if (ev.type === 'drop') {
    if (take.probation) c.player.duck(false);
    else go('drop');
    return;
  }
  // end: cut the dead air the VAD had to wait through, keep a breath of it
  const extra = Math.floor((performance.now() - ev.lastVoice - TAIL_KEEP_MS) / frameMs);
  if (extra > 0) take.frames.splice(Math.max(0, take.frames.length - extra), extra);
  const timing = { lastVoice: ev.lastVoice, vadEnd: performance.now() };
  // The state moves NOW, not when the words come back: by then he may be
  // talking again, and that newer take owns the state. Silence mode: the turn
  // is over. Keyword mode: back to listening while this chunk transcribes.
  if (!take.probation) go(c.mode === 'silence' ? 'end' : 'drop');
  // Keyword mode re-hears the whole turn (below); a lone chunk is all the
  // other cases need. Either way, handled in the order spoken.
  if (c.mode === 'keyword' && !take.probation) {
    c.chain = c.chain.then(() => turnHeard(c, take, ev.voicedMs, timing));
    return;
  }
  const heard = transcribe(take.frames, take.rate);
  c.chain = c.chain.then(() => heard).then(
    (text) => segment(c, take, text, ev.voicedMs, timing),
    (e) => {
      if (call !== c) return;
      c.note('transcription failed: ' + why(e));
      if (take.probation && !take.confirmed) c.player.duck(false);
      else if (c.mode === 'silence') go('failed');
    },
  );
}

const BARGE_PROBE_MS = 700;
// Words in the first second of the barge → it is him: stop the reply.
async function probeBarge(c, take) {
  if (call !== c || take.confirmed || c.take !== take) return;
  let text = '';
  try { text = await transcribe(take.frames.slice(), take.rate); } catch (e) { return; }
  if (call !== c || take.confirmed) return;
  if (hasWords(text) && !isPhantom(text, 0)) confirmBarge(c, take);
}
function confirmBarge(c, take) {
  if (take.confirmed) return;
  take.confirmed = true;
  c.player.stop();
  c.player.duck(false);
  if (c.debug) console.info('[call] barge-in confirmed');
  go('speech');
}
function unprobe(c, take) {
  if (take.barge && !take.confirmed) c.player.duck(false);
}

async function transcribe(frames, rate) {
  const wav = encodeWav16k(frames, rate);
  const fd = new FormData();
  fd.append('file', new Blob([wav], { type: 'audio/wav' }), 'call.wav');
  fd.append('language', LANG);
  const r = await fetch(STT_ROUTE, { method: 'POST', body: fd });
  if (!r.ok) throw new Error('STT HTTP ' + r.status);
  const d = await r.json();
  return typeof d.text === 'string' ? d.text.trim() : '';
}

// One segment's words, in order. Noise is dropped (and a barge on probation
// is let go); words confirm a barge; then the mode decides what words mean.
function segment(c, take, text, voicedMs, timing) {
  if (call !== c) return;
  timing.sttDone = performance.now();
  const words = hasWords(text) && !isPhantom(text, voicedMs);
  if (take.probation) {
    if (!words && !take.confirmed) {
      if (c.debug) console.info('[call] barge-in was noise: back to full volume', JSON.stringify(text));
      c.player.duck(false);
      return;
    }
    confirmBarge(c, take);                    // idempotent: the probe may have got there first
    go(c.mode === 'silence' ? 'end' : 'drop');
  }
  if (!words) {
    if (c.debug) console.info('[call] dropped noise', JSON.stringify(text));
    if (c.mode === 'silence') go('failed');
    return;
  }
  if (c.mode === 'silence') return deliver(c, text, timing);
  return turnHeard(c, take, voicedMs, timing);
}

// Keyword mode. Each chunk's audio joins the turn's, and the WHOLE turn is
// transcribed again: a lone "Câmbio." is under a second of sound and Whisper,
// with no context, hears "Quem viu?"; at the end of the sentence it belongs to
// it is heard right, and a word cut across two chunks is whole again. A turn
// longer than TURN_WINDOW_MS freezes its text and starts a fresh window, so
// the re-hearing never grows without bound.
const TURN_WINDOW_MS = 25000;
async function turnHeard(c, take, voicedMs, timing) {
  const gen = c.turnGen;
  for (const f of take.frames) c.turnFrames.push(f);
  c.turnVoiced += voicedMs;
  let text = '';
  try { text = await transcribe(c.turnFrames.slice(), take.rate); } catch (e) {
    if (call === c) c.note('transcription failed: ' + why(e));
    return;
  }
  if (call !== c || gen !== c.turnGen) return;     // cleared or sent while the engine listened
  timing.sttDone = performance.now();
  if (!hasWords(text) || isPhantom(text, c.turnVoiced)) text = '';
  const full = [c.frozen, text].filter(Boolean).join(' ');
  if (takeKeyword(full, c.cancelWord).hit) return clearBuffer(c, 'cancelled');
  const k = takeKeyword(full, c.keyword);
  if (k.hit) {
    resetTurn(c);
    showBuffer(c);
    if (!k.text) return;                    // "câmbio" with nothing before it
    go('commit');
    return deliver(c, k.text, timing);
  }
  c.buffer = full;
  showBuffer(c);
  const ms = c.turnFrames.reduce((a, f) => a + f.length, 0) / take.rate * 1000;
  if (ms > TURN_WINDOW_MS) { const keep = c.buffer; resetTurn(c); c.frozen = c.buffer = keep; }
}
function resetTurn(c) {
  c.turnGen++;
  c.turnFrames = [];
  c.turnVoiced = 0;
  c.frozen = '';
  c.buffer = '';
}

function clearBuffer(c, how) {
  resetTurn(c);
  showBuffer(c);
  c.note(how === 'cancelled' ? 'cancelled — nothing sent' : '');
}

function showBuffer(c) {
  if (c.mode !== 'keyword') return;
  const h = c.view.heard;
  h.classList.toggle('buffer', !!c.buffer);
  h.innerHTML = c.buffer
    ? esc(c.buffer) + '<span class="call-hint">say “' + esc(c.keyword) + '” to send · tap or say “' + esc(c.cancelWord) + '” to clear</span>'
    : '<span class="call-hint">end with “' + esc(c.keyword) + '” to send</span>';
}

async function deliver(c, text, timing) {
  c.turn = timing;
  if (c.mode === 'silence') c.view.heard.textContent = '“' + text + '”';
  else c.view.said.textContent = '';
  c.note(c.mode === 'keyword' ? 'sent: “' + text + '”' : '');
  try {
    await api.feedback(c.target, text, [], 'call');
  } catch (e) {
    if (call !== c) return;
    c.note('not delivered — ' + why(e));
    return go('failed');
  }
  if (call !== c) return;
  timing.posted = performance.now();
  addPending(c.target, text, []);
  render();
  c.awaiting = true;
  c.nth = 0;
  c.filler.sent(performance.now());
  go('sent');
}

function tickFiller() {
  const c = call;
  if (!c || c.paused || c.state !== 'thinking' || !c.fillers.length) return;
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
  clearTimeout(c.awayTimer);
  clearTimeout(c.devTimer);
  if (c.take) clearTimeout(c.take.probe);
  try { c.player.stop(); } catch (e) {}
  if (c.onDevices && navigator.mediaDevices.removeEventListener) navigator.mediaDevices.removeEventListener('devicechange', c.onDevices);
  if (c.proc) { c.proc.onaudioprocess = null; try { c.proc.disconnect(); } catch (e) {} }
  try { c.src && c.src.disconnect(); } catch (e) {}
  if (c.stream) c.stream.getTracks().forEach((t) => { try { t.stop(); } catch (e) {} });
  try { c.ctx.close(); } catch (e) {}
  c.view.root.remove();
  document.body.classList.remove('in-call');
  setAutoSpeakGate(null);
  endedAway = reason === 'away';
  syncButton();
  if (endedAway && !document.hidden) awayToast();
}
function awayToast() {
  endedAway = false;
  toast({ emoji: '📞', text: 'the call ended — the screen was off for over ' + AWAY_MAX_MS / 1000 + 's. Tap 📞 to call again' });
}

// ── screen off, page hidden ─────────────────────────────────────────────────
// Holding the phone to his ear blanks the screen (proximity) and iOS hides the
// page, which takes the microphone with it. A short absence PAUSES the call —
// nothing heard is acted on — and coming back resumes it, re-taking the mic if
// iOS let go of it. Only a long absence ends the call, and he is told so.
function pause(c) {
  if (c.paused) return;
  c.paused = true;
  c.hiddenAt = Date.now();
  if (c.take) { clearTimeout(c.take.probe); if (c.take.barge && !c.take.confirmed) c.player.duck(false); }
  c.take = null; c.pre = [];
  c.view.label.textContent = 'paused';
  c.awayTimer = setTimeout(() => { if (call === c && c.paused) endCall('away'); }, AWAY_MAX_MS);
  if (c.debug) console.info('[call] paused');
}
async function resume(c) {
  if (!c.paused) return;
  clearTimeout(c.awayTimer);
  if (Date.now() - c.hiddenAt > AWAY_MAX_MS) return endCall('away');
  c.paused = false;
  try { await c.ctx.resume(); } catch (e) {}
  const t = c.stream && c.stream.getAudioTracks()[0];
  if (!t || t.readyState !== 'live' || t.muted) await remic(c, 'back from a pause');
  if (call !== c) return;
  c.vad.reset();
  c.view.label.textContent = LABEL[c.state] || c.state;
  c.note(c.ctx.state === 'running' ? '' : 'tap anywhere to bring the sound back');
  if (c.debug) console.info('[call] resumed after', Date.now() - c.hiddenAt, 'ms; audio', c.ctx.state);
}

if (typeof document !== 'undefined' && document.addEventListener) {
  document.addEventListener('visibilitychange', () => {
    if (document.hidden) { if (call) pause(call); return; }
    if (call) resume(call);
    else if (endedAway) awayToast();
  });
  window.addEventListener('pagehide', (e) => { if (call) { if (e.persisted) pause(call); else endCall('hangup'); } });
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
