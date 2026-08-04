/* COPIED FILE. The original lives in tonylampada/chatterbox_server as
   console/speech.js, next to the bench page it was proven on. This is a copy,
   not a fork: fix it there, then bring the fix over. Two consumers — this board
   and a test page — is not worth a package and a registry, so the copy is the
   distribution channel, chosen deliberately.
   ponytail: `ui/js/speech.js` is a hand-copy of chatterbox_server's
   console/speech.js. Two copies drift. If a third consumer ever appears, that is
   the moment to publish it properly instead of copying again.
   ponytail: hold() — the keep-alive at the bottom — was written HERE first,
   against the captain's phone, and the copy upstream does not have it yet. It
   belongs in the original for the same reason the rest of this file does: it is
   about the audio session, not about the board. Carry it over there.

   speech.js — the speech path: one message, spoken out loud, on a phone whose
   screen is off. Import it, call speak(), and the three verbs work everywhere
   they are offered: on the page, on the lock screen, in the car.

   Nothing here is clever. Every line was found on a real iPhone, and the ORDER
   of the lines is most of what this module knows:

   · The sound leaves through an <audio> element fed by a MediaStream, not
     straight out of the AudioContext. To the OS an element playing is media
     playback and survives the screen locking; a bare page is suspended, and the
     AudioContext with it.
   · The element's play() happens inside the tap that asked for the speech,
     before the first await. iOS allows it nowhere else.
   · A VISIBLE transport is on screen for as long as the speech runs. WebKit
     hands the lock screen to a player it can see and takes it back from one it
     cannot — that is why the little bar below lives in here and not in a page.
   · pause freezes the context clock, and pauses the element FIRST, so nothing is
     being pulled while the clock stops (pull on a MediaStream with nothing new
     in it and the last fragment is chewed over and over — "lá lá lá" in the
     middle of a word). stop is the destructive one, and has to be: it aborts the
     request so the ENGINE stops synthesizing. An abandoned synthesis overlapping
     the next request is what kills voxcpm2's CUDA context.

   It speaks with the voice it is given, through the endpoint it is given. Both
   are arguments; neither has a default. When the engine refuses, the refusal is
   thrown to the caller — this module never quietly finds another way to speak. */

let ctx;              // the AudioContext, kept until it dies (see audio())
let sink;             // MediaStreamAudioDestinationNode — null once the browser refuses
let el;               // the <audio> the sound leaves through
let live = null;      // the speech in flight, or null

/* ── the visible transport ───────────────────────────────────────────────
   Up while speaking, gone when not. Plain on purpose: it is here to be seen by
   WebKit and pressed by a thumb, not admired. Its three buttons are the three
   verbs the lock screen has, wired to the same three functions, so pressing
   them on screen and pressing them on the lock screen are the same act.
   It borrows the page's palette if there is one, and stands on its own if not. */
const CSS = `
.speech-transport { position: fixed; left: 50%; transform: translateX(-50%); bottom: 1rem;
  display: flex; gap: .4rem; align-items: center; z-index: 5;
  background: var(--panel, #1c1815); border: 1px solid var(--line, #332b23);
  border-radius: 999px; padding: .4rem .5rem .4rem .9rem;
  box-shadow: 0 6px 20px rgba(0,0,0,.5); color: var(--text, #ede6d9);
  font: 15px/1.5 system-ui, sans-serif; }
.speech-transport[hidden] { display: none; }
.speech-transport .what { max-width: 40vw; overflow: hidden; text-overflow: ellipsis;
  white-space: nowrap; color: var(--muted, #9c9183);
  font: .75rem var(--mono, ui-monospace, Menlo, monospace); }
.speech-transport button { width: 2.2rem; height: 2.2rem; border-radius: 50%; cursor: pointer;
  background: var(--inset, #241d17); border: 1px solid var(--line, #332b23);
  color: inherit; font-size: .8rem; line-height: 1; padding: 0; }
.speech-transport button:hover { border-color: var(--signal, #e8a343); }
`;

