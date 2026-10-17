'use strict';
// The one door for writing a co-edited artifact, and the screen it tells.
//
// PR #79 locked the artifact write on ONE side: the captain saves through
// PUT /api/artifact and gets a 409 when the file moved, while an agent wrote the
// same file straight to disk, checking nothing and telling nobody. This suite
// pins the other side shut and the live update open:
//   - `bc-axi artifact read/write` go through the server, so the agent gets the
//     SAME version check — and a refused write is REPORTED (exit 1), never
//     swallowed, which is the one failure that would make this worse than before;
//   - a write that lands announces itself on the board SSE (event `artifact`),
//     carrying the writer's client tag so the tab that saved ignores its own echo;
//   - changedLines is what turns "it changed" into "these lines changed".
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { pathToFileURL } = require('node:url');
const { startServerWithLieutenant, withOwner, runCli } = require('./helper');

const sha256 = (s) => crypto.createHash('sha256').update(s).digest('hex');

async function cardWithArtifact(s, uri, label) {
  const cr = await s.api('POST', '/api/cards', withOwner({ title: 'Deliverable' }));
  assert.strictEqual(cr.status, 200, JSON.stringify(cr.body));
  const add = await s.api('POST', '/api/cards/' + cr.body.card.id + '/artifacts', { uri, label });
  assert.strictEqual(add.status, 200, JSON.stringify(add.body));
  return { id: cr.body.card.id, uri: add.body.artifact.uri };
}

// Keep an SSE stream open and pull frames one at a time; next(ms) resolves the
// next non-ping frame as {event, data}, or null when the window closes quiet.
async function sseReader(base) {
  const res = await fetch(base + '/api/events');
  assert.strictEqual(res.status, 200);
  const reader = res.body.getReader();
  const dec = new TextDecoder();
  let buf = '';
  let pending = null;
  async function next(timeoutMs) {
    const deadline = Date.now() + timeoutMs;
    for (;;) {
      const end = buf.indexOf('\n\n');
      if (end !== -1) {
        const frame = buf.slice(0, end);
        buf = buf.slice(end + 2);
        const event = (/^event: (.*)$/m.exec(frame) || [])[1];
        if (!event || event === 'ping') continue; // comments and heartbeats
        const raw = (/^data: (.*)$/m.exec(frame) || [])[1];
        return { event, data: raw ? JSON.parse(raw) : null };
      }
      const left = deadline - Date.now();
      if (left <= 0) return null;
      if (!pending) pending = reader.read();
      const r = await Promise.race([pending, new Promise((ok) => setTimeout(() => ok('timeout'), left))]);
      if (r === 'timeout') return null;
      pending = null;
      if (r.done) return null;
      buf += dec.decode(r.value, { stream: true });
    }
  }
  return { next, close: () => reader.cancel().catch(() => {}) };
}

test('a landed write announces itself on the board SSE — uri, new version, and who wrote it', async () => {
  const s = await startServerWithLieutenant();
  const sse = await sseReader(s.base);
  try {
    const file = path.join(s.dir, 'brief.md');
    fs.writeFileSync(file, 'one\n');
    const { uri } = await cardWithArtifact(s, 'file://' + file, 'brief');
    assert.strictEqual((await sse.next(2000)).event, 'board'); // the on-connect hello
    assert.strictEqual((await sse.next(2000)).event, 'board'); // card created
    assert.strictEqual((await sse.next(2000)).event, 'board'); // artifact promoted

    const v = (await s.api('GET', '/api/artifact?uri=' + encodeURIComponent(uri))).body.version;
    const put = await s.api('PUT', '/api/artifact', { uri, content: 'two\n', version: v, client: 'tab-7' });
    assert.strictEqual(put.status, 200, JSON.stringify(put.body));

    const ev = await sse.next(2000);
    assert.strictEqual(ev.event, 'artifact', 'the write is announced on the stream that already exists');
    assert.strictEqual(ev.data.uri, uri);
    assert.strictEqual(ev.data.version, sha256('two\n'), 'the new version, so an open editor can tell it from its own');
    assert.strictEqual(ev.data.by, 'tab-7', 'the writer is named — that is how a tab ignores its own echo');
    assert.strictEqual(await sse.next(400), null, 'and nothing else — no board re-push for a file write');
  } finally {
    sse.close();
    await s.stop();
  }
});

