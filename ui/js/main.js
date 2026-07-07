// boot: SSE, header controls, mobile tabs, render orchestration
import { S, onRender, render, cards, lieutenants, cardUnread, lieutenantUnread, notifUnreadCount, owedTargets, clearFilters, filtersActive } from './state.js';
import { api } from './api.js';
import { trackMessages } from './voice.js';
import { renderBoard, newCardOpen, closeNewCard, newLieutenantOpen, closeNewLieutenant, closeMoveMenu } from './board.js';
import { renderChat, onOpenCard as chatOnOpenCard } from './chat.js';
import { renderDetail, openDetail, closeDetail, detailOpen, closeArtifact, artifactOpen } from './detail.js';
import { renderNotifications, onOpenCard as notifOnOpenCard } from './notify.js';
import { renderLabelManager, renderPicker, pickerIsOpen, closeLabelPicker } from './labels.js';
import './resize.js'; // draggable side-panel widths

chatOnOpenCard(openDetail);
notifOnOpenCard(openDetail);

// ---------- header: filter ----------
const filterInput = document.getElementById('filter');
const filterAge = document.getElementById('filter-age');
const filterClear = document.getElementById('filter-clear');
const chipsEl = document.getElementById('filter-chips');
filterInput.oninput = () => { S.filters.text = filterInput.value; render(); };
filterAge.onchange = () => { S.filters.age = filterAge.value; render(); };
filterClear.onclick = () => { clearFilters(); syncFilterInputs(); };
function syncFilterInputs() {
  if (filterInput.value !== S.filters.text) filterInput.value = S.filters.text;
  if (filterAge.value !== S.filters.age) filterAge.value = S.filters.age;
  filterClear.style.display = filtersActive() ? 'inline' : 'none';
  chipsEl.textContent = '';
  for (const f of S.filters.sel) {
    const chip = document.createElement('span');
    chip.className = 'fchip';
    chip.title = 'remove this filter';
    const t = document.createElement('span');
    t.textContent = (f.kind === 'owner' ? '@' : '') + f.value;
    const x = document.createElement('span');
    x.className = 'x';
    x.textContent = '✕';
    chip.append(t, x);
    chip.onclick = () => {
      S.filters.sel = S.filters.sel.filter((g) => g !== f);
      render();
    };
    chipsEl.appendChild(chip);
  }
}

// ---------- header: status dot ----------
function renderStatusDot() {
  const el = document.getElementById('status-dot');
  const owed = owedTargets().length;
  el.className = !S.connected ? '' : owed ? 'busy' : 'ok';
  el.title = !S.connected ? 'disconnected — reconnecting…'
    : owed ? 'a lieutenant owes a reply on ' + owed + ' conversation' + (owed > 1 ? 's' : '')
    : 'connected — all quiet';
}

// ---------- settings panel ----------
const gearBtn = document.getElementById('gear');
const spEl = document.getElementById('settings-panel');
gearBtn.onclick = (e) => {
  e.stopPropagation();
  spEl.hidden = !spEl.hidden;
  gearBtn.classList.toggle('on', !spEl.hidden);
  if (!spEl.hidden) { S.notifOpen = false; renderLabelManager(); render(); }
};
document.addEventListener('click', (e) => {
  if (!spEl.hidden && !spEl.contains(e.target) && e.target !== gearBtn) {
    spEl.hidden = true;
    gearBtn.classList.remove('on');
  }
});

// ---------- mobile tabs ----------
const tabChat = document.getElementById('tab-chat');
const tabBoard = document.getElementById('tab-board');
tabChat.onclick = () => { S.view = 'chat'; render(); };
tabBoard.onclick = () => { S.view = 'board'; render(); };
function renderTabs() {
  document.body.dataset.view = S.view;
  tabChat.classList.toggle('on', S.view === 'chat');
  tabBoard.classList.toggle('on', S.view === 'board');
  // chat tab badge: unread across every lieutenant chat + all card threads;
  // board badge: notifications
  let chatN = 0;
  for (const l of lieutenants()) chatN += lieutenantUnread(l);
  for (const c of cards()) chatN += cardUnread(c);
  const cn = document.getElementById('tab-chat-n');
  cn.hidden = !chatN; cn.textContent = chatN > 99 ? '99+' : String(chatN);
  const bn = document.getElementById('tab-board-n');
  const notifN = notifUnreadCount();
  bn.hidden = !notifN; bn.textContent = notifN > 99 ? '99+' : String(notifN);
}

