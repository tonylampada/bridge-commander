'use strict';
// ui/js/composerpaste.js — a paste into the chat composer (MNC-280).
//
// Chrome drops a paste whose clipboard changed while it was being handled
// (ClipboardCommands::Paste, the sequence-number check): the paste event still
// sees the text, nothing is inserted. A dictation app that restores the
// clipboard right after its Cmd+V hits that every time it races. The fake
// browser below does exactly that, so the test fails with the browser left to
// insert, and passes only when the composer inserts the snapshot text itself.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const { pathToFileURL } = require('node:url');

const MOD = pathToFileURL(path.join(__dirname, '..', 'ui', 'js', 'composerpaste.js')).href;

function field(value = '') {
  const f = {
    value, selectionStart: value.length, selectionEnd: value.length, inputs: 0,
    setRangeText(text, start, end) {
      f.value = f.value.slice(0, start) + text + f.value.slice(end);
      f.selectionStart = f.selectionEnd = start + text.length;
    },
    dispatchEvent(e) { if (e.type === 'input') f.inputs++; return true; },
  };
  return f;
}

// document.execCommand('insertText') on the focused field, or a browser without it.
function doc(input, { exec = true } = {}) {
  return {
    calls: [],
    execCommand(cmd, ui, text) {
      this.calls.push([cmd, text]);
      if (!exec || cmd !== 'insertText') return false;
      input.setRangeText(text, input.selectionStart, input.selectionEnd);
      input.inputs++;
      return true;
    },
  };
}

function pasteEvent({ text = '', files = [] }) {
  return {
    defaultPrevented: false,
    preventDefault() { this.defaultPrevented = true; },
    clipboardData: {
      items: [...files.map((f) => ({ kind: 'file', getAsFile: () => f })), ...(text ? [{ kind: 'string' }] : [])],
      getData: (t) => (t === 'text/plain' ? text : ''),
    },
  };
}

// Chrome after the paste handlers: inserts only when the paste was not
// cancelled AND the clipboard did not move since the snapshot.
function browserFinishes(e, input, clipboardMoved) {
  if (e.defaultPrevented || clipboardMoved) return;
  input.setRangeText(e.clipboardData.getData('text/plain'), input.selectionStart, input.selectionEnd);
  input.inputs++;
}

test('text survives a clipboard that moves mid-paste (the Wispr race)', async () => {
  const { composerPaste } = await import(MOD);
  const input = field('already typed ');
  const d = doc(input);
  const e = pasteEvent({ text: 'dictated words' });
  assert.strictEqual(composerPaste(e, { input, doc: d, addFiles: () => assert.fail('no files') }), 'text');
  browserFinishes(e, input, true);
  assert.strictEqual(input.value, 'already typed dictated words');
  assert.strictEqual(input.inputs, 1);
  assert.ok(e.defaultPrevented, 'the browser must not insert it a second time');
  assert.deepStrictEqual(d.calls, [['insertText', 'dictated words']]);
});

test('without execCommand the text is spliced in at the caret and input fires', async () => {
  const { composerPaste } = await import(MOD);
  globalThis.Event ||= class { constructor(type) { this.type = type; } };
  const input = field('ab');
  input.selectionStart = input.selectionEnd = 1;
  const e = pasteEvent({ text: 'X' });
  composerPaste(e, { input, doc: doc(input, { exec: false }), addFiles: () => {} });
  browserFinishes(e, input, true);
  assert.strictEqual(input.value, 'aXb');
  assert.strictEqual(input.selectionStart, 2);
  assert.strictEqual(input.inputs, 1);
});

test('files still become attachments and are not inserted as text', async () => {
  const { composerPaste } = await import(MOD);
  const input = field('');
  const d = doc(input);
  const shot = { name: 'shot.png' };
  let added = null;
  const e = pasteEvent({ text: 'shot.png', files: [shot] });
  assert.strictEqual(composerPaste(e, { input, doc: d, addFiles: (f) => { added = f; } }), 'files');
  assert.deepStrictEqual(added, [shot]);
  assert.ok(e.defaultPrevented);
  assert.strictEqual(input.value, '');
  assert.deepStrictEqual(d.calls, []);
});

test('a paste with no text and no files is left to the browser', async () => {
  const { composerPaste } = await import(MOD);
  const input = field('');
  const e = pasteEvent({});
  assert.strictEqual(composerPaste(e, { input, doc: doc(input), addFiles: () => {} }), null);
  assert.ok(!e.defaultPrevented);
});

// chat.js binds DOM at import time, so its wiring is pinned at the source.
test('the composer routes its paste through composerPaste', () => {
  const src = fs.readFileSync(path.join(__dirname, '..', 'ui', 'js', 'chat.js'), 'utf8');
  assert.match(src, /import \{ composerPaste \} from '\.\/composerpaste\.js'/);
  assert.match(src, /inputEl\.addEventListener\('paste'[\s\S]{0,200}composerPaste\(e, \{ input: inputEl, doc: document, addFiles: addPendingFiles \}\)/);
});
