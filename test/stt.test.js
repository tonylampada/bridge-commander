'use strict';
// External STT: the whisper engine served from the board's own origin, so a
// page delivered over https (and a microphone, which needs a secure context)
// can reach it. /api/stt/<rest> is a dumb passthrough to <engine>/<rest>, and
// /api/stt/ws/<rest> is the same passthrough one layer down — the handshake and
// then raw bytes, in both directions, with nothing in between reading them.
const { test } = require('node:test');
const assert = require('node:assert');
const crypto = require('node:crypto');
const fs = require('node:fs');
const http = require('node:http');
const path = require('node:path');
const { startServer } = require('./helper');

function seedConfig(cfg) {
  return (dir) => {
    const sd = path.join(dir, '.bridge-commander');
    fs.mkdirSync(sd, { recursive: true });
    fs.writeFileSync(path.join(sd, 'config.json'), JSON.stringify(cfg));
  };
}

// A stand-in engine. `onUpgrade` is optional: only the websocket test needs one.
function startEngine(handler, onUpgrade) {
  return new Promise((resolve) => {
    const srv = http.createServer(handler || ((req, res) => res.end()));
    if (onUpgrade) srv.on('upgrade', onUpgrade);
    srv.listen(0, '127.0.0.1', () => resolve({
      url: 'http://127.0.0.1:' + srv.address().port,
      stop: () => new Promise((r) => srv.close(r)),
    }));
  });
}

// The handshake an engine owes a client, computed from the client's own key.
function accept(key) {
  return crypto.createHash('sha1').update(key + '258EAFA5-E914-47DA-95CA-C5AB0DC85B11').digest('base64');
}

test('no stt block: the proxy path is a plain 404 and /api/config is untouched', async () => {
  const s = await startServer({ seed: seedConfig({ voices: ['Luciana'] }) });
  try {
    assert.equal((await s.api('POST', '/api/stt/transcribe', {})).status, 404);
    assert.equal((await s.api('GET', '/api/stt')).status, 404);
    const cfg = await s.api('GET', '/api/config');
    assert.deepEqual(cfg.body, { voices: ['Luciana'] });   // no stt key: this is not a UI feature
  } finally { await s.stop(); }
});

// The UI gets a flag and nothing else: the engine's address stays the server's,
// and the browser posts to the board's own prefix. This is what puts the
// microphone on the chat composer (ui/js/mic.js).
test('stt configured: /api/config says stt, and never the engine address', async () => {
  const s = await startServer({ seed: seedConfig({ stt: { url: 'http://127.0.0.1:8878' } }) });
  try {
    const cfg = (await s.api('GET', '/api/config')).body;
    assert.equal(cfg.stt, true);
    assert.ok(!JSON.stringify(cfg).includes('8878'));
  } finally { await s.stop(); }
});

// Method, path, query, headers and body go up; status, headers and body come
// back. The proxy knows none of the names involved.
test('the passthrough relays the request up and the answer back, whole', async () => {
  let seen = null;
  const engine = await startEngine((req, res) => {
    let body = '';
    req.on('data', (c) => (body += c));
    req.on('end', () => {
      seen = { method: req.method, url: req.url, ctype: req.headers['content-type'], mark: req.headers['x-mark'], body };
      res.writeHead(418, { 'Content-Type': 'application/json', 'x-model': 'large-v3-turbo' });
      res.end('{"text":"olá capitão"}');
    });
  });
  const s = await startServer({ seed: seedConfig({ stt: { url: engine.url } }) });
  try {
    const r = await fetch(s.base + '/api/stt/transcribe?language=pt', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-mark': 'up' },
      body: '{"audio":"…"}',
    });
    assert.deepEqual(seen, {
      method: 'POST',
      url: '/transcribe?language=pt',
      ctype: 'application/json',
      mark: 'up',
      body: '{"audio":"…"}',
    });
    assert.equal(r.status, 418);                            // the engine's status, not ours
    assert.equal(r.headers.get('x-model'), 'large-v3-turbo');
    assert.equal(await r.text(), '{"text":"olá capitão"}');
  } finally { await s.stop(); await engine.stop(); }
});

