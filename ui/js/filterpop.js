// filterpop.js — the ONE filter button next to the topbar text input, and its
// popup where the richer filters live: status/type selects, owner/label
// pickers (multi, shown as removable chips) and the updated-recently window.
// The badge counts active popup filters; zero = no badge. Every board-region
// mode shares this state (S.filters) — clicking a label or owner anywhere adds
// a chip here. In 🧊 archived mode the popup slims down to what makes sense on
// frozen snapshots (owner/label/type); status and updated hide.
import { S, lieutenants, columns, render, clearFilters, activeFilterCount, toggleFilter, toggleDim } from './state.js';
import { registryLabels } from './labels.js';
import { esc, setHtmlIfChanged } from './util.js';

const btn = document.getElementById('filter-btn');
const badge = document.getElementById('filter-btn-n');
const panel = document.getElementById('filter-panel');

export function filterPanelOpen() { return !panel.hidden; }
export function closeFilterPanel() { panel.hidden = true; btn.classList.remove('on'); }
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
  if (!panel.hidden && !panel.contains(e.target) && !btn.contains(e.target)) closeFilterPanel();
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
// every option shows, the selected ones light up — OR within the dimension
function optChips(dim, list) {
  return '<span class="fp-opts">' + list.map((o) =>
    '<button type="button" class="fp-opt' + (S.filters[dim].includes(o.v) ? ' on' : '') + '" data-dim="' + dim + '" data-v="' + esc(o.v) + '">' +
    esc(o.t) + '</button>').join('') + '</span>';
}
function renderFilterPanel() {
  const f = S.filters;
  const archMode = S.boardMode === 'archive';
  const chips = f.sel.map((s, i) =>
    '<span class="fchip" data-i="' + i + '" title="remove this filter"><span>' +
    (s.kind === 'owner' ? '@' : '') + esc(s.value) + '</span><span class="x">✕</span></span>').join('');
  const html =
    (chips ? '<div class="fp-chips">' + chips + '</div>' : '') +
    (archMode ? '<div class="fp-note">🧊 archived mode — status/updated don\'t apply to frozen snapshots</div>'
      : '<div class="fp-row"><span class="fp-lbl">status</span>' +
        optChips('columns', columns().map((k) => ({ v: k.id, t: k.title }))) + '</div>') +
    '<div class="fp-row"><span class="fp-lbl">type</span>' +
    optChips('types', [{ v: 'plan', t: '🧠 plan' }, { v: 'implementation', t: '🔥 impl' }, { v: 'investigation', t: '🕵️ invest' }]) + '</div>' +
    '<div class="fp-row"><span class="fp-lbl">owner</span><select data-fp-add="owner">' +
    opts([{ v: '', t: 'add owner…' }].concat(lieutenants().map((l) => ({ v: l.id, t: l.name || l.id }))), '') + '</select></div>' +
    '<div class="fp-row"><span class="fp-lbl">label</span><select data-fp-add="label">' +
    opts([{ v: '', t: 'add label…' }].concat(registryLabels().map((l) => ({ v: l.name, t: l.name }))), '') + '</select></div>' +
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
  // owner/label are multi: choosing adds a chip; the select snaps back to its placeholder
  for (const sel of panel.querySelectorAll('[data-fp-add]')) {
    sel.onchange = () => {
      const v = sel.value;
      sel.value = '';
      if (v) toggleFilter(sel.dataset.fpAdd, v);
    };
  }
  for (const chip of panel.querySelectorAll('.fchip')) {
    chip.onclick = () => {
      S.filters.sel.splice(parseInt(chip.dataset.i, 10), 1);
      render();
    };
  }
  panel.querySelector('#fp-clear').onclick = () => clearFilters();
}
