// sound.js — zero-dependency WebAudio synth palette for notifications.
// No audio files: every tone is oscillators + a short gain envelope. The
// AudioContext is created lazily and resumed on the first real user gesture
// anywhere on the page (the same autoplay-gate dance voice.js does for
// speechSynthesis), so a later programmatic play() from an SSE event isn't
// silently blocked by the browser.
let ctx = null, master = null, comp = null, volume = 0.85;
function ensureCtx() {
  if (ctx) return ctx;
  const AC = window.AudioContext || window.webkitAudioContext;
  if (!AC) return null;
  try {
    ctx = new AC();
    master = ctx.createGain(); master.gain.value = volume;
    comp = ctx.createDynamicsCompressor();
    comp.threshold.value = -14; comp.knee.value = 26; comp.ratio.value = 3.2;
    comp.attack.value = 0.003; comp.release.value = 0.25;
    master.connect(comp); comp.connect(ctx.destination);
  } catch (e) { ctx = null; master = null; }
  return ctx;
}
export function setVolume(v) {
  volume = Math.max(0, Math.min(1, Number(v)));
  if (master) master.gain.value = volume;
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
