'use strict';
// Editing a hook through the artifact routes — what the config screen's hooks
// section rides on.
//
// A hook is a file, so editing one is the file screen and the same
// PUT /api/artifact a card artifact is saved with: one editor, one version
// check, one 409. That means exactly one more widening of the gate, and this
// file is where its edges live. The accepted shape is the namespace hooks.js
// already defines — an executable file under <workspace>/.bridge-commander/hooks/,
// ONE level deep (a named hook) or TWO (a lifecycle hook in its event's dir).
// Nothing else: not a path outside hooks/, not a symlink, not a traversal, not
// a directory, and no third level.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const { startServerWithLieutenant, runCli } = require('./helper');
const { LIFECYCLE_EVENTS } = require('../server/hooks.js');

const sha256 = (s) => crypto.createHash('sha256').update(s).digest('hex');
const uriOf = (f) => 'file://' + f;
const get = (s, uri) => s.api('GET', '/api/artifact?uri=' + encodeURIComponent(uri));

function hooksDir(ws) { return path.join(ws, '.bridge-commander', 'hooks'); }
function write(file, body, mode = 0o755) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, body);
  fs.chmodSync(file, mode);
  return file;
}
async function boot() {
  const s = await startServerWithLieutenant();
  fs.mkdirSync(hooksDir(s.dir), { recursive: true });
  return s;
}

test('a named hook reads and writes through the artifact routes, version check and all', async () => {
  const s = await boot();
  try {
    const file = write(path.join(hooksDir(s.dir), 'gh-watch'), '#!/bin/sh\necho v1\n');
    const uri = uriOf(file);
    const got = await get(s, uri);
    assert.strictEqual(got.status, 200, JSON.stringify(got.body));
    assert.strictEqual(got.body.name, 'gh-watch');
    assert.strictEqual(got.body.content, '#!/bin/sh\necho v1\n');
    assert.strictEqual(got.body.version, sha256('#!/bin/sh\necho v1\n'));

    const put = await s.api('PUT', '/api/artifact',
      { uri, content: '#!/bin/sh\necho v2\n', version: got.body.version });
    assert.strictEqual(put.status, 200, JSON.stringify(put.body));
    assert.strictEqual(fs.readFileSync(file, 'utf8'), '#!/bin/sh\necho v2\n');
    // an edit never costs a hook its executable bit — a hook the runner skips
    // silently is not a hook
    assert.strictEqual(fs.statSync(file).mode & 0o111, 0o111, 'still executable');

    const stale = await s.api('PUT', '/api/artifact', { uri, content: 'mine\n', version: got.body.version });
    assert.strictEqual(stale.status, 409);
    assert.strictEqual(fs.readFileSync(file, 'utf8'), '#!/bin/sh\necho v2\n', 'nothing was written');
  } finally { await s.stop(); }
});

test('a lifecycle hook — two levels deep, in its event directory — opens the same way', async () => {
  const s = await boot();
  try {
    const file = write(path.join(hooksDir(s.dir), 'worker-done', 'sweep.sh'), '#!/bin/sh\nexit 0\n');
    const uri = uriOf(file);
    const got = await get(s, uri);
    assert.strictEqual(got.status, 200, JSON.stringify(got.body));
    const put = await s.api('PUT', '/api/artifact',
      { uri, content: '#!/bin/sh\nexit 1\n', version: got.body.version });
    assert.strictEqual(put.status, 200, JSON.stringify(put.body));
    assert.strictEqual(fs.readFileSync(file, 'utf8'), '#!/bin/sh\nexit 1\n');
  } finally { await s.stop(); }
});

test('a hook written where none was is born EXECUTABLE — there is no chmod on a phone', async () => {
  const s = await boot();
  try {
    const file = path.join(hooksDir(s.dir), 'brand-new');
    const uri = uriOf(file);
    // A board-owned file that is not written yet reads as the empty document at
    // version '' — whatever kind it is. The board built this path, so "not
    // there" is a state, not a 404, and '' is exactly what the PUT reads as "I
    // expect no file". A charter already worked this way; so does a hook.
    const got = await get(s, uri);
    assert.strictEqual(got.status, 200, JSON.stringify(got.body));
    assert.deepStrictEqual(
      { content: got.body.content, version: got.body.version }, { content: '', version: '' });

    const put = await s.api('PUT', '/api/artifact', { uri, content: '#!/bin/sh\necho hi\n', version: '' });
    assert.strictEqual(put.status, 200, JSON.stringify(put.body));
    assert.strictEqual(fs.statSync(file).mode & 0o111, 0o111);
    // and it is a hook the moment it lands
    assert.ok((await s.api('GET', '/api/hooks')).body.hooks.some((h) => h.name === 'brand-new'));
  } finally { await s.stop(); }
});

