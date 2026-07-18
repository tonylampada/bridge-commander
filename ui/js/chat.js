// chat panel: the captain's conversation with ONE lieutenant at a time — either
// the lieutenant's main chat or one of its card threads (a card thread's
// interlocutor is always the owning lieutenant). Whole-window mode switch,
// premium composer.
import { S, card, lieutenants, lieutenant, lieutenantColor, lieutenantName, lieutenantAvatar, lieutenantUnread, cardStatus, cardActivityTs, render, threadUnread, targetOwedState, targetOwedStale, USER } from './state.js';
import { api } from './api.js';
import { esc, hhmm, dayLabel, cardEmoji, setHtmlIfChanged, fmtSize, isImageMime, statusBlockHtml, ctxBarHtml, owedIndHtml } from './util.js';
import { md, mdEnhance } from './md.js';
import { speakMessage, trackMessages } from './voice.js';
import { openAttachment } from './detail.js';
import { avatarHtml } from './avatars.js';

const feedEl = document.getElementById('chat-feed');
const titleEl = document.getElementById('chat-title');
const ltBtn = document.getElementById('chat-lt'); // switcher trigger (ltswitcher.js owns its click)
const backBtn = document.getElementById('chat-back');
const openBtn = document.getElementById('chat-card-open');
const inputEl = document.getElementById('chat-input');

let detailOpener = null; // set by main.js to avoid a circular import
export function onOpenCard(fn) { detailOpener = fn; }

// The chat panel's lieutenant-or-thread mode, normalized: a stale card / dead
// lieutenant falls back to the first lieutenant; no lieutenants = no target.
function ensureChatMode() {
  const lts = lieutenants();
  if (S.chatMode) {
    if (S.chatMode.mode === 'card' && card(S.chatMode.id)) return;
    if (S.chatMode.mode === 'lieutenant' && lieutenant(S.chatMode.id)) return;
    S.chatMode = null;
  }
  if (lts.length) S.chatMode = { mode: 'lieutenant', id: lts[0].id };
}
export function currentTarget() {
  ensureChatMode();
  if (!S.chatMode) return null;
  return S.chatMode.mode === 'card' ? 'card:' + S.chatMode.id : 'lieutenant:' + S.chatMode.id;
}
// The lieutenant behind the current conversation (card threads route to the owner).
function currentLieutenant() {
  if (!S.chatMode) return null;
  if (S.chatMode.mode === 'lieutenant') return lieutenant(S.chatMode.id);
  const c = card(S.chatMode.id);
  return c ? lieutenant(c.owner) : null;
}

// Open a lieutenant's main chat (switcher row tap, new-lieutenant create).
export function openLieutenantChat(id) {
  S.chatMode = { mode: 'lieutenant', id };
  S.view = 'chat'; // on mobile, switch to the chat tab
  render();
  if (window.innerWidth > 760) inputEl.focus();
}
// Switch the chat panel into a card's thread. The one owner of the card
// mode-switch: the "talk" button and the desktop card-detail sync both go through
// here. opts.silent (desktop detail-sync) skips the mobile tab-switch and the
// input focus, so selecting a card doesn't steal focus or flip the mobile tab.
export function openCardThread(id, opts) {
  S.chatMode = { mode: 'card', id };
  if (!(opts && opts.silent)) {
    S.view = 'chat'; // on mobile, switch to the chat tab
    render();
    // desktop only: auto-focus the composer. On mobile, focusing raises the
    // on-screen keyboard before the user has read the thread, so wait for a tap.
    if (window.innerWidth > 760) inputEl.focus();
  } else {
    render();
  }
}
// Return the chat panel from a card thread to the owning lieutenant's main chat
// (used when a synced card detail closes on desktop, and by the back button).
export function syncChatToMain() {
  if (S.chatMode && S.chatMode.mode === 'card') {
    const c = card(S.chatMode.id);
    S.chatMode = c && lieutenant(c.owner) ? { mode: 'lieutenant', id: c.owner } : null;
    render();
  }
}
export function backToMain() { syncChatToMain(); }
backBtn.onclick = backToMain;
openBtn.onclick = () => { if (S.chatMode && S.chatMode.mode === 'card' && detailOpener) detailOpener(S.chatMode.id); };

