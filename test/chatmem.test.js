'use strict';
// ui/js/chatmem.js — the store/restore decision behind "reload lands where you
// left off": which chat gets written to localStorage, and which chat comes
// back on load. Pure, so it's imported directly (panekeys.test.js pattern);
// chat.js owns the localStorage calls and the DOM around them.
const test = require('node:test');
const assert = require('node:assert');
const path = require('node:path');
const { pathToFileURL } = require('node:url');

let CHAT_KEY, CLOSED, encodeChat, decodeChat;
test.before(async () => {
  ({ CHAT_KEY, CLOSED, encodeChat, decodeChat } =
    await import(pathToFileURL(path.join(__dirname, '..', 'ui', 'js', 'chatmem.js')).href));
});

test('the key is bc- prefixed like the other remembered board state', () => {
  assert.strictEqual(CHAT_KEY, 'bc-chat-open');
});

test('store: what was open, not just an id — both kinds round-trip', () => {
  assert.strictEqual(encodeChat({ mode: 'lieutenant', id: 'ada' }), 'lieutenant:ada');
  assert.strictEqual(encodeChat({ mode: 'card', id: 'ship-it' }), 'card:ship-it');
  // the kind survives, so a card and a lieutenant sharing an id never collide
  assert.deepStrictEqual(decodeChat('lieutenant:ada'), { mode: 'lieutenant', id: 'ada' });
  assert.deepStrictEqual(decodeChat('card:ada'), { mode: 'card', id: 'ada' });
  // ids are not sanitized on the way out — colons in an id survive the split
  assert.deepStrictEqual(decodeChat(encodeChat({ mode: 'card', id: 'a:b' })), { mode: 'card', id: 'a:b' });
});

test('nothing open, or junk: null — remove the key rather than store it', () => {
  assert.strictEqual(encodeChat(null), null);
  assert.strictEqual(encodeChat(undefined), null);
  assert.strictEqual(encodeChat({ mode: 'lieutenant' }), null, 'no id');
  assert.strictEqual(encodeChat({ mode: 'card', id: '' }), null);
  assert.strictEqual(encodeChat({ mode: 'notakind', id: 'x' }), null);
});

test('no memory: the board default stands, no error', () => {
  assert.strictEqual(decodeChat(null), null);
  assert.strictEqual(decodeChat(undefined), null);
  assert.strictEqual(decodeChat(''), null);
  assert.strictEqual(decodeChat('lieutenant:'), null, 'no id is not a chat');
  assert.strictEqual(decodeChat('{"mode":"card"}'), null, 'an older/other format is not an error');
});

test('closing the chat is remembered as closed, and reopens nothing', () => {
  assert.strictEqual(CLOSED, 'none');
  assert.strictEqual(decodeChat(CLOSED), 'closed');
  // …which is a different answer from "no memory at all" (first run): one lands
  // on the board, the other leaves the default alone
  assert.notStrictEqual(decodeChat(CLOSED), decodeChat(null));
});

test('a hash in the URL wins over the stored chat', () => {
  assert.strictEqual(decodeChat('lieutenant:ada', '#card/ship-it'), null);
  assert.strictEqual(decodeChat(CLOSED, '#card/ship-it'), null, 'a link opens even from closed');
  // a bare/empty hash is not a link — the memory still applies
  assert.deepStrictEqual(decodeChat('lieutenant:ada', ''), { mode: 'lieutenant', id: 'ada' });
  assert.deepStrictEqual(decodeChat('lieutenant:ada', '#'), { mode: 'lieutenant', id: 'ada' });
});
