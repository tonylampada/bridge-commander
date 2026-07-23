'use strict';
// SSE staleness recovery (papercut #9): the board payload carries a `boot` id
// naming the server instance, so a client can detect a restart (and refetch)
// even when EventSource auto-retry reconnects too fast for onerror to matter.
const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { startServer, freePort } = require('./helper');

// Read the first SSE event from /api/events (the server pushes the full board
// on connect) and return { event, data }.
async function firstSseEvent(base) {
  const res = await fetch(base + '/api/events');
  assert.equal(res.status, 200);
  assert.match(res.headers.get('content-type'), /text\/event-stream/);
  const reader = res.body.getReader();
  const dec = new TextDecoder();
  let buf = '';
  for (;;) {
    const { value, done } = await reader.read();
    if (done) throw new Error('stream ended before first event');
    buf += dec.decode(value, { stream: true });
    const end = buf.indexOf('\n\n');
    if (end === -1) continue;
    reader.cancel().catch(() => {});
    const frame = buf.slice(0, end);
    const event = (/^event: (.*)$/m.exec(frame) || [])[1];
    const data = (/^data: (.*)$/m.exec(frame) || [])[1];
    return { event, data: data ? JSON.parse(data) : null };
  }
}

test('board payload carries a stable per-instance boot id', async () => {
  const s = await startServer();
  try {
    const r1 = await s.api('GET', '/api/board');
    assert.equal(r1.status, 200);
    assert.equal(typeof r1.body.boot, 'string');
    assert.ok(r1.body.boot.length > 0);

    // stable across requests within one server life
    const r2 = await s.api('GET', '/api/board');
    assert.equal(r2.body.boot, r1.body.boot);

    // the SSE hello (event: board) carries the same id
    const ev = await firstSseEvent(s.base);
    assert.equal(ev.event, 'board');
    assert.equal(ev.data.boot, r1.body.boot);
  } finally {
    await s.stop();
  }
});

// Keep an SSE stream open and pull frames one at a time; next(ms) resolves the
// next non-ping event name, or null when the window closes with the stream quiet.
async function sseReader(base) {
  const res = await fetch(base + '/api/events');
  assert.equal(res.status, 200);
  const reader = res.body.getReader();
  const dec = new TextDecoder();
  let buf = '';
  let pending = null; // a timed-out read stays pending; the next call reuses it
  async function next(timeoutMs) {
    const deadline = Date.now() + timeoutMs;
    for (;;) {
      const end = buf.indexOf('\n\n');
      if (end !== -1) {
        const frame = buf.slice(0, end);
        buf = buf.slice(end + 2);
        const event = (/^event: (.*)$/m.exec(frame) || [])[1];
        if (event === 'ping') continue;
        return event;
      }
      const left = deadline - Date.now();
      if (left <= 0) return null;
      if (!pending) pending = reader.read();
      const r = await Promise.race([
        pending,
        new Promise((resolve) => setTimeout(() => resolve('timeout'), left)),
      ]);
      if (r === 'timeout') return null;
      pending = null;
      if (r.done) return null;
      buf += dec.decode(r.value, { stream: true });
    }
  }
  return { next, close: () => reader.cancel().catch(() => {}) };
}

// A thread read marker only moves the POSTING user's own unread derivation —
// it must persist WITHOUT a board broadcast (the unified stream fires one POST
// per viewed thread per device; full pushes here burst every client and can
// drown a composer's own send echo).
test('POST /api/read persists the marker without broadcasting', async () => {
  const s = await startServer();
  const sse = await sseReader(s.base);
  try {
    assert.equal(await sse.next(2000), 'board'); // the on-connect hello

    const r = await s.api('POST', '/api/read', { target: 'card:quiet', ts: '2026-01-01T00:00:00.000Z' });
    assert.equal(r.status, 200);
    assert.equal(await sse.next(500), null); // stream stays quiet

    // the marker still persisted for the posting user
    const b = await s.api('GET', '/api/board');
    assert.equal(b.body.reads.user.threads['card:quiet'], '2026-01-01T00:00:00.000Z');

    // contrast probe: the bell's mark-all STILL broadcasts — proving the
    // quiet window above was a suppressed push, not a dead stream
    await s.api('POST', '/api/notifications/read', { all: true });
    assert.equal(await sse.next(2000), 'board');
  } finally {
    sse.close();
    await s.stop();
  }
});

test('boot id changes across a server restart on the same workspace+port', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bc-boot-'));
  const port = await freePort();
  try {
    const s1 = await startServer({ dir, port });
    const boot1 = (await s1.api('GET', '/api/board')).body.boot;
    await s1.stop();

    const s2 = await startServer({ dir, port });
    const boot2 = (await s2.api('GET', '/api/board')).body.boot;
    await s2.stop();

    assert.ok(boot1 && boot2);
    assert.notEqual(boot2, boot1);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
