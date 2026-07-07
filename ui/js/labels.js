// label registry: colors, manage panel (gear), picker popover, chips
import { S, card, render } from './state.js';
import { api } from './api.js';
import { esc } from './util.js';

export function registryLabels() { return ((S.doc && S.doc.labels) || []).filter((l) => l && l.name); }
export function labelColor(name) {
  const l = registryLabels().find((x) => x.name === name);
  return l && /^#[0-9a-fA-F]{6}$/.test(l.color || '') ? l.color : null;
}
export function labelChipHtml(name, active) {
  const col = active ? null : labelColor(name);
  const style = col ? ' style="border-color:' + col + ';color:' + col + '"' : '';
  return '<span class="label' + (active ? ' active' : '') + '" data-label="' + esc(name) + '"' + style +
    ' title="filter by this label">' + esc(name) + '</span>';
}

async function labelApi(body) {
  try { await api.labels(body); } catch (e) { alert(e.message); }
}
export async function saveCardLabels(id, labels) {
  try { await api.patchCard(id, { labels }); } catch (e) { alert(e.message); }
}

// ---------- picker popover ----------
const lpEl = document.getElementById('label-picker');
const lpInput = document.getElementById('lp-input');
const lpList = document.getElementById('lp-list');
let pickerCardId = null;

export function openLabelPicker(cardId, anchor) {
  pickerCardId = cardId;
  const r = anchor.getBoundingClientRect();
  lpEl.hidden = false;
  lpEl.style.left = Math.max(8, Math.min(r.left, window.innerWidth - 218)) + 'px';
  lpEl.style.top = Math.max(8, Math.min(r.bottom + 4, window.innerHeight - 160)) + 'px';
  lpInput.value = '';
  renderPicker();
  lpInput.focus();
}
export function closeLabelPicker() { pickerCardId = null; lpEl.hidden = true; }
export function pickerIsOpen() { return !!pickerCardId; }

function pickerChoices() {
  const c = card(pickerCardId);
  if (!c) return null;
  const q = lpInput.value.trim();
  const ql = q.toLowerCase();
  const have = new Set(c.labels || []);
  const names = registryLabels().map((l) => l.name).filter((n) => !have.has(n));
  const matches = names.filter((n) => n.toLowerCase().includes(ql));
  const creatable = q && !registryLabels().some((l) => l.name.toLowerCase() === ql) && !have.has(q) ? q : null;
  return { card: c, q, matches, creatable };
}
export function renderPicker() {
  if (!pickerCardId) return;
  const ch = pickerChoices();
  if (!ch) { closeLabelPicker(); return; }
  lpList.textContent = '';
  const addRow = (name, isCreate) => {
    const row = document.createElement('div');
    row.className = 'lp-item' + (isCreate ? ' create' : '');
    if (!isCreate) {
      const sw = document.createElement('span');
      sw.className = 'sw';
      sw.style.background = labelColor(name) || 'var(--faint)';
      row.appendChild(sw);
    }
    const t = document.createElement('span');
    t.textContent = isCreate ? 'create "' + name + '"' : name;
    row.appendChild(t);
    row.onclick = (e) => { e.stopPropagation(); addLabel(ch.card, name); };
    lpList.appendChild(row);
  };
  for (const n of ch.matches.slice(0, 12)) addRow(n, false);
  if (ch.creatable) addRow(ch.creatable, true);
}
function addLabel(c, name) {
  if (!name || (c.labels || []).includes(name)) return;
  saveCardLabels(c.id, (c.labels || []).concat(name)); // server auto-registers unknown names
  lpInput.value = '';
}
lpInput.oninput = renderPicker;
lpInput.onkeydown = (e) => {
  if (e.key === 'Escape') { closeLabelPicker(); e.stopPropagation(); return; }
  if (e.key !== 'Enter') return;
  e.preventDefault();
  const ch = pickerChoices();
  if (!ch || (!ch.q && !ch.matches.length)) { closeLabelPicker(); return; }
  const exact = ch.matches.find((n) => n.toLowerCase() === ch.q.toLowerCase());
  const pick = exact || ch.matches[0] || ch.creatable;
  if (pick) addLabel(ch.card, pick); else closeLabelPicker();
};
document.addEventListener('click', (e) => {
  if (!lpEl.hidden && !lpEl.contains(e.target) && !e.target.closest('[data-label-add]')) closeLabelPicker();
});

// ---------- manage panel (inside settings) ----------
export function renderLabelManager() {
  const list = document.getElementById('lm-list');
  if (list.contains(document.activeElement)) return; // don't clobber an in-progress rename
  list.textContent = '';
  for (const l of registryLabels()) {
    const row = document.createElement('div');
    row.className = 'lm-row';
    const color = document.createElement('input');
    color.type = 'color';
    color.value = /^#[0-9a-fA-F]{6}$/.test(l.color || '') ? l.color : '#66788a';
    color.title = 'recolor';
    color.onchange = () => labelApi({ recolor: { name: l.name, color: color.value } });
    const name = document.createElement('input');
    name.type = 'text';
    name.value = l.name;
    name.title = 'rename (Enter or blur commits)';
    const commit = () => {
      const to = name.value.trim();
      if (to && to !== l.name) labelApi({ rename: { from: l.name, to } });
      else name.value = l.name;
    };
    name.onkeydown = (e) => {
      if (e.key === 'Enter') { e.preventDefault(); name.blur(); }
      else if (e.key === 'Escape') { name.value = l.name; name.blur(); e.stopPropagation(); }
    };
    name.onblur = commit;
    const n = document.createElement('span');
    n.className = 'lm-n';
    n.title = 'cards with this label';
    n.textContent = String(((S.doc && S.doc.cards) || []).filter((c) => (c.labels || []).includes(l.name)).length);
    const del = document.createElement('button');
    del.type = 'button'; del.textContent = '✕'; del.title = 'delete label';
    del.onclick = () => {
      if (confirm('Delete label "' + l.name + '" from the board and all cards?')) labelApi({ delete: { name: l.name } });
    };
    row.append(color, name, n, del);
    list.appendChild(row);
  }
}
document.getElementById('lm-new').onsubmit = (e) => {
  e.preventDefault();
  const name = document.getElementById('lm-name');
  const v = name.value.trim();
  if (v) labelApi({ create: { name: v, color: document.getElementById('lm-color').value } });
  name.value = '';
};