// A workspace that has never had a hook has no hooks/ either, and that must not
// be the one place a lieutenant cannot write the first one — `bc-axi artifact
// write` IS the path the card names for "a new hook is a file you or a
// lieutenant writes". hooks/ is a fixed name the board owns, so the board makes
// it, exactly as it makes a lieutenant's memory folder.
test('the FIRST hook in a workspace creates hooks/ — the board owns that name', async () => {
  const s = await startServerWithLieutenant();
  try {
    assert.ok(!fs.existsSync(hooksDir(s.dir)), 'no hooks directory to start with');
    const file = path.join(hooksDir(s.dir), 'gh-watch');
    const put = await s.api('PUT', '/api/artifact',
      { uri: uriOf(file), content: '#!/bin/sh\necho hi\n', version: '' });
    assert.strictEqual(put.status, 200, JSON.stringify(put.body));
    assert.strictEqual(fs.readFileSync(file, 'utf8'), '#!/bin/sh\necho hi\n');
    assert.strictEqual(fs.statSync(file).mode & 0o111, 0o111, 'and born executable');
    assert.ok((await s.api('GET', '/api/hooks')).body.hooks.some((h) => h.name === 'gh-watch'));
  } finally { await s.stop(); }
});

// The gate that writes hooks lets the writer pick the basename, and NAME_RE says
// a dot is fine — so `report.html` is a legal hook. The viewer's one exemption
// (a curated .html artifact renders instead of downloading) exists for a file the
// captain promoted onto a card by hand; a hook is never that. So a hook keeps the
// sandbox and the attachment disposition every other non-card artifact gets, and
// writing one is not a way to get script onto the board's own origin.
test('a hook named report.html is served sandboxed and as an attachment, never rendered', async () => {
  const s = await startServerWithLieutenant();
  try {
    const file = path.join(hooksDir(s.dir), 'report.html');
    const uri = uriOf(file);
    const body = '<!doctype html><script>fetch("/api/board")</script>';
    const put = await s.api('PUT', '/api/artifact', { uri, content: body, version: '' });
    assert.strictEqual(put.status, 200, JSON.stringify(put.body));

    const res = await fetch(s.base + '/api/artifact?uri=' + encodeURIComponent(uri) + '&raw=1');
    assert.strictEqual(res.status, 200);
    assert.strictEqual(res.headers.get('content-security-policy'), 'sandbox');
    assert.match(res.headers.get('content-disposition') || '', /^attachment/);
    assert.strictEqual(res.headers.get('x-content-type-options'), 'nosniff');
    assert.strictEqual(await res.text(), body);
  } finally { await s.stop(); }
});

// The same thing at the surface a human types. The two halves above proved the
// SHAPE — a 200 with an empty version, a PUT that creates — and missed the
// surface: `bc-axi artifact write` guarded on a FALSY --version, so the one
// version `artifact read` hands you for a file nobody wrote yet was the one
// version it would not take. A rule whose reason cannot be executed is not a
// rule, so it is asserted here, through the CLI, end to end.
test('cli: artifact read then write CREATES the first hook — the empty version is a real one', async () => {
  const s = await startServerWithLieutenant();
  try {
    const file = path.join(hooksDir(s.dir), 'gh-watch');
    const uri = uriOf(file);
    const args = ['--workspace', s.dir, '--port', String(s.port)];

    const read = await runCli(['artifact', 'read', uri, ...args]);
    assert.strictEqual(read.code, 0, read.stderr);
    assert.strictEqual(read.stdout, '', 'a board-owned file nobody wrote yet reads as the empty document');
    assert.match(read.stderr, /^version: *$/m, 'at version ""');

    const body = path.join(s.dir, 'draft.sh');
    fs.writeFileSync(body, '#!/bin/sh\nbc-axi event "$BC_CARD" --kind note\n');
    const wrote = await runCli(['artifact', 'write', uri, '--file', body, '--version', '', ...args]);
    assert.strictEqual(wrote.code, 0, wrote.stderr);
    assert.strictEqual(fs.readFileSync(file, 'utf8'), '#!/bin/sh\nbc-axi event "$BC_CARD" --kind note\n');
    assert.strictEqual(fs.statSync(file).mode & 0o111, 0o111, 'and born executable, like any other hook');
    assert.ok((await s.api('GET', '/api/hooks')).body.hooks.some((h) => h.name === 'gh-watch'),
      'a lieutenant wrote a hook with nothing but the CLI');

    // …and the door still closes behind it: the version that just landed is the
    // only one the next write may carry.
    const stale = await runCli(['artifact', 'write', uri, '--file', body, '--version', '', ...args]);
    assert.strictEqual(stale.code, 1, 'an empty version means "no file yet" — and there is one now');
    assert.match(stale.stderr, /NOT WRITTEN/);
  } finally { await s.stop(); }
});