// Any path, any method, and an engine error is an engine error.
test('an unknown path and a failing engine both pass straight through', async () => {
  const engine = await startEngine((req, res) => {
    res.writeHead(500, { 'Content-Type': 'text/plain' });
    res.end('boom ' + req.method + ' ' + req.url);
  });
  const s = await startServer({ seed: seedConfig({ stt: { url: engine.url } }) });
  try {
    const r = await fetch(s.base + '/api/stt/anything/at/all', { method: 'DELETE' });
    assert.equal(r.status, 500);
    assert.equal(await r.text(), 'boom DELETE /anything/at/all');
  } finally { await s.stop(); await engine.stop(); }
});

// The half ttsproxy.js has no equivalent of: the upgrade goes up, the 101 comes
// back, and then it is raw bytes each way — audio up, JSON down, neither of
// them anything the proxy looks at.
test('the websocket reaches the engine and carries bytes both ways', async () => {
  let seenPath = null;
  const engine = await startEngine(null, (req, sock) => {
    seenPath = req.url;
    sock.write('HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n'
      + 'Sec-WebSocket-Accept: ' + accept(req.headers['sec-websocket-key']) + '\r\n\r\n');
    sock.write('HELLO');                                    // the engine speaks first
    sock.on('data', (d) => sock.write('ECHO:' + d));        // ...and answers what it is sent
    sock.on('end', () => sock.destroy());                   // ...and lets go when the proxy does
  });
  const s = await startServer({ seed: seedConfig({ stt: { url: engine.url } }) });
  try {
    const key = crypto.randomBytes(16).toString('base64');
    const up = await new Promise((resolve, reject) => {
      const req = http.request({
        port: s.port, host: '127.0.0.1', path: '/api/stt/ws/transcribe?lang=pt',
        headers: { Connection: 'Upgrade', Upgrade: 'websocket', 'Sec-WebSocket-Key': key, 'Sec-WebSocket-Version': '13' },
      });
      req.on('upgrade', (res, socket, head) => resolve({ res, socket, head }));
      req.on('response', (res) => reject(new Error('no upgrade, HTTP ' + res.statusCode)));
      req.on('error', reject);
      req.end();
    });
    assert.equal(seenPath, '/ws/transcribe?lang=pt');        // prefix stripped, query kept
    assert.equal(up.res.statusCode, 101);
    // The accept hash is the ENGINE's, computed from the client's own key — the
    // browser checks it, so a proxy that invented one would be caught here.
    assert.equal(up.res.headers['sec-websocket-accept'], accept(key));

    const said = [];
    if (up.head && up.head.length) said.push(up.head.toString());
    const heard = new Promise((resolve) => {
      up.socket.on('data', (d) => {
        said.push(d.toString());
        if (said.join('').includes('ECHO:AUDIO')) resolve(said.join(''));
      });
      if (said.join('').includes('ECHO:AUDIO')) resolve(said.join(''));
    });
    up.socket.write('AUDIO');
    assert.equal(await heard, 'HELLOECHO:AUDIO');
    up.socket.destroy();
  } finally { await s.stop(); await engine.stop(); }
});

// No engine, no websocket: the upgrade is dropped rather than answered.
test('no stt block: an upgrade on the prefix is refused', async () => {
  const s = await startServer({ seed: seedConfig({}) });
  try {
    const outcome = await new Promise((resolve) => {
      const req = http.request({
        port: s.port, host: '127.0.0.1', path: '/api/stt/ws/transcribe',
        headers: { Connection: 'Upgrade', Upgrade: 'websocket', 'Sec-WebSocket-Key': crypto.randomBytes(16).toString('base64'), 'Sec-WebSocket-Version': '13' },
      });
      req.on('upgrade', () => resolve('upgraded'));
      req.on('response', (res) => resolve('http ' + res.statusCode));
      req.on('error', () => resolve('dropped'));
      req.end();
    });
    assert.equal(outcome, 'dropped');
  } finally { await s.stop(); }
});