// ---------- feed rendering ----------
// A message's attachments: images render inline (click → full-size viewer),
// non-images render as a file chip (click → open/download). In a card thread a
// small 📌 promotes the file to the open card's artifacts (deliberate — the
// upload itself never did). All handlers are delegated on the feed (see below),
// so the markup only carries data-* ids; nothing is interpolated into a handler.
function attachmentsHtml(atts, promote) {
  if (!Array.isArray(atts) || !atts.length) return '';
  return '<div class="atts">' + atts.map((a) => {
    const url = '/api/attachments/' + encodeURIComponent(a.id);
    const meta = 'data-att-id="' + esc(a.id) + '" data-att-mime="' + esc(a.mime || '') + '" data-att-name="' + esc(a.name || '') + '"';
    const pin = promote ? '<button type="button" class="att-pin" ' + meta + ' title="add to card artifacts" aria-label="add to card artifacts">📌</button>' : '';
    if (isImageMime(a.mime)) {
      return '<div class="att att-img">' +
        '<img class="att-thumb" src="' + esc(url) + '" alt="' + esc(a.name || '') + '" loading="lazy" data-att-open ' + meta + '>' +
        pin + '</div>';
    }
    return '<div class="att att-file">' +
      '<span class="att-open" data-att-open ' + meta + ' title="' + esc(a.name || '') + '">' +
      '<span class="att-ico">📄</span>' +
      '<span class="att-nm">' + esc(a.name || 'file') + '</span>' +
      '<span class="att-sz">' + esc(fmtSize(a.size)) + '</span>' +
      '</span>' + pin + '</div>';
  }).join('') + '</div>';
}
// A slash command's request+reply are the SYSTEM, not the lieutenant: they get a
// full-width console block (monospace, subtle border, dim palette, a small "⌘"
// affordance) — no avatar, no speak button — so they never read as an agent bubble.
function cmdMsgHtml(m) {
  const ts = '<span class="ts">' + hhmm(m.ts) + '</span>';
  if (!m.cmd.reply) {
    // the request: a console prompt line echoing exactly what was typed
    return '<div class="msg cmd cmd-req"><span class="cmd-glyph">⌘</span>' +
      '<span class="cmd-line">' + esc(m.text) + '</span>' + ts + '</div>';
  }
  // the reply: /status renders a rich model+context block; everything else is
  // the harness's formatted text as console output
  const body = m.status
    ? statusBlockHtml(m.status)
    : '<div class="cmd-out md">' + md(m.text) + '</div>';
  const badge = '<span class="cmd-badge">⌘ ' + esc(m.cmd.name || '') + '</span>';
  return '<div class="msg cmd cmd-reply">' + badge + body + ts + '</div>';
}
function msgHtml(m, promote, avatarIdx) {
  if (m.cmd && typeof m.cmd === 'object') return cmdMsgHtml(m);
  const mine = m.author === USER;
  const hasText = !!(m.text && m.text.trim());
  const body = !hasText ? '' : (mine
    ? '<div class="md pre">' + esc(m.text) + '</div>'
    : '<div class="md">' + md(m.text) + '</div>');
  const atts = attachmentsHtml(m.attachments, promote);
  const who = mine ? '' : esc(m.author) + ' · ';
  // speak button only on lieutenant bubbles; 🔊 icon, no message text in markup
  const speakBtn = mine ? '' :
    '<button class="msg-speak" type="button" data-speak title="read this message aloud" aria-label="read this message aloud">🔊</button>';
  // face sits inside the bubble, top-left — same face for every agent bubble in
  // this feed (a card thread's interlocutor is always the owning lieutenant,
  // so even a worker's stamped-as-owner say gets its face)
  const hasAvatar = !mine && avatarIdx != null;
  const face = hasAvatar ? avatarHtml(avatarIdx, 'msg-face') : '';
  return '<div class="msg ' + (mine ? 'user' : 'agent') + (hasAvatar ? ' has-avatar' : '') + '">' + face + body + atts +
    '<span class="ts">' + who + hhmm(m.ts) + '</span>' + speakBtn + '</div>';
}
// empty-conversation placeholder: the lieutenant's face (or its colored dot,
// same fallback rule as everywhere else) above the "no messages yet" text
function emptyFeedHtml(lt) {
  if (!lt) return '<div class="empty">no messages yet</div>';
  const av = lieutenantAvatar(lt.id);
  const face = av != null
    ? avatarHtml(av, 'chat-empty-avatar')
    : '<span class="chat-empty-dot" style="background:' + esc(lieutenantColor(lt.id)) + '"></span>';
  return '<div class="empty">' + face + 'no messages yet</div>';
}
function typingHtml(state, name) {
  // the "owes you a reply" balloon (card.status.owedState / the main-chat rule),
  // one visual per state so queued-unseen never masquerades as being worked on:
  // 'stale'  = owed past the threshold: a DISTINCT "may be stuck" state, static
  //            and amber, so a dropped message never looks healthy forever
  // 'queued' = delivered to the durable inbox but NOT drained yet — static
  //            hourglass, "waiting to be picked up", no typing animation
  // 'seen'   = drained; the lieutenant owes the reply for real — animated dots
  if (state === 'stale') {
    return '<div class="msg agent typing stale" title="no response for a while — the message may not have reached ' + esc(name) + '">' +
      '<span class="twarn">⚠</span>' +
      '<span class="lbl">no response yet — ' + esc(name) + ' may be stuck</span></div>';
  }
  if (state === 'queued') {
    return '<div class="msg agent typing queued" title="delivered — ' + esc(name) + ' hasn\'t picked it up yet">' +
      '<span class="tcheck">⏳</span>' +
      '<span class="lbl">delivered — waiting for ' + esc(name) + ' to pick it up</span></div>';
  }
  return '<div class="msg agent typing" title="' + esc(name) + ' owes you a reply here">' +
    '<span class="tdot"></span><span class="tdot"></span><span class="tdot"></span>' +
    '<span class="lbl">' + esc(name) + ' owes you a reply…</span></div>';
}
function mainFeedMsgs() {
  // the current lieutenant's main-chat messages; card threads live in their own card view
  const l = S.chatMode && S.chatMode.mode === 'lieutenant' ? lieutenant(S.chatMode.id) : null;
  const msgs = ((l && l.chat) || []).slice();
  msgs.sort((a, b) => (a.ts < b.ts ? -1 : a.ts > b.ts ? 1 : 0));
  return msgs;
}

