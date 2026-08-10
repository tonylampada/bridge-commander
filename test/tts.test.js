'use strict';
// External TTS: the engine is served from the board's own origin. /api/config
// hands the browser the proxy prefix instead of the engine's address, and
// /api/tts/<rest> is a dumb passthrough to <engine>/<rest> — same method, same
// path, same headers, same status, same bytes, streamed both ways, and a client
// that hangs up hangs up on the engine.
const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const http = require('node:http');
const path = require('node:path');
const { startServer, sleep } = require('./helper');

// Seed <dir>/.bridge-commander/config.json before the server boots.
function seedConfig(cfg) {
  return (dir) => {
    const sd = path.join(dir, '.bridge-commander');
    fs.mkdirSync(sd, { recursive: true });
    fs.writeFileSync(path.join(sd, 'config.json'), JSON.stringify(cfg));
  };
}

// A stand-in engine: whatever the handler does is what the board must relay.
function startEngine(handler) {
  return new Promise((resolve) => {
    const srv = http.createServer(handler);
    srv.listen(0, '127.0.0.1', () => resolve({
      url: 'http://127.0.0.1:' + srv.address().port,
      stop: () => new Promise((r) => srv.close(r)),
    }));
  });
}

test('no tts in config: /api/config is unchanged', async () => {
  const s = await startServer({ seed: seedConfig({ voices: ['Luciana'] }) });
  try {
    const r = await s.api('GET', '/api/config');
    assert.equal(r.status, 200);
    assert.deepEqual(r.body, { voices: ['Luciana'] });
    assert.ok(!('tts' in r.body));
  } finally { await s.stop(); }
});

// The engine's address is the server's business now. The browser gets a path,
// which resolves against the origin the page came from — the whole point: an
// https page, or a phone off the tailnet, can reach it.
test('tts in config: the browser is handed the proxy prefix, defaults and all', async () => {
  const s = await startServer({
    seed: seedConfig({ tts: { url: 'http://127.0.0.1:8883/', lang: 'pt', voice: null, params: { speed: 1.2 } } }),
  });
  try {
    const r = await s.api('GET', '/api/config');
    assert.deepEqual(r.body.tts, {
      enabled: true,
      url: '/api/tts',                            // never the tailnet address
      lang: 'pt',
      voice: null,
      params: { speed: 1.2 },
    });
  } finally { await s.stop(); }
});

test('malformed tts config reads as not configured', async () => {
  for (const tts of [{ lang: 'pt' }, { url: '' }, 'nope', []]) {
    const s = await startServer({ seed: seedConfig({ tts }) });
    try {
      const r = await s.api('GET', '/api/config');
      assert.ok(!('tts' in r.body), 'tts=' + JSON.stringify(tts) + ' should be off');
    } finally { await s.stop(); }
  }
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
      res.writeHead(418, { 'Content-Type': 'audio/wav', 'x-sample-rate': '24000' });
      res.end('AUDIO');
    });
  });
  const s = await startServer({ seed: seedConfig({ tts: { url: engine.url, lang: 'pt' } }) });
  try {
    const r = await fetch(s.base + '/api/tts/v1/audio/speech?fast=1', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-mark': 'up' },
      body: JSON.stringify({ input: 'olá' }),
    });
    assert.deepEqual(seen, {
      method: 'POST',
      url: '/v1/audio/speech?fast=1',
      ctype: 'application/json',
      mark: 'up',
      body: '{"input":"olá"}',
    });
    assert.equal(r.status, 418);                       // the engine's status, not ours
    assert.equal(r.headers.get('content-type'), 'audio/wav');
    assert.equal(r.headers.get('x-sample-rate'), '24000');
    assert.equal(await r.text(), 'AUDIO');
  } finally { await s.stop(); await engine.stop(); }
});

// Any path, any method, and an engine error is an engine error — the proxy does
// not turn a 500 into something friendlier.
test('an unknown path and a failing engine both pass straight through', async () => {
  const engine = await startEngine((req, res) => {
    res.writeHead(500, { 'Content-Type': 'text/plain' });
    res.end('boom ' + req.method + ' ' + req.url);
  });
  const s = await startServer({ seed: seedConfig({ tts: { url: engine.url } }) });
  try {
    const r = await fetch(s.base + '/api/tts/anything/at/all', { method: 'DELETE' });
    assert.equal(r.status, 500);
    assert.equal(await r.text(), 'boom DELETE /anything/at/all');
  } finally { await s.stop(); await engine.stop(); }
});

// Sound has to start while synthesis is still running. If the proxy buffered,
// both chunks would land together at the end.
test('the response streams: the first chunk arrives before the second is written', async () => {
  const engine = await startEngine((req, res) => {
    res.writeHead(200, { 'Content-Type': 'audio/wav' });
    res.write('first');
    setTimeout(() => res.end('second'), 300);
  });
  const s = await startServer({ seed: seedConfig({ tts: { url: engine.url } }) });
  try {
    const r = await fetch(s.base + '/api/tts/v1/audio/speech', { method: 'POST', body: '{}' });
    const reader = r.body.getReader();
    const t0 = Date.now();
    const chunks = [];
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      chunks.push({ text: Buffer.from(value).toString(), at: Date.now() - t0 });
    }
    assert.ok(chunks.length >= 2, 'arrived in one lump: ' + JSON.stringify(chunks));
    assert.ok(chunks[0].at < 150, 'first chunk waited for the rest: ' + JSON.stringify(chunks));
    assert.equal(chunks.map((c) => c.text).join(''), 'firstsecond');
  } finally { await s.stop(); await engine.stop(); }
});

