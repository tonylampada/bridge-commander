// filterpop.js — the ONE filter button next to the topbar text input, and its
// popup where the richer filters live: status/type selects, owner/label
// pickers (multi, shown as removable chips) and the updated-recently window.
// The badge counts active popup filters; zero = no badge. Every board-region
// mode shares this state (S.filters) — clicking a label or owner anywhere adds
// a chip here. In 🧊 archived mode the popup slims down to what makes sense on
// frozen snapshots (owner/label/type); status and updated hide.
import { S, lieutenants, columns, render, clearFilters, activeFilterCount, setFilter, filterMode, toggleDim } from './state.js';
import { registryLabels } from './labels.js';
import { esc, setHtmlIfChanged } from './util.js';

const btn = document.getElementById('filter-btn');
const badge = document.getElementById('filter-btn-n');
const panel = document.getElementById('filter-panel');

export function filterPanelOpen() { return !panel.hidden; }
export function closeFilterPanel() { panel.hidden = true; btn.classList.remove('on'); ddOpen = null; }
export function openFilterPanel() {
  panel.hidden = false;
  btn.classList.add('on');
  panel.__bcHtml = null; // force a fresh paint (selects may have gone stale while closed)
  renderFilterPanel();
  // anchor under the button, right-aligned, clamped to the viewport
  const r = btn.getBoundingClientRect();
  const w = panel.offsetWidth;
  panel.style.left = Math.max(8, Math.min(r.right - w, window.innerWidth - w - 8)) + 'px';
  panel.style.top = (r.bottom + 6) + 'px';
}
btn.onclick = (e) => {
  e.stopPropagation();
  if (filterPanelOpen()) closeFilterPanel(); else openFilterPanel();
};
document.addEventListener('click', (e) => {
  // composedPath, not contains: a tri-state row click repaints the panel
  // synchronously, so by the time the click bubbles here its target is detached
  const path = e.composedPath ? e.composedPath() : [];
  if (!panel.hidden && !path.includes(panel) && !path.includes(btn)) closeFilterPanel();
});

// badge + (when open) panel content — called from the main render pass
export function renderFilterUI() {
  const n = activeFilterCount();
  badge.hidden = !n;
  badge.textContent = String(n);
  btn.classList.toggle('active', !!n);
  if (!panel.hidden) renderFilterPanel();
}

