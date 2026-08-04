// sound.js — zero-dependency WebAudio synth palette for notifications.
// No audio files: every tone is oscillators + a short gain envelope. The
// AudioContext is created lazily and resumed on the first real user gesture
// anywhere on the page (the same autoplay-gate dance voice.js does for
// speechSynthesis), so a later programmatic play() from an SSE event isn't
// silently blocked by the browser.
let ctx = null, master = null, comp = null, volume = 0.85;

// Ask whether it is RUNNING, not which way it is broken: Chrome parks a
// backgrounded context in 'suspended', iOS Safari moves it to 'interrupted'
// when the screen locks, and WebKit is free to invent a third. 'closed' is the
// one dead end — resume() can never bring it back.
export const needsResume = (state) => state !== 'running' && state !== 'closed';
// resume() rejects on iOS when there is no gesture behind it. Stay silent and
// leave every recovery path armed for the next try.
const wake = (c) => { if (c && needsResume(c.state)) c.resume().catch(() => {}); };

// …and sometimes there is nothing to wake. An iOS audio-session interruption (a
// Siri Shortcut taking the microphone, a call) can leave the context PERMANENTLY
// dead: resume() resolves, state reads 'running', and not one sample ever comes
// out of it again. So do not ask the state field, it lies — ask the clock. A
// running context whose currentTime did not move across real time is a corpse,
// and the only cure is the one a page reload performs: build a new one.
export const needsRebuild = (state, ctxAdvance, realMs) =>
  state === 'running' && realMs >= 200 && ctxAdvance <= 0;

// "Across a SHORT wait" is the whole of it. Comparing against whenever this
// module last happened to look answers a different question — "did the clock
// move at any point since then" — and a context that ran for a moment and died
// inside that window answers it "alive". That is exactly the dictation: the
// last look is before the Shortcut takes the microphone, so the tone goes into
// the corpse and the cure arrives one tap too late.
// So nobody's call site owns the baseline: a heartbeat does, and it is never
// more than one beat old. Beats only ever set the verdict — the replacement
// itself waits for a gesture, because iOS wants one to start the new context.
const BEAT_MS = 500;
let lastTime = 0, lastWall = 0, dead = false, watch = null;
function beat() {
  if (!ctx || !watch) return;
  const wall = performance.now();
  dead = needsRebuild(ctx.state, ctx.currentTime - lastTime, wall - lastWall);
  lastTime = ctx.currentTime; lastWall = wall;
}

// The switch this watch was always waiting for. It used to beat for the life of
// every page, on a page that is nearly always fine and on a phone where it costs
// battery — the KNOWN HACK that stood here. The cure that was tried first (arm
// the watch around the moments that could take the audio session, disarm it once
// the clock keeps up) was built and REVERTED: it dropped the hidden media
// element around the moment the screen locks, and that element is the only
// reason iOS keeps this page alive with the screen off. Speech stopped
// mid-sentence on lock. See the revert of cb2622e for what was tried.
//
// So it is not a cleverer watch, it is the captain's switch — the same one that
// holds the audio session open from his pocket (keepalive.js). ON: the corpse
// left by a Siri Shortcut is found within a beat and the next gesture replaces
// it. OFF: nothing beats, and a page behaves exactly as it did before any of
// this existed — which is the right trade for a desktop tab, where no Shortcut
// ever takes the audio session away.
export function setCorpseWatch(on) {
  if (!!on === !!watch) return;
  if (on) {
    // A fresh baseline: a sample from before the watch was off answers a
    // question about a window nobody was watching.
    lastTime = ctx ? ctx.currentTime : 0; lastWall = performance.now();
    dead = false;
    watch = setInterval(beat, BEAT_MS);
    watch?.unref?.();                  // a timer is no reason to hold a process open
  } else {
    clearInterval(watch); watch = null;
    dead = false;                      // no verdict outlives the watch that made it
  }
}

function ensureCtx() {
  if (ctx) return ctx;
  const AC = window.AudioContext || window.webkitAudioContext;
  if (!AC) return null;
  try {
    ctx = new AC();
    // Recover the moment iOS allows it, instead of finding out at the next tone.
    ctx.onstatechange = () => wake(ctx);
    master = ctx.createGain(); master.gain.value = volume;
    comp = ctx.createDynamicsCompressor();
    comp.threshold.value = -14; comp.knee.value = 26; comp.ratio.value = 3.2;
    comp.attack.value = 0.003; comp.release.value = 0.25;
    master.connect(comp); comp.connect(ctx.destination);
    lastTime = ctx.currentTime; lastWall = performance.now(); dead = false;
  } catch (e) { ctx = null; master = null; }
  return ctx;
}

