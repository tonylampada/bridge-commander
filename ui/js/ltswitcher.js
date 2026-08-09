// ltswitcher.js — the chat header's lieutenant dropdown. The header trigger
// (#chat-lt, rendered by chat.js) opens a panel with one row per lieutenant —
// avatar, name, model, context bar, unread/owed — so the captain switches
// conversations in place, without leaving the chat. The rows also carry the
// per-lieutenant controls that used to live on the lane chips: 👁 watch
// terminal, ⋯ actions (settings / retire), and the ＋ lieutenant row.
import { S, cards, lieutenants, lieutenantsByRecent, lieutenant, lieutenantColor, lieutenantAvatar, lieutenantUnread, targetOwedState, targetOwedStale } from './state.js';
import { api } from './api.js';
import { esc, setHtmlIfChanged, ctxBarHtml, owedIndHtml } from './util.js';
import { avatarHtml, avatarGridHtml, wireAvatarGrid } from './avatars.js';
import { openLieutenantChat } from './chat.js';
import { openLieutenantPane } from './pane.js';
import { openNewLieutenant, closeMoveMenu } from './board.js';
import { voiceOptions } from './voice.js';

const trigEl = document.getElementById('chat-lt');
const panelEl = document.getElementById('lt-switcher');
const menuEl = document.getElementById('move-menu'); // shared with the board's move menu

let open = false;
// The row order, in ids, captured when the panel opens and FROZEN while it
// stays open. The panel re-renders on every board push, so a message landing
// mid-tap would otherwise re-sort the rows under the captain's finger and he
// taps the wrong lieutenant. Row content stays live; only the order is pinned.
let frozenOrder = [];
export function ltSwitcherOpen() { return open; }
export function closeLtSwitcher() { if (open) { open = false; renderLtSwitcher(); } }

// The trigger toggles the panel; with no lieutenants yet it IS the create
// affordance (chat.js renders it as "＋ lieutenant"), so it opens the modal.
trigEl.onclick = () => {
  if (!lieutenants().length) { openNewLieutenant(); return; }
  open = !open;
  if (open) frozenOrder = lieutenantsByRecent().map((l) => l.id);
  renderLtSwitcher();
};
// tap-out closes (the trigger's own click toggled already — exclude it)
document.addEventListener('click', (e) => {
  if (open && !panelEl.contains(e.target) && !trigEl.contains(e.target)) closeLtSwitcher();
});

// The current lieutenant's 👁/⋯ sit right in the chat header (chat.js toggles
// their visibility with the trigger) — no need to open the dropdown for them.
const headPeekEl = document.getElementById('chat-lt-peek');
const headMenuEl = document.getElementById('chat-lt-menu');
function currentLtId() { return S.chatMode && S.chatMode.mode === 'lieutenant' ? S.chatMode.id : null; }
headPeekEl.onclick = () => {
  const id = currentLtId();
  if (id) { closeLtSwitcher(); openLieutenantPane(id); }
};
headMenuEl.onclick = (e) => {
  // stop before the board's document closer would dismiss the menu we just opened
  e.stopPropagation();
  const id = currentLtId();
  if (id) { closeLtSwitcher(); openLtMenu(id, e.clientX, e.clientY); }
};

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
    '>' +
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

// The frozen order, resolved against the live doc: retired lieutenants drop
// out, and any that appeared since the panel opened land at the end.
function panelLieutenants() {
  const frozen = new Set(frozenOrder);
  return frozenOrder.map(lieutenant).filter(Boolean)
    .concat(lieutenants().filter((l) => !frozen.has(l.id)));
}

