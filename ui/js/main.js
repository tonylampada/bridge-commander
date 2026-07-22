// boot: SSE, header controls, mobile tabs, render orchestration
import { S, onRender, render, cards, lieutenants, cardUnread, lieutenantUnread, notifUnreadCount, owedTargets, clearFilters, filtersActive } from './state.js';
import { api } from './api.js';
import { refreshAgoLabels } from './util.js';
import { trackMessages } from './voice.js';
import { trackEvents, renderNotifSettings } from './notifysettings.js';
import { onOpenCard as toastOnOpenCard } from './toast.js';
import { renderBoard, newCardOpen, closeNewCard, newLieutenantOpen, closeNewLieutenant, closeMoveMenu } from './board.js';
import { renderTable } from './table.js';
import { renderFilterUI, filterPanelOpen, closeFilterPanel } from './filterpop.js';
import { renderChat, onOpenCard as chatOnOpenCard } from './chat.js';
import { renderLtSwitcher, ltSwitcherOpen, closeLtSwitcher, appearancePopoverOpen, closeAppearancePopover } from './ltswitcher.js';
import { renderDetail, openDetail, closeDetail, detailOpen, closeArtifact, artifactOpen, onArtifactClose, closeOwnerMenu, ownerMenuOpen } from './detail.js';
import { closePane, paneOpen } from './pane.js';
import { openMonitor, closeMonitor, monitorOpen } from './monitor.js';
import { renderNotifications, onOpenCard as notifOnOpenCard } from './notify.js';
import { renderLabelManager, renderPicker, pickerIsOpen, closeLabelPicker } from './labels.js';
import './resize.js'; // draggable side-panel widths

chatOnOpenCard(openDetail);
notifOnOpenCard(openDetail);
toastOnOpenCard(openDetail);

// ---------- header: filter ----------
// Just the text input here — every richer filter lives in the popup
// (filterpop.js), behind the one button with the active-count badge.
const filterInput = document.getElementById('filter');
filterInput.oninput = () => { S.filters.text = filterInput.value; render(); };
function syncFilterInputs() {
  if (filterInput.value !== S.filters.text) filterInput.value = S.filters.text;
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
  if (!spEl.hidden) { S.notifOpen = false; renderLabelManager(); renderNotifSettings(); render(); }
};
document.addEventListener('click', (e) => {
  if (!spEl.hidden && !spEl.contains(e.target) && e.target !== gearBtn) {
    spEl.hidden = true;
    gearBtn.classList.remove('on');
  }
});
// ⚙️ → monitoring: the settings row hands off to the monitor panel
document.getElementById('mon-open').onclick = () => {
  spEl.hidden = true;
  gearBtn.classList.remove('on');
  openMonitor();
};

// ---------- board ⇄ table toggle ----------
// One region, two views over the same cards. The choice sticks per browser.
const vsBoard = document.getElementById('vs-board');
const vsTable = document.getElementById('vs-table');
function setBoardMode(mode) {
  S.boardMode = mode;
  try { localStorage.setItem('bc-board-mode', mode); } catch (e) {}
  document.getElementById('board-wrap').classList.toggle('table-mode', mode === 'table');
  vsBoard.classList.toggle('on', mode === 'board');
  vsTable.classList.toggle('on', mode === 'table');
  render();
}
vsBoard.onclick = () => setBoardMode('board');
vsTable.onclick = () => setBoardMode('table');
try { if (localStorage.getItem('bc-board-mode') === 'table') setBoardMode('table'); } catch (e) {}

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
    else if (paneOpen()) closePane();
    else if (monitorOpen()) closeMonitor();
    else if (newCardOpen()) closeNewCard();
    else if (newLieutenantOpen()) closeNewLieutenant();
    else if (pickerIsOpen()) closeLabelPicker();
    else if (appearancePopoverOpen()) closeAppearancePopover();
    else if (filterPanelOpen()) closeFilterPanel();
    else if (ltSwitcherOpen()) closeLtSwitcher();
    else if (ownerMenuOpen()) closeOwnerMenu(); // just the menu — keep the detail open
    else if (S.notifOpen) { S.notifOpen = false; render(); }
    else if (!spEl.hidden) { spEl.hidden = true; gearBtn.classList.remove('on'); }
    else if (detailOpen()) closeDetail();
    else if (filtersActive()) { clearFilters(); syncFilterInputs(); }
    closeMoveMenu();
  }
});

// ---------- render orchestration ----------
// Reading-mode guard: while the artifact viewer popup is open, workers still
// push board updates (S.doc keeps updating) but repainting the regions would
// blink the text/iframe being read. So record the pending render and bail; when
// the viewer closes, onArtifactClose below runs the one deferred pass.
let renderPending = false;
onRender(() => {
  if (!S.doc) return;
  if (artifactOpen()) { renderPending = true; return; }
  document.title = S.doc.title || 'bridge command';
  document.getElementById('b-title').textContent = S.doc.title || 'bridge command';
  document.getElementById('b-subtitle').textContent = S.doc.subtitle || '';
  syncFilterInputs();
  renderFilterUI();
  renderStatusDot();
  if (S.boardMode === 'table') renderTable(); else renderBoard();
  renderChat();
  renderLtSwitcher();
  renderDetail();
  renderNotifications();
  renderTabs();
  if (pickerIsOpen()) renderPicker();
  if (!spEl.hidden) { renderLabelManager(); renderNotifSettings(); }
  // fill the [data-ago] spans the panels above left empty (see util.js: time
  // text stays out of the compared markup so it never forces a rebuild)
  refreshAgoLabels();
});
// When the viewer closes, flush the render that was deferred while it was open
// so the board catches up in one pass (no-op if nothing pushed meanwhile).
onArtifactClose(() => { if (renderPending) { renderPending = false; render(); } });

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
  trackEvents(S.doc);
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
// the minute tick: one guarded render pass — the [data-ago] labels are updated
// in place by the refreshAgoLabels post-pass, and time-derived STATE (the
// stale-owed ⚠ flip) still surfaces; panels whose markup didn't change leave
// their DOM untouched
setInterval(render, 60000);