// The context every caller should use: the live one, or a replacement for the
// corpse the last heartbeat found. The rebuild goes back through ensureCtx() so
// the graph (master at the current volume, the compressor, the wiring) can never
// drift from the original. It takes no sample of its own — the window belongs to
// the heartbeat, and a call landing just after a beat must not shrink it.
function liveCtx() {
  const c = ensureCtx();
  if (!c || !dead) return c;
  try { c.close(); } catch (e) {}
  ctx = master = comp = null;
  return ensureCtx();
}
// The notification volume, and who else it governs. Every tone here reads it
// through `master` at the moment it plays, so a tone needs no telling — but the
// keep-alive music (keepalive.js, music.js) is one long sound in ANOTHER
// context's graph, playing while the slider is being dragged, and it has to
// follow the slider live rather than at the next pass of the loop.
const watchers = [];
export const getVolume = () => volume;
export function onVolume(fn) { watchers.push(fn); }
export function setVolume(v) {
  volume = Math.max(0, Math.min(1, Number(v)));
  if (master) master.gain.value = volume;
  for (const fn of watchers) { try { fn(volume); } catch (e) {} }
}
// one voice: oscillator through an attack/decay gain envelope, optional pitch glide
function voice(t0, { freq, freqTo, type = 'sine', dur = 0.3, peak = 0.3, attack = 0.006 }) {
  const o = ctx.createOscillator(), g = ctx.createGain();
  o.type = type; o.frequency.setValueAtTime(freq, t0);
  if (freqTo) o.frequency.exponentialRampToValueAtTime(Math.max(1, freqTo), t0 + dur);
  g.gain.setValueAtTime(0.0001, t0);
  g.gain.linearRampToValueAtTime(peak, t0 + attack);
  g.gain.exponentialRampToValueAtTime(0.0001, t0 + dur);
  o.connect(g); g.connect(master);
  o.start(t0); o.stop(t0 + dur + 0.04);
}
// a bell = fundamental + inharmonic partials decaying together
function bell(t0, { freq, dur = 0.8, peak = 0.32, partials = [[1,1],[2.0,0.5],[2.76,0.28],[5.4,0.12]], type = 'sine' }) {
  partials.forEach(([mult, amp]) => voice(t0, { freq: freq * mult, type, dur: dur * (0.6 + 0.4/mult), peak: peak * amp }));
}
const N = { C4:261.63,D4:293.66,E4:329.63,F4:349.23,G4:392,A4:440,B4:493.88,C5:523.25,D5:587.33,E5:659.25,F5:698.46,G5:783.99,A5:880,B5:987.77,C6:1046.5,D6:1174.7,E6:1318.5,G6:1568 };

