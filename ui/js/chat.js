// chat panel: the captain's conversation with ONE lieutenant at a time — either
// the lieutenant's main chat or one of its card threads (a card thread's
// interlocutor is always the owning lieutenant). Whole-window mode switch,
// premium composer.
import { S, card, cards, lieutenants, lieutenant, lieutenantColor, lieutenantName, lieutenantAvatar, lieutenantUnread, cardStatus, cardActivityTs, render, threadUnread, targetOwedState, targetOwedStale, USER } from './state.js';
import { api } from './api.js';
import { esc, hhmm, dayLabel, cardEmoji, setHtmlIfChanged, fmtSize, isImageMime, statusBlockHtml, ctxBarHtml, owedIndHtml } from './util.js';
import { md, mdEnhance, copyText } from './md.js';
import { speakMessage, trackMessages } from './voice.js';
import { openAttachment } from './detail.js';
import { avatarHtml } from './avatars.js';
import { isEchoOf, addPending, pendingFor } from './pending.js';
import { fileContextBlock } from './filectx.js';
import { CHAT_KEY, CLOSED, encodeChat, decodeChat } from './chatmem.js';
import { slashOptions } from './slash.js';

const feedEl = document.getElementById('chat-feed');
const titleEl = document.getElementById('chat-title');
const ltBtn = document.getElementById('chat-lt'); // switcher trigger (ltswitcher.js owns its click)
const ltPeekBtn = document.getElementById('chat-lt-peek'); // current lt's 👁/⋯ (ltswitcher.js owns clicks)
const ltMenuBtn = document.getElementById('chat-lt-menu');
const backBtn = document.getElementById('chat-back');
const openBtn = document.getElementById('chat-card-open');
const inputEl = document.getElementById('chat-input');

let detailOpener = null; // set by main.js to avoid a circular import
export function onOpenCard(fn) { detailOpener = fn; }

// ---------- the chat that was open last time ----------
// Restored by assigning S.chatMode directly rather than going through
// openLieutenantChat/openCardThread: coming back must not focus the composer,
// flip the mobile tab, scroll the board or mark anything read — it just puts
// the panel back where it was. A chat that no longer exists is dropped by
// ensureChatMode() below, which rewrites the key on the next render.
let chatMemo = null;
try { chatMemo = localStorage.getItem(CHAT_KEY); } catch (e) {}
const reopen = decodeChat(chatMemo, window.location.hash);
if (reopen === 'closed') S.view = 'board'; // mobile: he closed the chat on purpose
else if (reopen) S.chatMode = reopen;
// Persist whatever the panel is showing now. Driven from currentTarget() (so
// it runs after normalization, and after any way the mode can change), and
// deduped against the last written value so a render loop is not a write loop.
function rememberChat() {
  // desktop keeps the chat pane open always — only the mobile tab can close it
  const closed = window.innerWidth <= 760 && S.view !== 'chat';
  const v = closed ? CLOSED : encodeChat(S.chatMode);
  if (v === chatMemo) return;
  chatMemo = v;
  try {
    if (v) localStorage.setItem(CHAT_KEY, v);
    else localStorage.removeItem(CHAT_KEY);
  } catch (e) {}
}