// The load-bearing one. speech.js aborts its fetch so the ENGINE stops
// synthesizing — an abandoned synthesis overlapping the next request takes
// voxcpm2's CUDA context down with it.
test('a client abort reaches the engine', async () => {
  let hangup = null;
  const seenHangup = new Promise((r) => (hangup = r));
  const engine = await startEngine((req, res) => {
    res.writeHead(200, { 'Content-Type': 'audio/wav' });
    res.write('first');
    const timer = setInterval(() => res.write('.'), 50); // synthesis, still going
    res.on('close', () => { clearInterval(timer); hangup(res.writableFinished); });
  });
  const s = await startServer({ seed: seedConfig({ tts: { url: engine.url } }) });
  try {
    const ac = new AbortController();
    const r = await fetch(s.base + '/api/tts/v1/audio/speech', { method: 'POST', body: '{}', signal: ac.signal });
    await r.body.getReader().read();          // sound is playing
    ac.abort();
    const finished = await Promise.race([seenHangup, sleep(3000).then(() => 'timeout')]);
    assert.equal(finished, false, 'the engine kept synthesizing after the client hung up');
  } finally { await s.stop(); await engine.stop(); }
});

// An engine that dies mid-response is a truncation, not a hang: the error lands
// on the upstream RESPONSE, not on the request, and the browser has to see it —
// a stuck fetch would leave the speech queue draining forever.
test('an engine that dies after the headers truncates the client, it does not hang it', async () => {
  const engine = await startEngine((req, res) => {
    res.writeHead(200, { 'Content-Type': 'audio/wav' });
    res.write('first');
    setTimeout(() => req.socket.destroy(), 100);        // synthesis dies mid-stream
  });
  const s = await startServer({ seed: seedConfig({ tts: { url: engine.url } }) });
  try {
    const r = await fetch(s.base + '/api/tts/v1/audio/speech', { method: 'POST', body: '{}' });
    const reader = r.body.getReader();
    assert.equal(Buffer.from((await reader.read()).value).toString(), 'first');
    const ended = reader.read().then(() => 'closed', () => 'errored');
    assert.notEqual(await Promise.race([ended, sleep(3000).then(() => 'hung')]), 'hung');
  } finally { await s.stop(); await engine.stop(); }
});

// The gap is between BYTES, never a cap on the whole request.
test('an engine that goes quiet past the gap is hung up on', async () => {
  const engine = await startEngine((req, res) => {
    res.writeHead(200, { 'Content-Type': 'audio/wav' });
    res.write('first');                                  // ...and then nothing, ever
  });
  const s = await startServer({
    seed: seedConfig({ tts: { url: engine.url } }),
    env: { BC_TTS_IDLE_MS: '400' },
  });
  try {
    const t0 = Date.now();
    const r = await fetch(s.base + '/api/tts/v1/audio/speech', { method: 'POST', body: '{}' });
    const reader = r.body.getReader();
    assert.equal(Buffer.from((await reader.read()).value).toString(), 'first');
    const ended = reader.read().then(() => 'closed', () => 'errored');
    assert.notEqual(await Promise.race([ended, sleep(5000).then(() => 'hung')]), 'hung');
    assert.ok(Date.now() - t0 >= 400, 'hung up before the gap had elapsed');
  } finally { await s.stop(); await engine.stop(); }
});

// The other half of the same rule: a slow engine that keeps trickling runs well
// past the gap and is left alone. A total-time cap would cut this one off.
test('an engine that keeps trickling past the gap is not cut off', async () => {
  const engine = await startEngine((req, res) => {
    res.writeHead(200, { 'Content-Type': 'audio/wav' });
    let n = 0;
    const timer = setInterval(() => {
      if (++n > 10) { clearInterval(timer); return res.end('done'); }
      res.write('.');                                    // every 150ms, for 1.5s
    }, 150);
    res.on('close', () => clearInterval(timer));
  });
  const s = await startServer({
    seed: seedConfig({ tts: { url: engine.url } }),
    env: { BC_TTS_IDLE_MS: '400' },
  });
  try {
    const t0 = Date.now();
    const r = await fetch(s.base + '/api/tts/v1/audio/speech', { method: 'POST', body: '{}' });
    assert.equal(await r.text(), '..........done');
    assert.ok(Date.now() - t0 > 400, 'the engine did not actually outlast the gap');
  } finally { await s.stop(); await engine.stop(); }
});

// No engine, no route: the board is exactly as silent as it is today.
test('no tts block: the proxy path is a plain 404', async () => {
  const s = await startServer({ seed: seedConfig({ voices: ['Luciana'] }) });
  try {
    assert.equal((await s.api('GET', '/api/tts/v1/voices')).status, 404);
    assert.equal((await s.api('POST', '/api/tts/v1/audio/speech', { input: 'olá' })).status, 404);
    assert.equal((await s.api('GET', '/api/tts')).status, 404);
  } finally { await s.stop(); }
});