// a main chat collapses older history behind one expander; expansion is
// client-side only and resets on page load. The cutoff is ANCHORED when the
// conversation is first shown (not "always the last 30"): new arrivals extend
// the visible window downward without shifting it, which keeps the earlier
// blocks' markup stable so the append fast-path below can run.
const COLLAPSE_KEEP = 30;
let mainExpanded = false;
let collapsedHidden = -1; // -1 = recompute on next render (conversation switch)

// What the feed currently shows: per-block html (a block = one message with
// its day divider merged in, or the history expander) plus the trailing typing
// indicator. Diffed on every render: identical = leave the DOM alone; new
// blocks at the end only = append them without touching the earlier DOM (no
// flicker, no scroll/selection reset); anything else = full rebuild.
let feed = { key: null, blocks: [], tail: '' };

// the conversation currently shown; a change means "jump to the newest message"
let lastViewKey = null;
// #chat can still be display:none this frame (renderTabs runs after renderChat),
// so defer the scroll across two frames until layout + visibility have settled.
function scrollFeedToBottom() {
  const jump = () => { feedEl.scrollTop = feedEl.scrollHeight; };
  requestAnimationFrame(() => { jump(); requestAnimationFrame(jump); });
}

// Wire the speak buttons of freshly (re)built blocks. Buttons not yet wired
// appear in DOM order and map 1:1 to the given blocks' lieutenant messages, so
// message text never needs to be interpolated into markup (XSS-safe).
function wireSpeak(blocks, target) {
  const msgs = blocks.filter((b) => b.msg).map((b) => b.msg);
  const btns = feedEl.querySelectorAll('.msg.agent [data-speak]:not([data-wired])');
  btns.forEach((btn, i) => {
    const m = msgs[i];
    if (!m) return;
    btn.setAttribute('data-wired', '');
    const key = target + '|' + m.ts + '|' + m.author; // stable per message, for toggle-off
    btn.onclick = (e) => {
      e.stopPropagation();
      const spoke = speakMessage(m.text, key);
      btn.classList.toggle('speaking', spoke);
    };
  });
}

