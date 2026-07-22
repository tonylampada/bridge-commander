// archtable.js — the 🧊 archived mode: a read-only ledger of frozen card
// snapshots, table layout, newest-archived first (the append-only log's own
// order — no re-sorting), with the pagination the live views don't have:
// page-in PAGE records at a time plus a "shown X of Y" footer. Rows never open
// a detail panel (there is no live card behind them); the only actions are the
// 🧟 unarchive button and the label/owner filter clicks shared with the popup.
import { S, lieutenant, lieutenantColor, render, toggleFilter, filterSelected } from './state.js';
import { esc, agoSpanHtml, cardEmoji, cardPrs, prChipHtml, setHtmlIfChanged } from './util.js';
import { labelChipHtml } from './labels.js';
import { ensureArchive, archivedRows, archiveStats, loadMore, unarchive, PAGE } from './archive.js';

const archEl = document.getElementById('archive');

function rowHtml(row) {
  const c = row.c;
  const l = lieutenant(c.owner);
  const r = row.arch.reason === 'merged' ? 'merged' : 'killed';
  return '<tr class="arch">' +
    '<td class="c-title"><span class="tv-emoji">' + esc(cardEmoji(c)) + '</span>' +
    '<span class="tv-title">' + esc(c.title || c.id) + '</span></td>' +
    '<td class="c-status"><span class="tv-rsn tv-rsn-' + r + '"' + (row.arch.note ? ' title="' + esc(row.arch.note) + '"' : '') + '>' +
    (r === 'merged' ? '🏁 merged' : '🪦 killed') + '</span></td>' +
    '<td class="c-owner' + (filterSelected('owner', c.owner) ? ' active' : '') + '" data-owner="' + esc(c.owner) + '" title="filter by lieutenant">' +
    '<span class="dot" style="background:' + esc(lieutenantColor(c.owner)) + '"></span>' + esc((l && l.name) || c.owner) + '</td>' +
    '<td class="c-labels hide-m">' + (c.labels || []).map((n) => labelChipHtml(n, filterSelected('label', n))).join('') + '</td>' +
    '<td class="c-prs hide-m">' + cardPrs(c).map((pr) => prChipHtml(pr)).join('') + '</td>' +
    '<td class="c-act">' + agoSpanHtml(row.arch.ts, 'tv-ago') + '</td>' +
    '<td class="c-created hide-m">' + agoSpanHtml(c.created, 'tv-ago') + '</td>' +
    '<td class="c-btn"><button class="tv-unarch" data-unarch="' + esc(c.id) + '" title="restore this card to the board">🧟 unarchive</button></td>' +
    '</tr>';
}

export function renderArchive() {
  if (S.boardMode !== 'archive') return;
  ensureArchive();
  const st = archiveStats();
  const list = archivedRows();
  const head = '<tr><th>card</th><th>outcome</th><th>owner</th><th class="hide-m">labels</th>' +
    '<th class="hide-m">prs</th><th>archived</th><th class="hide-m">created</th><th></th></tr>';
  const foot = '<div class="av-foot">' +
    '<span class="tv-n">' + list.length + ' shown · ' + st.loaded + ' of ' + st.total + ' records loaded</span>' +
    (st.more ? '<button id="av-more"' + (st.loading ? ' disabled' : '') + '>' +
      (st.loading ? 'loading…' : 'load ' + Math.min(PAGE, st.total - st.loaded) + ' more') + '</button>' : '') +
    '</div>';
  const html = '<div class="tv-scroll"><table class="tv"><thead>' + head + '</thead><tbody>' +
    (list.length ? list.map(rowHtml).join('')
      : '<tr><td colspan="8" class="tv-empty">' + (st.loading ? 'reading the archive…' : 'nothing archived matches') + '</td></tr>') +
    '</tbody></table>' + foot + '</div>';
  if (!setHtmlIfChanged(archEl, html)) return;
  wire();
}
function wire() {
  const more = archEl.querySelector('#av-more');
  if (more) more.onclick = () => { loadMore(); render(); };
  for (const tr of archEl.querySelectorAll('tbody tr')) {
    tr.onclick = (e) => {
      if (e.target.closest('a')) return;
      const un = e.target.closest('[data-unarch]');
      if (un) { unarchive(un.dataset.unarch, un); return; }
      const lab = e.target.closest('.label');
      if (lab) { toggleFilter('label', lab.dataset.label); return; }
      const own = e.target.closest('.c-owner');
      if (own) toggleFilter('owner', own.dataset.owner);
      // no detail: these are frozen snapshots, not live cards
    };
  }
}
