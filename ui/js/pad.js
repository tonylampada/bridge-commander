// pad.js — the music the keep-alive can hold the audio session with.
//
// Synthesised, not a file: oscillators and gain envelopes, the same discipline
// sound.js builds every notification tone with, so nothing is fetched and
// nothing is added to the page weight. What it plays is decided in
// keepalive.js — the notes, the spacing, the level — and this file is only the
// wiring that turns those decisions into sound.
//
// It renders into speech.js's context and speech.js's sink, because there is
// exactly one element the session survives a locked screen through and this is
// not allowed to be a second one. So it takes both as arguments and owns
// neither: startPad(ctx, destination, level) → { setLevel, stop }.
//
// Two hours in a pocket is the design brief. Everything here follows from it:
// long attacks and long releases so nothing ever starts or stops abruptly, a
// drone underneath so the stream is never digitally silent between notes, and
// notes scheduled far ahead of time — iOS throttles JS timers on a locked
// phone, but the audio clock is not throttled, so a minute of music queued into
// the context goes on playing while the page's timers are being starved.
import { DRONE, nextNote, padStep } from './keepalive.js';

const ATTACK = 3.5;        // seconds — a note arrives rather than begins
const SUSTAIN = 2.5;
const RELEASE = 5.5;       // …and leaves the same way
const LIFE = ATTACK + SUSTAIN + RELEASE;
const DETUNE = 1.003;      // the second oscillator of a note, ~5 cents sharp:
                           // the slow beating between the two is the shimmer
const VOICES = [[1, 0.5], [DETUNE, 0.35]];   // [ratio, peak]
const DRONE_FADE = 6;      // seconds to bring the drone up from nothing
const AHEAD = 60;          // seconds of music kept queued in the context
const TOP_UP_MS = 15000;   // …topped up this often, while the timers still run

export function startPad(ctx, destination, level) {
  const out = ctx.createGain();
  out.gain.value = level;
  out.connect(destination);

  let stopped = false;
  const running = [];        // {osc, gain, end} — everything still to be stopped

  function voice(t0, freq, peak, end) {
    const osc = ctx.createOscillator(), gain = ctx.createGain();
    osc.type = 'sine';
    osc.frequency.value = freq;
    osc.connect(gain); gain.connect(out);
    running.push({ osc, gain, end });
    return { osc, gain };
  }

  // The drone: a bare fifth, started once and never released. It fades in from
  // nothing so switching the music on is never a click.
  const t = ctx.currentTime;
  for (const [hz, amp] of DRONE) {
    const { osc, gain } = voice(t, hz, amp, Infinity);
    gain.gain.setValueAtTime(0.0001, t);
    gain.gain.linearRampToValueAtTime(amp, t + DRONE_FADE);
    osc.start(t);
  }

  // The notes over it, two detuned sines each, in and out of nothing.
  function note(t0, freq) {
    for (const [ratio, peak] of VOICES) {
      const { osc, gain } = voice(t0, freq * ratio, peak, t0 + LIFE);
      gain.gain.setValueAtTime(0.0001, t0);
      gain.gain.linearRampToValueAtTime(peak, t0 + ATTACK);
      gain.gain.setValueAtTime(peak, t0 + ATTACK + SUSTAIN);
      gain.gain.exponentialRampToValueAtTime(0.0001, t0 + LIFE);
      osc.start(t0);
      osc.stop(t0 + LIFE + 0.05);
      osc.onended = () => { try { gain.disconnect(); } catch (e) {} };
    }
  }

  let prev = null, at = ctx.currentTime + 1.5;
  function fill() {
    if (stopped) return;
    const until = ctx.currentTime + AHEAD;
    while (at < until) {
      prev = nextNote(prev, Math.random());
      note(at, prev);
      at += padStep(Math.random());
    }
    // Two hours is around a thousand notes; the ones that have finished are not
    // this pad's to hold on to.
    for (let i = running.length - 1; i >= 0; i--) {
      if (running[i].end < ctx.currentTime) running.splice(i, 1);
    }
  }
  fill();
  const timer = setInterval(fill, TOP_UP_MS);
  timer?.unref?.();          // a timer is no reason to hold a process open

  return {
    // The notification volume moved: the pad follows it live rather than at the
    // next note, because the slider is being dragged while it is playing.
    setLevel(v) { if (!stopped) out.gain.value = v; },
    // Off is off: every oscillator stopped, the whole pad disconnected. What is
    // already queued in the context would otherwise go on sounding for a minute
    // after the switch was thrown.
    stop() {
      stopped = true;
      clearInterval(timer);
      for (const { osc, gain } of running) {
        osc.onended = null;
        try { osc.stop(); } catch (e) {}
        try { osc.disconnect(); gain.disconnect(); } catch (e) {}
      }
      running.length = 0;
      try { out.disconnect(); } catch (e) {}
    },
  };
}
