// keepalive.js — what the audio keep-alive should be doing, and when.
//
// The captain talks to the board from a locked phone through a Siri Shortcut.
// The Shortcut takes the audio session; what it hands back is an AudioContext
// that reads 'running' and never produces another sample, and the only repair
// iOS accepts is a user gesture — which a locked screen cannot give. The one
// session that survives is the one that was PLAYING when the Shortcut arrived:
// he heard the next reply exactly once, by sending while the previous one was
// still speaking.
//
// So the cure is to never be idle. This module holds only the decision — no
// DOM, no WebAudio — the way notifypolicy.js holds the notification decision:
// speech.js owns the element the tone leaves through (hold()), sound.js owns
// the corpse watch (setCorpseWatch()), and keepalivesettings.js is the switch
// that drives both from here.
//
// It is a switch and not a heuristic on purpose. Holding a session open costs
// battery and puts a player on the lock screen for as long as it runs, and a
// desktop tab — which no Shortcut ever interrupts — has no reason to pay it.

// The three states the keep-alive can be in:
//   'off'   nothing playing, nothing beating: the page behaves as it always has
//   'hold'  the inaudible tone is playing, and the session is his to keep
//   'yield' there is real speech; the keep-alive is silent and out of its way
//
// `hidden` is an argument and changes NOTHING, deliberately: a hidden page is
// precisely the case this exists for (screen off, phone in a pocket), so
// standing down when the page goes away would stand down at the only moment
// that matters. It is named here so that stays a decision rather than an
// oversight.
export function keepAliveState({ enabled, speaking, hidden } = {}) {
  if (!enabled) return 'off';
  if (speaking) return 'yield';
  return 'hold';
}

// The same switch gates the corpse watch in sound.js — the heartbeat that asks
// every 500ms whether the notification context's clock is still moving. It was
// written for this phone and this Shortcut, and its own comment says so: on a
// page that is nearly always fine it is a timer beating for the life of the
// page, and on a phone it is battery. Off means neither this nor the tone runs.
export function corpseWatchRuns(enabled) {
  return enabled === true;
}

// Persisted the way voice.js persists its toggle: the key is present or it is
// not. Anything else that ever ends up in that slot is off — the safe answer,
// since off is what every page that never asked for this gets.
export function enabledFromStorage(raw) {
  return raw === '1';
}