// ---------- keyboard ----------
document.addEventListener('keydown', (e) => {
  const active = document.activeElement;
  const inField = /^(INPUT|TEXTAREA|SELECT)$/.test((active && active.tagName) || '');
  if (e.key === '/' && !inField) { e.preventDefault(); filterInput.focus(); return; }
  if (e.key === 'Escape') {
    if (artifactOpen()) closeArtifact();
    else if (newCardOpen()) closeNewCard();
    else if (newLieutenantOpen()) closeNewLieutenant();
    else if (pickerIsOpen()) closeLabelPicker();
    else if (S.notifOpen) { S.notifOpen = false; render(); }
    else if (!spEl.hidden) { spEl.hidden = true; gearBtn.classList.remove('on'); }
    else if (detailOpen()) closeDetail();
    else if (filtersActive()) { clearFilters(); syncFilterInputs(); }
    closeMoveMenu();
  }
});

// ---------- render orchestration ----------
onRender(() => {
  if (!S.doc) return;
  document.title = S.doc.title || 'bridge command';
  document.getElementById('b-title').textContent = S.doc.title || 'bridge command';
  document.getElementById('b-subtitle').textContent = S.doc.subtitle || '';
  syncFilterInputs();
  renderStatusDot();
  renderBoard();
  renderChat();
  renderDetail();
  renderNotifications();
  renderTabs();
  if (pickerIsOpen()) renderPicker();
  if (!spEl.hidden) renderLabelManager();
});

// ---------- SSE ----------
// A half-open connection after a server restart can sit silent forever without
// ever firing onerror, leaving a zombie tab. Two defenses:
//  - staleness watchdog: the server emits a named `ping` every 25s, so >STALE_MS
//    of total silence means the stream is dead — tear it down and reconnect;
//  - boot-id: the board payload carries the server instance id, so a restart is
//    detected even on a fast auto-retry reconnect.
// Every (re)open also refetches the full board: events missed while stale are
// gone for good, and the refetch is what heals the tab.
const STALE_MS = 40000;
let es = null;
let lastEventAt = Date.now();
let serverBoot = null;

function applyBoard(doc) {
  serverBoot = doc.boot || serverBoot;
  S.doc = doc;
  trackMessages(S.doc);
  render();
}
function refetchBoard() {
  api.board().then(applyBoard).catch(() => {}); // still down — the watchdog retries
}
function connect() {
  if (es) es.close();
  es = new EventSource('/api/events');
  es.addEventListener('board', (e) => {
    lastEventAt = Date.now();
    const doc = JSON.parse(e.data);
    const restarted = serverBoot && doc.boot && doc.boot !== serverBoot;
    applyBoard(doc);
    if (restarted) refetchBoard(); // new server instance — make sure we hold its current state
  });
  es.addEventListener('ping', () => { lastEventAt = Date.now(); });
  es.onopen = () => {
    lastEventAt = Date.now();
    S.connected = true;
    renderStatusDot();
    refetchBoard(); // anything pushed while we were away is unrecoverable — resync
  };
  es.onerror = () => { S.connected = false; renderStatusDot(); };
}
connect();
setInterval(() => {
  if (Date.now() - lastEventAt <= STALE_MS) return;
  lastEventAt = Date.now(); // one reconnect per stale window
  S.connected = false;
  renderStatusDot();
  connect();
}, 5000);
renderStatusDot();
setInterval(render, 60000); // refresh "ago" labels
