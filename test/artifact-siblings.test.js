'use strict';
// The directory serve: /artifacts/<dir>/<rel>. An HTML artifact rendered in the
// viewer needs a folder for its relative references to sit in — `?uri=…&raw=1`
// has none, so `./beep.wav` beside the page asked the board for /api/beep.wav.
// This route gives the page its own directory, scoped to it and nothing above.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const { startServerWithLieutenant, withOwner } = require('./helper');

const PNG = Buffer.from(
  '89504e470d0a1a0a0000000d49484452000000010000000108060000001f15c4890000000d4944415478' +
  '9c6200010000050001' + '0d0a2db400000000' + '49454e44ae426082',
  'hex'
);
const WAV = Buffer.concat([Buffer.from('RIFF....WAVEfmt '), Buffer.alloc(24), Buffer.from('data')]);

// A page + its two siblings in their own directory, promoted as a card artifact.
async function pageWithSiblings(s) {
  const dir = path.join(s.dir, 'demo');
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'index.html'),
    '<!doctype html><img src="./x.png"><audio src="./y.wav"></audio>');
  fs.writeFileSync(path.join(dir, 'x.png'), PNG);
  fs.writeFileSync(path.join(dir, 'y.wav'), WAV);
  const cr = await s.api('POST', '/api/cards', withOwner({ title: 'Deliverable' }));
  assert.strictEqual(cr.status, 200, JSON.stringify(cr.body));
  const add = await s.api('POST', '/api/cards/' + cr.body.card.id + '/artifacts',
    { uri: path.join(dir, 'index.html'), label: 'demo' });
  assert.strictEqual(add.status, 200, JSON.stringify(add.body));
  return { dir, base: s.base + '/artifacts/' + encodeURIComponent(dir) + '/' };
}

test('an HTML artifact loads the image and audio next to it by relative path', async () => {
  const s = await startServerWithLieutenant();
  try {
    const { base } = await pageWithSiblings(s);

    const page = await fetch(base + 'index.html');
    assert.strictEqual(page.status, 200);
    assert.strictEqual(page.headers.get('content-type'), 'text/html; charset=utf-8');
    // No sandbox: the board has no auth, hardening this page defends nothing.
    assert.strictEqual(page.headers.get('content-security-policy'), null);

    // What the browser actually asks for when it resolves ./x.png and ./y.wav
    // against the page's own URL — the whole point of the path-shaped route.
    const img = await fetch(new URL('./x.png', base));
    assert.strictEqual(img.status, 200);
    assert.strictEqual(img.headers.get('content-type'), 'image/png');
    assert.ok(Buffer.from(await img.arrayBuffer()).equals(PNG), 'served bytes match the file');

    const audio = await fetch(new URL('./y.wav', base));
    assert.strictEqual(audio.status, 200);
    assert.strictEqual(audio.headers.get('content-type'), 'audio/wav');
    assert.strictEqual(audio.headers.get('accept-ranges'), 'bytes'); // <audio> seeking
  } finally {
    await s.stop();
  }
});

test('the serve is scoped to the artifact directory — no escape, encoded or not', async () => {
  const s = await startServerWithLieutenant();
  try {
    const { dir, base } = await pageWithSiblings(s);
    const secret = path.join(s.dir, 'passwd');
    fs.writeFileSync(secret, 'root:x:0:0');

    for (const rel of ['%2e%2e%2fpasswd', '..%2Fpasswd', encodeURIComponent('../../etc/passwd'),
      encodeURIComponent(secret)]) {
      const res = await fetch(base + rel);
      assert.strictEqual(res.status, 403, rel + ' → ' + res.status);
      assert.doesNotMatch(await res.text(), /root:/, rel + ' leaked bytes');
    }

    // A directory that is not some listed artifact's own directory is not served.
    const other = s.base + '/artifacts/' + encodeURIComponent(path.dirname(dir)) + '/passwd';
    assert.strictEqual((await fetch(other)).status, 404);
    // Nor is a path that only looks absolute-ish.
    assert.strictEqual((await fetch(s.base + '/artifacts/' + encodeURIComponent(dir + '/..') + '/passwd')).status, 404);
  } finally {
    await s.stop();
  }
});
