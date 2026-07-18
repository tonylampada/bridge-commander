// ltswitcher.js — the chat header's lieutenant dropdown. The header trigger
// (#chat-lt, rendered by chat.js) opens a panel with one row per lieutenant —
// avatar, name, model, context bar, unread/owed — so the captain switches
// conversations in place, without leaving the chat. The rows also carry the
// per-lieutenant controls that used to live on the lane chips: 👁 watch
// terminal, ⋯ actions (appearance / retire), and the ＋ lieutenant row.
import { S, cards, lieutenants, lieutenant, lieutenantColor, lieutenantAvatar, lieutenantUnread, targetOwedState, targetOwedStale } from './state.js';
import { api } from './api.js';
import { esc, setHtmlIfChanged, ctxBarHtml, owedIndHtml } from './util.js';
import { avatarHtml, avatarGridHtml, wireAvatarGrid } from './avatars.js';
import { openLieutenantChat } from './chat.js';
import { openLieutenantPane } from './pane.js';
import { openNewLieutenant, closeMoveMenu } from './board.js';

const trigEl = document.getElementById('chat-lt');
const panelEl = document.getElementById('lt-switcher');
const menuEl = document.getElementById('move-menu'); // shared with the board's move menu

let open = false;
export function ltSwitcherOpen() { return open; }
export function closeLtSwitcher() { if (open) { open = false; renderLtSwitcher(); } }

// The trigger toggles the panel; with no lieutenants yet it IS the create
// affordance (chat.js renders it as "＋ lieutenant"), so it opens the modal.
trigEl.onclick = () => {
  if (!lieutenants().length) { openNewLieutenant(); return; }
  open = !open;
  renderLtSwitcher();
};
// tap-out closes (the trigger's own click toggled already — exclude it)
document.addEventListener('click', (e) => {
  if (open && !panelEl.contains(e.target) && !trigEl.contains(e.target)) closeLtSwitcher();
});

// One row per lieutenant: everything its lane chip used to carry.
function rowHtml(l) {
  const mine = cards().filter((c) => c.owner === l.id);
  const working = mine.filter((c) => c.column === 'working').length;
  const unread = lieutenantUnread(l);
  const cur = S.chatMode && S.chatMode.mode === 'lieutenant' && S.chatMode.id === l.id;
  const owed = targetOwedState('lieutenant:' + l.id);
  const ind = owedIndHtml(owed, owed && targetOwedStale('lieutenant:' + l.id));
  const st = l.agentStatus || {};
  const model = st.model
    ? '<span class="lts-model">' + esc(st.model) + (st.effort ? ' (' + esc(st.effort) + ')' : '') + '</span>'
    : '';
  const av = lieutenantAvatar(l.id);
  const face = av != null
    ? '<span class="lt-face" style="border-color:' + esc(lieutenantColor(l.id)) + '">' + avatarHtml(av) + '</span>'
    : '<span class="lt-dot" style="background:' + esc(lieutenantColor(l.id)) + '"></span>';
  return '<div class="lts-row' + (cur ? ' on' : '') + '" data-id="' + esc(l.id) + '" role="option"' +
    (cur ? ' aria-selected="true"' : '') +
    (l.charter ? ' title="' + esc(l.charter.split('\n')[0].slice(0, 160)) + '"' : '') + '>' +
    face +
    '<span class="lts-main">' +
    '<span class="lts-name">' + esc(l.name || l.id) + ind +
    (unread ? '<span class="badge-n">' + (unread > 99 ? '99+' : unread) + '</span>' : '') + '</span>' +
    '<span class="lts-meta">' + model +
    '<span class="lts-counts">' + mine.length + (working ? ' · 🔨' + working : '') + '</span>' +
    ctxBarHtml(st) + '</span>' +
    '</span>' +
    (cur ? '<span class="lts-cur" title="current conversation">✓</span>' : '') +
    '<button class="lts-peek" type="button" title="watch this lieutenant\'s terminal live">👁</button>' +
    '<button class="lts-menu" type="button" title="lieutenant actions">⋯</button>' +
    '</div>';
}

// Rendered on every board push while open, so unread/owed/context stay live.
export function renderLtSwitcher() {
  trigEl.setAttribute('aria-expanded', open ? 'true' : 'false');
  panelEl.hidden = !open;
  if (!open) return;
  setHtmlIfChanged(panelEl, lieutenants().map(rowHtml).join('') +
    '<button class="lts-add" type="button">＋ lieutenant</button>');
}

