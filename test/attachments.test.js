'use strict';
// Chat file uploads: the /api/attachments transport + serve, message attachments
// with agent path delivery (drain/thread), and the DELIBERATE promote-to-artifact
// tool. Uploading a file to chat must NEVER auto-add a card artifact.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const { startServerWithLieutenant, withOwner, runCli, LT } = require('./helper');

const b64 = (s) => Buffer.from(s).toString('base64');

test('upload → stored + served with the right Content-Type and correct size', async () => {
  const s = await startServerWithLieutenant();
  try {
    const payload = 'hello attachment world';
    const up = await s.api('POST', '/api/attachments', { name: 'note.txt', mime: 'text/plain', dataBase64: b64(payload) });
    assert.strictEqual(up.status, 200);
    assert.match(up.body.id, /^[a-f0-9]{16}$/);
    assert.strictEqual(up.body.uri, 'attachment://' + up.body.id);
    assert.strictEqual(up.body.name, 'note.txt');
    assert.strictEqual(up.body.mime, 'text/plain');
    assert.strictEqual(up.body.size, Buffer.byteLength(payload));

    // stored on disk under .bridge-commander/uploads with a sidecar
    const up_dir = path.join(s.dir, '.bridge-commander', 'uploads');
    assert.ok(fs.existsSync(path.join(up_dir, up.body.id + '.json')), 'sidecar written');
    assert.ok(fs.existsSync(path.join(up_dir, up.body.id + '__note.txt')), 'file written with id prefix');

    // GET streams the bytes with the stored Content-Type
    const res = await fetch(s.base + '/api/attachments/' + up.body.id);
    assert.strictEqual(res.status, 200);
    assert.strictEqual(res.headers.get('content-type'), 'text/plain');
    // untrusted content served from our own origin: sniffing off + sandboxed
    assert.strictEqual(res.headers.get('x-content-type-options'), 'nosniff');
    assert.strictEqual(res.headers.get('content-security-policy'), 'sandbox');
    assert.strictEqual(await res.text(), payload);
  } finally {
    await s.stop();
  }
});

test('video attachment serve honors Range (206 slice) for <video> playback', async () => {
  const s = await startServerWithLieutenant();
  try {
    const up = await s.api('POST', '/api/attachments', { name: 'clip.mp4', mime: 'video/mp4', dataBase64: b64('FAKE-MP4-BYTES') });
    assert.strictEqual(up.status, 200);
    const url = s.base + '/api/attachments/' + up.body.id;
    const full = await fetch(url);
    assert.strictEqual(full.status, 200);
    assert.strictEqual(full.headers.get('accept-ranges'), 'bytes');
    const r = await fetch(url, { headers: { Range: 'bytes=5-7' } });
    assert.strictEqual(r.status, 206);
    assert.strictEqual(r.headers.get('content-range'), 'bytes 5-7/14');
    assert.strictEqual(r.headers.get('content-type'), 'video/mp4');
    assert.strictEqual(await r.text(), 'MP4');
  } finally {
    await s.stop();
  }
});

test('over-cap upload → 413', async () => {
  const s = await startServerWithLieutenant({ env: { BC_UPLOAD_MAX_BYTES: '64' } });
  try {
    const ok = await s.api('POST', '/api/attachments', { name: 'small.bin', mime: 'application/octet-stream', dataBase64: b64('x'.repeat(64)) });
    assert.strictEqual(ok.status, 200);
    const over = await s.api('POST', '/api/attachments', { name: 'big.bin', mime: 'application/octet-stream', dataBase64: b64('x'.repeat(65)) });
    assert.strictEqual(over.status, 413);
  } finally {
    await s.stop();
  }
});

test('unknown id → 404', async () => {
  const s = await startServerWithLieutenant();
  try {
    const res = await fetch(s.base + '/api/attachments/deadbeefdeadbeef');
    assert.strictEqual(res.status, 404);
  } finally {
    await s.stop();
  }
});

