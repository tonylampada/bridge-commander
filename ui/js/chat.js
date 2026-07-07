// chat panel: unified main feed (messages + card-thread bubbles anchored at thread
// start), whole-window mode switch into a card thread, premium composer.
import { S, card, cardStatus, cardActivityTs, render, threadUnread, targetOwed, targetOwedStale, USER } from './state.js';
import { api } from './api.js';
import { esc, hhmm, dayLabel, cardEmoji } from './util.js';
import { md } from './md.js';
import { speakMessage } from './voice.js';

const feedEl = document.getElementById('chat-feed');
const titleEl = document.getElementById('chat-title');
const backBtn = document.getElementById('chat-back');
const openBtn = document.getElementById('chat-card-open');
const inputEl = document.getElementById('chat-input');

let detailOpener = null; // set by main.js to avoid a circular import
export function onOpenCard(fn) { detailOpener = fn; }

export function currentTarget() {
  return S.chatMode.mode === 'card' ? 'card:' + S.chatMode.id : 'chat';
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
// Return the chat panel to the main conversation (used when a synced card detail
// closes on desktop). Same mode representation as backToMain, no forked path.
export function syncChatToMain() {
  if (S.chatMode.mode === 'card') { S.chatMode = { mode: 'main' }; render(); }
}
export function backToMain() {
  S.chatMode = { mode: 'main' };
  render();
}
backBtn.onclick = backToMain;
openBtn.onclick = () => { if (S.chatMode.mode === 'card' && detailOpener) detailOpener(S.chatMode.id); };

// ---------- feed rendering ----------
// agent messages rendered this pass, in DOM order, so a post-render pass can wire
// each .msg.agent[data-speak] button to the right message's text without ever
// interpolating message text into markup (XSS-safe).
let speakMsgs = [];
function msgHtml(m) {
  const mine = m.author === USER;
  const body = mine
    ? '<div class="md pre">' + esc(m.text) + '</div>'
    : '<div class="md">' + md(m.text) + '</div>';
  const who = mine ? '' : esc(m.author) + ' · ';
  // speak button only on agent bubbles; 🔊 icon, no message text in markup
  const speakBtn = mine ? '' :
    '<button class="msg-speak" type="button" data-speak title="read this message aloud" aria-label="read this message aloud">🔊</button>';
  if (!mine) speakMsgs.push(m);
  return '<div class="msg ' + (mine ? 'user' : 'agent') + '">' + body +
    '<span class="ts">' + who + hhmm(m.ts) + '</span>' + speakBtn + '</div>';
}
function typingHtml(stale) {
  // the "agent owes you a reply" balloon (card.status.owed / the main-chat rule).
  // stale = owed past the threshold: a DISTINCT "may be stuck" state, static and
  // amber, so a dropped message never looks like a healthy pending reply forever
  if (stale) {
    return '<div class="msg agent typing stale" title="no response for a while — the message may not have reached the agent">' +
      '<span class="twarn">⚠</span>' +
      '<span class="lbl">no response yet — the agent may be stuck</span></div>';
  }
  return '<div class="msg agent typing" title="the agent owes you a reply here">' +
    '<span class="tdot"></span><span class="tdot"></span><span class="tdot"></span>' +
    '<span class="lbl">agent owes you a reply…</span></div>';
}
function mainFeedMsgs() {
  // main-chat messages only; card threads live in their own card view
  const msgs = (((S.doc && S.doc.chat) || [])).slice();
  msgs.sort((a, b) => (a.ts < b.ts ? -1 : a.ts > b.ts ? 1 : 0));
  return msgs;
}

// main chat collapses older history behind one expander; expansion is
// client-side only and resets on page load
const COLLAPSE_KEEP = 30;
let mainExpanded = false;

// the conversation currently shown; a change means "jump to the newest message"
let lastViewKey = null;
// #chat can still be display:none this frame (renderTabs runs after renderChat),
// so defer the scroll across two frames until layout + visibility have settled.
function scrollFeedToBottom() {
  const jump = () => { feedEl.scrollTop = feedEl.scrollHeight; };
  requestAnimationFrame(() => { jump(); requestAnimationFrame(jump); });
}

export function renderChat() {
  const isCard = S.chatMode.mode === 'card';
  const c = isCard ? card(S.chatMode.id) : null;
  if (isCard && !c) { S.chatMode = { mode: 'main' }; return renderChat(); }

  backBtn.hidden = !isCard;
  openBtn.hidden = !isCard;
  titleEl.textContent = isCard ? cardEmoji(c) + ' ' + (c.title || c.id) : '💬 chat';
  inputEl.placeholder = isCard ? 'message this card…' : 'message the agent…';

  // Land at the newest message when the visible conversation changes (first
  // paint, tab switch into Chat, or entering/leaving a card thread) or when the
  // feed was already near the bottom; otherwise leave the reader's scroll be.
  const viewKey = currentTarget() + '|' + (window.innerWidth <= 760 ? S.view : 'desktop');
  const switched = viewKey !== lastViewKey;
  lastViewKey = viewKey;
  const pinned = feedEl.scrollHeight - feedEl.scrollTop - feedEl.clientHeight < 48;
  speakMsgs = [];
  let html = '', lastDay = '';
  const push = (ts, itemHtml) => {
    const day = ts ? dayLabel(ts) : '';
    if (day && day !== lastDay) { html += '<div class="feed-day">' + esc(day) + '</div>'; lastDay = day; }
    html += itemHtml;
  };
  if (isCard) {
    for (const m of c.thread || []) push(m.ts, msgHtml(m));
  } else {
    // only the newest COLLAPSE_KEEP messages render by default; older history
    // sits behind the expander. msgHtml runs only for visible messages so the
    // speak-button ↔ speakMsgs DOM-order mapping stays 1:1.
    const msgs = mainFeedMsgs();
    const hidden = mainExpanded ? 0 : Math.max(0, msgs.length - COLLAPSE_KEEP);
    if (hidden) html += '<button class="feed-expand" type="button">show earlier messages (' + hidden + ')</button>';
    for (const m of msgs.slice(hidden)) push(m.ts, msgHtml(m));
  }
  if (targetOwed(currentTarget())) html += typingHtml(targetOwedStale(currentTarget()));
  feedEl.innerHTML = html || '<div class="empty">no messages yet</div>';
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

  // wire speak buttons: .msg.agent[data-speak] in DOM order maps 1:1 to speakMsgs
  const speakBtns = feedEl.querySelectorAll('.msg.agent [data-speak]');
  speakBtns.forEach((btn, i) => {
    const m = speakMsgs[i];
    if (!m) return;
    const key = currentTarget() + '|' + m.ts + '|' + m.author; // stable per message, for toggle-off
    btn.onclick = (e) => {
      e.stopPropagation();
      const spoke = speakMessage(m.text, key);
      btn.classList.toggle('speaking', spoke);
    };
  });

  maybeMarkRead(isCard ? c : null);
}

// mark the visible thread read (server-persisted) — debounced, loop-safe.
// Card unread also derives from level-1 EVENTS, not just thread messages, so a
// card target uses the server-derived card.status.unread (and the shared
// cardActivityTs dedupe key); message-based gating alone would leave an
// event-only unread dotted forever. Main chat keeps the message rule.
let lastMarked = { target: '', ts: '' };
function maybeMarkRead(c) {
  if (document.hidden) return;
  if (window.innerWidth <= 760 && S.view !== 'chat') return; // thread not visible
  const target = currentTarget();
  const msgs = target === 'chat' ? ((S.doc && S.doc.chat) || []) : ((c && c.thread) || []);
  const unread = target === 'chat' ? threadUnread(target, msgs) : !!(c && cardStatus(c).unread);
  if (!unread) return;
  const lastTs = target === 'chat' ? (msgs.length ? msgs[msgs.length - 1].ts : '') : cardActivityTs(c);
  if (lastMarked.target === target && lastMarked.ts === lastTs) return; // already sent
  lastMarked = { target, ts: lastTs };
  api.markThreadRead(target).catch(() => { lastMarked = { target: '', ts: '' }; });
}

// ---------- composer ----------
function autoGrow(t) { t.style.height = 'auto'; t.style.height = Math.min(t.scrollHeight, 132) + 'px'; }
async function send() {
  const text = inputEl.value.trim();
  if (!text) return;
  inputEl.value = '';
  autoGrow(inputEl);
  try { await api.feedback(currentTarget(), text); } catch (e) { alert(e.message); }
}
inputEl.oninput = () => autoGrow(inputEl);
// Enter inserts a newline; Cmd+Enter (mac) or Ctrl+Enter sends.
inputEl.onkeydown = (e) => {
  if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) { e.preventDefault(); send(); }
};
document.getElementById('chat-form').onsubmit = (e) => { e.preventDefault(); send(); };
