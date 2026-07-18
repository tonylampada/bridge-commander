'use strict';
// md.js — vendored marked + DOMPurify wiring. Real DOMPurify only runs against
// a browser DOM, so this suite splits the claim in two: the fail-closed tests
// prove md() NEVER returns live HTML without a working sanitizer (with the real
// vendored purify — unsupported under Node — and with none at all), and the
// feature tests run the real vendored marked with a pass-through sanitizer stub
// that records what md() sends it and with which config (so the sanitize call
// itself, and its tag policy, are asserted on every render).
// md.js is an ES module (browser code); load it via dynamic import.
const test = require('node:test');
const assert = require('node:assert');
const path = require('node:path');
const { pathToFileURL } = require('node:url');

globalThis.marked = require(path.join(__dirname, '..', 'ui', 'vendor', 'marked.umd.js'));
const realPurify = require(path.join(__dirname, '..', 'ui', 'vendor', 'purify.min.js'));

const calls = []; // every {html, cfg} md() sent to the sanitizer
const stubPurify = {
  isSupported: true,
  sanitize: (html, cfg) => { calls.push({ html, cfg }); return html; },
  addHook: () => {},
};

const mdMod = import(pathToFileURL(path.join(__dirname, '..', 'ui', 'js', 'md.js')).href);
async function md(src) { return (await mdMod).md(src); }

// ---------- fail closed (run before the stub is installed) ----------

test('no DOMPurify at all: output is escaped text, never live HTML', async () => {
  delete globalThis.DOMPurify;
  const out = await md('# hi\n<script>alert(1)</script>');
  assert.ok(!out.includes('<script>'));
  assert.ok(out.includes('&lt;script&gt;'));
  assert.ok(!out.includes('<h1>')); // fail closed = no rendering at all
});

test('real vendored DOMPurify, unsupported environment: still fails closed', async () => {
  globalThis.DOMPurify = realPurify; // under Node: isSupported === false
  assert.strictEqual(realPurify.isSupported, false);
  const out = await md('<img src=x onerror=alert(1)>');
  assert.ok(!out.includes('<img'));
  assert.ok(out.includes('&lt;img'));
});

// ---------- rendering features (real marked, recording sanitizer stub) ----------

test('every render goes through the sanitizer, with the formatting-only policy', async () => {
  globalThis.DOMPurify = stubPurify;
  calls.length = 0;
  const out = await md('hello <script>x</script>');
  assert.strictEqual(calls.length, 1);
  assert.strictEqual(calls[0].html, out); // md returns exactly what sanitize returned
  assert.ok(calls[0].html.includes('<script>'), 'marked passes raw HTML through — the sanitizer is load-bearing');
  const cfg = calls[0].cfg;
  assert.deepStrictEqual(cfg.USE_PROFILES, { html: true }); // no author SVG/MathML
  for (const t of ['style', 'form', 'button']) assert.ok(cfg.FORBID_TAGS.includes(t));
});

test('ordered and nested lists render natively', async () => {
  const out = await md('1. one\n2. two\n   - nested\n   - deep');
  assert.ok(out.includes('<ol>'));
  assert.ok(out.includes('<ul>'));
  assert.ok(out.includes('<li>one'));
  assert.ok(out.includes('<li>nested</li>'));
});

test('single newline inside a paragraph renders as a <br> soft break', async () => {
  const out = await md('line one\nline two');
  assert.ok(out.includes('line one<br>line two'));
});

test('blank line still separates paragraphs', async () => {
  const out = await md('para one\n\npara two');
  assert.ok(out.includes('<p>para one</p>'));
  assert.ok(out.includes('<p>para two</p>'));
});

test('GFM extras: italic, strikethrough, blockquote, hr, h4, task list', async () => {
  assert.ok((await md('*it*')).includes('<em>it</em>'));
  assert.ok((await md('~~gone~~')).includes('<del>gone</del>'));
  assert.ok((await md('> quoted')).includes('<blockquote>'));
  assert.ok((await md('---')).includes('<hr>'));
  assert.ok((await md('#### deep')).includes('<h4>deep</h4>'));
  assert.ok((await md('- [x] done')).includes('type="checkbox"'));
});

test('pipe table renders thead/tbody', async () => {
  const out = await md('| a | b |\n|---|---|\n| 1 | 2 |');
  assert.ok(out.includes('<table>'));
  assert.ok(out.includes('<th>a</th>'));
  assert.ok(out.includes('<td>1</td>'));
});

test('fenced code carries its language class; content stays escaped', async () => {
  const out = await md('```js\nconst x = 1 < 2;\n```');
  assert.ok(out.includes('language-js'));
  assert.ok(out.includes('1 &lt; 2'));
});

test('mermaid fence stays an escaped code block, tagged for the enhancer', async () => {
  const out = await md('```mermaid\ngraph TD\nA-->B\n```');
  assert.ok(out.includes('language-mermaid'));
  assert.ok(out.includes('A--&gt;B')); // escaped source, no diagram markup server-side
  assert.ok(!out.includes('<svg'));
});

test('links render with href; images survive', async () => {
  const out = await md('[x](https://example.com) ![alt](https://example.com/i.png)');
  assert.ok(out.includes('<a href="https://example.com"'));
  assert.ok(out.includes('<img src="https://example.com/i.png"'));
});
