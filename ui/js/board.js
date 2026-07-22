// board: dense card tiles, drag&drop, long-press move menu, new-card /
// new-lieutenant modals. (Lieutenant switching lives in the chat header —
// ltswitcher.js — not on the board.)
import { S, columns, cards, lieutenants, lieutenant, lieutenantColor, cardVisible, cardStatus, cardRecency, targetOwedState, targetOwedStale, toggleFilter, filterSelected, workerFor } from './state.js';
import { api } from './api.js';
import { esc, agoSpanHtml, cardEmoji, cardPrs, prChipHtml, ctxBarHtml } from './util.js';
import { labelChipHtml } from './labels.js';
import { openDetail } from './detail.js';
import { openLieutenantChat } from './chat.js';
import { openCardPane } from './pane.js';
import { avatarGridHtml, wireAvatarGrid } from './avatars.js';
import { ensureArchive, archivedRows, unarchive } from './archive.js';

const boardEl = document.getElementById('board');

function byRecency(a, b) {
  return (new Date(cardRecency(b) || 0).getTime() || 0) - (new Date(cardRecency(a) || 0).getTime() || 0);
}

// ---------- tiles ----------
function tileHtml(c) {
  const at = c.attributes || {};
  const repo = at.repo || '';
  // harness/model hint (set from the new-card modal) — a small badge so the
  // board tells the truth about how this card will start its worker
  const hintTxt = [at.harness, at.model].filter(Boolean).join(' · ');
  const hint = hintTxt
    ? '<span class="t-harness" title="starts with ' + esc(hintTxt) + '">' + esc(hintTxt) + '</span>'
    : '';
  const msgs = (c.thread || []).length;
  const st = cardStatus(c);
  // "the lieutenant owes you a reply" balloon: SAME source as the chat typing
  // bubble (card.status.owedState, server-derived), so tile and chat can never
  // drift. Takes priority over the unread dot — one unambiguous corner indicator.
  // stale-owed mirrors the chat's "may be stuck" state: static amber ⚠, no dots.
  // queued mirrors the chat's "delivered, not picked up": static hourglass, no dots.
  const owed = targetOwedState('card:' + c.id);
  const staleW = owed && targetOwedStale('card:' + c.id);
  const cornerInd = staleW
    ? '<span class="t-typing stale" title="no response yet — the lieutenant may be stuck">⚠</span>'
    : owed === 'queued'
    ? '<span class="t-typing queued" title="delivered — the lieutenant hasn\'t picked it up yet">⏳</span>'
    : owed
    ? '<span class="t-typing" title="the lieutenant owes you a reply here"><span class="tdot"></span><span class="tdot"></span><span class="tdot"></span></span>'
    : (st.unread ? '<span class="t-unread" title="unread activity"></span>' : '');
  const hasLink = Object.entries(at).some(([k, v]) => /^https?:\/\//.test(String(v)));
  const labels = (c.labels || []).map((n) => labelChipHtml(n, filterSelected('label', n))).join('');
  // PR chips: attributes.prs [{url, state}] — one state-colored chip per entry
  const prs = cardPrs(c).map((pr) => prChipHtml(pr)).join('');
  // a captain drag-order awaiting the lieutenant: subtle pending marker
  const order = c.pendingOrder
    ? '<span class="t-order" title="' + esc(c.pendingOrder.kind) + ' sent to ' + esc(c.owner) + ' — the card moves when the lieutenant acts">⏳ ordered</span>'
    : '';
  // worker-state stripe on the tile's RIGHT edge — a PERSISTENT status signal,
  // deliberately separate from the transient top-right corner (the LEFT edge is
  // the owner's color). Driven by card.status.worker (the lease); only the known
  // states get a stripe (whitelist, so no server value ever reaches the class
  // name — XSS-safe). working=green pulsing, needs-you=amber, idle=gray.
  const WORKER_STATES = { working: 'Working', 'needs-you': 'Needs you', idle: 'Idle' };
  const worker = st.worker && WORKER_STATES[st.worker.state] ? st.worker.state : '';
  const workerCls = worker ? ' worker worker-' + worker : ''; // worker value is whitelisted above
  const workerTitle = worker
    ? ' title="worker: ' + esc(WORKER_STATES[worker]) + (st.worker.id ? ' — ' + esc(st.worker.id) : '') + '"'
    : '';
  // owner color stripe on the LEFT edge: every card belongs to exactly one lieutenant
  const stripe = '<span class="t-stripe" style="background:' + esc(lieutenantColor(c.owner)) + '"></span>';
  return '<div class="tile' + (c.id === S.openCardId ? ' open' : '') + workerCls + '" draggable="true" data-id="' + esc(c.id) + '"' + workerTitle + '>' +
    stripe +
    '<div class="t-row1"><span class="t-emoji">' + esc(cardEmoji(c)) + '</span>' +
    '<span class="t-title">' + esc(c.title || c.id) + '</span>' +
    cornerInd + '</div>' +
    (labels || prs || order ? '<div class="t-chips">' + order + labels + prs + '</div>' : '') +
    '<div class="t-foot">' +
    '<span class="t-owner' + (filterSelected('owner', c.owner) ? ' active' : '') + '" data-owner="' + esc(c.owner) +
      '" title="filter by lieutenant"><span class="dot" style="background:' + esc(lieutenantColor(c.owner)) + '"></span>' + esc((lieutenant(c.owner) || {}).name || c.owner) + '</span>' +
    (repo ? '<span class="t-repo" title="repo">' + esc(repo) + '</span>' : '') +
    hint +
    '<span class="grow"></span>' +
    (hasLink ? '<span class="t-ind" title="has link">📎</span>' : '') +
    (msgs ? '<span class="t-ind" title="' + msgs + ' messages">💬' + msgs + '</span>' : '') +
    // Working tiles carry the worker's context bar (agentStatus, turn-end fed)
    (c.column === 'working' ? ctxBarHtml((workerFor(c.id) || {}).agentStatus) : '') +
    // 👁 peek: every Working card can be watched live (its worker's terminal)
    (c.column === 'working' ? '<button class="t-peek" title="watch this worker\'s terminal live">👁</button>' : '') +
    agoSpanHtml(cardRecency(c), 't-ago') +
    '</div></div>';
}

// A frozen tile in the 🧊 archived column: dimmed, not draggable, no detail —
// just the snapshot's face plus the reason and the unarchive affordance.
function archTileHtml(row) {
  const c = row.c;
  const r = row.arch.reason === 'merged' ? 'merged' : 'killed';
  const rsn = '<span class="tv-rsn tv-rsn-' + r + '"' + (row.arch.note ? ' title="' + esc(row.arch.note) + '"' : '') + '>' +
    (r === 'merged' ? '🏁 merged' : '🪦 killed') + '</span>';
  const labels = (c.labels || []).map((n) => labelChipHtml(n, false)).join('');
  return '<div class="tile arch">' +
    '<span class="t-stripe" style="background:' + esc(lieutenantColor(c.owner)) + '"></span>' +
    '<div class="t-row1"><span class="t-emoji">' + esc(cardEmoji(c)) + '</span>' +
    '<span class="t-title">' + esc(c.title || c.id) + '</span></div>' +
    '<div class="t-chips">' + rsn + labels + '</div>' +
    '<div class="t-foot">' +
    '<span class="t-owner"><span class="dot" style="background:' + esc(lieutenantColor(c.owner)) + '"></span>' + esc((lieutenant(c.owner) || {}).name || c.owner) + '</span>' +
    '<span class="grow"></span>' +
    '<button class="tv-unarch" data-unarch="' + esc(c.id) + '" title="restore this card to the board">🧟 unarchive</button>' +
    agoSpanHtml(row.arch.ts, 't-ago') +
    '</div></div>';
}
function archColumnHtml() {
  const list = archivedRows();
  return '<div class="column arch-col" data-id="__archived"><h2><span>🧊 archived</span>' +
    '<span class="count">' + list.length + '</span></h2>' +
    '<div class="cards">' + list.map(archTileHtml).join('') + '</div></div>';
}

export function renderBoard() {
  const cols = columns();
  if (S.filters.archived) ensureArchive();
  const html = !cols.length
    ? '<div class="empty">waiting for board…</div>'
    : cols.map((col) => {
      const list = cards().filter((c) => c.column === col.id && cardVisible(c)).sort(byRecency);
      return '<div class="column" data-id="' + esc(col.id) + '"><h2><span>' + esc(col.title || col.id) + '</span>' +
        '<span class="count">' + list.length + '</span>' +
        '<button class="add-card" title="new card here">+</button></h2>' +
        '<div class="cards">' + list.map(tileHtml).join('') + '</div></div>';
    }).join('') + (S.filters.archived ? archColumnHtml() : '');
  // unchanged markup = leave the DOM (and scroll/selection/handlers) alone;
  // only a real change pays the rebuild + scroll save/restore
  if (boardEl.__bcHtml === html) return;
  boardEl.__bcHtml = html;
  const sx = boardEl.scrollLeft;
  const colScroll = {};
  boardEl.querySelectorAll('.column').forEach((col) => {
    colScroll[col.dataset.id] = col.querySelector('.cards').scrollTop;
  });
  boardEl.innerHTML = html;
  if (!cols.length) return;
  boardEl.scrollLeft = sx;
  boardEl.querySelectorAll('.column').forEach((col) => {
    if (colScroll[col.dataset.id] != null) col.querySelector('.cards').scrollTop = colScroll[col.dataset.id];
  });
  wire();
}

// ---------- interactions ----------
let pressTimer = null, pressFired = false;

function wire() {
  // frozen tiles: only the unarchive button is live
  boardEl.querySelectorAll('.tile.arch [data-unarch]').forEach((b) => {
    b.onclick = (e) => { e.stopPropagation(); unarchive(b.dataset.unarch, b); };
  });
  boardEl.querySelectorAll('.tile:not(.arch)').forEach((el) => {
    el.onclick = (e) => {
      if (pressFired) { pressFired = false; return; } // long-press already handled
      const t = e.target;
      if (t.closest('a')) return; // PR chip / link: let the anchor navigate, don't open detail
      if (t.closest('.t-peek')) { openCardPane(el.dataset.id); return; }
      if (t.classList.contains('label')) { toggleFilter('label', t.dataset.label); return; }
      const own = t.closest('.t-owner');
      if (own) { toggleFilter('owner', own.dataset.owner); return; }
      openDetail(el.dataset.id);
    };
    // drag&drop (desktop)
    el.ondragstart = (e) => {
      e.dataTransfer.setData('text/bc-card', el.dataset.id);
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
    if (col.classList.contains('arch-col')) return; // no drops, no + on the frozen column
    const id = col.dataset.id;
    col.ondragover = (e) => {
      if (e.dataTransfer.types.includes('text/bc-card')) { e.preventDefault(); col.classList.add('drag-over'); }
    };
    col.ondragleave = () => col.classList.remove('drag-over');
    col.ondrop = async (e) => {
      e.preventDefault();
      col.classList.remove('drag-over');
      const cardId = e.dataTransfer.getData('text/bc-card');
      if (cardId) { try { await api.moveCard(cardId, id, orderComment(cardId, id)); } catch (err) { alert(err.message); } }
    };
    col.querySelector('.add-card').onclick = (e) => { e.stopPropagation(); openNewCard(id); };
  });
}

// A captain move that becomes an ORDER (any → working = start-order,
// review → backlog = rework-order) carries an optional comment for the owning
// lieutenant (the DNA: the rework-order QueueItem carries the captain's thread
// comment). Empty or cancelled = no comment; the order still goes.
function orderComment(cardId, to) {
  const c = cards().find((k) => k.id === cardId);
  if (!c || c.column === to) return '';
  const order = to === 'working' ? 'start order'
    : c.column === 'review' && to === 'backlog' ? 'rework order' : '';
  if (!order) return '';
  return (window.prompt('Comment for the ' + order + ' (optional):', '') || '').trim();
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
    else b.onclick = async () => { closeMoveMenu(); try { await api.moveCard(cardId, col.id, orderComment(cardId, col.id)); } catch (e) { alert(e.message); } };
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
const ncOwner = document.getElementById('nc-owner');
let ncColumnId = ''; // the column whose "+" opened the modal — the create target
export function openNewCard(columnId) {
  if (!lieutenants().length) { openNewLieutenant(); return; } // a card needs an owner
  ncColumnId = columnId || 'backlog';
  ncType.value = 'implementation';
  ncOwner.textContent = '';
  for (const l of lieutenants()) {
    const o = document.createElement('option');
    o.value = l.id;
    o.textContent = l.name || l.id;
    ncOwner.appendChild(o);
  }
  // default owner: the lieutenant whose chat is open, else the first
  if (S.chatMode) {
    const cur = S.chatMode.mode === 'lieutenant' ? S.chatMode.id : (cards().find((c) => c.id === S.chatMode.id) || {}).owner;
    if (cur && lieutenant(cur)) ncOwner.value = cur;
  }
  document.getElementById('nc-name').value = '';
  document.getElementById('nc-body').value = '';
  document.getElementById('nc-harness').value = '';
  document.getElementById('nc-model').value = '';
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
  // Optional harness/model hint → stored as card attributes; card.start honors
  // them as a fallback (an explicit CLI --harness/--model still wins).
  const attributes = {};
  const ncHarness = document.getElementById('nc-harness').value;
  const ncModel = document.getElementById('nc-model').value.trim();
  if (ncHarness) attributes.harness = ncHarness;
  if (ncModel) attributes.model = ncModel;
  try {
    const r = await api.createCard(Object.assign(
      { title, column: ncColumnId, body, type: ncType.value, owner: ncOwner.value },
      Object.keys(attributes).length ? { attributes } : {}));
    closeNewCard();
    openDetail(r.card.id);
  } catch (err) { alert(err.message); }
};

// ---------- new lieutenant modal ----------
const ltOverlay = document.getElementById('lt-overlay');
const ltAvatarGrid = document.getElementById('lt-avatar-grid');
let ltAvatarPick = null; // null = no avatar (the "none" cell), "none" allowed
export function openNewLieutenant() {
  document.getElementById('lt-name').value = '';
  document.getElementById('lt-charter').value = '';
  document.getElementById('lt-harness').value = 'claude';
  ltAvatarPick = null;
  ltAvatarGrid.innerHTML = avatarGridHtml(ltAvatarPick);
  wireAvatarGrid(ltAvatarGrid, (idx) => { ltAvatarPick = idx; });
  ltOverlay.hidden = false;
  document.getElementById('lt-name').focus();
}
export function closeNewLieutenant() { ltOverlay.hidden = true; }
export function newLieutenantOpen() { return !ltOverlay.hidden; }
document.getElementById('lt-cancel').onclick = closeNewLieutenant;
ltOverlay.onclick = (e) => { if (e.target === ltOverlay) closeNewLieutenant(); };
document.getElementById('lt-modal').onsubmit = async (e) => {
  e.preventDefault();
  const name = document.getElementById('lt-name').value.trim();
  if (!name) return;
  // This modal births a REAL lieutenant: the server spawns its agent
  // session (doctrine + charter as launch prompt) and persists the ref. Slow
  // (up to a minute) — keep the modal up, button disabled, until it lands.
  const btn = document.getElementById('lt-create');
  const label = btn.textContent;
  btn.disabled = true; btn.textContent = 'spawning…';
  try {
    const r = await api.createLieutenant({
      name,
      avatar: ltAvatarPick,
      color: document.getElementById('lt-color').value,
      charter: document.getElementById('lt-charter').value,
      harness: document.getElementById('lt-harness').value || 'claude',
      spawn: true,
    });
    closeNewLieutenant();
    openLieutenantChat(r.lieutenant.id);
  } catch (err) { alert(err.message); }
  finally { btn.disabled = false; btn.textContent = label; }
};
