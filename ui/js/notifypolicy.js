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
