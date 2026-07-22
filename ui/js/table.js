// table.js — the card ledger: every LIVE card as a sortable row, dual to the
// kanban. Filtering is the SAME state the board uses (S.filters): the topbar
// text input plus the filter popup (filterpop.js). Clicking a label or an
// owner in a row toggles it as a popup chip. Archived cards live in their own
// 🧊 mode (archtable.js) — they never mix in here.
import { S, cards, columns, lieutenant, lieutenantColor, cardVisible, cardStatus, cardRecency, targetOwedState, workerFor, render, toggleFilter, filterSelected } from './state.js';
import { esc, agoSpanHtml, cardEmoji, cardPrs, prChipHtml, ctxBarHtml, setHtmlIfChanged } from './util.js';
import { labelChipHtml } from './labels.js';
import { openDetail } from './detail.js';

const tableEl = document.getElementById('table');

// the table owns nothing but its sort — every filter is shared state
const T = { sort: { key: 'activity', dir: -1 } };

// ---------- columns ----------
const COLS = [
  { key: 'title', label: 'card', sortable: true },
  { key: 'status', label: 'status', sortable: true },
  { key: 'type', label: 'type', sortable: true, hideM: true },
  { key: 'owner', label: 'owner', sortable: true },
  { key: 'labels', label: 'labels', hideM: true },
  { key: 'prs', label: 'prs' },
  { key: 'msgs', label: '💬', sortable: true },
  { key: 'activity', label: 'activity', sortable: true },
  { key: 'created', label: 'created', sortable: true, hideM: true },
];

// ---------- rows ----------
function rows() {
  return cards().filter(cardVisible).map((c) => ({ c })).sort(cmp);
}
const colIndex = (id) => columns().findIndex((k) => k.id === id);
function sortVal(row, key) {
  const c = row.c;
  switch (key) {
    case 'title': return String(c.title || c.id).toLowerCase();
    case 'status': return colIndex(c.column);
    case 'type': return c.type || '';
    case 'owner': return (lieutenant(c.owner) || {}).name || c.owner || '';
    case 'msgs': return (c.thread || []).length;
    case 'activity': return cardRecency(c);
    case 'created': return c.created || '';
    default: return '';
  }
}
function cmp(a, b) {
  const { key, dir } = T.sort;
  const va = sortVal(a, key), vb = sortVal(b, key);
  return (va < vb ? -1 : va > vb ? 1 : 0) * dir;
}

// ---------- html ----------
function headHtml() {
  return '<tr>' + COLS.map((col) => {
    const on = T.sort.key === col.key;
    const arrow = on ? (T.sort.dir > 0 ? ' ▲' : ' ▼') : '';
    return '<th' + (col.sortable ? ' class="sort' + (on ? ' on' : '') + (col.hideM ? ' hide-m' : '') + '" data-sort="' + col.key + '"' : (col.hideM ? ' class="hide-m"' : '')) + '>' +
      esc(col.label) + arrow + '</th>';
  }).join('') + '</tr>';
}
function statusCellHtml(row) {
  const c = row.c;
  const col = columns().find((k) => k.id === c.column);
  const order = c.pendingOrder ? ' <span class="t-order" title="' + esc(c.pendingOrder.kind) + ' pending">⏳</span>' : '';
  return esc(col ? col.title : c.column) + order;
}
function titleCellHtml(row) {
  const c = row.c;
  const owed = targetOwedState('card:' + c.id);
  const st = cardStatus(c);
  const ind = owed
    ? '<span class="t-typing" title="the lieutenant owes you a reply"><span class="tdot"></span><span class="tdot"></span><span class="tdot"></span></span>'
    : st.unread ? '<span class="t-unread" title="unread activity"></span>' : '';
  return '<span class="tv-emoji">' + esc(cardEmoji(c)) + '</span>' +
    '<span class="tv-title">' + esc(c.title || c.id) + '</span>' + ind;
}
function rowHtml(row) {
  const c = row.c;
  const l = lieutenant(c.owner);
  const wst = c.column === 'working' ? ctxBarHtml((workerFor(c.id) || {}).agentStatus) : '';
  return '<tr data-id="' + esc(c.id) + '">' +
    '<td class="c-title">' + titleCellHtml(row) + '</td>' +
    '<td class="c-status">' + statusCellHtml(row) + '</td>' +
    '<td class="c-type hide-m">' + esc(c.type || '') + '</td>' +
    '<td class="c-owner' + (filterSelected('owner', c.owner) ? ' active' : '') + '" data-owner="' + esc(c.owner) + '" title="filter by lieutenant">' +
    '<span class="dot" style="background:' + esc(lieutenantColor(c.owner)) + '"></span>' + esc((l && l.name) || c.owner) + '</td>' +
    '<td class="c-labels hide-m">' + (c.labels || []).map((n) => labelChipHtml(n, filterSelected('label', n))).join('') + '</td>' +
    '<td class="c-prs">' + cardPrs(c).map((pr) => prChipHtml(pr)).join('') + '</td>' +
    '<td class="c-msgs">' + ((c.thread || []).length || '') + '</td>' +
    '<td class="c-act">' + agoSpanHtml(cardRecency(c), 'tv-ago') + wst + '</td>' +
    '<td class="c-created hide-m">' + agoSpanHtml(c.created, 'tv-ago') + '</td>' +
    '</tr>';
}

// ---------- render + wiring ----------
export function renderTable() {
  if (S.boardMode !== 'table') return;
  const list = rows();
  const html = '<div class="tv-scroll"><table class="tv"><thead>' + headHtml() + '</thead><tbody>' +
    (list.length ? list.map(rowHtml).join('') : '<tr><td colspan="9" class="tv-empty">no cards match</td></tr>') +
    '</tbody></table></div>';
  if (!setHtmlIfChanged(tableEl, html)) return;
  wire();
}
function wire() {
  for (const th of tableEl.querySelectorAll('th.sort')) {
    th.onclick = () => {
      const key = th.dataset.sort;
      if (T.sort.key === key) T.sort.dir = -T.sort.dir;
      else T.sort = { key, dir: key === 'activity' || key === 'created' || key === 'msgs' ? -1 : 1 };
      render();
    };
  }
  for (const tr of tableEl.querySelectorAll('tbody tr[data-id]')) {
    tr.onclick = (e) => {
      if (e.target.closest('a')) return; // PR chip: let the link navigate
      // label / owner clicks feed the shared filter (a chip in the popup)
      const lab = e.target.closest('.label');
      if (lab) { toggleFilter('label', lab.dataset.label); return; }
      const own = e.target.closest('.c-owner');
      if (own) { toggleFilter('owner', own.dataset.owner); return; }
      openDetail(tr.dataset.id);
    };
  }
}
