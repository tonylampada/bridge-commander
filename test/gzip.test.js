'use strict';
// JSON replies past ~1 KB go out gzipped when the client says it takes gzip:
// the full board is megabytes of JSON, and a phone pays for every one of them.
// Raw http.get here, because fetch() would ask for gzip and undo it unseen.
const { test } = require('node:test');
const assert = require('node:assert');
const http = require('node:http');
const zlib = require('node:zlib');
const { startServer } = require('./helper');

function rawGet(base, p, headers) {
  return new Promise((resolve, reject) => {
    http.get(base + p, { headers: headers || {} }, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body: Buffer.concat(chunks) }));
      res.on('error', reject);
    }).on('error', reject);
  });
}

test('/api/board: gzip when asked, plain otherwise, same JSON either way', async () => {
  const s = await startServer();
  try {
    // make the board comfortably past the threshold
    await s.api('POST', '/api/cards', { title: 'gzip probe', description: 'x'.repeat(4000) });

    const plain = await rawGet(s.base, '/api/board');
    assert.equal(plain.status, 200);
    assert.equal(plain.headers['content-encoding'], undefined);
    assert.equal(plain.headers.vary, 'Accept-Encoding');
    assert.equal(Number(plain.headers['content-length']), plain.body.length);
    assert.ok(plain.body.length > 1024);

    const gz = await rawGet(s.base, '/api/board', { 'Accept-Encoding': 'gzip, deflate, br' });
    assert.equal(gz.status, 200);
    assert.equal(gz.headers['content-encoding'], 'gzip');
    assert.equal(gz.headers.vary, 'Accept-Encoding');
    assert.match(gz.headers['content-type'], /application\/json/);
    assert.equal(Number(gz.headers['content-length']), gz.body.length);
    assert.ok(gz.body.length < plain.body.length, 'gzip is smaller');
    assert.deepEqual(JSON.parse(zlib.gunzipSync(gz.body)), JSON.parse(plain.body));

    // gzip;q=0 is a refusal
    const refused = await rawGet(s.base, '/api/board', { 'Accept-Encoding': 'gzip;q=0, br' });
    assert.equal(refused.headers['content-encoding'], undefined);
    JSON.parse(refused.body);
  } finally {
    await s.stop();
  }
});

test('small JSON replies stay plain even when gzip is accepted', async () => {
  const s = await startServer();
  try {
    const r = await rawGet(s.base, '/api/no-such-route', { 'Accept-Encoding': 'gzip' });
    assert.equal(r.status, 404);
    assert.equal(r.headers['content-encoding'], undefined);
    assert.equal(r.headers.vary, undefined);
    assert.deepEqual(JSON.parse(r.body), { error: 'not found' });
  } finally {
    await s.stop();
  }
});

test('/api/events stays uncompressed with gzip accepted', async () => {
  const s = await startServer();
  try {
    const r = await new Promise((resolve, reject) => {
      const req = http.get(s.base + '/api/events', { headers: { 'Accept-Encoding': 'gzip' } }, (res) => {
        res.once('data', (c) => { resolve({ headers: res.headers, first: String(c) }); req.destroy(); });
      });
      req.on('error', (e) => { if (e.code !== 'ECONNRESET') reject(e); });
    });
    assert.notEqual(r.headers['content-encoding'], 'gzip');
    assert.ok(r.first.startsWith(':ok'), 'plain text on the wire');
  } finally {
    await s.stop();
  }
});
