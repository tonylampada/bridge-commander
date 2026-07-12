// small shared helpers
export function esc(s) {
  return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}
export function ago(iso) {
  if (!iso) return '';
  const s = (Date.now() - new Date(iso).getTime()) / 1000;
  if (s < 60) return 'now';
  if (s < 3600) return Math.floor(s / 60) + 'm';
  if (s < 86400) return Math.floor(s / 3600) + 'h';
  return Math.floor(s / 86400) + 'd';
}
// "ago" labels are rendered as EMPTY spans carrying the timestamp, then filled
// in by refreshAgoLabels after every render pass (and on the periodic tick).
// Keeping the time-dependent text OUT of the markup keeps panel html strings
// stable, so the skip-identical render guards don't rebuild the DOM just
// because a minute passed.
export function agoSpanHtml(iso, cls) {
  return '<span' + (cls ? ' class="' + cls + '"' : '') + ' data-ago="' + esc(iso || '') + '"></span>';
}
export function refreshAgoLabels(root) {
  for (const el of (root || document).querySelectorAll('[data-ago]')) {
    const t = ago(el.dataset.ago);
    if (el.textContent !== t) el.textContent = t;
  }
}
// Assign innerHTML only when the markup actually changed since the LAST
// assignment through this helper (cached on the element — never read back from
// the live DOM, which post-passes like refreshAgoLabels mutate). Returns true
// when the DOM was rebuilt, so callers re-wire handlers only then.
export function setHtmlIfChanged(el, html) {
  if (el.__bcHtml === html) return false;
  el.__bcHtml = html;
  el.innerHTML = html;
  return true;
}
export function hhmm(iso) {
  try { return new Date(iso).toTimeString().slice(0, 5); } catch (e) { return ''; }
}
export function dayLabel(iso) {
  const d = new Date(iso), today = new Date();
  const key = d.toDateString();
  if (key === today.toDateString()) return 'today';
  const yd = new Date(today.getTime() - 86400000);
  if (key === yd.toDateString()) return 'yesterday';
  return d.toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
}

// card `type` is first-class: plan | implementation | investigation.
// attributes.emoji still overrides for one-off flavor; unknown falls back to
// the neutral marker.
const TYPE_EMOJI = {
  plan: '🧠', implementation: '🔥', investigation: '🕵️',
};
export function cardEmoji(card) {
  const at = (card && card.attributes) || {};
  if (at.emoji) return String(at.emoji);
  if (card && card.type && TYPE_EMOJI[String(card.type).toLowerCase()]) return TYPE_EMOJI[String(card.type).toLowerCase()];
  return '▫️';
}

// attributes.prs — [{url, state: open|merged|closed}] — the only PR source on a card
const PR_STATES = new Set(['open', 'merged', 'closed']);
export function cardPrs(card) {
  const v = card && card.attributes && card.attributes.prs;
  if (!Array.isArray(v)) return [];
  return v.filter((e) => e && typeof e === 'object' && typeof e.url === 'string' && e.url);
}
// state is whitelisted before it reaches the class name (XSS-safe); unknown
// states render as open. withState adds the state word for the roomier detail view.
export function prChipHtml(pr, withState) {
  const state = PR_STATES.has(pr.state) ? pr.state : 'open';
  const m = /\/pull\/(\d+)\b/.exec(pr.url);
  const label = (m ? '#' + m[1] : 'PR') + (withState ? ' · ' + state : '');
  return '<a class="prchip pr-' + state + '" href="' + esc(pr.url) + '" target="_blank" rel="noopener"' +
    ' title="' + esc(pr.url) + ' (' + state + ')">' + esc(label) + '</a>';
}

