'use strict';
// ui/js/panekeys.js — the browser-keydown → pane-input mapping behind ⌨️ typing
// into the LIVE pane. Printable characters ride as literal text, the keys that
// only mean something to a terminal ride as tmux key NAMES, and anything the
// browser or the OS owns is left alone. The module is ESM (it ships to the
// browser), hence dynamic import — same shape as ansi.test.js.
const test = require('node:test');
const assert = require('node:assert');
const path = require('node:path');
const { pathToFileURL } = require('node:url');

let keyForEvent;
test.before(async () => {
  ({ keyForEvent } = await import(
    pathToFileURL(path.join(__dirname, '..', 'ui', 'js', 'panekeys.js')).href));
});

// A KeyboardEvent stand-in: only the fields the mapper reads.
function ev(key, mods = {}) {
  return { key, ctrlKey: !!mods.ctrl, shiftKey: !!mods.shift, altKey: !!mods.alt, metaKey: !!mods.meta };
}

test('printable characters ride as literal text', () => {
  assert.deepStrictEqual(keyForEvent(ev('a')), { text: 'a' });
  assert.deepStrictEqual(keyForEvent(ev('Z')), { text: 'Z' });
  assert.deepStrictEqual(keyForEvent(ev('7')), { text: '7' });
  assert.deepStrictEqual(keyForEvent(ev(' ')), { text: ' ' });
  assert.deepStrictEqual(keyForEvent(ev('/')), { text: '/' });
  assert.deepStrictEqual(keyForEvent(ev('é')), { text: 'é' }, 'non-US layouts are text, not a table');
  // Shift is already baked into e.key by the browser — never a modifier we send
  assert.deepStrictEqual(keyForEvent(ev('A', { shift: true })), { text: 'A' });
});

test('terminal keys map to their tmux names (BSpace/DC are not the DOM names)', () => {
  const cases = [
    ['Enter', 'Enter'], ['Backspace', 'BSpace'], ['Escape', 'Escape'],
    ['ArrowUp', 'Up'], ['ArrowDown', 'Down'], ['ArrowLeft', 'Left'], ['ArrowRight', 'Right'],
    ['Home', 'Home'], ['End', 'End'], ['PageUp', 'PageUp'], ['PageDown', 'PageDown'],
    ['Delete', 'DC'], ['Insert', 'IC'],
  ];
  for (const [dom, tmux] of cases) {
    assert.deepStrictEqual(keyForEvent(ev(dom)), { key: tmux }, dom);
  }
});

test('Tab and Shift-Tab are different tmux keys', () => {
  assert.deepStrictEqual(keyForEvent(ev('Tab')), { key: 'Tab' });
  assert.deepStrictEqual(keyForEvent(ev('Tab', { shift: true })), { key: 'BTab' });
});

test('Ctrl-<letter> combos, Ctrl-C above all', () => {
  assert.deepStrictEqual(keyForEvent(ev('c', { ctrl: true })), { key: 'C-c' });
  assert.deepStrictEqual(keyForEvent(ev('d', { ctrl: true })), { key: 'C-d' });
  assert.deepStrictEqual(keyForEvent(ev('a', { ctrl: true })), { key: 'C-a' });
  // the punctuation controls a shell actually uses
  assert.deepStrictEqual(keyForEvent(ev('\\', { ctrl: true })), { key: 'C-\\' });
  assert.deepStrictEqual(keyForEvent(ev('_', { ctrl: true })), { key: 'C-_' });
  // browsers report the uppercase letter when Shift rides along — still C-c
  assert.deepStrictEqual(keyForEvent(ev('C', { ctrl: true, shift: true })), { key: 'C-c' });
});

test('Ctrl-V is left to the browser so the paste path (bracketed, multi-line) wins', () => {
  assert.strictEqual(keyForEvent(ev('v', { ctrl: true })), null);
});

test('Alt/Meta chords and unmappable keys are never stolen', () => {
  assert.strictEqual(keyForEvent(ev('w', { meta: true })), null, '⌘W must still close the tab');
  assert.strictEqual(keyForEvent(ev('Tab', { alt: true })), null, 'Alt-Tab belongs to the OS');
  assert.strictEqual(keyForEvent(ev('F5')), null);
  assert.strictEqual(keyForEvent(ev('Shift', { shift: true })), null, 'a bare modifier sends nothing');
  assert.strictEqual(keyForEvent(ev('Control', { ctrl: true })), null);
  assert.strictEqual(keyForEvent(ev('F5', { ctrl: true })), null, 'Ctrl-<non-character> is not a combo');
  assert.strictEqual(keyForEvent(ev('AudioVolumeUp')), null);
});

test('every key name it emits is one tmux would accept as a key, never as a flag', () => {
  const KEY_RE = /^(C-|M-|S-)*[A-Za-z0-9]+$/; // the server-side guard, verbatim
  const keys = ['Enter', 'Backspace', 'Tab', 'Escape', 'ArrowUp', 'ArrowDown', 'ArrowLeft',
    'ArrowRight', 'Home', 'End', 'PageUp', 'PageDown', 'Delete', 'Insert'];
  for (const k of keys) {
    const out = keyForEvent(ev(k));
    assert.match(out.key, KEY_RE, k);
  }
  assert.match(keyForEvent(ev('Tab', { shift: true })).key, KEY_RE);
  for (const c of 'abcdefghijklmnopqrstuwxyz') { // v is excluded on purpose
    assert.match(keyForEvent(ev(c, { ctrl: true })).key, KEY_RE, 'C-' + c);
  }
});
