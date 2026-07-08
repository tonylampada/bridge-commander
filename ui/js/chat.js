// chat panel: the captain's conversation with ONE lieutenant at a time — either
// the lieutenant's main chat or one of its card threads (a card thread's
// interlocutor is always the owning lieutenant). Whole-window mode switch,
// premium composer.
import { S, card, lieutenants, lieutenant, lieutenantColor, lieutenantName, cardStatus, cardActivityTs, render, threadUnread, targetOwedState, targetOwedStale, USER } from './state.js';
import { api } from './api.js';
import { esc, hhmm, dayLabel, cardEmoji, setHtmlIfChanged } from './util.js';
import { md } from './md.js';
import { speakMessage, trackMessages } from './voice.js';

const feedEl = document.getElementById('chat-feed');
const titleEl = document.getElementById('chat-title');
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

// Open a lieutenant's main chat (lane card click, new-lieutenant create).
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
function msgHtml(m) {
  const mine = m.author === USER;
  const body = mine
    ? '<div class="md pre">' + esc(m.text) + '</div>'
    : '<div class="md">' + md(m.text) + '</div>';
  const who = mine ? '' : esc(m.author) + ' · ';
  // speak button only on lieutenant bubbles; 🔊 icon, no message text in markup
  const speakBtn = mine ? '' :
    '<button class="msg-speak" type="button" data-speak title="read this message aloud" aria-label="read this message aloud">🔊</button>';
  return '<div class="msg ' + (mine ? 'user' : 'agent') + '">' + body +
    '<span class="ts">' + who + hhmm(m.ts) + '</span>' + speakBtn + '</div>';
}
function typingHtml(state, name) {
  // the "owes you a reply" balloon (card.status.owedState / the main-chat rule),
  // one visual per state so queued-unseen never masquerades as being worked on:
  // 'stale'  = owed past the threshold: a DISTINCT "may be stuck" state, static
  //            and amber, so a dropped message never looks healthy forever
  // 'queued' = delivered to the durable inbox but NOT drained yet — static
  //            single check, "waiting to be picked up", no typing animation
  // 'seen'   = drained; the lieutenant owes the reply for real — animated dots
  if (state === 'stale') {
    return '<div class="msg agent typing stale" title="no response for a while — the message may not have reached ' + esc(name) + '">' +
      '<span class="twarn">⚠</span>' +
      '<span class="lbl">no response yet — ' + esc(name) + ' may be stuck</span></div>';
  }
  if (state === 'queued') {
    return '<div class="msg agent typing queued" title="delivered — ' + esc(name) + ' hasn\'t picked it up yet">' +
      '<span class="tcheck">✓</span>' +
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

export function renderChat() {
  const target = currentTarget();
  if (!target) {
    backBtn.hidden = true;
    openBtn.hidden = true;
    setHtmlIfChanged(titleEl, '💬 chat');
    inputEl.placeholder = 'create a lieutenant to start…';
    inputEl.disabled = true;
    if (feed.key !== '') feedEl.innerHTML = '<div class="empty">no lieutenants yet — add one above the board to start commanding</div>';
    feed = { key: '', blocks: [], tail: '' };
    return;
  }
  inputEl.disabled = false;
  const isCard = S.chatMode.mode === 'card';
  const c = isCard ? card(S.chatMode.id) : null;
  const lt = currentLieutenant();
  const ltName = lt ? lt.name || lt.id : 'lieutenant';

  backBtn.hidden = !isCard;
  openBtn.hidden = !isCard;
  setHtmlIfChanged(titleEl, isCard
    ? esc(cardEmoji(c) + ' ' + (c.title || c.id))
    : '<span class="lt-dot" style="background:' + esc(lieutenantColor(lt.id)) + '"></span> ' + esc(ltName));
  inputEl.placeholder = isCard ? 'message ' + ltName + ' about this card…' : 'message ' + ltName + '…';

  // Land at the newest message when the visible conversation changes (first
  // paint, tab switch into Chat, or entering/leaving a thread) or when the
  // feed was already near the bottom; otherwise leave the reader's scroll be.
  const viewKey = target + '|' + (window.innerWidth <= 760 ? S.view : 'desktop');
  const switched = viewKey !== lastViewKey;
  lastViewKey = viewKey;
  if (target !== feed.key) { mainExpanded = false; collapsedHidden = -1; } // each conversation starts collapsed
  const pinned = feedEl.scrollHeight - feedEl.scrollTop - feedEl.clientHeight < 48;

  const blocks = []; // {html, msg?} — msg only on lieutenant bubbles, for speak wiring
  let lastDay = '';
  const push = (m) => {
    const day = m.ts ? dayLabel(m.ts) : '';
    let h = '';
    if (day && day !== lastDay) { h += '<div class="feed-day">' + esc(day) + '</div>'; lastDay = day; }
    blocks.push({ html: h + msgHtml(m), msg: m.author === USER ? null : m });
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
    wireSpeak(fresh, target);
    if (switched) scrollFeedToBottom();
    else if (pinned) feedEl.scrollTop = feedEl.scrollHeight;
  } else {
    feedEl.innerHTML = blocks.map((b) => b.html).join('') + tail || '<div class="empty">no messages yet</div>';
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

// ---------- composer ----------
// The input clears ONLY once the message is confirmed delivered AND visible in
// the chat timeline; until then the text is the captain's only copy. On failure
// it stays in the composer with an error indication — never silently eaten.
const sendBtn = document.querySelector('#chat-form button[type=submit]');
const sendErrEl = document.getElementById('chat-send-err');

function autoGrow(t) { t.style.height = 'auto'; t.style.height = Math.min(t.scrollHeight, 132) + 'px'; }

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
  if (!text) return;
  sending = true;
  clearSendError();
  sendBtn.disabled = true;
  sendBtn.classList.add('sending');
  inputEl.readOnly = true; // the pending text must stay exactly what was sent
  try {
    await api.feedback(target, text);
    if (!(await waitForEcho(target, text))) throw new Error('sent, but no echo from the server');
    inputEl.value = '';
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
inputEl.oninput = () => { autoGrow(inputEl); clearSendError(); };
// Enter inserts a newline; Cmd+Enter (mac) or Ctrl+Enter sends.
inputEl.onkeydown = (e) => {
  if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) { e.preventDefault(); send(); }
};
document.getElementById('chat-form').onsubmit = (e) => { e.preventDefault(); send(); };