// The switcher trigger: the current lieutenant's face + name (the lane chip's
// content, relocated) plus model (+effort), context bar and owed state. A
// badge with the OTHER lieutenants' unread total keeps their activity visible
// now that the chips are gone.
function ltTriggerHtml(lt) {
  const av = lieutenantAvatar(lt.id);
  const face = av != null
    ? '<span class="lt-face" style="border-color:' + esc(lieutenantColor(lt.id)) + '">' + avatarHtml(av) + '</span>'
    : '<span class="lt-dot" style="background:' + esc(lieutenantColor(lt.id)) + '"></span>';
  const owed = targetOwedState('lieutenant:' + lt.id);
  const ind = owedIndHtml(owed, owed && targetOwedStale('lieutenant:' + lt.id));
  const st = lt.agentStatus || {};
  const model = st.model
    ? '<span class="clt-model">' + esc(st.model) + (st.effort ? ' <span class="clt-effort">(' + esc(st.effort) + ')</span>' : '') + '</span>'
    : '';
  const meta = model || ctxBarHtml(st) ? '<span class="clt-meta">' + model + ctxBarHtml(st) + '</span>' : '';
  const others = lieutenants().reduce((n, l) => n + (l.id === lt.id ? 0 : lieutenantUnread(l)), 0);
  return face +
    '<span class="clt-main">' +
    '<span class="clt-name">' + esc(lt.name || lt.id) + ind + '</span>' + meta +
    '</span>' +
    '<span class="clt-caret">▾</span>' +
    (others ? '<span class="badge-n" title="unread in other lieutenants\' chats">' + (others > 99 ? '99+' : others) + '</span>' : '');
}

