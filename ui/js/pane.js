// pane.js — the 👁 peek drawer: watch a worker's / lieutenant's terminal LIVE.
// Opens an EventSource on the target's /pane/stream (a dedicated per-target
// SSE — never the board-wide /api/events). Every `frame` event carries the
// pane's full rendered screen, so the <pre> is REPLACED, not appended to.
// Closing the drawer closes the EventSource; the server releases the harness
// pane by refcount. unsupported/no-pane/busy arrive as tidy inline messages.
//
// The <pre> is also TYPEABLE: focus it and every keystroke is POSTed to the
// target's /pane/input (the write half of the same pair). No terminal emulator
// is involved — keys go out, the polled frames come back, and the server bursts
// the poll for a moment after input so the echo does not sit behind the 1s
// baseline.
import { card, lieutenant } from './state.js';
import { ansiToHtml } from './ansi.js';
import { keyForEvent } from './panekeys.js';

const overlay = document.getElementById('pane-overlay');
const titleEl = document.getElementById('pane-title');
const liveEl = document.getElementById('pane-live');
const preEl = document.getElementById('pane-body');
const msgEl = document.getElementById('pane-msg');
const hintEl = document.getElementById('pane-hint');
let es = null;
let inputUrl = null;

function stop() { if (es) { es.close(); es = null; } }
function setLive(on) {
  liveEl.classList.toggle('on', on);
  liveEl.title = on ? 'live' : 'not streaming';
}
function showMsg(text) {
  stop(); // a guard event ends the stream server-side too — don't let EventSource retry-loop
  inputUrl = null; // no screen, nothing to type into — and the hint says so
  setHint();
  setLive(false);
  preEl.hidden = true;
  msgEl.hidden = false;
  msgEl.textContent = text;
}

// ---------- typing into the pane ----------
// One POST per keystroke, chained: fetches to the same origin can complete out
// of order, and out-of-order keystrokes would scramble typed text ("abc" → "acb").
// The chain costs one promise per key and makes ordering a non-question.
let sending = Promise.resolve();
function sendInput(payload) {
  if (!inputUrl) return;
  const url = inputUrl;
  sending = sending.then(() => fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
  }).catch(() => { /* a dropped keystroke is not worth a dialog; the frame shows the truth */ }));
}

function typing() { return document.activeElement === preEl; }
// The head line doubles as the focus indicator and as the way OUT: once the
// pane has focus Escape belongs to the terminal (Claude's own composer uses
// it), so the close affordance has to be stated somewhere the eye already is.
function setHint() {
  const on = typing() && !!inputUrl;
  preEl.classList.toggle('typing', on);
  hintEl.textContent = on
    ? 'typing — keys go to the pane · Esc too · ✕ or click outside to close'
    : (inputUrl ? 'click the screen to type' : '');
  hintEl.classList.toggle('on', on);
}
preEl.addEventListener('focus', setHint);
preEl.addEventListener('blur', setHint);

preEl.addEventListener('keydown', (e) => {
  if (!inputUrl) return;
  const payload = keyForEvent(e);
  if (!payload) return; // browser/OS chord: leave it alone (Ctrl-V, ⌘W, F5…)
  e.preventDefault();
  e.stopPropagation(); // main.js closes the pane on Escape — not while typing
  sendInput(payload);
});

// Paste rides the literal path: sendLiteral switches to a bracketed paste for
// multi-line text, so newlines land as part of the paste instead of as Enters.
preEl.addEventListener('paste', (e) => {
  if (!inputUrl) return;
  e.preventDefault();
  const text = (e.clipboardData || window.clipboardData || {}).getData('text');
  if (text) sendInput({ text });
});

function open(url, title, inputAt) {
  stop();
  inputUrl = inputAt;
  titleEl.textContent = title;
  preEl.hidden = false;
  msgEl.hidden = true;
  preEl.textContent = 'connecting…';
  setLive(false);
  overlay.hidden = false;
  setHint();
  es = new EventSource(url);
  es.addEventListener('frame', (e) => {
    let frame;
    try { frame = JSON.parse(e.data); } catch (err) { return; }
    // Frames are whole-screen snapshots: replace, don't append. Stick to the
    // bottom only when the user was already there — a scroll-up into the
    // scrollback must survive the next frame.
    const stick = preEl.scrollTop + preEl.clientHeight >= preEl.scrollHeight - 12;
    preEl.innerHTML = ansiToHtml(String(frame));
    if (stick) preEl.scrollTop = preEl.scrollHeight;
    setLive(true);
  });
  es.addEventListener('unsupported', () => showMsg('this harness has no live pane view'));
  es.addEventListener('busy', () => showMsg('too many live panes open — close one and try again'));
  es.addEventListener('no-pane', (e) => {
    let reason = '';
    try { reason = (JSON.parse(e.data) || {}).reason || ''; } catch (err) { /* plain message */ }
    showMsg('no live pane' + (reason ? ' — ' + reason : ''));
  });
  es.onerror = () => setLive(false); // EventSource reconnects on its own
}

export function openCardPane(cardId) {
  const c = card(cardId);
  const at = (c && c.attributes) || {};
  const base = '/api/cards/' + encodeURIComponent(cardId) + '/pane/';
  open(base + 'stream', String(at.session || (c && c.title) || cardId), base + 'input');
}
export function openLieutenantPane(id) {
  const l = lieutenant(id);
  const base = '/api/lieutenants/' + encodeURIComponent(id) + '/pane/';
  open(base + 'stream', String((l && l.ref && l.ref.session) || (l && l.name) || id), base + 'input');
}
export function closePane() { stop(); inputUrl = null; preEl.blur(); overlay.hidden = true; }
export function paneOpen() { return !overlay.hidden; }

document.getElementById('pane-close').onclick = closePane;
overlay.onclick = (e) => { if (e.target === overlay) closePane(); };
