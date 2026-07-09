// notifypolicy.js — pure decision logic for toast+sound notifications.
// NO DOM, NO WebAudio, NO side effects at import: safe for node --test to import
// directly. Kept separate from state.js/sound.js/toast.js so the policy itself
// stays trivially unit-testable.
//
// The captain asked for 4 semantic buckets instead of one row per event kind
// (server/server.js's BUILTIN_KINDS is a couple dozen entries and growing —
// too many toggles to reason about). categorize() is the single place that
// maps a kind name to a bucket; everything downstream only ever deals with
// the 4 buckets.

const DONE_KINDS = new Set(['worker-done', 'landed', 'handoff', 'done']);
const CHAT_KINDS = new Set(['reply', 'question', 'message']);
const ERROR_KINDS = new Set(['needs-captain', 'needs-you', 'failed', 'blocked', 'worker-died', 'worker-stalled']);

// Maps a kind (+ level, currently unused but kept for symmetry with the old
// per-kind API and in case a future kind needs level to disambiguate) to one
// of the 4 semantic categories. Anything not explicitly listed — including
// level-2 chatter like created/moved/ordered/started/signal — falls into
// 'other', which is OFF by default: the captain said this bucket "não deve
// ser importante".
export function categorize(kind, level) {
  if (DONE_KINDS.has(kind)) return 'done';
  if (CHAT_KINDS.has(kind)) return 'chat';
  if (ERROR_KINDS.has(kind)) return 'error';
  return 'other';
}

// Out-of-box behavior per category.
export function defaultCategoryPolicy() {
  return {
    done: { toast: true, sound: 'chime' },
    chat: { toast: true, sound: 'ding' },
    error: { toast: true, sound: 'alert' },
    other: { toast: false, sound: 'none' },
  };
}

// Resolve a kind's effective policy: categorize it, then apply the saved
// per-category override on top of that category's default, honoring the
// master on/off switch.
export function policyFor(kind, level, settings) {
  if (!settings || settings.master === false) return { toast: false, sound: 'none' };
  const cat = categorize(kind, level);
  const base = defaultCategoryPolicy()[cat];
  const override = settings.categories && settings.categories[cat];
  if (!override) return base;
  return {
    toast: override.toast !== undefined ? override.toast : base.toast,
    sound: override.sound !== undefined ? override.sound : base.sound,
  };
}

// The unified event stream over a board doc: board-level events + every card's
// events, ascending by seq. Mirrors state.js's allEvents() but takes a plain
// `doc` argument so this module never depends on live UI state.
function docEvents(doc) {
  const out = [];
  for (const e of (doc && doc.events) || []) out.push(e);
  for (const c of (doc && doc.cards) || []) {
    for (const e of c.events || []) out.push(Object.assign({ card: c.id, cardTitle: c.title }, e));
  }
  out.sort((a, b) => a.seq - b.seq);
  return out;
}

// Returns the events in `doc` whose seq is not yet in `seenSet` (ascending),
// and mutates `seenSet` to include them. Pair with a `firstLoad` flag in the
// caller (not here) so the very first board never fires notifications.
export function selectNewEvents(seenSet, doc) {
  const out = [];
  for (const e of docEvents(doc)) {
    if (e.seq == null || seenSet.has(e.seq)) continue;
    seenSet.add(e.seq);
    out.push(e);
  }
  return out;
}

// The unified chat/thread stream over a board doc: lieutenant chat + every
// card's thread, ascending by ts. Mirrors voice.js's trackMessages walk, but
// as a plain-doc function so it can live here alongside selectNewEvents.
function docMessages(doc) {
  const out = [];
  for (const l of (doc && doc.lieutenants) || []) {
    for (const m of l.chat || []) out.push(Object.assign({ scope: 'lieutenant:' + l.id }, m));
  }
  for (const c of (doc && doc.cards) || []) {
    for (const m of c.thread || []) out.push(Object.assign({ scope: 'card:' + c.id, card: c.id, cardTitle: c.title }, m));
  }
  out.sort((a, b) => a.ts - b.ts);
  return out;
}

// Returns the chat/thread messages in `doc` not yet in `seenSet` (ascending
// by ts), and mutates `seenSet` to include them. Symmetric with
// selectNewEvents: a pure "what's new" diff that does NOT filter by author —
// the driver decides whether the captain's own messages should notify.
export function selectNewMessages(seenSet, doc) {
  const out = [];
  for (const m of docMessages(doc)) {
    const k = m.scope + '|' + m.ts + '|' + m.author + '|' + m.text;
    if (seenSet.has(k)) continue;
    seenSet.add(k);
    out.push({ scope: m.scope, author: m.author, text: m.text, ts: m.ts, card: m.card, cardTitle: m.cardTitle });
  }
  return out;
}

// True when a chat message for `scope` should NOT notify because the captain is
// already looking at that exact conversation. ctx: { focused, openTarget, chatVisible }.
export function shouldSuppressChat(scope, ctx) {
  return !!(ctx && ctx.focused && ctx.chatVisible && ctx.openTarget && ctx.openTarget === scope);
}