export function renderChat() {
  const target = currentTarget();
  if (!target) {
    backBtn.hidden = true;
    openBtn.hidden = true;
    titleEl.hidden = true;
    // no lieutenants yet: the trigger doubles as the create button
    ltBtn.hidden = false;
    setHtmlIfChanged(ltBtn, '<span class="clt-main"><span class="clt-name">＋ lieutenant</span></span>');
    inputEl.placeholder = 'create a lieutenant to start…';
    inputEl.disabled = true;
    attachBtn.disabled = true;
    if (feed.key !== '') feedEl.innerHTML = '<div class="empty">no lieutenants yet — tap ＋ lieutenant above to start commanding</div>';
    feed = { key: '', blocks: [], tail: '' };
    return;
  }
  inputEl.disabled = false;
  attachBtn.disabled = false;
  const isCard = S.chatMode.mode === 'card';
  const c = isCard ? card(S.chatMode.id) : null;
  const lt = currentLieutenant();
  const ltName = lt ? lt.name || lt.id : 'lieutenant';

  backBtn.hidden = !isCard;
  openBtn.hidden = !isCard;
  // card thread: plain card title (back returns to the lieutenant, where the
  // switcher lives); lieutenant chat: the switcher trigger IS the header
  ltBtn.hidden = isCard || !lt;
  titleEl.hidden = !ltBtn.hidden;
  if (isCard || !lt) setHtmlIfChanged(titleEl, esc(cardEmoji(c) + ' ' + (c.title || c.id)));
  else setHtmlIfChanged(ltBtn, ltTriggerHtml(lt));
  inputEl.placeholder = isCard ? 'message ' + ltName + ' about this card…' : 'message ' + ltName + '…';

  // Land at the newest message when the visible conversation changes (first
  // paint, tab switch into Chat, or entering/leaving a thread) or when the
  // feed was already near the bottom; otherwise leave the reader's scroll be.
  const viewKey = target + '|' + (window.innerWidth <= 760 ? S.view : 'desktop');
  const switched = viewKey !== lastViewKey;
  lastViewKey = viewKey;
  if (target !== feed.key) { mainExpanded = false; collapsedHidden = -1; closeSlash(); } // each conversation starts collapsed (and drops the slash picker)
  const pinned = feedEl.scrollHeight - feedEl.scrollTop - feedEl.clientHeight < 48;

  const blocks = []; // {html, msg?} — msg only on lieutenant bubbles, for speak wiring
  const avatarIdx = lt ? lieutenantAvatar(lt.id) : null;
  let lastDay = '';
  const push = (m) => {
    const day = m.ts ? dayLabel(m.ts) : '';
    let h = '';
    if (day && day !== lastDay) { h += '<div class="feed-day">' + esc(day) + '</div>'; lastDay = day; }
    // command blocks render no speak button, so they carry no `msg` (speak wiring
    // maps buttons to blocks-with-msg by index — a command block would desync it)
    const speakable = m.author !== USER && !(m.cmd && typeof m.cmd === 'object');
    blocks.push({ html: h + msgHtml(m, isCard, avatarIdx), msg: speakable ? m : null });
  };
  if (isCard) {
    for (const m of c.thread || []) push(m);
  } else {
    // only the newest COLLAPSE_KEEP messages render by default; older history
    // sits behind the expander (anchored cutoff — see collapsedHidden above)
    const msgs = mainFeedMsgs();
    if (collapsedHidden < 0) collapsedHidden = Math.max(0, msgs.length - COLLAPSE_KEEP);
    const hidden = mainExpanded ? 0 : Math.min(collapsedHidden, msgs.length);
    if (hidden) blocks.push({ html: '<button class="feed-expand" type="button">show earlier messages (' + hidden + ')</button>' });
    for (const m of msgs.slice(hidden)) push(m);
  }
  const owedState = targetOwedState(target);
  const tail = owedState ? typingHtml(targetOwedStale(target) ? 'stale' : owedState, ltName) : '';

  const prev = feed;
  feed = { key: target, blocks, tail };
  const prefixOk = target === prev.key && blocks.length >= prev.blocks.length &&
    prev.blocks.every((b, i) => b.html === blocks[i].html);
  if (prefixOk && blocks.length === prev.blocks.length && tail === prev.tail) {
    // nothing visible changed — leave the DOM (and the reader) alone
    if (switched) scrollFeedToBottom();
  } else if (prefixOk && prev.blocks.length) {
    // append-only delta: swap the typing indicator, add the new blocks at the
    // end; the earlier DOM — scroll, selection, focus — is never touched
    const typingEl = feedEl.querySelector('.msg.typing');
    if (typingEl) typingEl.remove();
    const fresh = blocks.slice(prev.blocks.length);
    feedEl.insertAdjacentHTML('beforeend', fresh.map((b) => b.html).join('') + tail);
    mdEnhance(feedEl);
    wireSpeak(fresh, target);
    if (switched) scrollFeedToBottom();
    else if (pinned) feedEl.scrollTop = feedEl.scrollHeight;
  } else {
    feedEl.innerHTML = blocks.map((b) => b.html).join('') + tail || emptyFeedHtml(lt);
    mdEnhance(feedEl);
    wireSpeak(blocks, target);
    if (switched) scrollFeedToBottom(); // deferred: the feed may still be hidden this frame
    else if (pinned) feedEl.scrollTop = feedEl.scrollHeight;

    // expander: reveal the full history, keeping the reader's place (content is
    // inserted above, so anchor scrollTop by the height delta)
    const expandBtn = feedEl.querySelector('.feed-expand');
    if (expandBtn) expandBtn.onclick = () => {
      const prevH = feedEl.scrollHeight, prevTop = feedEl.scrollTop;
      mainExpanded = true;
      renderChat();
      feedEl.scrollTop = prevTop + (feedEl.scrollHeight - prevH);
    };
  }

  maybeMarkRead(isCard ? c : null, target);
}

