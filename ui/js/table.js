// table.js — the card ledger: every card as a sortable row, dual to the kanban.
// Same cards, same global filter (text/age/chips all still apply); the toolbar
// adds table-native filters (status/owner/type/label selects) plus the archive:
// archived cards are frozen snapshots fetched on demand from /api/archive,
// rendered dimmed with their reason, and restorable in place (🧟 unarchive).
import { S, cards, columns, lieutenants, lieutenant, lieutenantColor, cardVisible, cardStatus, cardRecency, targetOwedState, workerFor, render } from './state.js';
import { api } from './api.js';
import { esc, agoSpanHtml, cardEmoji, cardPrs, prChipHtml, ctxBarHtml, setHtmlIfChanged } from './util.js';
import { labelChipHtml, registryLabels } from './labels.js';
import { openDetail } from './detail.js';

const tableEl = document.getElementById('table');

// view state (module-local: the table owns its filters, the board never sees them)
const T = {
  sort: { key: 'activity', dir: -1 },
  status: '', owner: '', type: '', label: '',   // toolbar selects; '' = any
  archived: false,                              // include archived rows
  recs: [], fetched: false, fetching: false,    // /api/archive cache
};

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
  { key: 'act', label: '' },
];

// ---------- rows ----------
// A row is {c: card, arch: null | archiveRec}. Archived rows use the frozen
// snapshot; a record whose card is live again (restored) is skipped.
function rows() {
  const out = [];
  for (const c of cards()) out.push({ c, arch: null });
  if (T.archived) {
    const live = new Set(cards().map((c) => c.id));
    const seen = new Set();
    for (let i = 0; i < T.recs.length; i++) { // newest first — keep only the latest record per id
      const r = T.recs[i];
      if (!r || !r.card || live.has(r.card.id) || seen.has(r.card.id)) continue;
      seen.add(r.card.id);
      out.push({ c: r.card, arch: r });
    }
  }
  return out.filter(rowVisible).sort(cmp);
}
function rowVisible(row) {
  const c = row.c;
  if (!row.arch && !cardVisible(c)) return false; // the global filter still rules live cards
  if (T.status === 'archived') { if (!row.arch) return false; }
  else if (T.status) { if (row.arch || c.column !== T.status) return false; }
  if (T.owner && c.owner !== T.owner) return false;
  if (T.type && c.type !== T.type) return false;
  if (T.label && !(c.labels || []).includes(T.label)) return false;
  return true;
}
const colIndex = (id) => columns().findIndex((k) => k.id === id);
function sortVal(row, key) {
  const c = row.c;
  switch (key) {
    case 'title': return String(c.title || c.id).toLowerCase();
    case 'status': return row.arch ? 99 : colIndex(c.column); // archived sorts last
    case 'type': return c.type || '';
    case 'owner': return (lieutenant(c.owner) || {}).name || c.owner || '';
    case 'msgs': return (c.thread || []).length;
    case 'activity': return row.arch ? row.arch.ts || '' : cardRecency(c);
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
function optionList(list, cur) {
  return list.map((o) => '<option value="' + esc(o.v) + '"' + (o.v === cur ? ' selected' : '') + '>' + esc(o.t) + '</option>').join('');
}
function toolbarHtml(shown, archivedN) {
  const statuses = [{ v: '', t: 'any status' }]
    .concat(columns().map((k) => ({ v: k.id, t: k.title })))
    .concat(T.archived ? [{ v: 'archived', t: '🧊 archived' }] : []);
  const owners = [{ v: '', t: 'any owner' }].concat(lieutenants().map((l) => ({ v: l.id, t: l.name || l.id })));
  const types = [{ v: '', t: 'any type' }, { v: 'plan', t: '🧠 plan' }, { v: 'implementation', t: '🔥 implementation' }, { v: 'investigation', t: '🕵️ investigation' }];
  const labels = [{ v: '', t: 'any label' }].concat(registryLabels().map((l) => ({ v: l.name, t: l.name })));
  return '<div class="tv-bar">' +
    '<select data-tf="status" title="status">' + optionList(statuses, T.status) + '</select>' +
    '<select data-tf="owner" title="owner">' + optionList(owners, T.owner) + '</select>' +
    '<select data-tf="type" title="type">' + optionList(types, T.type) + '</select>' +
    '<select data-tf="label" title="label">' + optionList(labels, T.label) + '</select>' +
    '<label class="tv-arch" title="include archived cards">' +
    '<input type="checkbox" id="tv-archived"' + (T.archived ? ' checked' : '') + '> 🧊 archived' +
    (T.archived ? ' (' + archivedN + ')' : '') + '</label>' +
    '<span class="grow"></span>' +
    '<span class="tv-n">' + shown + ' card' + (shown === 1 ? '' : 's') + '</span>' +
    '</div>';
}
function headHtml() {
  return '<tr>' + COLS.map((col) => {
    const on = T.sort.key === col.key;
    const arrow = on ? (T.sort.dir > 0 ? ' ▲' : ' ▼') : '';
    return '<th' + (col.sortable ? ' class="sort' + (on ? ' on' : '') + (col.hideM ? ' hide-m' : '') + '" data-sort="' + col.key + '"' : (col.hideM ? ' class="hide-m"' : '')) + '>' +
      esc(col.label) + arrow + '</th>';
  }).join('') + '</tr>';
}
function statusCellHtml(row) {
  if (row.arch) {
    const r = row.arch.reason === 'merged' ? 'merged' : 'killed';
    return '<span class="tv-rsn tv-rsn-' + r + '"' + (row.arch.note ? ' title="' + esc(row.arch.note) + '"' : '') + '>' +
      (r === 'merged' ? '🏁 merged' : '🪦 killed') + '</span>' + agoSpanHtml(row.arch.ts, 'tv-ago');
  }
  const c = row.c;
  const col = columns().find((k) => k.id === c.column);
  const order = c.pendingOrder ? ' <span class="t-order" title="' + esc(c.pendingOrder.kind) + ' pending">⏳</span>' : '';
  return esc(col ? col.title : c.column) + order;
}
function titleCellHtml(row) {
  const c = row.c;
  let ind = '';
  if (!row.arch) {
    const owed = targetOwedState('card:' + c.id);
    const st = cardStatus(c);
    ind = owed
      ? '<span class="t-typing" title="the lieutenant owes you a reply"><span class="tdot"></span><span class="tdot"></span><span class="tdot"></span></span>'
      : st.unread ? '<span class="t-unread" title="unread activity"></span>' : '';
  }
  return '<span class="tv-emoji">' + esc(cardEmoji(c)) + '</span>' +
    '<span class="tv-title">' + esc(c.title || c.id) + '</span>' + ind;
}
function rowHtml(row) {
  const c = row.c;
  const l = lieutenant(c.owner);
  const wst = !row.arch && c.column === 'working' ? ctxBarHtml((workerFor(c.id) || {}).agentStatus) : '';
  return '<tr data-id="' + esc(c.id) + '"' + (row.arch ? ' class="arch" data-arch="1"' : '') + '>' +
    '<td class="c-title">' + titleCellHtml(row) + '</td>' +
    '<td class="c-status">' + statusCellHtml(row) + '</td>' +
    '<td class="c-type hide-m">' + esc(c.type || '') + '</td>' +
    '<td class="c-owner"><span class="dot" style="background:' + esc(lieutenantColor(c.owner)) + '"></span>' + esc((l && l.name) || c.owner) + '</td>' +
    '<td class="c-labels hide-m">' + (c.labels || []).map((n) => labelChipHtml(n, false)).join('') + '</td>' +
    '<td class="c-prs">' + cardPrs(c).map((pr) => prChipHtml(pr)).join('') + '</td>' +
    '<td class="c-msgs">' + ((c.thread || []).length || '') + '</td>' +
    '<td class="c-act">' + agoSpanHtml(row.arch ? row.arch.ts : cardRecency(c), 'tv-ago') + wst + '</td>' +
    '<td class="c-created hide-m">' + agoSpanHtml(c.created, 'tv-ago') + '</td>' +
    '<td class="c-btn">' + (row.arch ? '<button class="tv-unarch" data-unarch="' + esc(c.id) + '" title="restore this card to the board">🧟 unarchive</button>' : '') + '</td>' +
    '</tr>';
}

// ---------- archive fetch (on demand, cached until the next toggle/restore) ----------
function fetchArchive() {
  if (T.fetching) return;
  T.fetching = true;
  api.archive()
    .then((r) => { T.recs = r.archive || []; T.fetched = true; })
    .catch(() => { T.recs = []; })
    .finally(() => { T.fetching = false; render(); });
}

// ---------- render + wiring ----------
export function renderTable() {
  if (S.boardMode !== 'table') return;
  const list = rows();
  const archivedN = T.archived ? list.filter((r) => r.arch).length : 0;
  const html = toolbarHtml(list.length, archivedN) +
    '<div class="tv-scroll"><table class="tv"><thead>' + headHtml() + '</thead><tbody>' +
    (list.length ? list.map(rowHtml).join('') : '<tr><td colspan="10" class="tv-empty">no cards match</td></tr>') +
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
  for (const sel of tableEl.querySelectorAll('[data-tf]')) {
    sel.onchange = () => { T[sel.dataset.tf] = sel.value; render(); };
  }
  const arch = tableEl.querySelector('#tv-archived');
  if (arch) arch.onchange = () => {
    T.archived = arch.checked;
    if (T.status === 'archived' && !T.archived) T.status = '';
    if (T.archived && !T.fetched) fetchArchive();
    render();
  };
  for (const tr of tableEl.querySelectorAll('tbody tr[data-id]')) {
    tr.onclick = (e) => {
      if (e.target.closest('a')) return; // PR chip: let the link navigate
      const un = e.target.closest('[data-unarch]');
      if (un) {
        un.disabled = true;
        api.restoreCard(un.dataset.unarch)
          .then(() => { T.fetched = false; fetchArchive(); }) // the broadcast brings the live card
          .catch((err) => { un.disabled = false; alert(err.message); });
        return;
      }
      if (tr.dataset.arch) return; // frozen snapshot — no live detail behind it
      openDetail(tr.dataset.id);
    };
  }
}
