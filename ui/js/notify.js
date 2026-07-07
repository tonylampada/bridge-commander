// notification bell: level-1 filter over the unified event stream, with
// expandable "· N events ·" dividers revealing the suppressed level-2 events.
import { S, allEvents, notifItems, notifUnreadCount, card, kindEmoji, render } from './state.js';
import { api } from './api.js';

const bellBtn = document.getElementById('bell');
const bellN = document.getElementById('bell-n');
const panel = document.getElementById('notif-panel');
const listEl = document.getElementById('np-list');
const showAllCb = document.getElementById('np-show-all');

let detailOpener = null;
export function onOpenCard(fn) { detailOpener = fn; }

bellBtn.onclick = (e) => {
  e.stopPropagation();
  S.notifOpen = !S.notifOpen;
  render();
};
document.addEventListener('click', (e) => {
  if (S.notifOpen && !panel.contains(e.target) && e.target !== bellBtn) { S.notifOpen = false; render(); }
});
showAllCb.onchange = () => { S.notifShowAll = showAllCb.checked; render(); };
document.getElementById('np-mark-all').onclick = async () => {
  try { await api.markAllNotifRead(); } catch (e) { alert(e.message); }
};

function itemNode(e, lvl2) {
  const row = document.createElement('div');
  row.className = 'np-item lvl' + e.level + (lvl2 ? '' : e.read ? ' read' : ' unread');
  const em = document.createElement('span');
  em.className = 'em';
  // emoji from the effective kinds map for ANY mapped kind; unmapped kinds keep
  // the legacy fallback (💡 for level-1 items incl. replies, · for level-2)
  em.textContent = kindEmoji(e.kind) || (e.level === 1 ? '💡' : '·');
  const bd = document.createElement('div');
  bd.className = 'bd';
  const tx = document.createElement('div');
  tx.className = 'tx';
  tx.textContent = e.text;
  const sub = document.createElement('div');
  sub.className = 'sub';
  // the "ago" text lives in a [data-ago] span filled post-render (util.js), so
  // the passage of time alone never changes the list's markup
  sub.textContent = [e.cardTitle || (e.card ? e.card : ''), e.actor].filter(Boolean).map((p) => p + ' · ').join('');
  const agoEl = document.createElement('span');
  agoEl.dataset.ago = e.ts || '';
  sub.append(agoEl, ' ago');
  bd.append(tx, sub);
  row.append(em, bd);
  if (!lvl2) {
    const dot = document.createElement('span');
    dot.className = 'rdot';
    row.appendChild(dot);
  }
  row.onclick = async () => {
    if (e.level === 1 && !e.read) { try { await api.markNotifRead([e.seq]); } catch (err) {} }
    if (e.card && card(e.card) && detailOpener) { S.notifOpen = false; detailOpener(e.card); }
  };
  return row;
}

function gapNode(count, seq) {
  const g = document.createElement('div');
  g.className = 'np-gap';
  g.textContent = '· ' + count + ' event' + (count === 1 ? '' : 's') + ' ·';
  g.title = 'show these events';
  g.onclick = (e) => { e.stopPropagation(); S.notifExpanded.add(seq); render(); };
  return g;
}

// The list rows are DOM-built (per-row click handlers), so the list is
// assembled DETACHED and swapped into the live panel only when its markup
// actually differs from what was last swapped in — otherwise the visible rows
// (and the reader's scroll position) are left alone. Compared against a cached
// string, never the live DOM, which the post-render ago pass mutates.
let lastListHtml = null;
function buildList(into) {
  const all = allEvents(); // ascending seq
  if (S.notifShowAll) {
    if (!all.length) { into.innerHTML = '<div class="np-empty">no events yet</div>'; return; }
    const items = notifItems(); // for read flags on level-1
    const readOf = new Map(items.map((i) => [i.seq, i.read]));
    for (const e of all.slice().reverse()) {
      const node = itemNode(Object.assign({}, e, { read: readOf.get(e.seq) !== false }), e.level === 2);
      into.appendChild(node);
    }
    return;
  }
  const lvl1 = notifItems(); // newest first
  if (!lvl1.length) { into.innerHTML = '<div class="np-empty">nothing yet — level-1 signals land here</div>'; return; }
  // Between consecutive level-1 items sit suppressed level-2 events (by seq gap):
  // collapsed to a "· N events ·" divider, expandable inline. Newer-than-newest
  // level-2 events get a leading divider on top.
  const top = all.filter((x) => x.level === 2 && x.seq > lvl1[0].seq).reverse();
  if (top.length) {
    if (S.notifExpanded.has('top')) for (const g of top) into.appendChild(itemNode(g, true));
    else into.appendChild(gapNode(top.length, 'top'));
  }
  for (let i = 0; i < lvl1.length; i++) {
    const e = lvl1[i];
    into.appendChild(itemNode(e, false));
    const lower = i + 1 < lvl1.length ? lvl1[i + 1].seq : 0;
    const gap = all.filter((x) => x.level === 2 && x.seq > lower && x.seq < e.seq).reverse();
    if (gap.length) {
      if (S.notifExpanded.has(e.seq)) for (const g of gap) into.appendChild(itemNode(g, true));
      else into.appendChild(gapNode(gap.length, e.seq));
    }
  }
}

export function renderNotifications() {
  const unread = notifUnreadCount();
  bellN.hidden = !unread;
  bellN.textContent = unread > 99 ? '99+' : String(unread);
  bellBtn.classList.toggle('on', S.notifOpen);

  panel.hidden = !S.notifOpen;
  if (!S.notifOpen) return;
  showAllCb.checked = S.notifShowAll;

  const tmp = document.createElement('div');
  buildList(tmp);
  if (lastListHtml === tmp.innerHTML) return; // same markup — keep the live rows
  lastListHtml = tmp.innerHTML;
  listEl.textContent = '';
  while (tmp.firstChild) listEl.appendChild(tmp.firstChild);
}