// Rendered on every board push while open, so unread/owed/context stay live.
export function renderLtSwitcher() {
  trigEl.setAttribute('aria-expanded', open ? 'true' : 'false');
  panelEl.hidden = !open;
  if (!open) return;
  setHtmlIfChanged(panelEl, panelLieutenants().map(rowHtml).join('') +
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
  const settings = document.createElement('button');
  settings.textContent = '⚙ settings';
  settings.onclick = (e) => { e.stopPropagation(); closeMoveMenu(); openLtSettings(ltId); };
  menuEl.appendChild(settings);
  const owned = cards().filter((c) => c.owner === ltId).length;
  const retire = document.createElement('button');
  retire.className = 'danger';
  retire.textContent = '⚓ retire' + (owned ? ' (' + owned + ' card' + (owned > 1 ? 's' : '') + ' in the way)' : '');
  retire.onclick = async () => {
    closeMoveMenu();
    if (!confirm('Retire ' + (l.name || ltId) + '? Its live session is killed and its queue removed;'
      + ' its memory file in the workspace is kept.')) return;
    // A later lieutenant on this same id is launched on that charter — a choice
    // the captain should make with the path in front of them, not a surprise.
    try {
      const r = await api.retireLieutenant(ltId);
      if (r && r.memory) alert('Memory file kept: ' + r.memory + '\nA new lieutenant with id ' + ltId + ' would be launched on it.');
    } catch (e) { alert(e.message); }
  };
  menuEl.appendChild(retire);
  menuEl.hidden = false;
  const r = menuEl.getBoundingClientRect();
  menuEl.style.left = Math.max(8, Math.min(x, window.innerWidth - r.width - 8)) + 'px';
  menuEl.style.top = Math.max(8, Math.min(y, window.innerHeight - r.height - 8)) + 'px';
}

// ---------- lieutenant settings modal (⋯ → settings) ----------
// Everything the BOARD owns about a lieutenant lives here. Color, avatar, voice
// and prefix are picks — each PATCHes immediately, exactly as the old appearance
// popover did (mirrors the label manager's recolor-on-change). The charter is
// not board state: it is the lieutenant's memory file in the workspace.
const lsEl = document.getElementById('ls-overlay');
const lsWho = document.getElementById('ls-who');
const lsColor = document.getElementById('ls-color');
const lsPrefix = document.getElementById('ls-prefix');
const lsVoice = document.getElementById('ls-voice');
const lsGrid = document.getElementById('ls-grid');
let lsLtId = null;
// Exported for the config screen's lieutenants tab: its ⚙ is THIS modal, not a
// second form over the same four fields.
export function openLtSettings(ltId) {
  const l = lieutenant(ltId);
  if (!l) return;
  lsLtId = ltId;
  lsWho.textContent = l.name || ltId;
  lsColor.value = lieutenantColor(ltId);
  lsPrefix.value = l.prefix || '';
  lsGrid.innerHTML = avatarGridHtml(lieutenantAvatar(ltId));
  wireAvatarGrid(lsGrid, (idx) => patch({ avatar: idx }));
  fillVoices(l.voice || '');
  lsEl.hidden = false;
  lsPrefix.focus();
}
export function closeLtSettings() { lsLtId = null; lsEl.hidden = true; }
export function ltSettingsOpen() { return !lsEl.hidden; }
async function patch(body) {
  if (!lsLtId) return false;
  try { await api.updateLieutenant(lsLtId, body); return true; } catch (e) { alert(e.message); return false; }
}
// "board's voice" is the default entry AND the empty value the server reads as
// "clear the pick" — a lieutenant with nothing chosen inherits the board's.
function fillVoices(chosen) {
  lsVoice.textContent = '';
  const def = document.createElement('option');
  def.value = '';
  def.textContent = "board's voice";
  lsVoice.appendChild(def);
  lsVoice.value = '';
  voiceOptions(chosen).then((list) => {
    for (const v of list) {
      const o = document.createElement('option');
      o.value = v.id;
      o.textContent = v.name + (v.lang ? ' (' + v.lang + ')' : '');
      lsVoice.appendChild(o);
    }
    if (chosen && list.some((v) => v.id === chosen)) lsVoice.value = chosen;
  });
}
lsColor.onchange = () => patch({ color: lsColor.value });
// The card-id prefix commits on change like the other picks. The server refuses
// one another lieutenant already holds — say so and put the field back, so the
// box never shows a prefix this lieutenant does not have.
lsPrefix.onchange = async () => {
  const l = lieutenant(lsLtId);
  const want = lsPrefix.value.trim().toUpperCase();
  if (!l || want === (l.prefix || '')) return;
  if (!(await patch({ prefix: want }))) lsPrefix.value = l.prefix || '';
  else lsPrefix.value = want;
};
// Enter in a one-line field would submit the form (= close). Here it means
// "commit this prefix" and nothing else.
lsPrefix.onkeydown = (e) => { if (e.key === 'Enter') { e.preventDefault(); lsPrefix.blur(); } };
lsVoice.onchange = () => patch({ voice: lsVoice.value });
document.getElementById('ls-cancel').onclick = closeLtSettings;
lsEl.onclick = (e) => { if (e.target === lsEl) closeLtSettings(); };
// Nothing is buffered — every field has already committed — so submit just closes.
document.getElementById('ls-modal').onsubmit = (e) => { e.preventDefault(); closeLtSettings(); };