let bar;
function transport(on, title) {
  if (!bar) {
    document.head.appendChild(document.createElement('style')).textContent = CSS;
    bar = document.createElement('div');
    bar.className = 'speech-transport';
    bar.innerHTML = `<span class="what"></span>
      <button type="button" title="play">▶</button>
      <button type="button" title="pause">❚❚</button>
      <button type="button" title="stop">■</button>`;
    const [play, pause_, stop_] = bar.querySelectorAll('button');
    play.onclick = resume; pause_.onclick = pause; stop_.onclick = stop;
    document.body.appendChild(bar);
  }
  bar.hidden = !on;
  if (on) bar.querySelector('.what').textContent = title || '';
}

/* ── the route to the speakers ───────────────────────────────────────── */

// The context, alive. An iOS audio-session interruption — the microphone taken
// by a Siri Shortcut, a call — can leave it PERMANENTLY dead: resume() resolves,
// state reads 'running', and nothing is ever heard from it again. The state
// field lies, so ask the clock instead: a running context whose currentTime did
// not move across real time is a corpse, and only a new one cures it. The sink
// is a node of the dead context and goes with it — openSink() then makes a fresh
// one and hands the element its stream again, which is what re-arms the element
// after the same interruption paused it.
// The window has to be SHORT and it has to be fresh. Sampling only inside
// speak() makes the baseline "the previous message", and a dictation happens
// exactly in that gap: the clock moved since the last message, so the verdict is
// "alive" and the first message back is silent. A heartbeat owns the sample
// instead, so the answer is never more than one beat old.
// sound.js holds the same rule in needsRebuild(); the numbers and the shape are
// deliberately identical, and the two have to be changed together. It is not
// imported because this file is a copy of chatterbox_server's (see the header)
// and must not grow a dependency on the board.
const BEAT_MS = 500;
let ctxTime = 0, ctxWall = 0, dead = false;
function beat() {
  if (!ctx) return;
  const wall = performance.now();
  dead = ctx.state === 'running' && wall - ctxWall >= 200 && ctx.currentTime - ctxTime <= 0;
  ctxTime = ctx.currentTime; ctxWall = wall;
}
setInterval(beat, BEAT_MS)?.unref?.();   // a timer is no reason to hold a process open

function audio() {
  if (ctx && dead) {
    try { ctx.close(); } catch {}
    ctx = undefined; sink = undefined;   // the sink is a node of the dead context
  }
  if (!ctx) {
    ctx = new (window.AudioContext || window.webkitAudioContext)();
    ctxTime = ctx.currentTime; ctxWall = performance.now(); dead = false;
  }
  return ctx;
}

// A fresh context is born suspended and iOS wants an activation to start it, so
// a gesture replaces the corpse too, not only speak(): a board message arrives
// with no tap behind it and has to find a context that is already alive. Capture
// phase and passive, the way sound.js primes its own; a no-op unless the last
// beat found the context dead. Optional call so the module still imports where
// there is no window to listen on.
// A held session is rebuilt here too: the tone's nodes belonged to the corpse
// and went with it, so the gesture that replaces the context is also what puts
// the tone back on the new one. humOn() is a no-op unless the switch is on.
for (const ev of ['click', 'pointerdown', 'touchstart', 'keydown'])
  window.addEventListener?.(ev, () => {
    if (!ctx || !dead) return;
    humLost();
    audio().resume().catch(() => {});
    humOn();
  }, { capture: true, passive: true });

// It renders nothing and has no controls of its own: the transport above is the
// player people see. This one is the player the OS sees.
function element() {
  if (!el) {
    el = document.createElement('audio');
    el.playsInline = true;
    document.body.appendChild(el);
  }
  return el;
}

// Refused (no autoplay, old browser) → the buffers go straight to the speakers,
// i.e. sound without the lock screen, never silence.
function openSink() {
  if (sink === null) return;                        // refused once, refused for good
  if (!sink) {
    if (!ctx.createMediaStreamDestination) { sink = null; return; }
    sink = ctx.createMediaStreamDestination();
  }
  // EVERY session, not just the one that made the sink. An element WebKit has
  // stopped will not play the stream it is already holding: play() resolves, no
  // error is thrown and nothing is heard — the element sits at paused with
  // readyState 4 while the context cheerfully renders into a sink no one is
  // listening to. The message runs its full length in silence and speak()
  // reports success, so the board has nothing to complain about either. Handing
  // it the stream again is what arms it; that is why closeSink() lets go.
  //
  // The board's own player did this before speech.js was extracted out of it —
  // a new stream per message, dropped at the end — and the extraction lost it.
  // The board then spoke exactly once per page load, and only the captain's
  // home-screen app showed it: in a plain tab the same code is forgiving.
  element().srcObject = sink.stream;
  element().play().catch(() => { sink = null; });   // blocked → the speakers
}

