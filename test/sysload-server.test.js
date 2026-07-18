'use strict';
// /api/sysload/stream — the on-demand monitoring endpoint: samples flow over a
// dedicated SSE while subscribed; the sampler refcount (visible on /api/status
// as `sysload`) starts at the first subscriber and stops dead at zero.
const { test } = require('node:test');
const assert = require('node:assert');
const { startServer, sleep } = require('./helper');

// Open the stream and read SSE `sample` events until n arrived (or timeout),
// then cancel the connection (dropping the server-side subscription).
async function readSamples(base, n, timeoutMs = 5000) {
  const ctrl = new AbortController();
  const res = await fetch(base + '/api/sysload/stream', { signal: ctrl.signal });
  assert.equal(res.status, 200);
  assert.match(res.headers.get('content-type'), /text\/event-stream/);
  const reader = res.body.getReader();
  const dec = new TextDecoder();
  const deadline = Date.now() + timeoutMs;
  let buf = '';
  const samples = [];
  while (samples.length < n && Date.now() < deadline) {
    const { value, done } = await reader.read();
    if (done) break;
    buf += dec.decode(value, { stream: true });
    for (;;) {
      const end = buf.indexOf('\n\n');
      if (end === -1) break;
      const frame = buf.slice(0, end);
      buf = buf.slice(end + 2);
      if (!/^event: sample$/m.test(frame)) continue;
      const data = (/^data: (.*)$/m.exec(frame) || [])[1];
      if (data) samples.push(JSON.parse(data));
    }
  }
  ctrl.abort();
  return samples;
}

test('sysload stream serves samples while subscribed; refcount starts/stops the sampler', async () => {
  const s = await startServer({ env: { BC_SYSLOAD_MS: '50' } });
  try {
    // closed panel = zero cost: no subscribers, not sampling
    let st = (await s.api('GET', '/api/status')).body;
    assert.deepEqual(st.sysload, { subscribers: 0, sampling: false });

    // subscribe → samples flow, and the probe flips on
    const streaming = readSamples(s.base, 2);
    // poll the probe while the stream is open
    let on = null;
    for (let i = 0; i < 50 && !(on && on.subscribers === 1); i++) {
      on = (await s.api('GET', '/api/status')).body.sysload;
      await sleep(20);
    }
    assert.equal(on.subscribers, 1);
    assert.equal(on.sampling, true);

    const samples = await streaming;
    assert.ok(samples.length >= 2, 'got ' + samples.length + ' samples');
    const sm = samples[0];
    // shape: machine numbers present (real /proc on Linux; graceful zeros
    // elsewhere), no live agents on a fresh board, containers count or null
    assert.equal(typeof sm.ts, 'string');
    assert.equal(typeof sm.machine.cpuPct, 'number');
    assert.equal(typeof sm.machine.memTotalBytes, 'number');
    assert.equal(typeof sm.machine.diskTotalBytes, 'number');
    assert.deepEqual(sm.entities, []);
    assert.ok(sm.containers === null || typeof sm.containers === 'number');

    // last subscriber gone → the sampler stops (allow the close to propagate)
    let off = null;
    for (let i = 0; i < 100 && !(off && off.subscribers === 0); i++) {
      off = (await s.api('GET', '/api/status')).body.sysload;
      await sleep(20);
    }
    assert.deepEqual(off, { subscribers: 0, sampling: false });
  } finally {
    await s.stop();
  }
});

test('two subscribers: one sampler; dropping one keeps it, dropping both stops it', async () => {
  const s = await startServer({ env: { BC_SYSLOAD_MS: '50' } });
  try {
    const a = new AbortController();
    const b = new AbortController();
    const ra = await fetch(s.base + '/api/sysload/stream', { signal: a.signal });
    const rb = await fetch(s.base + '/api/sysload/stream', { signal: b.signal });
    ra.body.getReader(); rb.body.getReader(); // hold the connections open
    let st = null;
    for (let i = 0; i < 50 && !(st && st.subscribers === 2); i++) {
      st = (await s.api('GET', '/api/status')).body.sysload;
      await sleep(20);
    }
    assert.equal(st.subscribers, 2);
    assert.equal(st.sampling, true);

    a.abort();
    for (let i = 0; i < 100 && !(st && st.subscribers === 1); i++) {
      st = (await s.api('GET', '/api/status')).body.sysload;
      await sleep(20);
    }
    assert.equal(st.subscribers, 1);
    assert.equal(st.sampling, true); // one viewer left — still sampling

    b.abort();
    for (let i = 0; i < 100 && !(st && st.subscribers === 0); i++) {
      st = (await s.api('GET', '/api/status')).body.sysload;
      await sleep(20);
    }
    assert.deepEqual(st, { subscribers: 0, sampling: false });
  } finally {
    await s.stop();
  }
});
