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
