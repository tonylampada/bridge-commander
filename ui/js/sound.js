// sound.js — zero-dependency WebAudio synth palette for notifications.
// No audio files: every tone is oscillators + a short gain envelope. The
// AudioContext is created lazily and resumed on the first real user gesture
// anywhere on the page (the same autoplay-gate dance voice.js does for
// speechSynthesis), so a later programmatic play() from an SSE event isn't
// silently blocked by the browser.
let ctx = null;
let master = null;
let volume = 0.7;

function ensureCtx() {
  if (ctx) return ctx;
  const AC = window.AudioContext || window.webkitAudioContext;
  if (!AC) return null;
  try {
    ctx = new AC();
    master = ctx.createGain();
    master.gain.value = volume;
    master.connect(ctx.destination);
  } catch (e) { ctx = null; master = null; }
  return ctx;
}

export function setVolume(v) {
  volume = Math.max(0, Math.min(1, Number(v)));
  if (master) master.gain.value = volume;
}

// One short note: an oscillator through its own attack/decay gain envelope,
// optionally sweeping frequency (freqTo), routed into the shared master gain.
function note(t0, { freq, freqTo, dur = 0.15, type = 'sine', peak = 0.22 }) {
  const osc = ctx.createOscillator();
  const g = ctx.createGain();
  osc.type = type;
  osc.frequency.setValueAtTime(freq, t0);
  if (freqTo) osc.frequency.exponentialRampToValueAtTime(freqTo, t0 + dur);
  g.gain.setValueAtTime(0.0001, t0);
  g.gain.linearRampToValueAtTime(peak, t0 + 0.012);
  g.gain.exponentialRampToValueAtTime(0.0001, t0 + dur);
  osc.connect(g);
  g.connect(master);
  osc.start(t0);
  osc.stop(t0 + dur + 0.03);
}

const PALETTE = {
  // pleasant two-note rise
  chime(t0) {
    note(t0, { freq: 523.25, dur: 0.16, peak: 0.22 });      // C5
    note(t0 + 0.11, { freq: 783.99, dur: 0.26, peak: 0.2 }); // G5
  },
  // single soft bell, with a quiet overtone for shimmer
  ding(t0) {
    note(t0, { freq: 880, dur: 0.5, peak: 0.2 });
    note(t0, { freq: 1760, dur: 0.32, peak: 0.05 });
  },
  // short, unobtrusive
  blip(t0) {
    note(t0, { freq: 1200, dur: 0.07, type: 'square', peak: 0.14 });
  },
  // two low taps — "someone knocking"
  knock(t0) {
    note(t0, { freq: 130, dur: 0.09, peak: 0.3 });
    note(t0 + 0.15, { freq: 112, dur: 0.1, peak: 0.3 });
  },
  // urgent triple beep
  alert(t0) {
    [0, 0.11, 0.22].forEach((d) => note(t0 + d, { freq: 988, dur: 0.09, type: 'square', peak: 0.26 }));
  },
  // classic two-note "coin" pickup
  coin(t0) {
    note(t0, { freq: 988, dur: 0.08, type: 'square', peak: 0.18 });
    note(t0 + 0.08, { freq: 1319, dur: 0.28, type: 'square', peak: 0.16 });
  },
};

export const SOUND_NAMES = Object.keys(PALETTE).concat('none');

// Fail silently on any audio hazard (no context, suspended and can't resume,
// unknown name) — this is called from the SSE event path and must never throw.
export function play(name) {
  if (!name || name === 'none') return;
  const fn = PALETTE[name];
  if (!fn) return;
  const c = ensureCtx();
  if (!c) return;
  try {
    if (c.state === 'suspended') c.resume().catch(() => {});
    fn(c.currentTime + 0.01);
  } catch (e) {}
}

// Global gesture primer: the first click/keydown anywhere unlocks the audio
// context ahead of time, so the FIRST real notification (which rides no
// gesture of its own) can still play instead of being silently dropped.
function primeOnGesture() {
  const c = ensureCtx();
  if (c && c.state === 'suspended') c.resume().catch(() => {});
}
window.addEventListener('click', primeOnGesture, { once: true, passive: true });
window.addEventListener('keydown', primeOnGesture, { once: true, passive: true });
