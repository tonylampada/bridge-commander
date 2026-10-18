// Live activity: what each lieutenant is doing right now ("🔧 running: gh pr
// checks 162", "📖 reading server.js"), pushed by the server as an `activity`
// SSE event (server.js activityTick — the transcript, read, never the agent
// asked). Absent from the map = no turn running. The turn's age arrives as
// agoMs and is pinned to THIS clock on receipt, so elapsed time never depends
// on the server's clock agreeing with the phone's.
import { esc } from './util.js';

let map = {};                 // ltId -> { kind, label, start }
const listeners = new Set();
let ticker = 0;

export function setActivity(snapshot) {
  const now = Date.now();
  const next = {};
  for (const [id, a] of Object.entries(snapshot || {})) {
    const prev = map[id];
    const start = a.agoMs == null ? (prev ? prev.start : now) : now - a.agoMs;
    next[id] = { kind: a.tool ? a.tool.kind : 'think', label: a.tool ? a.tool.label : '💭 thinking', start };
  }
  map = next;
  for (const fn of listeners) { try { fn(map); } catch (e) {} }
  tickTimes();
  // the clock runs only while some turn does
  const any = Object.keys(map).length > 0;
  if (any && !ticker) ticker = setInterval(tickTimes, 1000);
  else if (!any && ticker) { clearInterval(ticker); ticker = 0; }
}
export function activityOf(ltId) { return map[ltId] || null; }
export function onActivity(fn) { listeners.add(fn); return () => listeners.delete(fn); }

export function fmtElapsed(ms) {
  const s = Math.max(0, Math.floor(ms / 1000));
  return s < 60 ? s + 's' : Math.floor(s / 60) + 'm' + String(s % 60).padStart(2, '0') + 's';
}

// The line's markup. The label is in it (a change of tool re-renders); the
// elapsed time is not — tickTimes() rewrites [data-act-time] in place every
// second, so a running clock never churns the surrounding render.
export function activityHtml(ltId) {
  const a = map[ltId];
  if (!a) return '';
  return '<span class="act-label">' + esc(a.label) + '</span>' +
    '<span class="act-time" data-act-time="' + esc(ltId) + '">' + fmtElapsed(Date.now() - a.start) + '</span>';
}
function tickTimes() {
  if (typeof document === 'undefined') return;
  for (const el of document.querySelectorAll('[data-act-time]')) {
    const a = map[el.dataset.actTime];
    if (a) el.textContent = fmtElapsed(Date.now() - a.start);
  }
}