test('a REFUSED write announces nothing — no phantom update on anybody\'s screen', async () => {
  const s = await startServerWithLieutenant();
  const sse = await sseReader(s.base);
  try {
    const file = path.join(s.dir, 'brief.md');
    fs.writeFileSync(file, 'on disk\n');
    const { uri } = await cardWithArtifact(s, 'file://' + file, 'brief');
    while (await sse.next(300)) {} // drain the board pushes from the setup

    const put = await s.api('PUT', '/api/artifact', { uri, content: 'nope\n', version: sha256('stale') });
    assert.strictEqual(put.status, 409);
    assert.strictEqual(await sse.next(500), null, 'nothing was written, so nothing is announced');
    assert.strictEqual(fs.readFileSync(file, 'utf8'), 'on disk\n');
  } finally {
    sse.close();
    await s.stop();
  }
});

test('cli: artifact read hands out content + version; write with it lands', async () => {
  const s = await startServerWithLieutenant();
  try {
    const file = path.join(s.dir, 'brief.md');
    fs.writeFileSync(file, '# brief\n\noriginal\n');
    const { uri } = await cardWithArtifact(s, 'file://' + file, 'brief');
    const args = ['--workspace', s.dir, '--port', String(s.port)];

    const read = await runCli(['artifact', 'read', uri, ...args]);
    assert.strictEqual(read.code, 0, read.stderr);
    assert.strictEqual(read.stdout, '# brief\n\noriginal\n', 'content on stdout, byte for byte');
    const version = (/version: ([0-9a-f]{64})/.exec(read.stderr) || [])[1];
    assert.strictEqual(version, sha256('# brief\n\noriginal\n'), 'the version is on stderr, ready to hand back');

    // --json is the same thing in one piece, for a caller that would rather parse
    const asJson = await runCli(['artifact', 'read', uri, '--json', ...args]);
    assert.deepStrictEqual(JSON.parse(asJson.stdout), { name: 'brief.md', version, content: '# brief\n\noriginal\n' });

    const edited = path.join(s.dir, 'edited.md');
    fs.writeFileSync(edited, '# brief\n\nrewritten by the agent\n');
    const wrote = await runCli(['artifact', 'write', uri, '--file', edited, '--version', version, ...args]);
    assert.strictEqual(wrote.code, 0, wrote.stderr);
    assert.match(wrote.stdout, /wrote .*brief\.md/);
    assert.match(wrote.stdout, new RegExp(sha256('# brief\n\nrewritten by the agent\n')));
    assert.strictEqual(fs.readFileSync(file, 'utf8'), '# brief\n\nrewritten by the agent\n');
  } finally {
    await s.stop();
  }
});