// human file size (chat attachment chips)
export function fmtSize(n) {
  n = Number(n) || 0;
  if (n < 1024) return n + ' B';
  if (n < 1024 * 1024) return (n / 1024).toFixed(n < 10240 ? 1 : 0) + ' KB';
  return (n / (1024 * 1024)).toFixed(n < 10485760 ? 1 : 0) + ' MB';
}
export function isImageMime(m) { return /^image\//.test(String(m || '')); }

// last path segment of a uri/path (query/hash stripped) — the artifact display name
export function uriBasename(uri) {
  const s = String(uri).replace(/[?#].*$/, '').replace(/\/+$/, '');
  const i = s.lastIndexOf('/');
  return i >= 0 ? s.slice(i + 1) : s;
}

// human token count for the context bar tooltip (185709 → "186k", 1e6 → "1M")
export function fmtTokens(n) {
  if (!Number.isFinite(n)) return '?';
  if (n >= 1e6) return (n % 1e6 ? (n / 1e6).toFixed(1) : n / 1e6) + 'M';
  if (n >= 1000) return Math.round(n / 1000) + 'k';
  return String(n);
}

// context bar: used ÷ window from a lieutenant's/worker's agentStatus (the
// harness port's status(), refreshed at turn-end). Green → yellow (≥60%) →
// red (≥80% — auto-compact territory). No/partial status → no bar (graceful
// absence, like avatars).
export function ctxBarHtml(st) {
  if (!st || !(st.contextUsed > 0) || !(st.contextWindow > 0)) return '';
  const pct = Math.min(100, Math.round((st.contextUsed / st.contextWindow) * 100));
  const cls = pct >= 80 ? ' red' : pct >= 60 ? ' yellow' : '';
  const title = 'context: ' + fmtTokens(st.contextUsed) + ' / ' + fmtTokens(st.contextWindow)
    + ' tokens (' + pct + '%)' + (st.model ? ' — ' + st.model : '');
  return '<span class="ctx-bar" title="' + esc(title) + '">'
    + '<span class="ctx-fill' + cls + '" style="width:' + pct + '%"></span></span>';
}

// green → yellow (≥60%) → red (≥80%) — the shared context-bar thresholds
function ctxFillCls(pct) { return pct >= 80 ? ' red' : pct >= 60 ? ' yellow' : ''; }
function barRowHtml(label, pct, val) {
  const bar = pct == null ? ''
    : '<span class="ctx-bar st-bar"><span class="ctx-fill' + ctxFillCls(pct) + '" style="width:' + pct + '%"></span></span>';
  return '<div class="st-row"><span class="st-lbl">' + esc(label) + '</span>'
    + bar + '<span class="st-val">' + esc(val) + '</span></div>';
}
// A rate-limit window's short label (10080min=1w, 1440min=1d, 60min=1h, else min),
// mirroring the server's fmtWindowLabel so codex limits read the same in-thread.
function windowLabel(minutes) {
  if (!Number.isFinite(minutes)) return 'rate';
  if (minutes % 10080 === 0) return (minutes / 10080) + 'w';
  if (minutes % 1440 === 0) return (minutes / 1440) + 'd';
  if (minutes % 60 === 0) return (minutes / 60) + 'h';
  return minutes + 'min';
}
// /status rich reply: model name, context usage as a real progress bar (reusing
// the lane-chip context-bar visual language), plus rate-limit rows when present
// (codex). Fed the structured `status` payload the server attaches to the reply.
export function statusBlockHtml(st) {
  if (!st || typeof st !== 'object') return '';
  const rows = [];
  rows.push('<div class="st-model">' + esc(st.model || 'unknown') + '</div>');
  if (st.contextUsed > 0 && st.contextWindow > 0) {
    const pct = Math.min(100, Math.round((st.contextUsed / st.contextWindow) * 100));
    rows.push(barRowHtml('context', pct, fmtTokens(st.contextUsed) + ' / ' + fmtTokens(st.contextWindow) + ' · ' + pct + '%'));
  } else if (st.contextUsed > 0) {
    rows.push(barRowHtml('context', null, fmtTokens(st.contextUsed) + ' tokens'));
  }
  const rl = st.rateLimits || {};
  for (const key of ['primary', 'secondary']) {
    const w = rl[key];
    if (!w) continue;
    const pct = Number.isFinite(w.usedPercent) ? Math.min(100, Math.round(w.usedPercent)) : null;
    rows.push(barRowHtml(windowLabel(w.windowMinutes) + ' limit', pct, (pct == null ? '?' : pct) + '% used'));
  }
  return '<div class="status-block">' + rows.join('') + '</div>';
}

// attributes.artifacts — [{uri, label}] — resources hung on the card (briefs, docs)
export function cardArtifacts(card) {
  const v = card && card.attributes && card.attributes.artifacts;
  if (!Array.isArray(v)) return [];
  return v.filter((e) => e && typeof e === 'object' && typeof e.uri === 'string' && e.uri);
}