// Delegated clicks survive the setHtmlIfChanged rebuilds. Every action closes
// the panel — the switch, the peek overlay, the ⋯ menu, and the modal all take
// the stage themselves.
panelEl.addEventListener('click', (e) => {
  if (e.target.closest('.lts-add')) { closeLtSwitcher(); openNewLieutenant(); return; }
  const row = e.target.closest('.lts-row');
  if (!row) return;
  const id = row.dataset.id;
  if (e.target.closest('.lts-menu')) {
    // stop before board.js's document closer would dismiss the menu we just opened
    e.stopPropagation();
    closeLtSwitcher();
    openLtMenu(id, e.clientX, e.clientY);
    return;
  }
  if (e.target.closest('.lts-peek')) { closeLtSwitcher(); openLieutenantPane(id); return; }
  closeLtSwitcher();
  openLieutenantChat(id);
});

// lieutenant ⋯ menu — lieutenant.retire lives here (explicit only, per the DNA:
// the server refuses while the lieutenant still owns non-archived cards).
// Shares the #move-menu element, so the board's outside-click closer covers it.
function openLtMenu(ltId, x, y) {
  const l = lieutenant(ltId);
  if (!l) return;
  menuEl.textContent = '';
  const head = document.createElement('div');
  head.className = 'mm-head';
  head.textContent = l.name || ltId;
  menuEl.appendChild(head);
  const appearance = document.createElement('button');
  appearance.textContent = '🖼 appearance';
  appearance.onclick = (e) => { e.stopPropagation(); closeMoveMenu(); openAppearancePopover(ltId, x, y); };
  menuEl.appendChild(appearance);
  const owned = cards().filter((c) => c.owner === ltId).length;
  const retire = document.createElement('button');
  retire.className = 'danger';
  retire.textContent = '⚓ retire' + (owned ? ' (' + owned + ' card' + (owned > 1 ? 's' : '') + ' in the way)' : '');
  retire.onclick = async () => {
    closeMoveMenu();
    if (!confirm('Retire ' + (l.name || ltId) + '? Its live session is killed and its queue removed.')) return;
    try { await api.retireLieutenant(ltId); } catch (e) { alert(e.message); }
  };
  menuEl.appendChild(retire);
  menuEl.hidden = false;
  const r = menuEl.getBoundingClientRect();
  menuEl.style.left = Math.max(8, Math.min(x, window.innerWidth - r.width - 8)) + 'px';
  menuEl.style.top = Math.max(8, Math.min(y, window.innerHeight - r.height - 8)) + 'px';
}

// ---------- appearance popover (⋯ → appearance): avatar + color, each pick
// PATCHes immediately (mirrors the label manager's recolor-on-change) ----------
const apEl = document.getElementById('ap-popover');
const apColor = document.getElementById('ap-color');
const apGrid = document.getElementById('ap-grid');
let apLtId = null;
function openAppearancePopover(ltId, x, y) {
  const l = lieutenant(ltId);
  if (!l) return;
  apLtId = ltId;
  apColor.value = lieutenantColor(ltId);
  apGrid.innerHTML = avatarGridHtml(lieutenantAvatar(ltId));
  wireAvatarGrid(apGrid, async (idx) => {
    try { await api.updateLieutenant(ltId, { avatar: idx }); } catch (e) { alert(e.message); }
  });
  apEl.hidden = false;
  const r = apEl.getBoundingClientRect();
  apEl.style.left = Math.max(8, Math.min(x, window.innerWidth - r.width - 8)) + 'px';
  apEl.style.top = Math.max(8, Math.min(y, window.innerHeight - r.height - 8)) + 'px';
}
export function closeAppearancePopover() { apLtId = null; apEl.hidden = true; }
export function appearancePopoverOpen() { return !apEl.hidden; }
apColor.onchange = async () => {
  if (!apLtId) return;
  try { await api.updateLieutenant(apLtId, { color: apColor.value }); } catch (e) { alert(e.message); }
};
document.addEventListener('click', (e) => {
  if (!apEl.hidden && !apEl.contains(e.target) && !e.target.closest('.lts-menu')) closeAppearancePopover();
});
