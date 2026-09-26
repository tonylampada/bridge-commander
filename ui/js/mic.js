// mic.js — the microphone on the chat composer. Tap, speak, tap; the words land
// in the box and he presses send himself.
//
// **It imports nothing**, for the same reason `bridge3d/talk.js` imports
// nothing: what can be wrong in here is the state machine (a recorder left
// running, a track left open, a stale take answering after a cancel), and none
// of that shows in a screenshot. Everything from the page — the form, the
// textarea, the error line — is handed in, so a test can drive it with a fake
// DOM and a fake `MediaRecorder`.
//
// ## Not shared with the room
//
// `talk.js` holds one microphone for a whole visit and streams chunks up a
// websocket, because a permission prompt inside an immersive session ends the
// session. The composer is a flat page: it opens the microphone per utterance,
// closes it after, and POSTs one blob. The two overlap in three lines of
// `getUserMedia` and a mime test — not enough shared machinery to be worth a
// module both have to be read through.
//
// ## One take
//
//   idle → recording → sending → idle
//                   ↘ (Escape) idle, nothing sent
//
// Only the take that is current when the answer arrives may write to the
// composer: `drop()` clears `take`, and every continuation checks it first.

const ROUTE = '/api/stt/transcribe';
const LANG = 'pt';

// form, input, errEl: the composer's <form>, its <textarea>, and the line under
// it. stt: whether the board has a transcription engine at all (from
// /api/config). Returns the button, or null when there is nothing to mount —
// no engine, or a browser (or a plain-http origin) with no getUserMedia.
export function mountMic({ form, input, errEl, stt }) {
  if (!stt || !form || !input) return null;
  const md = typeof navigator !== 'undefined' && navigator.mediaDevices;
  if (!md || !md.getUserMedia) return null;

  const btn = document.createElement('button');
  btn.type = 'button';
  btn.id = 'chat-mic';
  btn.className = 'composer-attach composer-mic';
  btn.title = 'dictate — tap to start, tap to stop (Esc discards)';
  btn.textContent = '🎤';
  form.insertBefore(btn, input);

  let take = null;   // { rec, stream, chunks, timer, started }

  const say = (msg) => {
    if (!errEl) return;
    errEl.textContent = msg || '';
    errEl.hidden = !msg;
  };
  // The error is his to dismiss by carrying on typing, which is also the only
  // moment we can be sure he has read it.
  input.addEventListener('input', () => { if (errEl && !errEl.hidden) say(''); });

  const paint = (label, cls) => {
    btn.textContent = label;
    btn.className = 'composer-attach composer-mic' + (cls ? ' ' + cls : '');
  };
  const idle = () => paint('🎤', '');

  // Let go of everything this take holds. The microphone indicator must not
  // outlive the utterance on a laptop the way it does in the headset.
  function drop() {
    const t = take;
    take = null;
    if (!t) return;
    if (t.timer) clearInterval(t.timer);
    try { if (t.rec && t.rec.state !== 'inactive') t.rec.stop(); } catch (e) {}
    if (t.stream) { for (const tr of t.stream.getTracks()) { try { tr.stop(); } catch (e) {} } }
  }

  async function begin() {
    say('');
    paint('…', 'busy');
    let stream;
    try {
      stream = await md.getUserMedia({ audio: true });
    } catch (e) {
      idle();
      return say('no microphone: ' + why(e));
    }
    let rec;
    try {
      const mime = typeof MediaRecorder !== 'undefined' && MediaRecorder.isTypeSupported('audio/webm')
        ? { mimeType: 'audio/webm' } : {};
      rec = new MediaRecorder(stream, mime);
    } catch (e) {
      for (const tr of stream.getTracks()) { try { tr.stop(); } catch (err) {} }
      idle();
      return say('the recorder refused: ' + why(e));
    }
    const t = { rec, stream, chunks: [], timer: null, started: Date.now() };
    take = t;
    rec.ondataavailable = (e) => { if (e.data && e.data.size) t.chunks.push(e.data); };
    // The blob is only whole once the recorder has flushed, so the upload hangs
    // off onstop rather than off the press that asked for it.
    rec.onstop = () => { if (t === take) send(t); };
    rec.onerror = (e) => { drop(); idle(); say('the recorder stopped: ' + why(e && e.error ? e.error : e)); };
    try { rec.start(); } catch (e) { drop(); idle(); return say('the recorder refused: ' + why(e)); }
    tick(t);
    t.timer = setInterval(() => tick(t), 1000);
  }

  function tick(t) {
    if (t !== take) return;
    paint('● ' + Math.floor((Date.now() - t.started) / 1000) + 's', 'rec');
  }

  // He tapped again: stop recording, keep the take alive for the upload.
  function end() {
    const t = take;
    if (!t || !t.rec) return;
    if (t.timer) { clearInterval(t.timer); t.timer = null; }
    paint('…', 'busy');
    try { if (t.rec.state !== 'inactive') t.rec.stop(); } catch (e) { drop(); idle(); say('the recorder stopped: ' + why(e)); }
  }

  async function send(t) {
    if (t.stream) { for (const tr of t.stream.getTracks()) { try { tr.stop(); } catch (e) {} } }
    const type = (t.chunks[0] && t.chunks[0].type) || 'audio/webm';
    const blob = new Blob(t.chunks, { type });
    let text = '';
    try {
      const fd = new FormData();
      fd.append('file', blob, 'speech.' + (type.includes('ogg') ? 'ogg' : 'webm'));
      fd.append('language', LANG);
      const r = await fetch(ROUTE, { method: 'POST', body: fd });
      if (!r.ok) throw new Error('HTTP ' + r.status);
      const d = await r.json();
      text = typeof d.text === 'string' ? d.text.trim() : '';
    } catch (e) {
      if (t === take) { take = null; idle(); say('transcription failed: ' + why(e)); }
      return;
    }
    if (t !== take) return;          // Escape landed while the engine was thinking
    take = null;
    idle();
    if (!text) return say('nothing was heard');
    append(text);
  }

  // Space-separated onto whatever is already in the box — dictation adds to the
  // message, it never replaces what he typed.
  function append(text) {
    const had = input.value || '';
    input.value = had && !/\s$/.test(had) ? had + ' ' + text : had + text;
    try { input.setSelectionRange(input.value.length, input.value.length); } catch (e) {}
    try { input.focus(); } catch (e) {}
    // The textarea grows with its content everywhere else it is written to.
    try { input.dispatchEvent(new Event('input', { bubbles: true })); } catch (e) {}
  }

  btn.onclick = () => {
    if (!take) return begin();
    if (take.rec && take.rec.state === 'recording') return end();
  };

  // Escape throws the take away wherever the caret is — recording or already
  // uploading. Nothing reaches the composer.
  const onKey = (e) => {
    if (e.key !== 'Escape' || !take) return;
    drop();
    idle();
    say('');
  };
  if (document.addEventListener) document.addEventListener('keydown', onKey);

  return btn;
}

function why(e) { return String((e && e.message) || e); }