// mark the visible thread read (server-persisted) — debounced, loop-safe.
// Card unread also derives from level-1 EVENTS, not just thread messages, so a
// card target uses the server-derived card.status.unread (and the shared
// cardActivityTs dedupe key); message-based gating alone would leave an
// event-only unread dotted forever. Lieutenant main chats keep the message rule.
let lastMarked = { target: '', ts: '' };
function maybeMarkRead(c, target) {
  if (document.hidden) return;
  if (window.innerWidth <= 760 && S.view !== 'chat') return; // thread not visible
  const isCard = !!c;
  const msgs = isCard ? (c.thread || []) : mainFeedMsgs();
  const unread = isCard ? !!cardStatus(c).unread : threadUnread(target, msgs);
  if (!unread) return;
  const lastTs = isCard ? cardActivityTs(c) : (msgs.length ? msgs[msgs.length - 1].ts : '');
  if (lastMarked.target === target && lastMarked.ts === lastTs) return; // already sent
  lastMarked = { target, ts: lastTs };
  api.markThreadRead(target).catch(() => { lastMarked = { target: '', ts: '' }; });
}

// ---------- attachment interaction (delegated on the feed) ----------
// One listener for every rendered message: open a file/image, or promote it to
// the open card's artifacts. Delegation survives the append/rebuild fast-path
// without any per-message re-wiring.
feedEl.addEventListener('click', (e) => {
  const pin = e.target.closest('.att-pin');
  if (pin) {
    e.stopPropagation();
    promoteAttachment({ id: pin.dataset.attId, name: pin.dataset.attName, mime: pin.dataset.attMime }, pin);
    return;
  }
  const open = e.target.closest('[data-att-open]');
  if (open) {
    e.stopPropagation();
    openAttachment({ id: open.dataset.attId, name: open.dataset.attName, mime: open.dataset.attMime });
  }
});
// 📌 promote — card threads only. The action is only rendered in a card thread,
// but re-check S.chatMode so a stale click can never promote to the wrong place.
async function promoteAttachment(att, btn) {
  if (!(S.chatMode && S.chatMode.mode === 'card')) return;
  const cardId = S.chatMode.id;
  btn.disabled = true;
  try {
    await api.addArtifact(cardId, 'attachment://' + att.id, att.name || '');
    btn.textContent = '✅';
    btn.title = 'added to card artifacts';
    setTimeout(() => { btn.textContent = '📌'; btn.disabled = false; btn.title = 'add to card artifacts'; }, 1400);
  } catch (err) {
    btn.disabled = false;
    btn.title = 'failed: ' + err.message;
  }
}

// ---------- composer ----------
// The input clears ONLY once the message is confirmed delivered AND visible in
// the chat timeline; until then the text is the captain's only copy. On failure
// it stays in the composer with an error indication — never silently eaten.
const sendBtn = document.querySelector('#chat-form button[type=submit]');
const sendErrEl = document.getElementById('chat-send-err');
const fileInput = document.getElementById('chat-file');
const attachBtn = document.getElementById('chat-attach');
const attsEl = document.getElementById('chat-atts');

