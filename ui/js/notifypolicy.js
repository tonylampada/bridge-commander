// notifypolicy.js — pure decision logic for toast+sound notifications.
// NO DOM, NO WebAudio, NO side effects at import: safe for node --test to import
// directly. Kept separate from state.js/sound.js/toast.js so the policy itself
// stays trivially unit-testable.

// Kinds that mean "the captain needs to act right now" get the loud alert tone,
// regardless of what the server's built-in kinds map calls them today — this
// list is deliberately name-based (not level-based) so it still applies if a
// lieutenant later registers a custom kind under one of these names.
const RED_KINDS = new Set(['failed', 'needs-you', 'needs-captain', 'blocked', 'worker-died']);
// Level-1 kinds about a worker going quiet/away get a duller double-tap instead
// of the bright chime used for ordinary good-news level-1 events.
const KNOCK_KINDS = new Set(['worker-stalled', 'worker-stopped']);

// Out-of-box behavior for a kind with no saved override.
export function defaultsFor(kind, level) {
  if (level === 2) return { toast: false, sound: 'none' };
  if (RED_KINDS.has(kind)) return { toast: true, sound: 'alert' };
  if (KNOCK_KINDS.has(kind)) return { toast: true, sound: 'knock' };
  return { toast: true, sound: 'chime' };
}

// Resolve a kind's effective policy: saved per-kind override on top of the
// level default, honoring the master on/off switch. A kind absent from
// settings.kinds falls through to its level default, so newly registered
// kinds behave sensibly with zero configuration.
export function policyFor(kind, level, settings) {
  if (!settings || settings.master === false) return { toast: false, sound: 'none' };
  const base = defaultsFor(kind, level);
  const override = settings.kinds && settings.kinds[kind];
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
