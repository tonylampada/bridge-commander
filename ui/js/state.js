// central UI state + derived selectors. The board doc from SSE is the truth;
// everything here is view state or cheap derivation over it.
export const USER = 'user';

export const S = {
  doc: null,               // full board doc from the server
  connected: false,
  // The chat panel always talks to a lieutenant: either its main chat or one of
  // its card threads (the interlocutor of a card thread is the owning
  // lieutenant). null until the first doc lands / a lieutenant exists.
  chatMode: null,          // {mode:'lieutenant', id} | {mode:'card', id} | null
  openCardId: null,        // detail panel
  view: 'chat',            // mobile tab: 'chat' | 'board'
  boardMode: 'board',      // the board region's view: 'board' (kanban) | 'table'
  // The ONE filter state, shared by board and table. `text` lives in the topbar
  // input; everything else is configured in the filter popup (filterpop.js).
  // sel: [{kind:'label'|'owner', value}] — multi; type/column: single; archived
  // additionally pulls the frozen cards into both views.
  filters: { text: '', age: '', sel: [], type: '', column: '', archived: false },
  notifOpen: false,
  notifShowAll: false,
  notifExpanded: new Set(), // seq of level-1 item whose preceding gap is expanded
};

let renderFn = () => {};
export function onRender(fn) { renderFn = fn; }
export function render() { renderFn(); }

// ---------- selectors ----------
export function cards() { return (S.doc && S.doc.cards) || []; }
export function card(id) { return cards().find((c) => c.id === id); }
export function columns() { return (S.doc && S.doc.columns) || []; }
export function lieutenants() { return (S.doc && S.doc.lieutenants) || []; }
export function lieutenant(id) { return lieutenants().find((l) => l.id === id); }
export function lieutenantColor(id) {
  const l = lieutenant(id);
  return l && /^#[0-9a-fA-F]{6}$/.test(l.color || '') ? l.color : '#66788a';
}
export function lieutenantName(id) {
  const l = lieutenant(id);
  return l ? l.name || l.id : id;
}
export function lieutenantAvatar(id) {
  const l = lieutenant(id);
  const a = l && l.avatar;
  return Number.isInteger(a) && a >= 0 && a <= 63 ? a : null;
}
// the worker registry record bound to a card (board.workers rides the payload);
// its agentStatus feeds the Working-tile context bar
export function workerFor(cardId) {
  return ((S.doc && S.doc.workers) || []).find((w) => w.card === cardId);
}

export function reads() {
  const r = (S.doc && S.doc.reads && S.doc.reads[USER]) || {};
  return {
    notifSeq: r.notifSeq || 0,
    notifSeqs: r.notifSeqs || [],
    threads: r.threads || {},
  };
}
export function threadReadTs(target) { return reads().threads[target] || ''; }
export function threadUnread(target, msgs) {
  const ts = threadReadTs(target);
  return (msgs || []).filter((m) => m.author !== USER && (!ts || m.ts > ts)).length;
}
export function cardUnread(c) { return threadUnread('card:' + c.id, c.thread); }
export function lieutenantUnread(l) { return threadUnread('lieutenant:' + l.id, l.chat); }
// newest unread-relevant ts on a card: lieutenant thread messages + level-1
// events — the same inputs the server derives card unread from. Used as the
// read-marker dedupe key so each new unread-relevant item allows exactly one POST.
export function cardActivityTs(c) {
  let ts = '';
  for (const m of (c && c.thread) || []) if (m.author !== USER && m.ts > ts) ts = m.ts;
  for (const e of (c && c.events) || []) if (e.level === 1 && e.ts > ts) ts = e.ts;
  return ts;
}

// A card's last-real-activity timestamp, for display and column sort. The server
// derives `activity` (max of the card's real event/thread timestamps) so incidental
// writes — a status-lease refresh/decay, an attribute sync — never read as "now".
// Fall back to the mutable `updated` for any older cached doc without it.
export function cardRecency(c) { return (c && (c.activity || c.updated)) || ''; }

// ---------- status (card.status is the single source; no other status feed) ----------
export function cardStatus(c) {
  return (c && c.status) || { worker: { id: null, state: 'absent' }, owed: false, unread: false };
}
// owed on a target, as a tri-state: null (nothing owed), 'queued' (the message
// is durably in the lieutenant's inbox but NOT yet drained — unseen), or 'seen'
// (drained; the lieutenant is actively on the hook for a reply). Both are
// server-derived from the delivery queue — owed means the latest captain
// message is unACKED, regardless of who spoke last in the thread, so a message
// buried under an interleaved reply keeps showing until actually consumed.
// Cards carry status.owed/owedState; a lieutenant's main chat carries the
// equivalent chatOwed/chatQueued bits.
export function targetOwedState(target) {
  const lt = /^lieutenant:(.+)$/.exec(target || '');
  if (lt) {
    const l = lieutenant(lt[1]);
    if (!l) return null;
    let owed = l.chatOwed;
    if (owed === undefined) { // older server payload: fall back to the last-message rule
      const ch = l.chat || [];
      const last = ch[ch.length - 1];
      owed = !!(last && last.author === USER);
    }
    if (!owed) return null;
    return l.chatQueued ? 'queued' : 'seen';
  }
  const c = card((target || '').slice(5));
  const st = c && cardStatus(c);
  if (!st || !st.owed) return null;
  return st.owedState || 'seen'; // older server payload: owed only — assume seen
}
export function targetOwed(target) { return !!targetOwedState(target); }
// "may be stuck": owed with no lieutenant reply for longer than the stale
// threshold. Purely client-derived from thread timestamps; the periodic
// re-render refreshes it.
const OWED_STALE_MS = 180000;
function owedSinceTs(msgs) {
  let since = null;
  for (const m of msgs || []) {
    if (m.author === USER) { if (since == null) since = m.ts; }
    else since = null;
  }
  return since;
}
export function targetMsgs(target) {
  const lt = /^lieutenant:(.+)$/.exec(target || '');
  if (lt) return (lieutenant(lt[1]) || {}).chat || [];
  return (card((target || '').slice(5)) || {}).thread || [];
}
export function targetOwedStale(target) {
  if (!targetOwed(target)) return false;
  const since = owedSinceTs(targetMsgs(target));
  return !!since && Date.now() - new Date(since).getTime() >= OWED_STALE_MS;
}
export function owedTargets() {
  const out = [];
  for (const l of lieutenants()) if (targetOwed('lieutenant:' + l.id)) out.push('lieutenant:' + l.id);
  for (const c of cards()) if (cardStatus(c).owed) out.push('card:' + c.id);
  return out;
}