// THE defect this card exists to prevent: a write that did not happen and does
// not say so. The exit code and the words both have to carry it.
test('cli: writing with a stale version writes NOTHING and says so loudly (exit 1)', async () => {
  const s = await startServerWithLieutenant();
  try {
    const file = path.join(s.dir, 'brief.md');
    fs.writeFileSync(file, 'as the agent read it\n');
    const { uri } = await cardWithArtifact(s, 'file://' + file, 'brief');
    const args = ['--workspace', s.dir, '--port', String(s.port)];
    const stale = (/version: ([0-9a-f]{64})/.exec((await runCli(['artifact', 'read', uri, ...args])).stderr) || [])[1];

    // the captain saves while the agent is thinking
    const captain = 'the captain rewrote this paragraph\n';
    fs.writeFileSync(file, captain);

    const mine = path.join(s.dir, 'mine.md');
    fs.writeFileSync(mine, 'the agent version\n');
    const r = await runCli(['artifact', 'write', uri, '--file', mine, '--version', stale, ...args]);
    assert.strictEqual(r.code, 1, 'a refused write is a FAILED command, not a quiet no-op');
    assert.match(r.stderr, /NOT WRITTEN/, 'and it says so in words');
    assert.match(r.stderr, new RegExp(sha256(captain)), 'naming the version that is there now');
    assert.match(r.stderr, /artifact read/, 'and what to do about it');
    assert.strictEqual(fs.readFileSync(file, 'utf8'), captain, "the captain's text survives untouched");

    // re-read, redo on top, write with the new version: that lands
    const fresh = (/version: ([0-9a-f]{64})/.exec((await runCli(['artifact', 'read', uri, ...args])).stderr) || [])[1];
    fs.writeFileSync(mine, captain + 'plus the agent line\n');
    const again = await runCli(['artifact', 'write', uri, '--file', mine, '--version', fresh, ...args]);
    assert.strictEqual(again.code, 0, again.stderr);
    assert.strictEqual(fs.readFileSync(file, 'utf8'), captain + 'plus the agent line\n');
  } finally {
    await s.stop();
  }
});

test('cli: artifact write refuses to guess — no --version means no write', async () => {
  const s = await startServerWithLieutenant();
  try {
    const file = path.join(s.dir, 'brief.md');
    fs.writeFileSync(file, 'untouched\n');
    const { uri } = await cardWithArtifact(s, 'file://' + file, 'brief');
    const args = ['--workspace', s.dir, '--port', String(s.port)];
    const mine = path.join(s.dir, 'mine.md');
    fs.writeFileSync(mine, 'mine\n');

    const r = await runCli(['artifact', 'write', uri, '--file', mine, ...args]);
    assert.strictEqual(r.code, 1);
    assert.match(r.stderr, /usage: bc-axi artifact write/);
    assert.strictEqual(fs.readFileSync(file, 'utf8'), 'untouched\n');

    // and the server's own guards still answer through the CLI: an unlisted path
    const secret = path.join(s.dir, 'secret.txt');
    fs.writeFileSync(secret, 'do not touch\n');
    const bad = await runCli(['artifact', 'write', 'file://' + secret, '--file', mine, '--version', sha256('do not touch\n'), ...args]);
    assert.strictEqual(bad.code, 1);
    assert.match(bad.stderr, /not an artifact of any card/);
    assert.strictEqual(fs.readFileSync(secret, 'utf8'), 'do not touch\n');
  } finally {
    await s.stop();
  }
});

// What the editor marks after taking an outside write. 0-based line numbers,
// because that is what CodeMirror counts in.
test('changedLines names the lines the other hand touched', async () => {
  const { changedLines } = await import(pathToFileURL(path.join(__dirname, '..', 'ui', 'js', 'util.js')).href);

  assert.deepStrictEqual(changedLines('a\nb\nc\n', 'a\nb\nc\n'), [], 'identical text marks nothing');
  assert.deepStrictEqual(changedLines('a\nb\nc\n', 'a\nB\nc\n'), [1], 'one line rewritten');
  assert.deepStrictEqual(changedLines('a\nb\nc\n', 'a\nx\ny\nb\nc\n'), [1, 2], 'two lines inserted — only they are marked');
  assert.deepStrictEqual(changedLines('a\nb\nc\n', 'a\nb\nc\nd\n'), [3], 'appended at the end');
  assert.deepStrictEqual(changedLines('', 'hello\n'), [0], 'a file that was empty');
  // a pure deletion leaves no new line to mark, so the seam carries it — the
  // captain still gets a mark to look at instead of a silent shrink
  assert.deepStrictEqual(changedLines('a\nb\nc\n', 'a\nc\n'), [1]);
  assert.deepStrictEqual(changedLines('a\nb\n', ''), [0]);
});
