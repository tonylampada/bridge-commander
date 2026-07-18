// monitor.js — the ⚙️ → monitoring panel: live machine + per-agent load.
// On-demand by design: opening the panel opens an EventSource on
// /api/sysload/stream (a dedicated per-viewer SSE — never the board push);
// the server samples only while someone is subscribed. Closing the panel —
// ✕ / Esc / tap-out — closes the EventSource and the refcount drops; a hidden
// tab drops it too (visibilitychange) and reconnects when the tab returns.
import { esc } from './util.js';

const overlay = document.getElementById('mon-overlay');
const liveEl = document.getElementById('mon-live');
const machineEl = document.getElementById('mon-machine');
const agentsEl = document.getElementById('mon-agents');
const containersEl = document.getElementById('mon-containers');
let es = null;

function setLive(on) {
  liveEl.classList.toggle('on', on);
  liveEl.title = on ? 'sampling every ~2s' : 'not sampling';
}

// bytes → short human size, GB-aware (RAM/disk live up there)
function gb(n) {
  n = Number(n) || 0;
  if (n >= 1024 ** 3) return (n / 1024 ** 3).toFixed(n < 10 * 1024 ** 3 ? 1 : 0) + 'G';
  if (n >= 1024 ** 2) return Math.round(n / 1024 ** 2) + 'M';
  return Math.round(n / 1024) + 'K';
}
function pctCls(pct) { return pct >= 80 ? ' red' : pct >= 60 ? ' yellow' : ''; }
function barHtml(label, pct, val) {
  const p = Math.max(0, Math.min(100, Math.round(pct)));
  return '<div class="mon-row"><span class="mon-lbl">' + esc(label) + '</span>'
    + '<span class="mon-bar"><span class="ctx-fill' + pctCls(p) + '" style="width:' + p + '%"></span></span>'
    + '<span class="mon-val">' + esc(val) + '</span></div>';
}

function render(s) {
  const m = s.machine || {};
  const memPct = m.memTotalBytes ? (m.memUsedBytes / m.memTotalBytes) * 100 : 0;
  const diskPct = m.diskTotalBytes ? (m.diskUsedBytes / m.diskTotalBytes) * 100 : 0;
  machineEl.innerHTML =
    barHtml('cpu', m.cpuPct || 0, (m.cpuPct || 0).toFixed(0) + '%' + (m.cores ? ' · ' + m.cores + ' cores' : ''))
    + barHtml('ram', memPct, gb(m.memUsedBytes) + ' / ' + gb(m.memTotalBytes))
    + barHtml('disk', diskPct, gb(m.diskUsedBytes) + ' / ' + gb(m.diskTotalBytes));

  const ents = s.entities || [];
  agentsEl.innerHTML = !ents.length
    ? '<div class="mon-empty">no live workers or lieutenants</div>'
    : ents.map((e) =>
      '<div class="mon-agent"><span class="mon-kind">' + (e.kind === 'worker' ? '🔨' : '🎖️') + '</span>'
      + '<span class="mon-name" title="' + esc(e.label) + ' · ' + e.pids + ' process' + (e.pids === 1 ? '' : 'es') + '">' + esc(e.label) + '</span>'
      + '<span class="mon-cpu">' + (e.cpuPct || 0).toFixed(1) + '%</span>'
      + '<span class="mon-rss">' + gb(e.rssBytes) + '</span></div>').join('');

  // container count: docker absent → null → the row stays hidden
  containersEl.hidden = !(typeof s.containers === 'number');
  if (typeof s.containers === 'number') {
    containersEl.textContent = '🐳 ' + s.containers + ' container' + (s.containers === 1 ? '' : 's') + ' running';
  }
}

function stop() { if (es) { es.close(); es = null; } setLive(false); }
function connect() {
  stop();
  es = new EventSource('/api/sysload/stream');
  es.addEventListener('sample', (e) => {
    let s;
    try { s = JSON.parse(e.data); } catch (err) { return; }
    render(s);
    setLive(true);
  });
  es.onerror = () => setLive(false); // EventSource reconnects on its own
}

export function openMonitor() {
  machineEl.innerHTML = '<div class="mon-empty">sampling…</div>';
  agentsEl.innerHTML = '';
  containersEl.hidden = true;
  overlay.hidden = false;
  connect();
}
export function closeMonitor() { stop(); overlay.hidden = true; }
export function monitorOpen() { return !overlay.hidden; }

// a hidden tab must not keep the server sampling — drop the stream, resume on return
document.addEventListener('visibilitychange', () => {
  if (!monitorOpen()) return;
  if (document.hidden) stop();
  else connect();
});

document.getElementById('mon-close').onclick = closeMonitor;
overlay.onclick = (e) => { if (e.target === overlay) closeMonitor(); };