// The chat panel's lieutenant-or-thread mode, normalized: a stale card / dead
// lieutenant falls back to the first lieutenant; no lieutenants = no target.
function ensureChatMode() {
  if (!S.doc) return; // no board yet — nothing to validate a restored chat against
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
  rememberChat();
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

// Land the user IN a card's conversation: the chat filters to the card's
// thread and becomes/stays the visible surface (on mobile it flips to the chat
// tab), while the board tile is only pointed at — the detail panel never opens
// over the chat. The one action behind the message card chips AND notification
// row clicks, so both navigate identically.
export function openCardConversation(id) {
  if (!card(id)) return;
  openCardThread(id);
  flashBoardTile(id);
}

// Point at a card on the board without opening its detail: scroll its tile
// into view and pulse it. A no-op when the board isn't showing the tile
// (mobile chat tab, filtered-out card, table/archive mode) — the chat filter
// itself already communicates which card the conversation narrowed to.
function flashBoardTile(id) {
  const sel = '.tile[data-id="' + (window.CSS && CSS.escape ? CSS.escape(id) : id) + '"]';
  const el = document.querySelector('#board ' + sel);
  if (!el) return;
  el.scrollIntoView({ block: 'nearest', inline: 'nearest', behavior: 'smooth' });
  el.classList.add('flash');
  setTimeout(() => el.classList.remove('flash'), 1600);
}
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
// The card chip: a message that came from a card thread carries a small
// clickable pill (card emoji + title) on its bubble. Clicking it filters the
// conversation down to that card's thread — the CHAT stays the active surface;
// the board tile is only highlighted, never covered by the detail panel (that
// is the filtered header's explicit "open card" action). Delegated on the feed
// — see the chip branch of the click listener below. Main-chat messages carry none.
function chipHtml(m) {
  if (!m._card) return '';
  return '<button type="button" class="msg-chip" data-chip-card="' + esc(m._card) + '"' +
    ' title="show only this card’s conversation">' +
    esc((m._cardEmoji ? m._cardEmoji + ' ' : '') + m._cardTitle) + '</button>';
}
// A slash command's request+reply are the SYSTEM, not the lieutenant: they get a
// full-width console block (monospace, subtle border, dim palette, a small "⌘"
// affordance) — no avatar, no speak button — so they never read as an agent bubble.
function cmdMsgHtml(m) {
  const ts = '<span class="ts">' + hhmm(m.ts) + '</span>';
  if (!m.cmd.reply) {
    // the request: a console prompt line echoing exactly what was typed
    return '<div class="msg cmd cmd-req">' + chipHtml(m) + '<span class="cmd-glyph">⌘</span>' +
      '<span class="cmd-line">' + esc(m.text) + '</span>' + ts + '</div>';
  }
  // the reply: /status renders a rich model+context block; everything else is
  // the harness's formatted text as console output
  const body = m.status
    ? statusBlockHtml(m.status)
    : '<div class="cmd-out md">' + md(m.text) + '</div>';
  const badge = '<span class="cmd-badge">⌘ ' + esc(m.cmd.name || '') + '</span>';
  return '<div class="msg cmd cmd-reply">' + chipHtml(m) + badge + body + ts + '</div>';
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
  // copy button on BOTH sides: puts the raw markdown source on the clipboard
  // (one tap → the iPhone Action-button shortcut reads it aloud). Delegated on
  // the feed via data-copy — deliberately NOT a second index-mapped wiring pass
  // like the speak buttons, so it can't desync that mapping.
  const copyBtn = !hasText ? '' :
    '<button class="msg-copy" type="button" data-copy="' + esc(m.text) + '" title="copy message text" aria-label="copy message text">⧉</button>';
  // face sits inside the bubble, top-left — same face for every agent bubble in
  // this feed (a card thread's interlocutor is always the owning lieutenant,
  // so even a worker's stamped-as-owner say gets its face)
  const hasAvatar = !mine && avatarIdx != null;
  const face = hasAvatar ? avatarHtml(avatarIdx, 'msg-face') : '';
  // an optimistic (pending) send renders as a normal captain bubble, dimmed,
  // with a clock on the timestamp — provisional, but never error-looking
  return '<div class="msg ' + (mine ? 'user' : 'agent') + (m._pending ? ' pending' : '') + (hasAvatar ? ' has-avatar' : '') + '">' + face + chipHtml(m) + body + atts +
    '<span class="ts">' + (m._pending ? '🕓 ' : '') + who + hhmm(m.ts) + '</span>' + copyBtn + speakBtn + '</div>';
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
function typingHtml(state, name, chip) {
  // the "owes you a reply" balloon (card.status.owedState / the main-chat rule),
  // one visual per state so queued-unseen never masquerades as being worked on:
  // 'stale'  = owed past the threshold: a DISTINCT "may be stuck" state, static
  //            and amber, so a dropped message never looks healthy forever
  // 'queued' = delivered to the durable inbox but NOT drained yet — static
  //            hourglass, "waiting to be picked up", no typing animation
  // 'seen'   = drained; the lieutenant owes the reply for real — animated dots
  const src = chip || ''; // unified stream: which card thread this owed reply lives in
  if (state === 'stale') {
    return '<div class="msg agent typing stale" title="no response for a while — the message may not have reached ' + esc(name) + '">' +
      '<span class="twarn">⚠</span>' +
      '<span class="lbl">no response yet — ' + esc(name) + ' may be stuck</span>' + src + '</div>';
  }
  if (state === 'queued') {
    return '<div class="msg agent typing queued" title="delivered — ' + esc(name) + ' hasn\'t picked it up yet">' +
      '<span class="tcheck">⏳</span>' +
      '<span class="lbl">delivered — waiting for ' + esc(name) + ' to pick it up</span>' + src + '</div>';
  }
  return '<div class="msg agent typing" title="' + esc(name) + ' owes you a reply here">' +
    '<span class="tdot"></span><span class="tdot"></span><span class="tdot"></span>' +
    '<span class="lbl">' + esc(name) + ' owes you a reply…</span>' + src + '</div>';
}
function mainFeedMsgs() {
  // the UNIFIED stream: the lieutenant's main-chat messages PLUS every thread
  // message of the cards it owns, merged chronologically. A conversation with a
  // lieutenant is really ONE conversation — the card threads are just slices of
  // it, so the main chat shows it whole. Thread messages are annotated with
  // their source card (_card/_cardTitle/_cardEmoji) so the bubble renders the
  // clickable chip; main-chat messages carry none.
  const l = S.chatMode && S.chatMode.mode === 'lieutenant' ? lieutenant(S.chatMode.id) : null;
  // the board payload carries only the newest slice of the main chat; whatever
  // scrolling up has paged in off the log sits in front of it
  const msgs = (l ? olderLoaded('lieutenant:' + l.id) : []).concat((l && l.chat) || []);
  if (l) {
    for (const c of cards()) {
      if (c.owner !== l.id) continue;
      const emoji = cardEmoji(c);
      for (const m of c.thread || []) {
        msgs.push(Object.assign({}, m, { _card: c.id, _cardTitle: c.title || c.id, _cardEmoji: emoji }));
      }
    }
  }
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

// ---------- older history, paged off the lieutenant's append-only log ----------
// A main chat's older messages are not on the board — GET /api/board carries
// only its newest slice — so scrolling to the top of the feed fetches the page
// before the oldest message on screen and merges it in ahead. Client-side only,
// dropped on a conversation switch (like the collapse state above); the log is
// the truth, this is just how much of it is on screen.
const OLDER_PAGE = 50;
const older = { target: null, msgs: [], done: false, loading: false };
function olderLoaded(target) { return older.target === target ? older.msgs : []; }
function resetOlder() { older.target = null; older.msgs = []; older.done = false; older.loading = false; }
function loadOlder(target) {
  if (older.target !== target) resetOlder();
  if (older.loading || older.done) return;
  const l = lieutenant(target.slice('lieutenant:'.length));
  const have = older.msgs.length ? older.msgs : ((l && l.chat) || []);
  if (!have.length || !have[0].ts) return; // nothing on screen to page back from
  older.target = target;
  older.loading = true;
  api.chatBefore(target, have[0].ts, OLDER_PAGE).then((r) => {
    if (older.target !== target) return; // he switched conversations mid-flight
    older.loading = false;
    const got = (r && r.messages) || [];
    if (!got.length) { older.done = true; return; } // the beginning of the conversation
    older.msgs = got.concat(older.msgs);
    // content lands ABOVE the reader — keep his place by the height delta, the
    // same way the expander does
    const prevH = feedEl.scrollHeight, prevTop = feedEl.scrollTop;
    renderChat();
    feedEl.scrollTop = prevTop + (feedEl.scrollHeight - prevH);
    // a failed page is not the beginning of the conversation — leave `done`
    // alone so the next scroll-up retries
  }).catch(() => { older.loading = false; });
}
// Scroll-up is the whole gesture: at the top of a main chat with nothing left
// collapsed locally, page in what came before.
feedEl.addEventListener('scroll', () => {
  if (feedEl.scrollTop > 40) return;
  if (!mainExpanded && collapsedHidden > 0) return; // the expander still has local history to give
  const target = currentTarget();
  if (target && target.startsWith('lieutenant:')) loadOlder(target);
});

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
      const spoke = speakMessage(m.text, key, m.author);
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
    ltPeekBtn.hidden = ltMenuBtn.hidden = true;
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
  ltPeekBtn.hidden = ltMenuBtn.hidden = ltBtn.hidden; // current lt's 👁/⋯ ride with the trigger
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
  if (target !== feed.key) { mainExpanded = false; collapsedHidden = -1; resetOlder(); closeSlash(); } // each conversation starts collapsed (and drops the slash picker)
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
  // optimistic sends: reconciled against the server thread on every render
  // (the entry drops in the same paint that first shows its echo — never both),
  // rendered after everything the server sent, in send order. The unified
  // stream also merges the owned card threads' pendings, chip-labeled, so a
  // just-sent thread message doesn't vanish when the captain taps back.
  const pendMsg = (p, extra) => Object.assign(
    { author: USER, text: p.text, attachments: p.atts, ts: p.ts, _pending: true }, extra);
  if (isCard) {
    for (const m of c.thread || []) push(m);
    for (const p of pendingFor(target, c.thread || [])) push(pendMsg(p));
  } else {
    // only the newest COLLAPSE_KEEP messages render by default; older history
    // sits behind the expander (anchored cutoff — see collapsedHidden above)
    const msgs = mainFeedMsgs();
    if (collapsedHidden < 0) collapsedHidden = Math.max(0, msgs.length - COLLAPSE_KEEP);
    const hidden = mainExpanded ? 0 : Math.min(collapsedHidden, msgs.length);
    if (hidden) blocks.push({ html: '<button class="feed-expand" type="button">show earlier messages (' + hidden + ')</button>' });
    for (const m of msgs.slice(hidden)) push(m);
    const pend = pendingFor(target, (lt && lt.chat) || []).map((p) => [p, null]);
    if (lt) for (const cc of cards()) {
      if (cc.owner !== lt.id) continue;
      for (const p of pendingFor('card:' + cc.id, cc.thread || [])) {
        pend.push([p, { _card: cc.id, _cardTitle: cc.title || cc.id, _cardEmoji: cardEmoji(cc) }]);
      }
    }
    pend.sort((a, b) => a[0].seq - b[0].seq);
    for (const [p, extra] of pend) push(pendMsg(p, extra));
  }
  // owed tails: the filtered view shows its own target's; the unified stream
  // also surfaces every owed CARD thread of this lieutenant (chip-labeled), so
  // an owed reply is never invisible just because it lives in a card slice
  let tail = '';
  if (!isCard && lt) {
    for (const cc of cards()) {
      if (cc.owner !== lt.id) continue;
      const st = targetOwedState('card:' + cc.id);
      if (!st) continue;
      const chip = chipHtml({ _card: cc.id, _cardTitle: cc.title || cc.id, _cardEmoji: cardEmoji(cc) });
      tail += typingHtml(targetOwedStale('card:' + cc.id) ? 'stale' : st, ltName, chip);
    }
  }
  const owedState = targetOwedState(target);
  if (owedState) tail += typingHtml(targetOwedStale(target) ? 'stale' : owedState, ltName);

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

// mark the visible conversation read (server-persisted) — debounced, loop-safe.
// One POST per target per newest-activity ts: the `marked` map remembers what
// was already sent, and a failed POST forgets it so the next render retries.
const marked = new Map(); // target -> newest ts already POSTed
let readRepaint = 0; // one coalesced repaint per burst of markRead calls
function markRead(target, ts) {
  if (marked.get(target) === ts) return;
  marked.set(target, ts);
  api.markThreadRead(target).catch(() => marked.delete(target));
  // The server persists the marker WITHOUT broadcasting (a read only moves
  // this user's own derivation), so apply it locally: the reads map feeds
  // threadUnread/bell, the card's server-derived status.unread feeds the
  // board dot. The next real broadcast carries the same state.
  const reads = S.doc.reads || (S.doc.reads = {});
  const u = reads[USER] || (reads[USER] = { notifSeq: 0, notifSeqs: [], threads: {} });
  const threads = u.threads || (u.threads = {});
  if (!threads[target] || threads[target] < ts) threads[target] = ts;
  const m = /^card:(.+)$/.exec(target);
  const c = m && card(m[1]);
  if (c && c.status) c.status.unread = false;
  // markRead fires from inside render; repaint dots/bell on the next tick
  if (!readRepaint) readRepaint = setTimeout(() => { readRepaint = 0; render(); }, 0);
}
// A card target uses the server-derived card.status.unread (unread also derives
// from level-1 EVENTS, not just thread messages — message gating alone would
// leave an event-only unread dotted forever) and the shared cardActivityTs
// dedupe key. The unified stream marks the lieutenant's main chat AND every
// merged card thread read — the captain just read those messages here, so
// their dots/bell items must not linger. Cards are gated on MESSAGE unread
// only: an event-only unread (a question/handoff dot) never rendered in the
// stream, so it survives until the card itself is opened.
function maybeMarkRead(c, target) {
  if (document.hidden) return;
  if (window.innerWidth <= 760 && S.view !== 'chat') return; // thread not visible
  if (c) {
    if (cardStatus(c).unread) markRead(target, cardActivityTs(c));
    return;
  }
  const l = lieutenant(target.replace(/^lieutenant:/, ''));
  if (!l) return;
  const chat = l.chat || [];
  if (threadUnread(target, chat)) markRead(target, chat[chat.length - 1].ts);
  for (const cc of cards()) {
    if (cc.owner !== l.id) continue;
    if (threadUnread('card:' + cc.id, cc.thread)) markRead('card:' + cc.id, cardActivityTs(cc));
  }
}

// ---------- attachment interaction (delegated on the feed) ----------
// One listener for every rendered message: open a file/image, or promote it to
// the open card's artifacts. Delegation survives the append/rebuild fast-path
// without any per-message re-wiring.
feedEl.addEventListener('click', (e) => {
  // card chip on a unified-stream bubble: filter the conversation down to that
  // card's thread, keeping the CHAT front and visible (critical on narrow
  // layouts, where the detail panel would take the whole screen). The card is
  // pointed at on the board with a scroll + flash — the detail itself only
  // opens via the filtered header's explicit "open card" button.
  const chip = e.target.closest('[data-chip-card]');
  if (chip) {
    e.stopPropagation();
    openCardConversation(chip.dataset.chipCard);
    return;
  }
  // bubble copy button: message source travels in data-copy (esc()'d in the
  // markup, unescaped back by dataset) — copyText is called synchronously from
  // the gesture so the insecure-context execCommand fallback works.
  const cp = e.target.closest('.msg-copy');
  if (cp) {
    e.stopPropagation();
    copyText(cp.dataset.copy || '').then((ok) => {
      cp.textContent = ok ? '✓' : '✗';
      cp.classList.toggle('ok', ok);
      setTimeout(() => { cp.textContent = '⧉'; cp.classList.remove('ok'); }, 1500);
    });
    return;
  }
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
// The message is never nowhere: the text stays in the input until the POST
// 200 (delivery), at which point it moves to the thread as a pending bubble
// until the server echo replaces it. On failure it stays in the composer with
// an error indication — never silently eaten.
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

// ---------- file context (four-handed editing) ----------
// While a file screen is open, EVERY message the captain sends carries which
// file he is in — and, when he has highlighted something, which lines and what
// text. That is what makes the lieutenant a second pair of hands on the same
// file instead of a second program on the same screen.
//
// The context is pulled, never pushed: filepane.js owns the truth and calls
// refreshQuote() whenever it changes (open, cursor moved, closed). The message
// itself still goes to the card's thread — the context travels with it, it
// doesn't get an address of its own.
let quote = null; // { name, lines?, text? }
let quoteSource = () => null; // registered by main.js
const quoteEl = document.getElementById('chat-quote');
export function onQuoteSource(fn) { quoteSource = fn; refreshQuote(); }
export function refreshQuote() { quote = quoteSource(); renderQuote(); }
function renderQuote() {
  if (!quote) { quoteEl.hidden = true; quoteEl.textContent = ''; return; }
  quoteEl.hidden = false;
  quoteEl.textContent = '';
  const where = document.createElement('span');
  where.className = 'q-where';
  where.textContent = '📎 ' + quote.name + (quote.lines ? ' L' + quote.lines : '');
  const snip = document.createElement('span');
  snip.className = 'q-snip';
  if (quote.text) {
    const first = quote.text.split('\n')[0];
    snip.textContent = first.slice(0, 120) + (first.length > 120 || quote.text.includes('\n') ? ' …' : '');
    snip.title = quote.text.slice(0, 2000);
  } else {
    snip.textContent = 'goes with every message — select lines to point at them';
    snip.classList.add('q-hint');
  }
  quoteEl.append(where, snip);
}

// ---------- slash-command autocomplete ----------
// A composer holding a leading-"/" opens the picker, fed by /api/commands for
// the CURRENT target (lieutenant chat → its own session; card thread → the
// card's worker session). Arrows move, Tab/Enter pick, Esc closes; sending is
// unchanged (the server routes "/..." to runCommand and both the command and its
// reply land in the thread). Commands are refetched on every open — cheap, and
// the set changes when a worker starts.
//
// TWO STAGES: the command name, and then — for a command that reports `args` —
// its values, so "/output-style " keeps completing instead of closing. Which
// stage the text is in, and what each row inserts, is slash.js's job; everything
// here is DOM. The fetch gate is deliberately just "starts with /": stage two
// contains a space, so the old one-token test would have closed the picker on
// the very keystroke that opens the value list.
const slashEl = document.getElementById('chat-slash');
const slash = { open: false, items: [], sel: 0, target: null };

const SLASH_OPEN_RE = /^\/[^\n]*$/; // one line, starts with "/" — slash.js decides the rest

function slashMatches() {
  return slashOptions(inputEl.value, slash.items).matches;
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
  // Same two-column row for both stages — a style name reads like a command
  // name, and a captain scanning the list should not have to change gears.
  slashEl.innerHTML = matches.map((c, i) =>
    '<button type="button" class="slash-it' + (i === slash.sel ? ' on' : '') + '" data-insert="' + esc(c.insert) + '">' +
    '<span class="sn">' + esc(c.name) + '</span>' +
    '<span class="sd">' + esc(c.description || '') + '</span></button>').join('');
}
// pickSlash(insert) — insert is the WHOLE composer value the pick produces
// ("/status", "/output-style ", "/output-style ELI5"). One that ends in a space
// is a command still waiting for its argument, so the picker stays open on its
// value list rather than closing on a half-typed line.
function pickSlash(insert) {
  inputEl.value = insert;
  inputEl.focus();
  autoGrow(inputEl);
  if (/ $/.test(insert)) { slash.sel = 0; renderSlash(); return; }
  closeSlash();
}
function updateSlash() {
  const target = currentTarget();
  if (!target || !SLASH_OPEN_RE.test(inputEl.value)) { closeSlash(); return; }
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
  if (it) pickSlash(it.dataset.insert);
});
document.addEventListener('click', (e) => {
  if (slash.open && !composerEl.contains(e.target)) closeSlash();
});

// Delivery is the POST 200 (the QueueItem lands write-ahead, server-side); the
// echo normally paints over SSE within a beat. A missing echo means the LOCAL
// view is stale, not that the message was lost — so the watchdog is soft: it
// polls with one direct refetch as a fallback, shows a muted "syncing" hint
// after a generous window (never red, never blocks the composer), and clears
// the hint when the echo lands. A newer send supersedes the running watchdog.
function threadMsgs(target) {
  const m = /^card:(.+)$/.exec(target);
  if (m) { const c = card(m[1]); return (c && c.thread) || []; }
  const l = lieutenant(target.replace(/^lieutenant:/, ''));
  return (l && l.chat) || [];
}
let echoWatch = 0;
async function watchEcho(target, text) {
  const token = ++echoWatch;
  const seen = () => threadMsgs(target).some((m) => isEchoOf(m, { text })); // same predicate the pending bubble reconciles by
  for (let i = 0; i < 120; i++) { // 250ms steps: refetch at 3s, hint at 10s, give up at 30s
    if (token !== echoWatch) return;
    if (seen()) { clearSyncHint(); return; }
    if (i === 12) api.board().then((doc) => { if (token === echoWatch) { S.doc = doc; trackMessages(doc); render(); } }).catch(() => {});
    if (i === 40) setSyncHint();
    await new Promise((r) => setTimeout(r, 250));
  }
  console.warn('bc: no echo yet for a delivered message on ' + target);
}
let syncHinted = false;
function setSyncHint() {
  syncHinted = true;
  sendErrEl.classList.add('sync');
  sendErrEl.textContent = 'delivered — syncing…';
  sendErrEl.hidden = false;
}
function clearSyncHint() {
  if (!syncHinted) return;
  syncHinted = false;
  sendErrEl.classList.remove('sync');
  sendErrEl.hidden = true;
}
function setSendError(msg) {
  syncHinted = false;
  sendErrEl.classList.remove('sync');
  inputEl.classList.add('send-fail');
  sendErrEl.textContent = '⚠ not delivered — ' + msg + '. Your message is still below; try again.';
  sendErrEl.hidden = false;
}
function clearSendError() {
  syncHinted = false;
  sendErrEl.classList.remove('sync');
  inputEl.classList.remove('send-fail');
  sendErrEl.hidden = true;
}

let sending = false;
async function send() {
  if (sending) return;
  const target = currentTarget();
  if (!target) return;
  const typed = inputEl.value.trim();
  const atts = pendingAtts.slice();
  const q = quote; // the file screen's context rides along with this message
  if (!typed && !atts.length && !q) return; // nothing to send
  const text = q ? fileContextBlock(q) + typed : typed;
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
    // The 200 IS delivery (write-ahead queue) — clear the composer now, and in
    // the SAME paint put the message in the thread as a pending bubble, so
    // there is never a frame where it exists nowhere. The soft watchdog only
    // flags a stalled echo.
    addPending(target, text, metas);
    inputEl.value = '';
    if (q) refreshQuote(); // re-arm from the screen: still there = still attached
    closeSlash();
    pendingAtts = [];
    renderPendingAtts();
    render();
    if (text) watchEcho(target, text);
  } catch (e) {
    setSendError(e.message); // a real POST failure: red + input preserved
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
      pickSlash(matches[slash.sel].insert);
      return;
    }
    if (e.key === 'Escape') { e.preventDefault(); closeSlash(); return; }
  }
  if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) { e.preventDefault(); send(); }
};
document.getElementById('chat-form').onsubmit = (e) => { e.preventDefault(); send(); };