test('path traversal in the id or the filename is blocked', async () => {
  const s = await startServerWithLieutenant();
  try {
    // a bare ".." or an encoded traversal id never resolves to a file
    for (const bad of ['..', '%2e%2e', '..%2f..%2fboard.json', 'not-hex-id']) {
      const res = await fetch(s.base + '/api/attachments/' + bad);
      assert.strictEqual(res.status, 404, 'traversal id blocked: ' + bad);
    }
    // a traversal filename is sanitized to a safe basename inside the uploads dir
    const up = await s.api('POST', '/api/attachments', { name: '../../../etc/passwd', mime: 'text/plain', dataBase64: b64('x') });
    assert.strictEqual(up.status, 200);
    assert.strictEqual(up.body.name, 'passwd'); // stripped to the basename
    const up_dir = path.join(s.dir, '.bridge-commander', 'uploads');
    const stored = fs.readdirSync(up_dir).filter((f) => f.startsWith(up.body.id + '__'));
    assert.strictEqual(stored.length, 1);
    assert.ok(!stored[0].includes('..') && !stored[0].includes('/'), 'stored name has no traversal');
    // the file really lives inside the uploads dir
    assert.ok(fs.existsSync(path.join(up_dir, stored[0])));
  } finally {
    await s.stop();
  }
});

test('captain feedback with attachments persists them on the thread message and queues them with the absolute path', async () => {
  const s = await startServerWithLieutenant();
  try {
    await s.api('POST', '/api/cards', withOwner({ title: 'Shots' }));
    const up = await s.api('POST', '/api/attachments', { name: 'shot.png', mime: 'image/png', dataBase64: b64('PNGDATA') });
    const r = await s.api('POST', '/api/feedback', { target: 'card:shots', text: 'see this', attachments: [{ id: up.body.id }] });
    assert.strictEqual(r.status, 200);

    // persisted on the thread message with authoritative meta (server re-resolves by id)
    const card = (await s.api('GET', '/api/cards/shots')).body;
    const att = card.thread[0].attachments;
    assert.strictEqual(att.length, 1);
    assert.strictEqual(att[0].id, up.body.id);
    assert.strictEqual(att[0].name, 'shot.png');
    assert.strictEqual(att[0].mime, 'image/png');
    const absPath = path.join(s.dir, '.bridge-commander', 'uploads', up.body.id + '__shot.png');
    assert.strictEqual(att[0].path, absPath);

    // the queue item to the owner carries the same attachments (with path)
    const item = (await s.api('GET', '/api/feed?lieutenant=' + LT)).body.items[0];
    assert.strictEqual(item.kind, 'message');
    assert.strictEqual(item.attachments[0].path, absPath);
  } finally {
    await s.stop();
  }
});

test('a message may carry attachments with no text', async () => {
  const s = await startServerWithLieutenant();
  try {
    await s.api('POST', '/api/cards', withOwner({ title: 'Nomsg' }));
    const up = await s.api('POST', '/api/attachments', { name: 'log.txt', mime: 'text/plain', dataBase64: b64('L') });
    const r = await s.api('POST', '/api/feedback', { target: 'card:nomsg', text: '', attachments: [{ id: up.body.id }] });
    assert.strictEqual(r.status, 200);
    // but a message with neither text nor attachments is still rejected
    const empty = await s.api('POST', '/api/feedback', { target: 'card:nomsg', text: '  ' });
    assert.strictEqual(empty.status, 400);
  } finally {
    await s.stop();
  }
});

test('drain and thread output surface the absolute attachment path to the agent', async () => {
  const s = await startServerWithLieutenant();
  try {
    await s.api('POST', '/api/cards', withOwner({ title: 'Paths' }));
    const up = await s.api('POST', '/api/attachments', { name: 'diag.log', mime: 'text/plain', dataBase64: b64('trace') });
    await s.api('POST', '/api/feedback', { target: 'card:paths', text: 'look', attachments: [{ id: up.body.id }] });
    const absPath = path.join(s.dir, '.bridge-commander', 'uploads', up.body.id + '__diag.log');

    const drain = await runCli(['drain', '--lieutenant', LT, '--workspace', s.dir, '--port', String(s.port)]);
    assert.strictEqual(drain.code, 0, drain.stderr);
    assert.ok(drain.stdout.includes(absPath), 'drain shows the absolute path:\n' + drain.stdout);

    const thread = await runCli(['thread', 'card:paths', '--workspace', s.dir, '--port', String(s.port)]);
    assert.strictEqual(thread.code, 0, thread.stderr);
    assert.ok(thread.stdout.includes(absPath), 'thread shows the absolute path:\n' + thread.stdout);
  } finally {
    await s.stop();
  }
});

