// panekeys.js — browser keydown → what the pane input route should carry.
// Its own module (not part of pane.js) for the same reason ansi.js is: pane.js
// grabs DOM nodes at import time, this is pure, and pure is what a unit test
// can import.
//
// Two shapes come back, matching the route's payload exactly:
//   { key: '<tmux key name>' }  — Enter, BSpace, Up, BTab, C-c, …
//   { text: '<literal>' }       — one printable character, typed as-is
// null means "not ours": the browser keeps the event, nothing is preventDefaulted.

// The named keys worth having in a terminal. tmux spells several of them
// differently from the DOM (BSpace, DC), which is the whole point of the table.
export const NAMED = {
  Enter: 'Enter',
  Backspace: 'BSpace',
  Tab: 'Tab',
  Escape: 'Escape',
  ArrowUp: 'Up',
  ArrowDown: 'Down',
  ArrowLeft: 'Left',
  ArrowRight: 'Right',
  Home: 'Home',
  End: 'End',
  PageUp: 'PageUp',
  PageDown: 'PageDown',
  Delete: 'DC',
  Insert: 'IC',
};

// Ctrl-<x> combos tmux understands: the letters plus the five punctuation
// controls (C-[ is Escape, C-\ quits, C-_ undoes). A plain string, and exported
// with NAMED, because the test iterates exactly this to check every name we emit
// against the server's KEY_RE — a set it cannot read is a set it cannot pin.
export const CTRL_KEYS = 'abcdefghijklmnopqrstuvwxyz[\\]^_';

export function keyForEvent(e) {
  // Alt/Meta chords belong to the browser and the OS (⌘W, Alt-Tab). Never steal
  // them — a swallowed ⌘W is a far worse surprise than an unsupported M-b.
  if (e.altKey || e.metaKey) return null;

  // Shift-Tab before the table: same e.key, different tmux name.
  if (e.key === 'Tab') return { key: e.shiftKey ? 'BTab' : 'Tab' };

  const named = NAMED[e.key];
  if (named) return { key: named };

  if (e.ctrlKey) {
    if (e.key.length !== 1) return null; // Ctrl alone, Ctrl-Shift, Ctrl-F5, …
    const c = e.key.toLowerCase();
    // Ctrl-V is left to the browser ON PURPOSE: preventDefaulting it would kill
    // the `paste` event, and the paste path (bracketed, multi-line) is strictly
    // better than sending a bare C-v. Ctrl-C is NOT excluded — interrupting a
    // runaway agent is the headline reason this pane became typeable at all.
    if (c === 'v') return null;
    return CTRL_KEYS.includes(c) ? { key: 'C-' + c } : null;
  }

  // Any single printable character (letters, digits, punctuation, space, and
  // whatever an IME or a non-US layout produced) rides as literal text — no
  // per-character table can keep up with real keyboards.
  if (e.key.length === 1) return { text: e.key };

  return null; // F-keys, bare modifiers, dead keys, media keys
}