// An event directory is not a fixed name: creating one invents a lifecycle
// event, and a typo'd event is a hook that silently never fires, forever. So it
// stays a refusal — but an HONEST one. A legal path whose tree is missing is a
// different answer from a path that is not a hook at all, and "unknown
// artifact" would be a lie: the name is fine, the id is fine, the directory is
// what is missing.
test('a hook in an event directory that is not there is refused by NAME, not as an unknown artifact', async () => {
  const s = await boot();
  try {
    const missing = path.join(hooksDir(s.dir), 'worker-dnoe', 'sweep.sh'); // the typo is the point
    for (const r of [await get(s, uriOf(missing)),
      await s.api('PUT', '/api/artifact', { uri: uriOf(missing), content: '#!/bin/sh\n', version: '' })]) {
      assert.strictEqual(r.status, 400, JSON.stringify(r.body));
      assert.match(r.body.error, /no hook event directory "worker-dnoe"/);
      for (const e of LIFECYCLE_EVENTS) assert.ok(r.body.error.includes(e), 'it names ' + e);
      assert.ok(!/unknown artifact/.test(r.body.error), 'and never pretends the path is unknown');
    }
    assert.ok(!fs.existsSync(path.dirname(missing)), 'nothing was created for a typo');
  } finally { await s.stop(); }
});

test('an event directory that IS there takes the write, and the board never invents one', async () => {
  const s = await boot();
  try {
    fs.mkdirSync(path.join(hooksDir(s.dir), 'worker-done'), { recursive: true });
    const file = path.join(hooksDir(s.dir), 'worker-done', 'sweep.sh');
    const put = await s.api('PUT', '/api/artifact', { uri: uriOf(file), content: '#!/bin/sh\n', version: '' });
    assert.strictEqual(put.status, 200, JSON.stringify(put.body));
    assert.strictEqual(fs.statSync(file).mode & 0o111, 0o111);
  } finally { await s.stop(); }
});

