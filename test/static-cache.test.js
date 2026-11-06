'use strict';
// What the board tells a browser to keep.
//
// Our own files: `no-cache` plus a content-hash ETag, so a copy is kept but
// checked before every use, and an unchanged file answers a bodiless 304. The
// validator is what makes no-cache safe: without one, a phone behind a CDN
// served the captain yesterday's JavaScript three times running — each time
// looking like a bug in whatever he was testing rather than a stale file.
// Vendored builds are forever: their version is in their path.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const { startServer } = require('./helper');

test('our own files are revalidated, never served stale: no-cache + ETag', async () => {
  const s = await startServer();
  try {
    for (const p of ['/ui/js/bridge3d/main.js', '/ui/js/main.js', '/']) {
      const r = await fetch(s.base + p);
      assert.strictEqual(r.status, 200, p);
      assert.strictEqual(r.headers.get('cache-control'), 'no-cache', p);
      assert.match(r.headers.get('etag') || '', /^"[\w-]+"$/, p + ' carries a strong validator');
    }
  } finally { await s.stop(); }
});

test('a matching ETag answers 304 with no body; a stale one gets the file', async () => {
  const s = await startServer();
  try {
    const first = await fetch(s.base + '/ui/js/state.js');
    const tag = first.headers.get('etag');
    const body = await first.text();
    assert.ok(body.length > 0);

    const same = await fetch(s.base + '/ui/js/state.js', { headers: { 'If-None-Match': tag } });
    assert.strictEqual(same.status, 304);
    assert.strictEqual(same.headers.get('etag'), tag);
    assert.strictEqual(same.headers.get('cache-control'), 'no-cache');
    assert.strictEqual(await same.text(), '', 'a 304 carries no body');

    // a compressing edge hands the tag back weakened, often in a list
    const weak = await fetch(s.base + '/ui/js/state.js', { headers: { 'If-None-Match': '"nope", W/' + tag } });
    assert.strictEqual(weak.status, 304);

    const stale = await fetch(s.base + '/ui/js/state.js', { headers: { 'If-None-Match': '"something-older"' } });
    assert.strictEqual(stale.status, 200);
    assert.strictEqual(await stale.text(), body);

    // the tag is the content's: another file, another tag
    const other = await fetch(s.base + '/ui/js/api.js');
    assert.notStrictEqual(other.headers.get('etag'), tag);
    // and the same bytes always hash the same — across requests, and to what the file holds
    const disk = fs.readFileSync(path.join(__dirname, '..', 'ui', 'js', 'state.js'), 'utf8');
    assert.strictEqual(body, disk);
  } finally { await s.stop(); }
});

test('a vendored build is kept for a year — its version is in its path', async () => {
  const s = await startServer();
  try {
    const r = await fetch(s.base + '/ui/vendor/three/three.module.min.js');
    assert.strictEqual(r.status, 200);
    const cc = r.headers.get('cache-control');
    assert.match(cc, /max-age=31536000/, 'four megabytes should not be refetched');
    assert.match(cc, /immutable/);
  } finally { await s.stop(); }
});

// There is deliberately no test for a file merely SPELLED like the vendor
// directory, which a sloppy includes('vendor') would cache for a year by
// accident: no file in the tree reaches that boundary, so a test for it would
// pass whatever the code said. The rule is written strictly at the source.
