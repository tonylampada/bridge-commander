// usage.js — the 📊 mode: where the tokens go.
//
// One fetch per question (entering the mode, a control, a bar, ⟳): the server
// summarizes its index (server/usage.js) for the window asked and answers with
// a per-day series stacked by category and a drill-down tree, category →
// lieutenant | repo → card → session. Board events repaint from the answer in
// hand and never refetch — usage moves by the minute, not by the card move.
//
// $ is API list price per model: a WEIGHT to compare work by. The subscription
// bills nothing per token and its quota formula is not public, so the page
// says so under the numbers, and shows the quota trail on its own axis.
import { api } from './api.js';
import { esc, fmtTokens } from './util.js';

const el = document.getElementById('usage-screen');
const CATS = [
  { id: 'lt', label: 'lieutenants', color: 'var(--u-lt)' },
  { id: 'worker', label: 'workers', color: 'var(--u-worker)' },
  { id: 'other', label: 'non-BC', color: 'var(--u-other)' },
];
const TOK_LABEL = ['input', 'output', 'cache read', 'cache write 5m', 'cache write 1h'];

// what is being asked, remembered per browser
const Q = { src: 'claude', days: 14, by: 'day', unit: 'usd', focus: '' };
try { Object.assign(Q, JSON.parse(localStorage.getItem('bc-usage') || '{}'), { focus: '' }); } catch (e) {}
let data = null;
let error = '';
let loading = false;
let pollT = null;
const open = new Set(['lt', 'worker', 'other']); // expanded tree rows, by path

function remember() {
  try { localStorage.setItem('bc-usage', JSON.stringify({ src: Q.src, days: Q.days, by: Q.by, unit: Q.unit })); } catch (e) {}
}

function load() {
  loading = true;
  const tz = -new Date().getTimezoneOffset();
  api.usage({ src: Q.src, days: Q.days, by: Q.by, tz, focus: Q.focus })
    .then((r) => { data = r; error = ''; })
    .catch((e) => { error = e.message || String(e); })
    .finally(() => {
      loading = false;
      paint();
      // an index run in flight: ask again when it has had time to land
      clearTimeout(pollT);
      if (data && data.index && data.index.running && S_visible()) pollT = setTimeout(load, 4000);
    });
}
function S_visible() { return el.offsetParent !== null; }

export function renderUsage(entering) {
  if (entering || (!data && !loading)) load();
  else paint();
}

