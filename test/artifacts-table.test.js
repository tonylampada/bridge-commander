'use strict';
// The ARTIFACTS block on the card detail screen. It used to be a stack of flex
// rows that each sized themselves — labels never lined up, and a long filename
// truncated to an ellipsis the captain could not read. It is now a two-column
// table inside a horizontally scrolling wrapper: columns align down the list,
// long filenames stay whole and scroll into view.
// util.js is browser ES-module code but touches no DOM at import time, so the
// renderer can be imported and asserted on directly (detail.js cannot — it
// binds DOM elements at import). The overflow-x claim lives in app.css, so it
// is asserted against the stylesheet source.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const { pathToFileURL } = require('node:url');

const utilMod = import(pathToFileURL(path.join(__dirname, '..', 'ui', 'js', 'util.js')).href);
const css = fs.readFileSync(path.join(__dirname, '..', 'ui', 'app.css'), 'utf8');

const ARTS = [
  { uri: 'file:///w/validated-pr-pipeline-design.md', label: 'design' },
  { uri: '/w/pipeline-journal-sample.jsonl', label: 'journal' },
  { uri: 'https://github.com/tonylampada/bridge-commander/pull/32', label: 'pr' },
  { uri: '/w/a-really-quite-long-artifact-filename.png' },
  { uri: '/w/notes.md', label: 'notes' },
];

test('artifacts render as a table with one row per artifact', async () => {
  const { artifactsHtml } = await utilMod;
  const html = artifactsHtml(ARTS);
  assert.match(html, /<table[ >]/, 'artifacts are a table');
  const rows = html.match(/<tr>/g) || [];
  assert.strictEqual(rows.length, ARTS.length, 'one row per artifact');
  // two aligned columns per row: label cell, then the filename cell
  assert.strictEqual((html.match(/<td class="a-label">/g) || []).length, ARTS.length);
  assert.strictEqual((html.match(/class="a-uri"/g) || []).length, ARTS.length);
  // no label falls back to the basename
  assert.ok(html.includes('<td class="a-label">a-really-quite-long-artifact-filename.png</td>'));
});

test('the table sits in a scroll container that scrolls sideways', async () => {
  const { artifactsHtml } = await utilMod;
  const html = artifactsHtml(ARTS);
  const m = html.match(/<div class="([\w-]*arts-scroll[\w-]*)">\s*<table/);
  assert.ok(m, 'the table is wrapped in a scroll container: ' + html.slice(0, 200));
  const rule = css.match(new RegExp('\\.' + m[1] + '\\s*\\{[^}]*\\}'));
  assert.ok(rule, '.' + m[1] + ' is styled in app.css');
  assert.match(rule[0], /overflow-x:\s*auto/, 'the wrapper scrolls horizontally');
  // filenames must never be clipped again
  assert.doesNotMatch(css.match(/\.dt-artifacts \.a-uri\s*\{[^}]*\}/)[0], /text-overflow/);
});

test('behaviour kept: http links open in a new tab, everything else opens the viewer', async () => {
  const { artifactsHtml } = await utilMod;
  const html = artifactsHtml(ARTS);
  assert.match(html, /<a class="a-uri" href="https:\/\/github\.com[^"]*" target="_blank" rel="noopener"/);
  assert.match(html, /<code class="a-uri" data-view="\/w\/notes\.md"/);
  assert.strictEqual(artifactsHtml([]), '', 'no artifacts renders nothing');
  assert.match(html, /<div class="dt-arts-head">artifacts<\/div>/, 'the head is kept');
});

test('escaping is kept', async () => {
  const { artifactsHtml } = await utilMod;
  const html = artifactsHtml([{ uri: '/w/<img src=x>.md', label: '"><script>' }]);
  assert.doesNotMatch(html, /<script>|<img /);
  assert.match(html, /&lt;img src=x&gt;\.md/);
});
