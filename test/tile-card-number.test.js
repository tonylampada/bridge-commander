'use strict';
// The card number is back on the kanban tile — the number ALONE, never the
// prefix, because the owner's color already says whose card it is. util.js is
// browser ES-module code that touches no DOM at import, so the renderer runs
// directly; board.js and table.js bind DOM at import, so where the element goes
// (tile yes, table no) is pinned at the source level, same as av-dispatch.test.js.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const { pathToFileURL } = require('node:url');

const ui = (...p) => path.join(__dirname, '..', 'ui', ...p);
const utilMod = import(pathToFileURL(ui('js', 'util.js')).href);
const boardSrc = fs.readFileSync(ui('js', 'board.js'), 'utf8');
const tableSrc = fs.readFileSync(ui('js', 'table.js'), 'utf8');
const css = fs.readFileSync(ui('app.css'), 'utf8');

test('the tile carries the number and not the prefix', async () => {
  const { cardNumHtml } = await utilMod;
  const html = cardNumHtml('MNC-62');
  assert.match(html, /62/, 'the number is on the tile');
  assert.ok(!html.includes('MNC-'), 'the prefix is not');
  assert.strictEqual(cardNumHtml('MNC-62'), '<span class="t-num">62</span>');
});

test('an id with no trailing number gets no element at all', async () => {
  const { cardNumHtml } = await utilMod;
  // archived cards really are shaped like this — a guess would be worse than nothing
  for (const id of ['pipeline-test-b6', 'bc-unblock-server', 'MNC', '', undefined]) {
    assert.strictEqual(cardNumHtml(id), '', String(id) + ': no number element, not an empty one');
  }
});

test('the number is drawn on the tile and nowhere else', () => {
  assert.match(boardSrc, /cardNumHtml\(c\.id\) \+ cornerInd/, 'tileHtml draws it beside the title');
  assert.ok(!tableSrc.includes('cardNumHtml'), 'the table is untouched');
  assert.match(tableSrc, /'<tr data-id="' \+ esc\(c\.id\)/, 'and its row still carries the full id, un-stripped');
});

test('the number is dim, monospace and never wraps', () => {
  const rule = /\.tile \.t-num \{([^}]*)\}/.exec(css);
  assert.ok(rule, '.t-num is styled');
  assert.match(rule[1], /font-family: var\(--mono\)/);
  assert.match(rule[1], /color: var\(--faint\)/);
  assert.match(rule[1], /white-space: nowrap/);
});