// Pending (not-yet-uploaded) files staged in the composer. Each is uploaded on
// send; until then they show as removable chips and are the captain's only copy.
let pendingAtts = []; // { file, key }
let attSeq = 0;
function addPendingFiles(files) {
  for (const f of files) { if (f) pendingAtts.push({ file: f, key: ++attSeq }); }
  renderPendingAtts();
}
function renderPendingAtts() {
  if (!pendingAtts.length) { attsEl.hidden = true; attsEl.textContent = ''; return; }
  attsEl.hidden = false;
  attsEl.textContent = '';
  for (const p of pendingAtts) {
    const chip = document.createElement('span');
    chip.className = 'att-chip';
    const isImg = isImageMime(p.file.type);
    const nm = document.createElement('span');
    nm.className = 'att-chip-nm';
    nm.textContent = (isImg ? '🖼 ' : '📄 ') + (p.file.name || 'file');
    const sz = document.createElement('span');
    sz.className = 'att-chip-sz';
    sz.textContent = fmtSize(p.file.size);
    const x = document.createElement('button');
    x.type = 'button'; x.className = 'att-chip-x'; x.textContent = '✕'; x.title = 'remove';
    x.onclick = () => { pendingAtts = pendingAtts.filter((q) => q !== p); renderPendingAtts(); };
    chip.append(nm, sz, x);
    attsEl.appendChild(chip);
  }
}
attachBtn.onclick = () => fileInput.click();
fileInput.onchange = () => { if (fileInput.files && fileInput.files.length) addPendingFiles([...fileInput.files]); fileInput.value = ''; };
// drag-and-drop onto the composer
const composerEl = document.getElementById('chat-form');
['dragenter', 'dragover'].forEach((ev) => composerEl.addEventListener(ev, (e) => {
  if (inputEl.disabled) return;
  e.preventDefault(); composerEl.classList.add('drag');
}));
['dragleave', 'drop'].forEach((ev) => composerEl.addEventListener(ev, (e) => {
  e.preventDefault();
  if (ev === 'dragleave' && composerEl.contains(e.relatedTarget)) return;
  composerEl.classList.remove('drag');
}));
composerEl.addEventListener('drop', (e) => {
  if (inputEl.disabled) return;
  const files = e.dataTransfer && e.dataTransfer.files;
  if (files && files.length) addPendingFiles([...files]);
});
// paste-image from the clipboard (screenshots)
inputEl.addEventListener('paste', (e) => {
  const items = e.clipboardData && e.clipboardData.items;
  if (!items) return;
  const files = [];
  for (const it of items) { if (it.kind === 'file') { const f = it.getAsFile(); if (f) files.push(f); } }
  if (files.length) { e.preventDefault(); addPendingFiles(files); }
});

function autoGrow(t) { t.style.height = 'auto'; t.style.height = Math.min(t.scrollHeight, 132) + 'px'; }

// ---------- slash-command autocomplete ----------
// A composer holding a single leading-"/" token opens the picker, fed by
// /api/commands for the CURRENT target (lieutenant chat → its own session;
// card thread → the card's worker session). Arrows move, Tab/Enter pick, Esc
// closes; sending is unchanged (the server routes "/..." to runCommand and
// both the command and its reply land in the thread). Commands are refetched
// on every open — cheap, and the set changes when a worker starts.
const slashEl = document.getElementById('chat-slash');
const slash = { open: false, items: [], sel: 0, target: null };

function slashMatches() {
  const v = inputEl.value;
  if (!/^\/\S*$/.test(v)) return [];
  return slash.items.filter((c) => c && typeof c.name === 'string' && c.name.startsWith(v));
}
function closeSlash() {
  slash.open = false;
  slash.target = null;
  slashEl.hidden = true;
}
function renderSlash() {
  const matches = slashMatches();
  if (!matches.length) { slashEl.hidden = true; return; }
  slash.sel = Math.max(0, Math.min(slash.sel, matches.length - 1));
  slashEl.hidden = false;
  slashEl.innerHTML = matches.map((c, i) =>
    '<button type="button" class="slash-it' + (i === slash.sel ? ' on' : '') + '" data-name="' + esc(c.name) + '">' +
    '<span class="sn">' + esc(c.name) + '</span>' +
    '<span class="sd">' + esc(c.description || '') + '</span></button>').join('');
}
function pickSlash(name) {
  inputEl.value = name;
  closeSlash();
  inputEl.focus();
  autoGrow(inputEl);
}
function updateSlash() {
  const target = currentTarget();
  if (!target || !/^\/\S*$/.test(inputEl.value)) { closeSlash(); return; }
  if (!slash.open || slash.target !== target) { // opening: (re)fetch the target's commands
    slash.open = true;
    slash.target = target;
    slash.sel = 0;
    slash.items = [];
    api.commands(target)
      .then((r) => { if (slash.open && slash.target === target) { slash.items = r.commands || []; renderSlash(); } })
      .catch(() => {});
  }
  renderSlash();
}
slashEl.addEventListener('mousedown', (e) => e.preventDefault()); // picking must not blur the composer
slashEl.addEventListener('click', (e) => {
  const it = e.target.closest('.slash-it');
  if (it) pickSlash(it.dataset.name);
});
document.addEventListener('click', (e) => {
  if (slash.open && !composerEl.contains(e.target)) closeSlash();
});