const sum = (a) => (a || []).reduce((x, y) => x + y, 0);
const val = (n) => (Q.unit === 'usd' ? sum(n.usd) : sum(n.tok));
function fmtUsd(v) {
  if (v >= 1000) return '$' + (v / 1000).toFixed(1) + 'k';
  if (v >= 10) return '$' + v.toFixed(0);
  return '$' + v.toFixed(2);
}
const fmtVal = (v) => (Q.unit === 'usd' ? fmtUsd(v) : fmtTokens(Math.round(v)));
function fmtHour(h) {
  if (!h) return '';
  const d = new Date(h + ':00:00Z');
  return d.toLocaleString(undefined, { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' });
}
function bucketLabel(key, short) {
  const d = new Date(key + 'T12:00:00Z');
  const s = d.toLocaleDateString(undefined, { month: 'short', day: 'numeric', timeZone: 'UTC' });
  if (short) return Q.by === 'week' ? s : String(d.getUTCDate());
  return Q.by === 'week' ? 'week of ' + s : d.toLocaleDateString(undefined, { weekday: 'short', month: 'short', day: 'numeric', timeZone: 'UTC' });
}

function seg(name, opts, cur) {
  return '<span class="us-seg" role="group">' + opts.map(([v, label]) =>
    `<button type="button" data-q="${name}" data-v="${v}"${String(v) === String(cur) ? ' class="on"' : ''}>${esc(label)}</button>`).join('') + '</span>';
}

function paint() {
  if (!el) return;
  const ix = data && data.index;
  const status = loading && !data ? 'loading…'
    : ix && ix.running ? 'indexing…'
    : ix && ix.last ? 'indexed ' + new Date(ix.last.at).toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' })
    : data ? 'never indexed' : '';
  let h = '<div class="us-masthead"><div class="au-head">usage</div>'
    + `<span class="us-status">${esc(status)}${ix && ix.error ? ' · <span class="us-err">index failed</span>' : ''}</span>`
    + '<button type="button" id="us-refresh" title="index the newest transcript lines now">⟳</button></div>'
    + '<div class="us-controls">'
    + seg('src', [['claude', 'Claude'], ['codex', 'Codex']], Q.src)
    + seg('days', [[7, '7d'], [14, '14d'], [30, '30d'], [90, '90d']], Q.days)
    + seg('by', [['day', 'day'], ['week', 'week']], Q.by)
    + seg('unit', [['usd', '$'], ['tok', 'tokens']], Q.unit)
    + '</div>';
  if (error) h += `<div class="us-empty us-err">${esc(error)}</div>`;
  if (data) h += body(data);
  el.innerHTML = h;
  drawnW = el.clientWidth;
}

function body(d) {
  const tree = d.tree || { tok: [0, 0, 0, 0, 0], usd: [0, 0, 0, 0, 0], kids: [] };
  if (!sum(tree.tok) && !(d.buckets || []).length) {
    return '<div class="us-empty">no ' + (d.src === 'codex' ? 'Codex' : 'Claude') + ' usage in this window'
      + (d.index && d.index.running ? ' yet — the first index is running' : '') + '</div>';
  }
  return tiles(d, tree) + chart(d) + quota(d) + table(d, tree) + footnote(d);
}

// ---------- headline ----------
function tiles(d, tree) {
  const t = tree.tok;
  const all = sum(t);
  const scope = d.focus ? bucketLabel(d.focus) : 'last ' + d.days + ' days';
  const cacheShare = all ? Math.round(100 * t[2] / all) : 0;
  return '<div class="us-tiles">'
    + `<div class="us-tile"><div class="us-k">API-price weight · ${esc(scope)}</div><div class="us-big">${fmtUsd(sum(tree.usd))}</div>`
    + (tree.unpriced ? `<div class="us-sub">+ ${fmtTokens(tree.unpriced)} tokens on unpriced models</div>` : '') + '</div>'
    + `<div class="us-tile"><div class="us-k">tokens</div><div class="us-big">${fmtTokens(all)}</div><div class="us-sub">${cacheShare}% cache reads</div></div>`
    + `<div class="us-tile"><div class="us-k">output</div><div class="us-big">${fmtTokens(t[1])}</div><div class="us-sub">${fmtTokens(t[0])} fresh input</div></div>`
    + `<div class="us-tile"><div class="us-k">responses</div><div class="us-big">${fmtTokens(tree.n || 0)}</div><div class="us-sub">${(d.models || []).length} model${(d.models || []).length === 1 ? '' : 's'}</div></div>`
    + '</div>';
}

// ---------- the stacked bars ----------
// One bar per bucket, three stacked segments (fixed category order, so a
// category keeps its colour whatever survives the window). Every bucket of the
// window gets a slot, empty ones too — a quiet day is information.
function slots(d) {
  const out = [];
  const have = new Map((d.buckets || []).map((b) => [b.key, b]));
  const step = d.by === 'week' ? 7 : 1;
  const tz = -new Date().getTimezoneOffset();
  let t = Date.parse(d.from) + tz * 60000;
  if (d.by === 'week') { const dow = (new Date(t).getUTCDay() + 6) % 7; t -= dow * 864e5; }
  const end = Date.now() + tz * 60000;
  for (; t <= end; t += step * 864e5) {
    const key = new Date(t).toISOString().slice(0, 10);
    out.push(have.get(key) || { key, cats: {} });
  }
  return out;
}
// charts draw at the width they get (1 unit = 1px), so text never stretches
function chartWidth() { return Math.max(300, (el.clientWidth || 640) - 58); }
function niceMax(v) {
  if (v <= 0) return 1;
  const p = Math.pow(10, Math.floor(Math.log10(v)));
  for (const m of [1, 2, 2.5, 5, 10]) if (m * p >= v) return m * p;
  return 10 * p;
}
function chart(d) {
  const bs = slots(d);
  const tot = (b) => CATS.reduce((a, c) => a + (b.cats[c.id] ? val(b.cats[c.id]) : 0), 0);
  const max = niceMax(Math.max(0, ...bs.map(tot)));
  const narrow = matchMedia('(max-width: 760px)').matches;
  const W = chartWidth(), H = narrow ? 170 : 200, L = 44, B = 22, T = 8;
  const pw = W - L - 4, ph = H - B - T;
  const bw = pw / bs.length;
  const gap = Math.max(2, Math.min(10, bw * 0.25));
  let g = '';
  for (let i = 0; i <= 4; i++) {
    const y = T + ph - ph * i / 4;
    g += `<line class="us-grid" x1="${L}" x2="${W - 4}" y1="${y}" y2="${y}"/>`
      + `<text class="us-ax" x="${L - 6}" y="${y + 3.5}" text-anchor="end">${esc(fmtVal(max * i / 4))}</text>`;
  }
  const labelEvery = Math.ceil(bs.length / Math.max(4, Math.floor(pw / 34)));
  bs.forEach((b, i) => {
    const x = L + i * bw + gap / 2, w = bw - gap;
    let y = T + ph;
    const on = Q.focus === b.key;
    const tip = [bucketLabel(b.key)].concat(CATS.filter((c) => b.cats[c.id]).map((c) => c.label + ': ' + fmtVal(val(b.cats[c.id])))).join('\n');
    g += `<g class="us-bar${on ? ' on' : ''}${Q.focus && !on ? ' dim' : ''}" data-focus="${b.key}"><title>${esc(tip + '\n' + (on ? 'click: show the whole window' : 'click: drill into this ' + Q.by))}</title>`
      + `<rect class="us-hit" x="${L + i * bw}" y="${T}" width="${bw}" height="${ph + B}"/>`;
    const segs = CATS.filter((c) => b.cats[c.id] && val(b.cats[c.id]) > 0);
    segs.forEach((c, k) => {
      const hgt = ph * val(b.cats[c.id]) / max;
      y -= hgt;
      // 2px surface gap between stacked fills; only the top segment is rounded
      const top = k === segs.length - 1;
      const hh = Math.max(0, hgt - (k ? 2 : 0));
      g += top && hh > 4
        ? `<path fill="${c.color}" d="M${x},${y + hh} v${-(hh - 3)} q0,-3 3,-3 h${w - 6} q3,0 3,3 v${hh - 3} z"/>`
        : `<rect fill="${c.color}" x="${x}" y="${y}" width="${w}" height="${hh}"/>`;
    });
    if (i % labelEvery === 0) g += `<text class="us-ax" x="${x + w / 2}" y="${H - 6}" text-anchor="middle">${esc(bucketLabel(b.key, true))}</text>`;
    g += '</g>';
  });
  const legend = CATS.map((c) => `<span class="us-lg"><i style="background:${c.color}"></i>${c.label}</span>`).join('');
  return `<div class="us-card"><div class="us-cardhead"><span class="us-k">per ${Q.by}, by who spent it</span>${legend}</div>`
    + `<svg class="us-chart" viewBox="0 0 ${W} ${H}" width="${W}" height="${H}" role="img" aria-label="usage per ${Q.by}">${g}</svg></div>`;
}

// ---------- quota trail ----------
// The 5h / 7d used% the CLI reports, as sampled over time: its own chart on its
// own axis, under the bars and spanning the same window, to line the two up.
function quota(d) {
  const qs = (d.quota || []).filter((s) => s.windows);
  if (qs.length < 2) return '';
  const W = chartWidth(), H = 90, L = 44, T = 6, B = 6;
  const t0 = Date.parse(d.from), t1 = Date.now();
  const x = (ts) => L + (W - L - 4) * (Date.parse(ts) - t0) / (t1 - t0);
  const y = (p) => T + (H - T - B) * (1 - Math.min(100, p) / 100);
  let g = '';
  for (const p of [0, 50, 100]) g += `<line class="us-grid" x1="${L}" x2="${W - 4}" y1="${y(p)}" y2="${y(p)}"/><text class="us-ax" x="${L - 6}" y="${y(p) + 3.5}" text-anchor="end">${p}%</text>`;
  const lines = [['7d', 'var(--u-lt)'], ['5h', 'var(--u-other)']];
  for (const [w, color] of lines) {
    const pts = qs.filter((s) => s.windows[w] != null).map((s) => `${x(s.ts).toFixed(1)},${y(s.windows[w]).toFixed(1)}`);
    if (pts.length > 1) g += `<polyline fill="none" stroke="${color}" stroke-width="2" vector-effect="non-scaling-stroke" points="${pts.join(' ')}"/>`;
  }
  const last = qs[qs.length - 1];
  const legend = lines.filter(([w]) => last.windows[w] != null)
    .map(([w, c]) => `<span class="us-lg"><i style="background:${c}"></i>${w} ${Math.round(last.windows[w])}%</span>`).join('');
  return `<div class="us-card"><div class="us-cardhead"><span class="us-k">quota used, as the CLI reported it</span>${legend}</div>`
    + `<svg class="us-chart us-quota" viewBox="0 0 ${W} ${H}" width="${W}" height="${H}" role="img" aria-label="quota used over time">${g}</svg></div>`;
}

// ---------- the drill-down ----------
function table(d, tree) {
  let rows = '';
  const walk = (n, depth, pathKey) => {
    const key = pathKey ? pathKey + '/' + n.id : n.id;
    const kids = n.kids || [];
    const isOpen = open.has(key);
    const caret = kids.length ? `<span class="us-caret">${isOpen ? '▾' : '▸'}</span>` : '<span class="us-caret"></span>';
    const cat = depth === 0 ? CATS.find((c) => c.id === n.id) : null;
    const sw = cat ? `<i class="us-sw" style="background:${cat.color}"></i>` : '';
    let name = esc(n.label);
    let sub = '';
    if (n.kind === 'card') { name = `<span class="us-id">${esc(n.id)}</span> ${esc(n.label === n.id ? '' : n.label)}`; if (n.project) sub = esc(n.project); }
    if (n.kind === 'session') {
      name = `<span class="us-id">${esc(n.label)}</span> ${esc(fmtHour(n.first))}${n.last !== n.first ? ' → ' + esc(fmtHour(n.last)) : ''}`;
      sub = esc((n.models || []).join(', ')) + (n.cwd ? ' · ' + esc(n.cwd) : '');
    }
    const t = n.tok;
    rows += `<tr class="us-row us-d${depth}${kids.length ? ' us-can' : ''}" data-key="${esc(key)}">`
      + `<td class="us-name" style="padding-left:${6 + depth * 14}px">${caret}${sw}<span class="us-label">${name}</span>`
      + (sub ? `<div class="us-subline">${sub}</div>` : '')
      + `<div class="us-split">in ${fmtTokens(t[0])} · out ${fmtTokens(t[1])} · cache r ${fmtTokens(t[2])} · w ${fmtTokens(t[3] + t[4])}</div></td>`
      + `<td class="us-num">${fmtUsd(sum(n.usd))}${n.unpriced ? '<span class="us-unp" title="tokens on models with no price">*</span>' : ''}</td>`
      + `<td class="us-num">${fmtTokens(sum(t))}</td>`
      + `<td class="us-num us-wide">${fmtTokens(t[0])}</td><td class="us-num us-wide">${fmtTokens(t[1])}</td>`
      + `<td class="us-num us-wide">${fmtTokens(t[2])}</td><td class="us-num us-wide">${fmtTokens(t[3] + t[4])}</td>`
      + `<td class="us-num us-wide">${n.n}</td></tr>`;
    if (isOpen) for (const k of kids) walk(k, depth + 1, key);
  };
  for (const c of CATS) { const n = (tree.kids || []).find((k) => k.id === c.id); if (n) walk(n, 0, ''); }
  const scope = d.focus ? `<button type="button" class="us-chip" data-focus="${d.focus}">${esc(bucketLabel(d.focus))} ✕</button>` : '';
  return `<div class="us-card us-tablecard"><div class="us-cardhead"><span class="us-k">who · lieutenant → card → session</span>${scope}</div>`
    + '<div class="us-scroll"><table class="us-table"><thead><tr><th></th><th class="us-num">$</th><th class="us-num">tokens</th>'
    + '<th class="us-num us-wide">input</th><th class="us-num us-wide">output</th><th class="us-num us-wide">cache r</th><th class="us-num us-wide">cache w</th><th class="us-num us-wide">resp</th>'
    + `</tr></thead><tbody>${rows}</tbody></table></div></div>`;
}

function footnote(d) {
  const ps = Object.entries(d.prices || {}).map(([m, p]) => p
    ? `<tr><td>${esc(m)}</td>${p.map((v) => `<td class="us-num">${v}</td>`).join('')}</tr>`
    : `<tr><td>${esc(m)}</td><td colspan="5" class="us-unp">no price: tokens counted, $ left out</td></tr>`).join('');
  return '<details class="us-note"><summary>$ is a weight, not your quota</summary>'
    + '<p>Each response is priced at the API list price of its model, per million tokens: what this work would cost '
    + 'billed by the token. The subscription is not billed that way and its quota formula is not public, so read $ as a weight '
    + 'that puts input, output and cache traffic on one scale. The quota chart shows what the CLI itself reports. '
    + (d.src === 'codex' ? 'OpenAI rates come from public price aggregators, not OpenAI\'s own page. ' : '')
    + 'Override or add rates in <code>.bridge-commander/usage/prices.json</code>.</p>'
    + `<table class="us-prices"><thead><tr><th>model</th>${TOK_LABEL.map((l) => `<th class="us-num">${l}</th>`).join('')}</tr></thead><tbody>${ps}</tbody></table></details>`;
}

// ---------- events (delegated: the screen is rebuilt on every paint) ----------
if (el) el.addEventListener('click', (e) => {
  const q = e.target.closest('[data-q]');
  if (q) {
    const v = q.dataset.v;
    Q[q.dataset.q] = q.dataset.q === 'days' ? parseInt(v, 10) : v;
    if (q.dataset.q === 'unit') { remember(); paint(); return; }
    Q.focus = '';
    remember();
    load();
    return;
  }
  const f = e.target.closest('[data-focus]');
  if (f) { Q.focus = Q.focus === f.dataset.focus ? '' : f.dataset.focus; load(); return; }
  if (e.target.closest('#us-refresh')) {
    loading = true; paint();
    api.usageIndex().catch(() => {}).finally(load);
    return;
  }
  const row = e.target.closest('tr.us-can');
  if (row) {
    const k = row.dataset.key;
    if (open.has(k)) open.delete(k); else open.add(k);
    paint();
  }
});
// The charts are drawn to the pixel, so a new width redraws them — including
// the first one: a screen painted while hidden (a phone on the chat tab) has
// no width yet, and showing it is a resize from 0.
let drawnW = -1;
let resizeT = null;
if (el && typeof ResizeObserver === 'function') new ResizeObserver(() => {
  clearTimeout(resizeT);
  resizeT = setTimeout(() => {
    if (data && el.clientWidth && el.clientWidth !== drawnW) paint();
  }, 100);
}).observe(el);
