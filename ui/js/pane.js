// pane.js — the 👁 peek drawer: watch a worker's / lieutenant's terminal LIVE.
// Opens an EventSource on the target's /pane/stream (a dedicated per-target
// SSE — never the board-wide /api/events). Every `frame` event carries the
// pane's full rendered screen, so the <pre> is REPLACED, not appended to.
// Closing the drawer closes the EventSource; the server releases the harness
// pane by refcount. unsupported/no-pane/busy arrive as tidy inline messages.
import { card, lieutenant } from './state.js';
import { ansiToHtml } from './ansi.js';

const overlay = document.getElementById('pane-overlay');
const titleEl = document.getElementById('pane-title');
const liveEl = document.getElementById('pane-live');
const preEl = document.getElementById('pane-body');
const msgEl = document.getElementById('pane-msg');
let es = null;

function stop() { if (es) { es.close(); es = null; } }
function setLive(on) {
  liveEl.classList.toggle('on', on);
  liveEl.title = on ? 'live' : 'not streaming';
}
function showMsg(text) {
  stop(); // a guard event ends the stream server-side too — don't let EventSource retry-loop
  setLive(false);
  preEl.hidden = true;
  msgEl.hidden = false;
  msgEl.textContent = text;
}

function open(url, title) {
  stop();
  titleEl.textContent = title;
  preEl.hidden = false;
  msgEl.hidden = true;
  preEl.textContent = 'connecting…';
  setLive(false);
  overlay.hidden = false;
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
  open('/api/cards/' + encodeURIComponent(cardId) + '/pane/stream',
    String(at.session || (c && c.title) || cardId));
}
export function openLieutenantPane(id) {
  const l = lieutenant(id);
  open('/api/lieutenants/' + encodeURIComponent(id) + '/pane/stream',
    String((l && l.ref && l.ref.session) || (l && l.name) || id));
}
export function closePane() { stop(); overlay.hidden = true; }
export function paneOpen() { return !overlay.hidden; }

document.getElementById('pane-close').onclick = closePane;
overlay.onclick = (e) => { if (e.target === overlay) closePane(); };