// The POST already triggered a broadcast, so the echo normally arrives over SSE
// within a beat; poll the local state for it, with one direct refetch as a
// fallback (e.g. the SSE stream is stale and hasn't been reaped yet).
function threadMsgs(target) {
  const m = /^card:(.+)$/.exec(target);
  if (m) { const c = card(m[1]); return (c && c.thread) || []; }
  const l = lieutenant(target.replace(/^lieutenant:/, ''));
  return (l && l.chat) || [];
}
async function waitForEcho(target, text) {
  const seen = () => threadMsgs(target).some((m) => m.author === USER && m.text === text);
  for (let i = 0; i < 20; i++) {
    if (seen()) return true;
    if (i === 10) api.board().then((doc) => { S.doc = doc; trackMessages(doc); render(); }).catch(() => {});
    await new Promise((r) => setTimeout(r, 150));
  }
  return seen();
}
function setSendError(msg) {
  inputEl.classList.add('send-fail');
  sendErrEl.textContent = '⚠ not delivered — ' + msg + '. Your message is still below; try again.';
  sendErrEl.hidden = false;
}
function clearSendError() {
  inputEl.classList.remove('send-fail');
  sendErrEl.hidden = true;
}

let sending = false;
async function send() {
  if (sending) return;
  const target = currentTarget();
  if (!target) return;
  const text = inputEl.value.trim();
  const atts = pendingAtts.slice();
  if (!text && !atts.length) return; // nothing to send
  sending = true;
  clearSendError();
  sendBtn.disabled = true;
  sendBtn.classList.add('sending');
  inputEl.readOnly = true; // the pending text must stay exactly what was sent
  try {
    // Upload the staged files first (A) — concurrently, since they're
    // independent — then post the message with the returned attachment metas
    // (the server re-resolves them authoritatively by id).
    const metas = await Promise.all(atts.map((p) => api.uploadAttachment(p.file)));
    await api.feedback(target, text, metas);
    // With text, wait for its echo; attachments-only has no text to match, so the
    // 200 is the confirmation (the SSE board push renders the bubble a beat later).
    if (text && !(await waitForEcho(target, text))) throw new Error('sent, but no echo from the server');
    inputEl.value = '';
    closeSlash();
    pendingAtts = [];
    renderPendingAtts();
  } catch (e) {
    setSendError(e.message);
  } finally {
    sending = false;
    sendBtn.disabled = false;
    sendBtn.classList.remove('sending');
    inputEl.readOnly = false;
    autoGrow(inputEl);
  }
}
inputEl.oninput = () => { autoGrow(inputEl); clearSendError(); updateSlash(); };
// Enter inserts a newline; Cmd+Enter (mac) or Ctrl+Enter sends. With the slash
// picker open, arrows/Tab/Enter drive the picker (Cmd/Ctrl+Enter still sends).
inputEl.onkeydown = (e) => {
  if (slash.open && !slashEl.hidden && !(e.metaKey || e.ctrlKey)) {
    const matches = slashMatches();
    if (matches.length && (e.key === 'ArrowDown' || e.key === 'ArrowUp')) {
      e.preventDefault();
      slash.sel = (slash.sel + (e.key === 'ArrowDown' ? 1 : matches.length - 1)) % matches.length;
      renderSlash();
      return;
    }
    if (matches.length && (e.key === 'Tab' || e.key === 'Enter')) {
      e.preventDefault();
      pickSlash(matches[slash.sel].name);
      return;
    }
    if (e.key === 'Escape') { e.preventDefault(); closeSlash(); return; }
  }
  if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) { e.preventDefault(); send(); }
};
document.getElementById('chat-form').onsubmit = (e) => { e.preventDefault(); send(); };