// ---------- kinds ----------
// The board doc carries the EFFECTIVE kinds map (server-merged: built-ins under
// registered entries): {<kind>: {emoji, level}}. Any event whose kind is in the
// map renders that emoji; absent/unknown kinds render with no emoji.
export function kinds() { return (S.doc && S.doc.kinds) || {}; }
export function kindEmoji(kind) {
  const k = kind && kinds()[kind];
  return k && k.emoji ? String(k.emoji) : '';
}

// the unified event stream: board-level events + every card's events, by seq
export function allEvents() {
  const out = [];
  for (const e of (S.doc && S.doc.events) || []) out.push(e);
  for (const c of cards()) for (const e of c.events || []) out.push(Object.assign({ card: c.id, cardTitle: c.title }, e));
  out.sort((a, b) => a.seq - b.seq);
  return out;
}
// the bell: level-1 events UNION lieutenant card-thread replies, newest first,
// with read flags. Mirrors the server's /api/notifications derivation: reply
// items carry ts/text/actor/card/cardTitle/read + kind "reply" (no seq — their
// read state is the thread read marker, so opening the card clears them).
// Lieutenant main-chat messages ride their own level-1 event, so those chats
// are excluded (no double count); level-2 never notifies.
export function notifItems() {
  const r = reads();
  const items = allEvents().filter((e) => e.level === 1)
    .map((e) => Object.assign({}, e, { read: e.seq <= r.notifSeq || r.notifSeqs.includes(e.seq) }));
  for (const c of cards()) {
    const readTs = threadReadTs('card:' + c.id);
    for (const m of c.thread || []) {
      if (m.author === USER) continue;
      items.push({ ts: m.ts, level: 1, kind: 'reply', text: m.text, actor: m.author,
        card: c.id, cardTitle: c.title, read: !!readTs && m.ts <= readTs });
    }
  }
  return items.sort((a, b) => (a.ts < b.ts ? 1 : a.ts > b.ts ? -1 : (b.seq || 0) - (a.seq || 0)));
}
export function notifUnreadCount() { return notifItems().filter((e) => !e.read).length; }

// ---------- filters ----------
export function filterSelected(kind, value) { return S.filters.sel.some((f) => f.kind === kind && f.value === value); }
export function toggleFilter(kind, value) {
  if (!value) return;
  const i = S.filters.sel.findIndex((f) => f.kind === kind && f.value === value);
  if (i >= 0) S.filters.sel.splice(i, 1); else S.filters.sel.push({ kind, value });
  render();
}
export function clearFilters() {
  S.filters = { text: '', age: '', sel: [], type: '', column: '', archived: false };
  render();
}
export function filtersActive() {
  return !!(S.filters.text || S.filters.age || S.filters.sel.length
    || S.filters.type || S.filters.column || S.filters.archived);
}
// what the filter button's badge counts: every active filter EXCEPT text
// (the text is already visible in the input itself)
export function activeFilterCount() {
  const f = S.filters;
  return f.sel.length + (f.age ? 1 : 0) + (f.type ? 1 : 0) + (f.column ? 1 : 0) + (f.archived ? 1 : 0);
}
function ageCutoff() {
  const v = S.filters.age;
  if (!v) return 0;
  if (v === 'today') { const d = new Date(); d.setHours(0, 0, 0, 0); return d.getTime(); }
  return Date.now() - parseInt(v, 10) * 1000;
}
function haystack(c) {
  const col = columns().find((k) => k.id === c.column);
  const at = c.attributes || {};
  return [c.title, c.id, c.body, c.type, c.owner, lieutenantName(c.owner), (c.labels || []).join(' '),
    Object.entries(at).map(([k, v]) => k + ' ' + v).join(' '),
    col ? col.title : c.column,
  ].filter(Boolean).join(' ').toLowerCase();
}
export function cardVisible(c) {
  if (!filtersActive()) return true;
  const q = S.filters.text.trim().toLowerCase();
  if (q && !haystack(c).includes(q)) return false;
  const cutoff = ageCutoff();
  if (cutoff) { const t = cardRecency(c); if (!t || new Date(t).getTime() < cutoff) return false; }
  if (S.filters.type && c.type !== S.filters.type) return false;
  if (S.filters.column && c.column !== S.filters.column) return false;
  for (const f of S.filters.sel) {
    if (f.kind === 'owner') { if ((c.owner || '') !== f.value) return false; }
    else if (!(c.labels || []).includes(f.value)) return false;
  }
  return true;
}
