// filterpop.js — the ONE filter button next to the topbar text input, and its
// popup where the richer filters live: status/type selects, owner/label
// pickers (multi, shown as removable chips), the updated-recently window and
// the 🧊 archived toggle. The badge counts active popup filters; zero = no
// badge. Board and table share this state (S.filters) — clicking a label or
// owner anywhere adds a chip here.
import { S, lieutenants, columns, render, clearFilters, activeFilterCount, toggleFilter } from './state.js';
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
function renderFilterPanel() {
  const f = S.filters;
  const chips = f.sel.map((s, i) =>
    '<span class="fchip" data-i="' + i + '" title="remove this filter"><span>' +
    (s.kind === 'owner' ? '@' : '') + esc(s.value) + '</span><span class="x">✕</span></span>').join('');
  const html =
    (chips ? '<div class="fp-chips">' + chips + '</div>' : '') +
    '<div class="fp-row"><span class="fp-lbl">status</span><select data-fp="column">' +
    opts([{ v: '', t: 'any status' }].concat(columns().map((k) => ({ v: k.id, t: k.title }))), f.column) + '</select></div>' +
    '<div class="fp-row"><span class="fp-lbl">type</span><select data-fp="type">' +
    opts([{ v: '', t: 'any type' }, { v: 'plan', t: '🧠 plan' }, { v: 'implementation', t: '🔥 implementation' }, { v: 'investigation', t: '🕵️ investigation' }], f.type) + '</select></div>' +
    '<div class="fp-row"><span class="fp-lbl">owner</span><select data-fp-add="owner">' +
    opts([{ v: '', t: 'add owner…' }].concat(lieutenants().map((l) => ({ v: l.id, t: l.name || l.id }))), '') + '</select></div>' +
    '<div class="fp-row"><span class="fp-lbl">label</span><select data-fp-add="label">' +
    opts([{ v: '', t: 'add label…' }].concat(registryLabels().map((l) => ({ v: l.name, t: l.name }))), '') + '</select></div>' +
    '<div class="fp-row"><span class="fp-lbl">updated</span><select data-fp="age">' + opts(AGES, f.age) + '</select></div>' +
    '<label class="fp-arch"><input type="checkbox" id="fp-archived"' + (f.archived ? ' checked' : '') + '> 🧊 include archived</label>' +
    '<div class="fp-foot"><button id="fp-clear"' + (activeFilterCount() || f.text ? '' : ' disabled') + '>clear all</button></div>';
  if (!setHtmlIfChanged(panel, html)) return;
  wire();
}
function wire() {
  for (const sel of panel.querySelectorAll('[data-fp]')) {
    sel.onchange = () => { S.filters[sel.dataset.fp] = sel.value; render(); };
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
  const arch = panel.querySelector('#fp-archived');
  arch.onchange = () => { S.filters.archived = arch.checked; render(); };
  panel.querySelector('#fp-clear').onclick = () => clearFilters();
}
