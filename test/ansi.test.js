'use strict';
// ui/js/ansi.js — the zero-dep ANSI SGR → HTML converter behind the 👁 peek
// drawer. SGR (reset/bold/dim/16-color/256-color) becomes inline-styled spans;
// text is HTML-escaped FIRST; non-SGR escapes (cursor movement, OSC) are
// stripped. The module is ESM (it ships to the browser), hence dynamic import.
const test = require('node:test');
const assert = require('node:assert');
const path = require('node:path');
const { pathToFileURL } = require('node:url');

let ansiToHtml;
test.before(async () => {
  ({ ansiToHtml } = await import(pathToFileURL(path.join(__dirname, '..', 'ui', 'js', 'ansi.js')).href));
});

test('plain text passes through; HTML is escaped', () => {
  assert.strictEqual(ansiToHtml('hello world'), 'hello world');
  assert.strictEqual(ansiToHtml('<b> & "quotes" >'), '&lt;b&gt; &amp; "quotes" &gt;');
});

test('escaping happens before markup: a styled < never becomes a tag', () => {
  assert.strictEqual(ansiToHtml('\x1b[1m<x>\x1b[0m'),
    '<span style="font-weight:700">&lt;x&gt;</span>');
});

test('bold, dim, and their resets', () => {
  assert.strictEqual(ansiToHtml('\x1b[1mbold\x1b[0m plain'),
    '<span style="font-weight:700">bold</span> plain');
  assert.strictEqual(ansiToHtml('\x1b[2mdim\x1b[22mnorm'),
    '<span style="opacity:.55">dim</span>norm');
});

test('16-color fg/bg, normal and bright, with 39/49 defaults', () => {
  assert.strictEqual(ansiToHtml('\x1b[31mred\x1b[39m plain'),
    '<span style="color:#cd3131">red</span> plain');
  assert.strictEqual(ansiToHtml('\x1b[91mbright\x1b[0m'),
    '<span style="color:#f14c4c">bright</span>');
  assert.strictEqual(ansiToHtml('\x1b[42mbg\x1b[49m.'),
    '<span style="background:#0dbc79">bg</span>.');
});

test('256-color fg/bg: base, cube, grayscale (semicolon and colon forms)', () => {
  assert.strictEqual(ansiToHtml('\x1b[38;5;196mX\x1b[0m'),
    '<span style="color:#ff0000">X</span>'); // cube 196 = pure red
  assert.strictEqual(ansiToHtml('\x1b[48;5;28mX\x1b[0m'),
    '<span style="background:#008700">X</span>');
  assert.strictEqual(ansiToHtml('\x1b[38;5;244mgray\x1b[0m'),
    '<span style="color:#808080">gray</span>');
  assert.strictEqual(ansiToHtml('\x1b[38:5:196mX\x1b[0m'),
    '<span style="color:#ff0000">X</span>'); // tmux may emit colon subparams
});

test('truecolor fg (defensive: TUIs render 24-bit, capture keeps it)', () => {
  assert.strictEqual(ansiToHtml('\x1b[38;2;10;20;30mX\x1b[0m'),
    '<span style="color:#0a141e">X</span>');
});

test('combined attributes render as one span; reset splits runs', () => {
  assert.strictEqual(ansiToHtml('\x1b[1;31mhot\x1b[0mcold'),
    '<span style="color:#cd3131;font-weight:700">hot</span>cold');
});

test('cursor-movement and OSC sequences are stripped, not rendered', () => {
  assert.strictEqual(ansiToHtml('\x1b[2J\x1b[Hhello\x1b[3;7Hthere'), 'hellothere');
  assert.strictEqual(ansiToHtml('\x1b]0;window title\x07visible'), 'visible');
  assert.strictEqual(ansiToHtml('a\x1b[Kb'), 'ab'); // erase-line mid-text
});

test('multi-line frames keep their newlines (the <pre> relies on it)', () => {
  assert.strictEqual(ansiToHtml('line1\n\x1b[32mline2\x1b[0m\n'),
    'line1\n<span style="color:#0dbc79">line2</span>\n');
});

test('unknown SGR codes are ignored without derailing the parse', () => {
  assert.strictEqual(ansiToHtml('\x1b[4;53munderline-ish\x1b[0m'), 'underline-ish');
});