// Let the element go. Pausing alone is not enough in either direction: it leaves
// the lock screen showing a player for speech that is over, and it leaves the
// element holding a stream it will never play again (see openSink).
// Unless the session is being HELD (see below) — then not letting go is the
// whole point, and the keep-alive tone takes the element back instead.
function closeSink() {
  owned = false;
  transport(false);
  playbackState('none');
  if (held) { humOn(); return; }
  element().pause();
  element().srcObject = null;
}

/* ── holding the session open ────────────────────────────────────────────
   A session that is PRODUCING sound survives what an idle one does not. The
   Siri Shortcut that takes the microphone from a locked phone leaves an
   AudioContext that reads 'running' and never makes another sample, and iOS
   only accepts a gesture as the repair — which a locked screen cannot give.
   The one session observed to come through it was the one already speaking
   when the Shortcut arrived. So: while the switch is on, never be idle.

   Something, not nothing. A paused element is not playback to the OS, a muted
   one is not either, and an all-zero stream is a session iOS is free to take
   back. So it is a real tone through the SAME element the speech leaves
   through — the one property that must not break is that the page reads as a
   music player — at a frequency and a level no phone can reproduce.

   It yields the instant there is something to say: speak() silences it before
   the first buffer is queued and closeSink() brings it back when the last one
   has been heard, so nothing is ever mixed into the speech and nothing races
   it for the element. The speech path above is untouched.

   The switch is somebody else's (a settings toggle, off by default): this costs
   battery and keeps a player on the lock screen for as long as it runs. So is
   WHAT plays: hold() takes an optional source — a function handed this module's
   context and its sink, returning something with a stop() — because "the
   session must never go quiet" is this module's business and "what quiet sounds
   like" is not. The board hands it a slow ambient loop (ui/js/music.js) when
   the captain asks for one. With no source, it is the tone below, which is what
   this module holds to on its own. */
const HUM_HZ = 30;         // under the low end of any phone speaker
const HUM_GAIN = 0.0008;   // and far under its floor in level: samples, no sound
// A diagnostic, not a feature. "Is the tone still playing after the screen
// locks" is the question the whole design rests on, and inaudible by design
// means it can only be answered by inference. ?hum=loud makes it a hum a person
// can hear in a headphone, so the answer is heard instead of argued.
const LOUD = (() => { try { return new URLSearchParams(location.search).get('hum') === 'loud'; }
                      catch { return false; } })();
const humHz = () => LOUD ? 220 : HUM_HZ;
const humGain = () => LOUD ? 0.02 : HUM_GAIN;
let held = false;          // the switch
let source = null;         // what to hold WITH, or null for the tone below
let hum = null;            // whatever is holding the session, with its stop()
let owned = false;         // true from speak() until closeSink(): speech has the element

// The module's own default: one oscillator, one gain, no sound. Same shape as
// anything hold() is given — start it, and hand back the way to stop it.
function tone(c, dest) {
  const osc = c.createOscillator(), gain = c.createGain();
  osc.frequency.value = humHz();
  gain.gain.value = humGain();
  osc.connect(gain); gain.connect(dest);
  osc.start();
  return { stop() { try { osc.stop(); } catch {} osc.disconnect(); gain.disconnect(); } };
}

function humOn() {
  if (hum || !held || owned || sink === null) return;   // refused once, refused for good
  const c = audio();
  if (!c.createMediaStreamDestination) return;
  if (!sink) sink = c.createMediaStreamDestination();
  const mine = hum = (source || tone)(c, sink);
  if (c.state !== 'running') c.resume().catch(() => {});
  // It arms the element itself instead of calling openSink(), for the sake of
  // what happens when the browser says no. A refusal HERE is only a keep-alive
  // that could not start — the switch comes back on at page load with no
  // gesture behind it, and iOS wants one — so it lets the tone go and the next
  // gesture (see keepalivesettings.js) tries again. openSink()'s refusal means
  // something else entirely and must never be reached from here: it condemns
  // the page to the bare speakers, and with them to silence on a locked screen.
  // Letting go matters: a tone into an element that is not playing holds
  // nothing open, and a `hum` left standing would make every retry a no-op.
  element().srcObject = sink.stream;
  element().play().catch(() => { if (hum === mine) humOff(); });
}

