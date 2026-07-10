'use strict';
// Unit tests for the pure parts of harness/tmux.js (no tmux server needed).
const test = require('node:test');
const assert = require('node:assert');
const { stripGhost, classifyComposerLine } = require('../tmux.js');

const ESC = '\x1b';

test('stripGhost passes plain text through', () => {
  assert.strictEqual(stripGhost('hello world'), 'hello world');
});

test('stripGhost drops dim (SGR 2) ghost text', () => {
  const line = `${ESC}[2mghost suggestion${ESC}[0m`;
  assert.strictEqual(stripGhost(line), '');
});

test('stripGhost keeps normal text around a dim run', () => {
  const line = `> ${ESC}[2mtry "fix the bug"${ESC}[22mreal`;
  assert.strictEqual(stripGhost(line), '> real');
});

test('stripGhost: reset-then-dim in one sequence reads as dim', () => {
  const line = `${ESC}[0;2mghost${ESC}[0mkeep`;
  assert.strictEqual(stripGhost(line), 'keep');
});

test('stripGhost: 256/RGB color payloads do not read as dim', () => {
  // 38;5;2 = fg palette color 2 — the "2" is a payload, not the dim code
  assert.strictEqual(stripGhost(`${ESC}[38;5;2mgreen${ESC}[0m`), 'green');
  // 38;2;10;20;30 = fg RGB — the "2" is the RGB mode selector
  assert.strictEqual(stripGhost(`${ESC}[38;2;10;20;30mrgb${ESC}[0m`), 'rgb');
  // colon form
  assert.strictEqual(stripGhost(`${ESC}[38:2:10:20:30mrgb${ESC}[0m`), 'rgb');
});

test('stripGhost strips non-SGR escape sequences', () => {
  assert.strictEqual(stripGhost(`${ESC}[2Ktext`), 'text'); // erase-line
  assert.strictEqual(stripGhost(`a${ESC}b`), 'ab'); // lone ESC dropped
});

test('stripGhost keeps multibyte glyphs intact', () => {
  assert.strictEqual(stripGhost('❯ café'), '❯ café');
  assert.strictEqual(stripGhost(`${ESC}[2m❯ ghost${ESC}[0m│real│`), '│real│');
});

test('classifyComposerLine: a cleared claude composer reads empty', () => {
  assert.strictEqual(classifyComposerLine('❯ '), 'empty');
  assert.strictEqual(classifyComposerLine('│ > │'), 'empty');
  assert.strictEqual(classifyComposerLine(`> ${ESC}[2mtry "fix the bug"${ESC}[0m`), 'empty');
  assert.strictEqual(classifyComposerLine('❯ real text'), 'pending');
});

test("classifyComposerLine: codex's '›' composer (U+203A) reads empty when cleared", () => {
  // The bare codex prompt glyph — a submit's positive ack. Without '›' in
  // PROMPT_GLYPHS this classified as pending and verified-submit saw every
  // codex send as stuck.
  assert.strictEqual(classifyComposerLine('› '), 'empty');
  // codex ghost text renders dim after the glyph
  assert.strictEqual(classifyComposerLine(`› ${ESC}[2mAsk Codex anything${ESC}[0m`), 'empty');
  // real unsubmitted text must still read pending
  assert.strictEqual(classifyComposerLine('› fix the flaky test'), 'pending');
});