test('uploading to chat does NOT auto-add a card artifact; promote add/rm is deliberate + idempotent', async () => {
  const s = await startServerWithLieutenant();
  try {
    await s.api('POST', '/api/cards', withOwner({ title: 'Promote' }));
    const up = await s.api('POST', '/api/attachments', { name: 'design.png', mime: 'image/png', dataBase64: b64('IMG') });
    await s.api('POST', '/api/feedback', { target: 'card:promote', text: 'here', attachments: [{ id: up.body.id }] });

    // the upload alone leaves artifacts empty
    let card = (await s.api('GET', '/api/cards/promote')).body;
    assert.ok(!card.attributes.artifacts || !card.attributes.artifacts.length, 'no auto artifact from upload');

    // deliberate promote appends {uri, label}
    const uri = 'attachment://' + up.body.id;
    const add = await s.api('POST', '/api/cards/promote/artifacts', { uri, label: 'the design' });
    assert.strictEqual(add.status, 200);
    card = (await s.api('GET', '/api/cards/promote')).body;
    assert.deepStrictEqual(card.attributes.artifacts, [{ uri, label: 'the design' }]);

    // idempotent — no duplicate on re-add
    await s.api('POST', '/api/cards/promote/artifacts', { uri, label: 'the design' });
    card = (await s.api('GET', '/api/cards/promote')).body;
    assert.strictEqual(card.attributes.artifacts.length, 1);

    // rm removes it
    const rm = await s.api('DELETE', '/api/cards/promote/artifacts', { uri });
    assert.strictEqual(rm.status, 200);
    assert.strictEqual(rm.body.removed, true);
    card = (await s.api('GET', '/api/cards/promote')).body;
    assert.strictEqual((card.attributes.artifacts || []).length, 0);
  } finally {
    await s.stop();
  }
});

test('card artifact add defaults the label to the attachment name; promoted attachment previews via /api/artifact', async () => {
  const s = await startServerWithLieutenant();
  try {
    await s.api('POST', '/api/cards', withOwner({ title: 'Deflabel' }));
    const up = await s.api('POST', '/api/attachments', { name: 'readme.md', mime: 'text/markdown', dataBase64: b64('# hi') });
    const uri = 'attachment://' + up.body.id;
    await s.api('POST', '/api/cards/deflabel/artifacts', { uri });
    const card = (await s.api('GET', '/api/cards/deflabel')).body;
    assert.deepStrictEqual(card.attributes.artifacts, [{ uri, label: 'readme.md' }]);

    // the artifact preview endpoint resolves the attachment:// uri to its bytes
    const prev = await s.api('GET', '/api/artifact?uri=' + encodeURIComponent(uri));
    assert.strictEqual(prev.status, 200);
    assert.strictEqual(prev.body.content, '# hi');
  } finally {
    await s.stop();
  }
});

test('cli: card artifact add/rm on the currently-open card', async () => {
  const s = await startServerWithLieutenant();
  try {
    await s.api('POST', '/api/cards', withOwner({ title: 'Cli art' }));
    const up = await s.api('POST', '/api/attachments', { name: 'plot.png', mime: 'image/png', dataBase64: b64('P') });
    const uri = 'attachment://' + up.body.id;
    const add = await runCli(['card', 'artifact', 'add', 'cli-art', '--uri', uri, '--label', 'plot', '--workspace', s.dir, '--port', String(s.port)]);
    assert.strictEqual(add.code, 0, add.stderr);
    let card = (await s.api('GET', '/api/cards/cli-art')).body;
    assert.deepStrictEqual(card.attributes.artifacts, [{ uri, label: 'plot' }]);

    const rm = await runCli(['card', 'artifact', 'rm', 'cli-art', '--uri', uri, '--workspace', s.dir, '--port', String(s.port)]);
    assert.strictEqual(rm.code, 0, rm.stderr);
    card = (await s.api('GET', '/api/cards/cli-art')).body;
    assert.strictEqual((card.attributes.artifacts || []).length, 0);
  } finally {
    await s.stop();
  }
});

test('card artifact add normalizes a bare path to a file:// uri', async () => {
  const s = await startServerWithLieutenant();
  try {
    await s.api('POST', '/api/cards', withOwner({ title: 'Filepath' }));
    const r = await s.api('POST', '/api/cards/filepath/artifacts', { uri: '/tmp/report.md', label: 'report' });
    assert.strictEqual(r.status, 200);
    assert.strictEqual(r.body.artifact.uri, 'file:///tmp/report.md');
  } finally {
    await s.stop();
  }
});