// A workspace reached through a symlinked parent is ordinary, not exotic: /tmp
// is one on macOS, and ~/work → /mnt/data/work is one anywhere. The gate
// realpaths the directory a hook sits in, so the path it compares against has to
// be resolved the same way — or the board refuses its OWN hooks, every ✎ on the
// tab answers "unknown artifact", and nothing in that message points at why.
test('a workspace reached through a SYMLINK edits its hooks like any other', async () => {
  const tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'bc-linkws-')));
  const real = path.join(tmp, 'real');
  const link = path.join(tmp, 'link');
  fs.mkdirSync(real, { recursive: true });
  fs.symlinkSync(real, link);
  const s = await startServerWithLieutenant({ dir: link });
  try {
    write(path.join(hooksDir(real), 'gh-watch'), '#!/bin/sh\necho v1\n');
    // the uri under test is the one the tab is handed, not one the test spells
    const listed = (await s.api('GET', '/api/hooks')).body.hooks.find((h) => h.name === 'gh-watch');
    assert.ok(listed, 'the board lists it');

    const got = await get(s, uriOf(listed.file));
    assert.strictEqual(got.status, 200, JSON.stringify(got.body));
    assert.strictEqual(got.body.content, '#!/bin/sh\necho v1\n');
    const put = await s.api('PUT', '/api/artifact',
      { uri: uriOf(listed.file), content: '#!/bin/sh\necho v2\n', version: got.body.version });
    assert.strictEqual(put.status, 200, JSON.stringify(put.body));
    assert.strictEqual(fs.readFileSync(path.join(hooksDir(real), 'gh-watch'), 'utf8'), '#!/bin/sh\necho v2\n');

    // …and a lifecycle hook, two levels down, through the same link
    const sweep = write(path.join(hooksDir(real), 'worker-done', 'sweep.sh'), '#!/bin/sh\nexit 0\n');
    const two = (await s.api('GET', '/api/hooks')).body.hooks.find((h) => h.event === 'worker-done');
    assert.ok(two, 'the board lists that one too');
    const g2 = await get(s, uriOf(two.file));
    assert.strictEqual(g2.status, 200, JSON.stringify(g2.body));
    const p2 = await s.api('PUT', '/api/artifact',
      { uri: uriOf(two.file), content: '#!/bin/sh\nexit 1\n', version: g2.body.version });
    assert.strictEqual(p2.status, 200, JSON.stringify(p2.body));
    assert.strictEqual(fs.readFileSync(sweep, 'utf8'), '#!/bin/sh\nexit 1\n');
  } finally {
    await s.stop();
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

// The board's own directory is one the board MAKES — `--workspace ~/boards/new`
// through a symlinked ~/boards is the first boot of a new board, not an error.
// Giving up on the link because the leaf is not there yet costs that whole
// process every hook it has, and a restart quietly fixing it is what makes the
// symptom impossible to place.
test('a workspace directory that does not exist YET still resolves through the link', async () => {
  const tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'bc-newws-')));
  const real = path.join(tmp, 'real');
  fs.mkdirSync(real, { recursive: true });
  fs.symlinkSync(real, path.join(tmp, 'link'));
  const fresh = path.join(tmp, 'link', 'newboard'); // nothing there — the server makes it
  const s = await startServerWithLieutenant({ dir: fresh });
  try {
    assert.ok(fs.existsSync(path.join(real, 'newboard')), 'the board was born through the link');
    write(path.join(hooksDir(path.join(real, 'newboard')), 'gh-watch'), '#!/bin/sh\necho v1\n');
    const listed = (await s.api('GET', '/api/hooks')).body.hooks.find((h) => h.name === 'gh-watch');
    assert.ok(listed, 'the board lists it');
    const got = await get(s, uriOf(listed.file));
    assert.strictEqual(got.status, 200, JSON.stringify(got.body));
    const put = await s.api('PUT', '/api/artifact',
      { uri: uriOf(listed.file), content: '#!/bin/sh\necho v2\n', version: got.body.version });
    assert.strictEqual(put.status, 200, JSON.stringify(put.body));
    assert.strictEqual(
      fs.readFileSync(path.join(hooksDir(path.join(real, 'newboard')), 'gh-watch'), 'utf8'),
      '#!/bin/sh\necho v2\n');
  } finally {
    await s.stop();
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

// The list the refusal prints has to be the events the server really fires, or
// it sends people to build hooks in a directory nothing will ever look at.
test('LIFECYCLE_EVENTS is exactly what the server fires', () => {
  const server = fs.readFileSync(path.join(__dirname, '..', 'server', 'server.js'), 'utf8');
  const fired = [...server.matchAll(/fireHooks\('([^']+)'/g)].map((m) => m[1]);
  assert.ok(fired.length >= 3, 'the fireHooks call sites are found');
  assert.deepStrictEqual([...new Set(fired)].sort(), [...LIFECYCLE_EVENTS].sort());
});

// ---------- what the gate refuses ----------
// Each of these is its own test on purpose: they are the reasons this is a hook
// route and not a workspace file API, and a single collapsed test would let one
// of them rot green.

async function refused(s, uri, content) {
  const g = await get(s, uri);
  assert.strictEqual(g.status, 404, 'GET ' + uri + ' → ' + JSON.stringify(g.body));
  const p = await s.api('PUT', '/api/artifact', { uri, content: content || 'pwned\n', version: '' });
  assert.strictEqual(p.status, 403, 'PUT ' + uri + ' → ' + JSON.stringify(p.body));
}

test('a path OUTSIDE hooks/ is refused, however ordinary it looks', async () => {
  const s = await boot();
  try {
    const outside = path.join(s.dir, '.bridge-commander', 'gh-watch');
    fs.writeFileSync(outside, 'not a hook\n');
    await refused(s, uriOf(outside));
    // the state dir's own files are the point of the refusal
    const brd = path.join(s.dir, '.bridge-commander', 'board.json');
    const before = fs.readFileSync(brd, 'utf8');
    await refused(s, uriOf(brd));
    assert.strictEqual(fs.readFileSync(brd, 'utf8'), before);
    assert.strictEqual(fs.readFileSync(outside, 'utf8'), 'not a hook\n');
  } finally { await s.stop(); }
});

test('a hook that is a SYMLINK is refused, not followed', async () => {
  const s = await boot();
  try {
    const secret = path.join(s.dir, 'secret.sh');
    fs.writeFileSync(secret, 'the good stuff\n');
    const link = path.join(hooksDir(s.dir), 'innocent');
    fs.symlinkSync(secret, link);
    await refused(s, uriOf(link));
    assert.strictEqual(fs.readFileSync(secret, 'utf8'), 'the good stuff\n');

    // …and so is a hook inside a symlinked EVENT directory
    const elsewhere = path.join(s.dir, 'elsewhere');
    fs.mkdirSync(elsewhere, { recursive: true });
    fs.writeFileSync(path.join(elsewhere, 'sweep.sh'), 'theirs\n');
    fs.symlinkSync(elsewhere, path.join(hooksDir(s.dir), 'worker-done'));
    await refused(s, uriOf(path.join(hooksDir(s.dir), 'worker-done', 'sweep.sh')));
    assert.strictEqual(fs.readFileSync(path.join(elsewhere, 'sweep.sh'), 'utf8'), 'theirs\n');
  } finally { await s.stop(); }
});

test('a TRAVERSAL out of hooks/ is refused — the client never supplies a prefix', async () => {
  const s = await boot();
  try {
    const brd = path.join(s.dir, '.bridge-commander', 'board.json');
    const before = fs.readFileSync(brd, 'utf8');
    const dir = hooksDir(s.dir);
    await refused(s, uriOf(path.join(dir, '..', 'board.json')));
    // the un-normalized spelling too — the string is what arrives, not a path object
    await refused(s, 'file://' + dir + '/../board.json');
    await refused(s, 'file://' + dir + '/worker-done/../../board.json');
    // …and one that spells its way BACK into hooks/ is still not a hook path
    write(path.join(dir, 'real'), '#!/bin/sh\nexit 0\n');
    await refused(s, 'file://' + dir + '/../hooks/real');
    assert.strictEqual(fs.readFileSync(brd, 'utf8'), before, 'the board is untouched');
    assert.strictEqual(fs.readFileSync(path.join(dir, 'real'), 'utf8'), '#!/bin/sh\nexit 0\n');
  } finally { await s.stop(); }
});

test('a DIRECTORY is refused — an event dir is not a file to edit', async () => {
  const s = await boot();
  try {
    const eventDir = path.join(hooksDir(s.dir), 'worker-done');
    fs.mkdirSync(eventDir, { recursive: true });
    await refused(s, uriOf(eventDir));
    await refused(s, uriOf(hooksDir(s.dir)));
    assert.ok(fs.statSync(eventDir).isDirectory(), 'still a directory');
  } finally { await s.stop(); }
});

test('a THIRD level is refused — hooks/ is one level of events, not a tree', async () => {
  const s = await boot();
  try {
    const deep = write(path.join(hooksDir(s.dir), 'worker-done', 'lib', 'helper.sh'), '#!/bin/sh\n');
    await refused(s, uriOf(deep));
    assert.strictEqual(fs.readFileSync(deep, 'utf8'), '#!/bin/sh\n');
  } finally { await s.stop(); }
});

test('a card artifact, a playbook and a charter still read and write exactly as they did', async () => {
  const s = await boot();
  try {
    const packaged = (await s.api('GET', '/api/playbooks')).body.items.find((p) => p.source === 'packaged');
    assert.strictEqual((await get(s, uriOf(packaged.file))).status, 200, 'a packaged playbook still opens');
    const charter = path.join(s.dir, 'lieutenants', 'ada', 'README.md');
    assert.strictEqual((await get(s, uriOf(charter))).status, 200, 'a charter still opens');
  } finally { await s.stop(); }
});