// Silence whatever is holding and leave the element alone: whoever calls this
// either takes the element over (speak) or lets it go itself (hold(false)).
function humOff() {
  if (!hum) return;
  try { hum.stop(); } catch {}
  hum = null;
}

// The nodes belonged to a context that has been closed; there is nothing left
// to stop, only to forget.
function humLost() { hum = null; }

/* The switch itself. On: the element plays for as long as it is on, through
   speech and around it. Off: nothing is left behind — no tone, no element
   playing, no stream held, no context kept open on its account.

   `src` is what to hold with (see above); it is compared by identity, so a
   caller that hands the same function on every gesture — which is what the
   board's primer does — changes nothing, and one that hands a different one
   swaps what is playing without the session ever going quiet for a turn. */
export function hold(on, src) {
  const was = held, before = source;
  held = !!on;
  source = held ? (src || null) : null;
  if (held) { if (hum && source !== before) humOff(); humOn(); }
  else { humOff(); if (was && !owned) closeSink(); }
}
export function holding() { return held; }

/* ── the lock screen ─────────────────────────────────────────────────── */
function announce(title, artist) {
  const s = navigator.mediaSession;
  if (!s) return;
  if (window.MediaMetadata) s.metadata = new MediaMetadata({title, artist});
  s.playbackState = 'playing';
  const on = (a, fn) => { try { s.setActionHandler(a, fn); } catch {} };
  on('pause', pause);
  on('play', resume);
  on('stop', stop);
}

function playbackState(v) {
  if (navigator.mediaSession) navigator.mediaSession.playbackState = v;
}

/* ── the three verbs ─────────────────────────────────────────────────── */

// BOTH halves stop. Element first, then the clock.
export function pause() {
  if (sink) element().pause();
  ctx?.suspend();
  playbackState('paused');
}

// Back in the same order, inside out: the clock first, then the element.
export function resume() {
  ctx?.resume();
  if (sink) element().play().catch(() => {});
  playbackState('playing');
}

// Aborts the request, drops the queued buffers, lets the lock screen go. The
// speak() promise it belongs to resolves with whatever was heard.
export function stop() {
  if (!live) return;
  const s = live;
  live = null;
  s.ac.abort();
  ctx?.resume();                 // stopped while paused: no frozen clock left behind
  for (const src of s.srcs) { src.onended = null; try { src.stop(); } catch {} }
  s.srcs = [];
  closeSink();
}

/* ── speaking ────────────────────────────────────────────────────────── */

function pcmToWav(chunks, rate) {
  let len = chunks.reduce((a, c) => a + c.length, 0);
  len &= ~1;   // 16-bit samples — an odd trailing byte is not audio
  const buf = new ArrayBuffer(44 + len), v = new DataView(buf), u = new Uint8Array(buf);
  const w = (o, s) => { for (let i = 0; i < s.length; i++) v.setUint8(o + i, s.charCodeAt(i)); };
  w(0, 'RIFF'); v.setUint32(4, 36 + len, true); w(8, 'WAVEfmt ');
  v.setUint32(16, 16, true); v.setUint16(20, 1, true); v.setUint16(22, 1, true);
  v.setUint32(24, rate, true); v.setUint32(28, rate * 2, true);
  v.setUint16(32, 2, true); v.setUint16(34, 16, true);
  w(36, 'data'); v.setUint32(40, len, true);
  let o = 44;
  for (const c of chunks) { const n = Math.min(c.length, len - (o - 44)); u.set(c.subarray(0, n), o); o += n; }
  return new Blob([buf], {type: 'audio/wav'});
}

async function errText(r) {
  const txt = await r.text();
  try { return JSON.parse(txt).detail || JSON.parse(txt).error || txt; } catch { return txt; }
}

