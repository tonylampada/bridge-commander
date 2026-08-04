// music.js — the music the keep-alive holds the audio session with: one file,
// decoded once, looped for as long as the switch is on.
//
// It replaces a synthesiser (ui/js/pad.js, deleted the day this arrived) for
// one reason: a phone lying face-down for two hours should not be running an
// oscillator bank and a note scheduler to make a sound its audio hardware can
// make from a buffer it decoded once. What is played is decided in
// keepalive.js — which tracks there are, how long each loop is, the level —
// and this file is only the wiring that turns those decisions into sound.
//
// It renders into speech.js's context and speech.js's sink, because there is
// exactly one element the session survives a locked screen through and this is
// not allowed to be a second one. So it takes both as arguments and owns
// neither, and hands back what everything hold() accepts hands back:
// startMusic(ctx, destination, level, url, seconds) → { ready, setLevel, stop }.
//
// Two things about a FILE that a synthesiser never had to worry about:
//
// · It has to start before it exists. humOn() calls this and calls the
//   element's play() on the very next line, inside the gesture, because iOS
//   allows play() nowhere else — so startMusic() returns synchronously, long
//   before the bytes land. What holds the session in the meantime is the same
//   inaudible tone speech.js holds with on its own, started here on the first
//   line and never stopped: the loop fades in underneath it, not instead of it.
//
// · A recording makes no promise about never being silent, and that promise is
//   the whole reason any of this exists — a digitally silent stream is a
//   session iOS is free to take back. The tone keeps it. It also keeps it when
//   the volume slider is at zero, which is a promise not to be HEARD and not a
//   promise to stop holding.
import { LEAD } from './keepalive.js';

const FADE = 2.5;          // seconds — the loop arrives rather than begins
const TONE_HZ = 30;        // under the low end of any phone speaker…
const TONE_GAIN = 0.0008;  // …and far under its floor in level: samples, no sound

// Fetched once per page, not once per switch-on: the captain toggling the
// keep-alive off and on again should not pull six hundred kilobytes over his
// phone's data a second time. Kept as bytes rather than as a decoded buffer
// because a decoded buffer belongs to a context, and the context is replaced
// every time a Siri Shortcut leaves one for dead (see speech.js).
const bytes = new Map();   // url → Promise<ArrayBuffer>
export function fetchTrack(url) {
  let p = bytes.get(url);
  if (!p) {
    p = fetch(url).then((r) => {
      if (!r.ok) throw new Error(`${url}: ${r.status}`);
      return r.arrayBuffer();
    });
    // A failure is not cached: the next attempt should be allowed to be a
    // network that came back, not the same rejection forever.
    p.catch(() => { if (bytes.get(url) === p) bytes.delete(url); });
    bytes.set(url, p);
  }
  return p;
}

// decodeAudioData detaches the ArrayBuffer it is handed, and these bytes are
// kept to be decoded again on the next context — so it is always given a copy.
// Safari's is callback-only and returns undefined; everyone else's returns a
// promise as well. Both are accepted rather than sniffed for.
function decode(ctx, buf) {
  return new Promise((resolve, reject) => {
    const p = ctx.decodeAudioData(buf.slice(0), resolve, reject);
    if (p && typeof p.then === 'function') p.then(resolve, reject);
  });
}

// Where in the decoded buffer the loop actually is. The file is one period
// with a second of the same loop in front of it and a second behind it
// (dev/build-loops.sh explains why: an AAC encoder has no signal before its
// first frame or after its last, and hands back tens of milliseconds of wrong
// samples at both ends — a tick, once a minute, forever). So the loop points
// are interior on both sides, and the whole file is periodic, which is what
// makes this robust: any window of exactly `seconds` is a whole loop, so a
// decoder that pads the front by a frame shifts WHERE the loop starts and
// changes nothing about whether it joins.
export function loopPoints(duration, seconds) {
  if (!(seconds > 0) || !(duration > seconds)) return { start: 0, end: duration };
  const start = Math.min(LEAD, (duration - seconds) / 2);
  return { start, end: start + seconds };
}

export function startMusic(ctx, destination, level, url, seconds) {
  const out = ctx.createGain();      // the level: the volume slider writes here
  out.gain.value = level;
  out.connect(destination);
  const fade = ctx.createGain();     // the arrival: written once, on decode
  fade.gain.value = 0.0001;
  fade.connect(out);

  // The floor, started before anything is fetched and stopped only by stop().
  const osc = ctx.createOscillator(), floor = ctx.createGain();
  osc.frequency.value = TONE_HZ;
  floor.gain.value = TONE_GAIN;
  osc.connect(floor); floor.connect(destination);
  osc.start();

  let stopped = false, src = null;

  const ready = fetchTrack(url)
    .then((b) => decode(ctx, b))
    .then((buf) => {
      if (stopped) return;           // switched off while the file was in the air
      const { start, end } = loopPoints(buf.duration, seconds);
      src = ctx.createBufferSource();
      src.buffer = buf;
      src.loop = true;
      src.loopStart = start;
      src.loopEnd = end;
      src.connect(fade);
      const t = ctx.currentTime;
      fade.gain.setValueAtTime(0.0001, t);
      fade.gain.linearRampToValueAtTime(1, t + FADE);
      src.start(t, start);
    });
  // Nothing here rethrows on its own account: a track that will not load is a
  // keep-alive that holds SILENTLY, which is the switch's other setting and not
  // a failure of the session. The caller gets the promise so it can say so.
  ready.catch(() => {});

  return {
    ready,
    // The notification volume moved: the loop follows it live rather than at
    // the next pass, because the slider is being dragged while it is playing.
    setLevel(v) { if (!stopped) out.gain.value = v; },
    // Off is off. The tone included — it is this module's, not speech.js's, and
    // leaving it running would leave the session held by a module that has been
    // told to stop.
    stop() {
      stopped = true;
      if (src) { try { src.stop(); } catch (e) {} try { src.disconnect(); } catch (e) {} }
      src = null;
      try { osc.stop(); } catch (e) {}
      try { osc.disconnect(); floor.disconnect(); } catch (e) {}
      try { fade.disconnect(); out.disconnect(); } catch (e) {}
    },
  };
}