function opts(list, cur) {
  return list.map((o) => '<option value="' + esc(o.v) + '"' + (o.v === cur ? ' selected' : '') + '>' + esc(o.t) + '</option>').join('');
}
const AGES = [
  { v: '', t: 'any time' }, { v: '3600', t: 'last hour' }, { v: 'today', t: 'today' },
  { v: '259200', t: 'last 3 days' }, { v: '604800', t: 'last week' },
];
// a multi-toggle chip group for a small enum dimension (status / type):
// every option shows, the selected ones light up — OR within the dimension.
// An option with a short form `s` (its emoji) renders that alone, keeping the
// full text `t` as title/aria-label, so the group fits one line.
function optChips(dim, list) {
  return '<span class="fp-opts">' + list.map((o) =>
    '<button type="button" class="fp-opt' + (S.filters[dim].includes(o.v) ? ' on' : '') + '" data-dim="' + dim + '" data-v="' + esc(o.v) + '"' +
    (o.s ? ' title="' + esc(o.t) + '" aria-label="' + esc(o.t) + '"' : '') + '>' +
    esc(o.s || o.t) + '</button>').join('') + '</span>';
}
// which tri-state dropdown list is unfolded ('owner' | 'label' | null) — kept
// across repaints so cycling a row doesn't snap the list shut
let ddOpen = null;
// a tri-state picker row set: every option carries a 3-position switch
// (⊘ exclude / · don't care / ✓ include) — a tap sets the state directly.
// The trigger sums up the picks.
function triDd(kind, list) {
  const nIn = list.filter((o) => filterMode(kind, o.v) === 'in').length;
  const nOut = list.filter((o) => filterMode(kind, o.v) === 'out').length;
  const sum = (nIn ? '✓' + nIn : '') + (nIn && nOut ? ' ' : '') + (nOut ? '⊘' + nOut : '');
  const open = ddOpen === kind;
  const seg = (kind2, v, m, mode, glyph) =>
    '<button type="button" class="sw-' + (mode || 'off') + (m === mode ? ' on' : '') +
    '" data-sw="' + kind2 + '" data-v="' + esc(v) + '" data-m="' + mode + '">' + glyph + '</button>';
  const rows = list.map((o) => {
    const m = filterMode(kind, o.v);
    return '<div class="fp-tri' + (m ? ' ' + m : '') + '"><span class="nm">' + esc(o.t) + '</span>' +
      '<span class="fp-sw">' + seg(kind, o.v, m, 'out', '⊘') + seg(kind, o.v, m, '', '·') + seg(kind, o.v, m, 'in', '✓') + '</span></div>';
  }).join('');
  return '<div class="fp-dd">' +
    '<button type="button" class="fp-dd-btn' + (open ? ' open' : '') + '" data-dd="' + kind + '">' +
    '<span>' + (sum || 'any') + '</span><span class="car">' + (open ? '▴' : '▾') + '</span></button>' +
    (open ? '<div class="fp-dd-list">' + rows + '</div>' : '') + '</div>';
}
function renderFilterPanel() {
  const f = S.filters;
  const archMode = S.boardMode === 'archive';
  const chips = f.sel.map((s, i) =>
    '<span class="fchip' + (s.mode === 'out' ? ' ex' : '') + '" data-i="' + i +
    '" title="remove this filter"><span>' + (s.mode === 'out' ? '⊘ ' : '') +
    (s.kind === 'owner' ? '@' : '') + esc(s.value) + '</span><span class="x">✕</span></span>').join('');
  const html =
    (chips ? '<div class="fp-chips">' + chips + '</div>' : '') +
    (archMode ? '<div class="fp-note">🧊 archived mode — status/updated don\'t apply to frozen snapshots</div>'
      : '<div class="fp-row"><span class="fp-lbl">status</span>' +
        optChips('columns', columns().map((k) => ({ v: k.id, t: k.title, s: k.title.split(/\s+/)[0] }))) + '</div>') +
    '<div class="fp-row"><span class="fp-lbl">type</span>' +
    optChips('types', [{ v: 'plan', t: '🧠 plan', s: '🧠' }, { v: 'implementation', t: '🔥 impl', s: '🔥' }, { v: 'investigation', t: '🕵️ invest', s: '🕵️' }]) + '</div>' +
    '<div class="fp-row"><span class="fp-lbl">lieutenant</span>' +
    triDd('owner', lieutenants().map((l) => ({ v: l.id, t: l.name || l.id }))) + '</div>' +
    '<div class="fp-row"><span class="fp-lbl">label</span>' +
    triDd('label', registryLabels().map((l) => ({ v: l.name, t: l.name }))) + '</div>' +
    (archMode ? '' : '<div class="fp-row"><span class="fp-lbl">updated</span><select data-fp="age">' + opts(AGES, f.age) + '</select></div>') +
    '<div class="fp-foot"><button id="fp-clear"' + (activeFilterCount() || f.text ? '' : ' disabled') + '>clear all</button></div>';
  if (!setHtmlIfChanged(panel, html)) return;
  wire();
}
function wire() {
  for (const sel of panel.querySelectorAll('[data-fp]')) {
    sel.onchange = () => { S.filters[sel.dataset.fp] = sel.value; render(); };
  }
  for (const b of panel.querySelectorAll('.fp-opt')) {
    b.onclick = () => toggleDim(b.dataset.dim, b.dataset.v);
  }
  for (const b of panel.querySelectorAll('[data-dd]')) {
    b.onclick = () => { ddOpen = ddOpen === b.dataset.dd ? null : b.dataset.dd; panel.__bcHtml = null; renderFilterPanel(); };
  }
  for (const b of panel.querySelectorAll('[data-sw]')) {
    b.onclick = () => setFilter(b.dataset.sw, b.dataset.v, b.dataset.m);
  }
  for (const chip of panel.querySelectorAll('.fchip')) {
    chip.onclick = () => {
      S.filters.sel.splice(parseInt(chip.dataset.i, 10), 1);
      render();
    };
  }
  panel.querySelector('#fp-clear').onclick = () => clearFilters();
}