/* Speak one message, live: each PCM chunk is queued into the AudioContext the
   moment it arrives, so sound starts on the first chunk.

   Call it from inside the tap that asked for it — everything iOS insists on
   seeing there happens before the first await.

     url            the engine's speech endpoint. Required, no default: whether
                    it is a proxy on this origin or the engine itself is the
                    caller's decision, and it should be a deliberate one.
     voice          the voice id to speak with. Required, no default: an empty
                    voice means "whatever the engine feels like", which is how a
                    board ends up speaking English in a Portuguese room.
     input          the text.
     params         engine knobs, passed through untouched (optional).
     title, artist  what the lock screen and the transport say (optional).
     onFirstSound   called with the ms to first audible chunk (optional).

   Resolves when the stream is over with {blob, bytes, rate, ttfs, stopped} —
   the same audio as a WAV, replayable. Rejects if the engine refuses or the
   network fails, with .status carrying the HTTP status when there was one. */
export async function speak({url, voice, input, params, title, artist, onFirstSound}) {
  if (!url) throw new Error('speak() needs the engine url — there is no default');
  if (!voice) throw new Error('speak() needs a voice — there is no default');
  stop();                     // one voice at a time
  owned = true;               // the element is the speech's now…
  humOff();                   // …and the keep-alive tone is out of its way
  audio();                    // a corpse from an interruption is replaced here
  openSink();                 // before any await: iOS only allows play() inside the tap
  announce(title, artist);
  transport(true, title);
  const s = live = {ac: new AbortController(), srcs: [], pending: 0, over: false};
  // Anything but 'running' needs the resume: iOS parks it in 'interrupted'
  // (not 'suspended') when the screen locks, and that is silence too.
  if (ctx.state !== 'running') await ctx.resume().catch(() => {});

  const t0 = performance.now();
  const chunks = [];
  let bytes = 0, rate = 24000, ttfs = null, stopped = false;
  try {
    const r = await fetch(url, {method: 'POST', signal: s.ac.signal,
      headers: {'Content-Type': 'application/json'},
      body: JSON.stringify({input, voice, stream: true, ...(params ? {params} : {})})});
    if (!r.ok) throw Object.assign(new Error(await errText(r)), {status: r.status});
    rate = parseInt(r.headers.get('x-sample-rate')) || 24000;
    const reader = r.body.getReader();
    let carry = null, nextAt = 0;
    for (;;) {
      const {done, value} = await reader.read();
      if (done) break;
      if (!value?.length) continue;
      if (ttfs == null) { ttfs = performance.now() - t0; onFirstSound?.(ttfs); }
      chunks.push(value); bytes += value.length;
      let b = value;
      if (carry) {
        b = new Uint8Array(carry.length + value.length);
        b.set(carry); b.set(value, carry.length); carry = null;
      }
      const even = b.length & ~1;
      if (b.length > even) carry = b.slice(even);
      if (!even) continue;
      const a = b.slice(0, even);        // fresh buffer — aligned for Int16
      const i16 = new Int16Array(a.buffer, 0, even >> 1);
      const abuf = ctx.createBuffer(1, i16.length, rate);
      const ch = abuf.getChannelData(0);
      for (let i = 0; i < i16.length; i++) ch[i] = i16[i] / 32768;
      const src = ctx.createBufferSource();
      src.buffer = abuf;
      src.connect(sink || ctx.destination);
      const at = Math.max(ctx.currentTime, nextAt);   // seamless queue
      src.start(at);
      nextAt = at + abuf.duration;
      // The element stays playing until the last buffer has actually been heard —
      // the stream can run dry mid-sentence and pick up again, and that gap is not
      // the end. Only "no buffers left AND nothing more coming" is.
      s.pending++;
      src.onended = () => { if (--s.pending === 0 && s.over) closeSink(); };
      s.srcs.push(src);
    }
  } catch (err) {
    // stop() aborted us: that is an answer, not a failure. Anything else is the
    // caller's to know about — this module has no second way to speak.
    if (err.name !== 'AbortError' && !s.ac.signal.aborted) {
      if (live === s) live = null;
      closeSink();
      throw err;
    }
    stopped = true;
  }
  if (live === s) {
    s.over = true;              // nothing more is coming; the last buffer ends it
    if (!s.pending) closeSink();  // …or it already did
  }
  return {blob: bytes ? pcmToWav(chunks, rate) : null, bytes, rate, ttfs, stopped};
}
