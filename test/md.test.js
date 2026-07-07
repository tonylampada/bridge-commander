'use strict';
// md.js renderer — pipe tables: valid table renders <table>, invalid falls back
// to paragraph text, cells run through inline markdown, HTML in cells stays escaped.
// md.js is an ES module (browser code); load it via dynamic import.
const test = require('node:test');
const assert = require('node:assert');
const path = require('node:path');
const { pathToFileURL } = require('node:url');

const mdMod = import(pathToFileURL(path.join(__dirname, '..', 'ui', 'js', 'md.js')).href);
async function md(src) { return (await mdMod).md(src); }

test('valid pipe table renders thead/tbody with trimmed cells', async () => {
  const out = await md('| a | b |\n|---|---|\n| 1 | 2 |\n| 3 | 4 |');
  assert.strictEqual(out,
    '<div class="tbl"><table><thead><tr><th>a</th><th>b</th></tr></thead>' +
    '<tbody><tr><td>1</td><td>2</td></tr><tr><td>3</td><td>4</td></tr></tbody></table></div>');
});

test('separator variants: alignment colons and spacing', async () => {
  const out = await md('| a | b |\n| :--- | ---: |\n| 1 | 2 |');
  assert.ok(out.includes('<table>'));
  assert.ok(out.includes('<th>a</th><th>b</th>'));
});

test('pipe lines without a separator row fall back to paragraph', async () => {
  const out = await md('| a | b |\n| 1 | 2 |');
  assert.ok(!out.includes('<table>'));
  assert.ok(out.startsWith('<p>'));
  assert.ok(out.includes('| a | b |'));
});

test('lone pipe line falls back to paragraph', async () => {
  const out = await md('| just | pipes |');
  assert.strictEqual(out, '<p>| just | pipes |</p>');
});

test('cells run through inline markdown', async () => {
  const out = await md('| name | note |\n|---|---|\n| **bold** | `code` |');
  assert.ok(out.includes('<td><strong>bold</strong></td>'));
  assert.ok(out.includes('<td><code>code</code></td>'));
});

test('HTML in cells stays escaped', async () => {
  const out = await md('| a |\n|---|\n| <script>x</script> |');
  assert.ok(!out.includes('<script>'));
  assert.ok(out.includes('&lt;script&gt;'));
});

test('table between paragraphs; text after the table starts a new paragraph', async () => {
  const out = await md('before\n\n| a |\n|---|\n| 1 |\n\nafter');
  assert.ok(out.includes('<p>before</p>'));
  assert.ok(out.includes('</table></div><p>after</p>'));
});

test('pipe lines inside a code fence stay verbatim', async () => {
  const out = await md('```\n| a | b |\n|---|---|\n```');
  assert.ok(!out.includes('<table>'));
  assert.ok(out.includes('| a | b |'));
});

test('single newline inside a paragraph renders as a <br> soft break', async () => {
  const out = await md('line one\nline two');
  assert.strictEqual(out, '<p>line one<br>line two</p>');
});

test('blank line still separates paragraphs (no <br> across the break)', async () => {
  const out = await md('para one\n\npara two');
  assert.strictEqual(out, '<p>para one</p><p>para two</p>');
});

test('soft-break lines run through inline markdown', async () => {
  const out = await md('**bold**\n`code`');
  assert.strictEqual(out, '<p><strong>bold</strong><br><code>code</code></p>');
});

test('newlines inside a code fence stay literal, never <br>', async () => {
  const out = await md('```\na\nb\n```');
  assert.ok(!out.includes('<br>'));
  assert.ok(out.includes('a\nb\n'));
});

test('headings and lists are unaffected by soft breaks', async () => {
  const out = await md('# Title\n- one\n- two');
  assert.strictEqual(out, '<h1>Title</h1><ul><li>one</li><li>two</li></ul>');
  assert.ok(!out.includes('<br>'));
});
