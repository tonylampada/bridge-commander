'use strict';
// Lieutenant page: lieutenants/<id>/page/ served static at /lt/<id>/, and its
// newest mtime on the lieutenants payload.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const { startServerWithLieutenant } = require('./helper');

function writePage(dir, rel, body) {
  const f = path.join(dir, 'lieutenants', 'ada', 'page', rel);
  fs.mkdirSync(path.dirname(f), { recursive: true });
  fs.writeFileSync(f, body);
  return f;
}
const get = (s, p) => fetch(s.base + p, { redirect: 'manual' });

test('serves index, sibling assets and subfolders, never cached', async () => {
  const s = await startServerWithLieutenant();
  try {
    writePage(s.dir, 'index.html', '<h1>ada</h1>');
    writePage(s.dir, 'style.css', 'h1{}');
    writePage(s.dir, 'img/x.svg', '<svg/>');
    let r = await get(s, '/lt/ada/');
    assert.strictEqual(r.status, 200);
    assert.match(r.headers.get('content-type'), /text\/html/);
    assert.strictEqual(r.headers.get('cache-control'), 'no-store');
    assert.strictEqual(await r.text(), '<h1>ada</h1>');
    r = await get(s, '/lt/ada/style.css');
    assert.match(r.headers.get('content-type'), /text\/css/);
    assert.strictEqual(await r.text(), 'h1{}');
    r = await get(s, '/lt/ada/img/x.svg');
    assert.strictEqual(r.status, 200);
    assert.match(r.headers.get('content-type'), /svg/);
    // no trailing slash: redirect so relative links resolve under the page
    r = await get(s, '/lt/ada');
    assert.strictEqual(r.status, 301);
    assert.strictEqual(r.headers.get('location'), '/lt/ada/');
  } finally { await s.stop(); }
});

test('404: unknown lieutenant, no page, missing asset', async () => {
  const s = await startServerWithLieutenant();
  try {
    assert.strictEqual((await get(s, '/lt/ada/')).status, 404, 'no page yet');
    writePage(s.dir, 'index.html', 'hi');
    assert.strictEqual((await get(s, '/lt/ada/nope.css')).status, 404);
    // a folder on disk for someone the board does not know is not served
    fs.mkdirSync(path.join(s.dir, 'lieutenants', 'ghost', 'page'), { recursive: true });
    fs.writeFileSync(path.join(s.dir, 'lieutenants', 'ghost', 'page', 'index.html'), 'boo');
    assert.strictEqual((await get(s, '/lt/ghost/')).status, 404);
  } finally { await s.stop(); }
});

test('traversal: nothing outside page/ is reachable', async () => {
  const s = await startServerWithLieutenant();
  try {
    writePage(s.dir, 'index.html', 'hi');
    fs.writeFileSync(path.join(s.dir, 'lieutenants', 'ada', 'README.md'), 'charter');
    // encoded so fetch() does not normalize the dots away before sending
    for (const p of ['/lt/ada/..%2FREADME.md', '/lt/ada/%2E%2E/README.md', '/lt/ada/..%2F..%2F.bridge-commander%2Fboard.json',
      '/lt/ada/%2Fetc%2Fpasswd', '/lt/ada/x%00.html', '/lt/ada/%E0%A4%A']) {
      const r = await get(s, p);
      assert.strictEqual(r.status, 404, p);
    }
    // a symlink inside page/ that points out is out
    fs.symlinkSync(path.join(s.dir, 'lieutenants', 'ada', 'README.md'),
      path.join(s.dir, 'lieutenants', 'ada', 'page', 'leak.md'));
    assert.strictEqual((await get(s, '/lt/ada/leak.md')).status, 404);
  } finally { await s.stop(); }
});

test('page.updated on the lieutenants payload: null without a page, newest mtime with one', async () => {
  const s = await startServerWithLieutenant();
  try {
    let lt = (await s.api('GET', '/api/lieutenants')).body.lieutenants[0];
    assert.strictEqual(lt.page, null);
    const idx = writePage(s.dir, 'index.html', 'hi');
    const css = writePage(s.dir, 'a/b.css', 'x');
    const old = new Date('2026-01-01T00:00:00Z'), newer = new Date('2026-02-03T04:05:06Z');
    for (const p of [idx, path.dirname(idx), path.dirname(css)]) fs.utimesSync(p, old, old);
    fs.utimesSync(css, newer, newer);
    lt = (await s.api('GET', '/api/lieutenants')).body.lieutenants[0];
    assert.deepStrictEqual(lt.page, { updated: newer.toISOString() });
    const b = (await s.api('GET', '/api/board')).body;
    assert.deepStrictEqual(b.lieutenants[0].page, { updated: newer.toISOString() });
  } finally { await s.stop(); }
});

test('/lt/_bc.js helper is served', async () => {
  const s = await startServerWithLieutenant();
  try {
    const r = await get(s, '/lt/_bc.js');
    assert.strictEqual(r.status, 200);
    assert.match(await r.text(), /window\.bc = /);
  } finally { await s.stop(); }
});
