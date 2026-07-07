// board: columns of dense tiles, drag&drop, long-press move menu, new-card modal
import { S, columns, cards, cardVisible, cardStatus, cardRecency, targetOwedStale, toggleFilter, filterSelected, render } from './state.js';
import { api } from './api.js';
import { esc, ago, cardEmoji, ownerColor, cardPrs, prChipHtml } from './util.js';
import { labelChipHtml } from './labels.js';
import { openDetail } from './detail.js';

const boardEl = document.getElementById('board');

function byRecency(a, b) {
  return (new Date(cardRecency(b) || 0).getTime() || 0) - (new Date(cardRecency(a) || 0).getTime() || 0);
}

function tileHtml(c) {
  const at = c.attributes || {};
  const owner = at.owner || '';
  const repo = at.repo || '';
  const msgs = (c.thread || []).length;
  const st = cardStatus(c);
  // "agent owes you a reply" balloon: SAME source as the chat typing bubble
  // (card.status.owed, server-derived), so tile and chat can never drift.
  // Takes priority over the unread dot — one unambiguous corner indicator.
  // stale-owed mirrors the chat's "may be stuck" state: static amber ⚠, no dots.
  const owed = !!st.owed;
  const staleW = owed && targetOwedStale('card:' + c.id);
  const cornerInd = staleW
    ? '<span class="t-typing stale" title="no response yet — the agent may be stuck">⚠</span>'
    : owed
    ? '<span class="t-typing" title="the agent owes you a reply here"><span class="tdot"></span><span class="tdot"></span><span class="tdot"></span></span>'
    : (st.unread ? '<span class="t-unread" title="unread activity"></span>' : '');
  const hasLink = Object.entries(at).some(([k, v]) => k !== 'owner' && /^https?:\/\//.test(String(v)));
  const labels = (c.labels || []).map((n) => labelChipHtml(n, filterSelected('label', n))).join('');
  // PR chips: attributes.prs [{url, state}] — one state-colored chip per entry
  const prs = cardPrs(c).map((pr) => prChipHtml(pr)).join('');
  // worker-state stripe on the tile's LEFT edge — a PERSISTENT status signal,
  // deliberately separate from the transient top-right corner. Driven by
  // card.status.worker (the lease); only the known states get a stripe (whitelist,
  // so absent renders no stripe and no server value ever reaches the class name —
  // XSS-safe). working=green pulsing, needs-you=amber solid, idle=gray solid,
  // absent=none.
  const WORKER_STATES = { working: 'Working', 'needs-you': 'Needs you', idle: 'Idle' };
  const worker = st.worker && WORKER_STATES[st.worker.state] ? st.worker.state : '';
  const workerCls = worker ? ' worker worker-' + worker : ''; // worker value is whitelisted above
  const workerTitle = worker
    ? ' title="worker: ' + esc(WORKER_STATES[worker]) + (st.worker.id ? ' — ' + esc(st.worker.id) : '') + '"'
    : '';
  return '<div class="tile' + (c.id === S.openCardId ? ' open' : '') + workerCls + '" draggable="true" data-id="' + esc(c.id) + '"' + workerTitle + '>' +
    '<div class="t-row1"><span class="t-emoji">' + esc(cardEmoji(c)) + '</span>' +
    '<span class="t-title">' + esc(c.title || c.id) + '</span>' +
    cornerInd + '</div>' +
    (labels || prs ? '<div class="t-chips">' + labels + prs + '</div>' : '') +
    '<div class="t-foot">' +
    (owner ? '<span class="t-owner' + (filterSelected('owner', owner) ? ' active' : '') + '" data-owner="' + esc(owner) +
      '" title="filter by owner"><span class="dot" style="background:' + ownerColor(owner) + '"></span>' + esc(owner) + '</span>' : '') +
    (repo ? '<span class="t-repo" title="repo">' + esc(repo) + '</span>' : '') +
    '<span class="grow"></span>' +
    (hasLink ? '<span class="t-ind" title="has link">📎</span>' : '') +
    (msgs ? '<span class="t-ind" title="' + msgs + ' messages">💬' + msgs + '</span>' : '') +
    '<span class="t-ago">' + ago(cardRecency(c)) + '</span>' +
    '</div></div>';
}

export function renderBoard() {
  const sx = boardEl.scrollLeft;
  const colScroll = {};
  boardEl.querySelectorAll('.column').forEach((col) => {
    colScroll[col.dataset.id] = col.querySelector('.cards').scrollTop;
  });

  const cols = columns();
  if (!cols.length) {
    boardEl.innerHTML = '<div class="empty">no columns yet — the agent hasn\'t set up this board</div>';
    return;
  }
  boardEl.innerHTML = cols.map((col) => {
    const list = cards().filter((c) => c.column === col.id && cardVisible(c)).sort(byRecency);
    return '<div class="column" data-id="' + esc(col.id) + '"><h2><span>' + esc(col.title || col.id) + '</span>' +
      '<span class="count">' + list.length + '</span>' +
      '<button class="add-card" title="new card here">+</button></h2>' +
      '<div class="cards">' + list.map(tileHtml).join('') + '</div></div>';
  }).join('');
  boardEl.scrollLeft = sx;
  boardEl.querySelectorAll('.column').forEach((col) => {
    if (colScroll[col.dataset.id] != null) col.querySelector('.cards').scrollTop = colScroll[col.dataset.id];
  });
  wire();
}

// ---------- interactions ----------
let pressTimer = null, pressFired = false;

function wire() {
  boardEl.querySelectorAll('.tile').forEach((el) => {
    el.onclick = (e) => {
      if (pressFired) { pressFired = false; return; } // long-press already handled
      const t = e.target;
      if (t.closest('a')) return; // PR chip / link: let the anchor navigate, don't open detail
      if (t.classList.contains('label')) { toggleFilter('label', t.dataset.label); return; }
      const own = t.closest('.t-owner');
      if (own) { toggleFilter('owner', own.dataset.owner); return; }
      openDetail(el.dataset.id);
    };
    // drag&drop (desktop)
    el.ondragstart = (e) => {
      e.dataTransfer.setData('text/bridge-card', el.dataset.id);
      e.dataTransfer.effectAllowed = 'move';
      el.classList.add('dragging');
    };
    el.ondragend = () => el.classList.remove('dragging');
    // long-press (touch) -> move menu
    el.addEventListener('pointerdown', (e) => {
      if (e.pointerType !== 'touch') return;
      pressFired = false;
      pressTimer = setTimeout(() => {
        pressFired = true;
        openMoveMenu(el.dataset.id, e.clientX, e.clientY);
      }, 480);
    });
    for (const evName of ['pointerup', 'pointercancel', 'pointermove']) {
      el.addEventListener(evName, (e) => {
        if (evName === 'pointermove' && pressTimer) return; // small moves ok until fired
        clearTimeout(pressTimer); pressTimer = null;
      });
    }
    el.oncontextmenu = (e) => { e.preventDefault(); openMoveMenu(el.dataset.id, e.clientX, e.clientY); };
  });
  boardEl.querySelectorAll('.column').forEach((col) => {
    const id = col.dataset.id;
    col.ondragover = (e) => {
      if (e.dataTransfer.types.includes('text/bridge-card')) { e.preventDefault(); col.classList.add('drag-over'); }
    };
    col.ondragleave = () => col.classList.remove('drag-over');
    col.ondrop = async (e) => {
      e.preventDefault();
      col.classList.remove('drag-over');
      const cardId = e.dataTransfer.getData('text/bridge-card');
      if (cardId) { try { await api.moveCard(cardId, id); } catch (err) { alert(err.message); } }
    };
    col.querySelector('.add-card').onclick = (e) => { e.stopPropagation(); openNewCard(id); };
  });
}

// ---------- move / actions menu ----------
const menuEl = document.getElementById('move-menu');
export function openMoveMenu(cardId, x, y) {
  const c = cards().find((k) => k.id === cardId);
  if (!c) return;
  menuEl.textContent = '';
  const head = document.createElement('div');
  head.className = 'mm-head';
  head.textContent = 'move to';
  menuEl.appendChild(head);
  for (const col of columns()) {
    const b = document.createElement('button');
    b.textContent = (col.id === c.column ? '● ' : '') + col.title;
    if (col.id === c.column) b.className = 'cur';
    else b.onclick = async () => { closeMoveMenu(); try { await api.moveCard(cardId, col.id); } catch (e) { alert(e.message); } };
    menuEl.appendChild(b);
  }
  const sep = document.createElement('div');
  sep.className = 'mm-sep';
  menuEl.appendChild(sep);
  const kill = document.createElement('button');
  kill.className = 'danger';
  kill.textContent = '✕ archive';
  kill.onclick = async () => { closeMoveMenu(); try { await api.archiveCard(cardId); } catch (e) { alert(e.message); } };
  menuEl.appendChild(kill);
  menuEl.hidden = false;
  const r = menuEl.getBoundingClientRect();
  menuEl.style.left = Math.max(8, Math.min(x, window.innerWidth - r.width - 8)) + 'px';
  menuEl.style.top = Math.max(8, Math.min(y, window.innerHeight - r.height - 8)) + 'px';
}
export function closeMoveMenu() { menuEl.hidden = true; }
document.addEventListener('click', (e) => { if (!menuEl.hidden && !menuEl.contains(e.target)) closeMoveMenu(); });

// ---------- new card modal ----------
const ncOverlay = document.getElementById('nc-overlay');
const ncType = document.getElementById('nc-type');
let ncColumnId = ''; // the column whose "+" opened the modal — the create target
export function openNewCard(columnId) {
  ncColumnId = columnId || (columns()[0] && columns()[0].id) || '';
  ncType.value = 'plan';
  document.getElementById('nc-name').value = '';
  document.getElementById('nc-body').value = '';
  ncOverlay.hidden = false;
  document.getElementById('nc-name').focus();
}
export function closeNewCard() { ncOverlay.hidden = true; }
export function newCardOpen() { return !ncOverlay.hidden; }
document.getElementById('nc-cancel').onclick = closeNewCard;
ncOverlay.onclick = (e) => { if (e.target === ncOverlay) closeNewCard(); };
document.getElementById('nc-modal').onsubmit = async (e) => {
  e.preventDefault();
  const title = document.getElementById('nc-name').value.trim();
  if (!title) return;
  const body = document.getElementById('nc-body').value;
  try {
    const r = await api.createCard({ title, column: ncColumnId, body, attributes: { type: ncType.value } });
    closeNewCard();
    openDetail(r.card.id);
  } catch (err) { alert(err.message); }
};
