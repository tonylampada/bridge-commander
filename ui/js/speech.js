/* COPIED FILE. The original lives in tonylampada/chatterbox_server as
   console/speech.js, next to the bench page it was proven on. This is a copy,
   not a fork: fix it there, then bring the fix over. Two consumers — this board
   and a test page — is not worth a package and a registry, so the copy is the
   distribution channel, chosen deliberately.
   ponytail: `ui/js/speech.js` is a hand-copy of chatterbox_server's
   console/speech.js. Two copies drift. If a third consumer ever appears, that is
   the moment to publish it properly instead of copying again.

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
// not keep up with real time is a corpse, and only a new one cures it. The sink
// is a node of the dead context and goes with it — openSink() then makes a fresh
// one and hands the element its stream again, which is what re-arms the element
// after the same interruption paused it.
// KEPT UP, not merely moved: currentTime is real time for a running context, so
// a clock holding less than half of the window it was measured across stopped
// somewhere inside it, however long that window was. Sampling only inside speak()
// makes the window "since the previous message" and asks the weaker question, and
// a dictation happens exactly in that gap: the clock moved since the last
// message, verdict "alive", and the first message back is silent.
// The beating is ARMED, not eternal: nothing takes the audio session while the
// page sits still, so the moments that could have taken it (a gesture, the page
// coming back) start the watch, and the first beat that sees the clock keeping up
// stops it. An idle page runs no timer.
// sound.js holds the same rule in needsRebuild() and the same watch around it;
// the numbers and the shape are deliberately identical, and the two have to be
// changed together. It is not imported because this file is a copy of
// chatterbox_server's (see the header) and must not grow a dependency on the board.
const BEAT_MS = 500;
let ctxTime = 0, ctxWall = 0, dead = false, watch = null;
// The verdict is sticky — only a new context cures a corpse, so only audio()
// clears it. The return is "this window is proof of life", which stops the watch.
function beat() {
  if (!ctx) return false;
  const wall = performance.now(), advance = ctx.currentTime - ctxTime, real = wall - ctxWall;
  if (ctx.state === 'running' && real >= 200 && advance * 1000 <= real / 2) dead = true;
  ctxTime = ctx.currentTime; ctxWall = wall;
  return !dead && advance > 0;
}
// Start a window over, judging nothing: pause() suspends the context on purpose
// and a suspended clock is SUPPOSED to be frozen, so a window containing one of
// those says nothing about anything and is thrown away rather than answered.
function rebase() { if (ctx) { ctxTime = ctx.currentTime; ctxWall = performance.now(); } }
function disarm() { if (watch) clearInterval(watch); watch = null; }
function look() { if (beat() || dead || !ctx) disarm(); }
// a timer is no reason to hold a process open
function watching() { if (!watch) { watch = setInterval(look, BEAT_MS); watch?.unref?.(); } }
// Arming closes the window since the last look, however long it has been: the
// shortfall answers for a long window too, which is what lets the watch sleep
// between the moments that could take the session. If it comes back "alive" the
// watch still runs on — a clock can always stop a moment after being looked at.
function arm() { if (!ctx) return; beat(); if (dead) disarm(); else watching(); }

function audio() {
  if (ctx && dead) {
    try { ctx.close(); } catch {}
    ctx = undefined; sink = undefined;   // the sink is a node of the dead context
  }
  if (!ctx) {
    ctx = new (window.AudioContext || window.webkitAudioContext)();
    ctxTime = ctx.currentTime; ctxWall = performance.now(); dead = false;
    watching();      // a newborn context is unproven until a beat has seen it run
  }
  return ctx;
}

// A fresh context is born suspended and iOS wants an activation to start it, so
// a gesture replaces the corpse too, not only speak(): a board message arrives
// with no tap behind it and has to find a context that is already alive. Capture
// phase and passive, the way sound.js primes its own. It arms the watch first,
// so the verdict this tap acts on covers the wait the tap just ended. Optional
// call so the module still imports where there is no window to listen on.
for (const ev of ['click', 'pointerdown', 'touchstart', 'keydown'])
  window.addEventListener?.(ev, () => { arm(); if (ctx && dead) audio().resume().catch(() => {}); },
    { capture: true, passive: true });

// The page leaving and coming back are the other pair: the baseline is taken at
// the moment of leaving, so returning measures the clock across exactly the
// interruption — a Shortcut taking the microphone happens in that window and
// nowhere else. Nothing is watched while the page is away; the timer would be
// throttled there anyway.
document.addEventListener?.('visibilitychange', () => {
  if (!ctx) return;
  if (document.hidden) { rebase(); disarm(); return; }
  arm();
  if (dead) audio().resume().catch(() => {});
});

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
function closeSink() {
  element().pause();
  element().srcObject = null;
  transport(false);
  playbackState('none');
}

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

// Back in the same order, inside out: the clock first, then the element. The
// pause the clock just came out of is not evidence of anything, so the window it
// sat in goes with it.
export function resume() {
  ctx?.resume();
  rebase();
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
  ctx?.resume(); rebase();       // stopped while paused: no frozen clock left behind
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
  audio();                    // a corpse from an interruption is replaced here
  openSink();                 // before any await: iOS only allows play() inside the tap
  announce(title, artist);
  transport(true, title);
  const s = live = {ac: new AbortController(), srcs: [], pending: 0, over: false};
  // Anything but 'running' needs the resume: iOS parks it in 'interrupted'
  // (not 'suspended') when the screen locks, and that is silence too. Whatever
  // it was parked in froze the clock legitimately, so the window ends there.
  if (ctx.state !== 'running') { await ctx.resume().catch(() => {}); rebase(); }

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