const PALETTE = {
  'chime':      t => { bell(t,{freq:N.C5,dur:.5,peak:.3}); bell(t+.1,{freq:N.G5,dur:.66,peak:.28}); },
  'ding':       t => bell(t,{freq:N.A5,dur:.9,peak:.34,partials:[[1,1],[2.76,0.3],[5.2,0.12]]}),
  'bell-tower': t => bell(t,{freq:N.G4,dur:1.1,peak:.34,partials:[[1,1],[2.0,0.5],[2.94,0.3],[4.2,0.16],[5.4,0.1]]}),
  'crystal':    t => { bell(t,{freq:N.E6,dur:.7,peak:.22,partials:[[1,1],[2.76,0.4],[5.4,0.2]],type:'triangle'}); voice(t,{freq:N.E6*4,type:'sine',dur:.4,peak:.04}); },
  'glass':      t => bell(t,{freq:N.B5,dur:.55,peak:.26,partials:[[1,1],[3.1,0.35],[6.2,0.12]],type:'triangle'}),
  'harp':       t => [N.C5,N.E5,N.G5].forEach((f,i)=>voice(t+i*.055,{freq:f,type:'triangle',dur:.5,peak:.24,attack:.004})),
  'bloom':      t => { voice(t,{freq:N.C5,type:'sine',dur:.5,peak:.26,attack:.06}); voice(t,{freq:N.G5,type:'sine',dur:.5,peak:.16,attack:.09}); },
  'halo':       t => { voice(t,{freq:N.E5,type:'triangle',dur:.6,peak:.2,attack:.08}); voice(t,{freq:N.B5,type:'sine',dur:.6,peak:.1,attack:.12}); },
  'modem':      t => { voice(t,{freq:N.C5,type:'square',dur:.06,peak:.16}); voice(t+.07,{freq:N.G5,type:'square',dur:.06,peak:.16}); voice(t+.14,{freq:N.E5,type:'square',dur:.08,peak:.16}); },
  'tri-tap':    t => [0,.1,.2].forEach(d=>voice(t+d,{freq:N.E6,type:'sine',dur:.05,peak:.28,attack:.001})),
  'rise':       t => [N.C5,N.E5,N.G5].forEach((f,i)=>voice(t+i*.08,{freq:f,type:'sine',dur:.24,peak:.28})),
  'descend':    t => [N.G5,N.E5,N.C5].forEach((f,i)=>voice(t+i*.08,{freq:f,type:'sine',dur:.24,peak:.28})),
  'coin':       t => { voice(t,{freq:N.B5,type:'square',dur:.07,peak:.2}); voice(t+.08,{freq:N.E6,type:'square',dur:.3,peak:.18}); },
  'fanfare':    t => { [N.C5,N.G5].forEach(f=>voice(t,{freq:f,type:'triangle',dur:.5,peak:.2})); voice(t+.12,{freq:N.C6,type:'triangle',dur:.5,peak:.22}); },
  'success':    t => { voice(t,{freq:N.E5,type:'sine',dur:.14,peak:.3}); voice(t+.11,{freq:N.A5,type:'sine',dur:.3,peak:.3}); },
  'alert':      t => [0,.12,.24].forEach(d=>voice(t+d,{freq:N.B5,type:'square',dur:.09,peak:.24})),
  'alarm':      t => [0,.16,.32].forEach(d=>{voice(t+d,{freq:N.A5,type:'sawtooth',dur:.13,peak:.2}); voice(t+d,{freq:N.A5*1.5,type:'sawtooth',dur:.13,peak:.08});}),
};
export const SOUND_NAMES = Object.keys(PALETTE).concat('none');
export const SOUND_LABELS = { 'chime':'Chime','ding':'Ding','bell-tower':'Bell Tower','crystal':'Crystal','glass':'Glass','harp':'Harp','bloom':'Bloom','halo':'Halo','modem':'Modem','tri-tap':'Tri-tap','rise':'Rise','descend':'Descend','coin':'Coin','fanfare':'Fanfare','success':'Success','alert':'Alert','alarm':'Alarm','none':'Off' };

// Fail silently on any audio hazard (no context, suspended and can't resume,
// unknown name) — this is called from the SSE event path and must never throw.
// Chrome starts (and re-suspends, e.g. on tab background) the AudioContext in
// 'suspended' state; scheduling a tone into a suspended context is silently
// dropped, so resume first and only schedule once it's actually running.
export function play(name) {
  if (!name || name === 'none') return;
  const fn = PALETTE[name];
  if (!fn) return;
  const c = liveCtx();
  if (!c) return;
  const run = () => { try { fn(c.currentTime + 0.02); } catch (e) {} };
  if (needsResume(c.state)) { c.resume().then(run).catch(() => {}); }
  else run();
}

// Global gesture primer: the first gesture anywhere unlocks the audio context
// ahead of time, so the FIRST real notification (which rides no gesture of
// its own) can still play instead of being silently dropped. Attached in the
// capture phase (runs before target handlers) across several gesture types,
// because the board's first click is often a control like the gear icon that
// calls stopPropagation() — a bubble-phase window listener would miss it.
// It stays attached for the life of the page: the context can die again long
// after the first gesture (screen lock), and a gesture must always be able to
// unlock it. A no-op when the context is already running.
// A fresh context is born suspended and iOS wants a gesture to start it, so the
// primer is also where a corpse gets replaced: capture phase means this runs
// BEFORE the handler of the ▶ that was tapped, and that play() gets the new one.
function primeOnGesture() { wake(liveCtx()); }
for (const ev of ['click', 'keydown', 'pointerdown', 'touchstart']) window.addEventListener(ev, primeOnGesture, { capture: true, passive: true });

// Re-resume proactively on refocus so the next notification after a
// backgrounded tab (or a locked phone) isn't the one that eats the latency.
// The beat comes first: iOS throttles timers on a page it has put away, so the
// sample waiting on return can be from before the interruption. Burning it here
// means the verdict is one beat away instead of two.
document.addEventListener('visibilitychange', () => { if (!document.hidden && ctx) { beat(); wake(liveCtx()); } });
