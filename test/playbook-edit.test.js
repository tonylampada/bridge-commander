'use strict';
// Editing a playbook through the artifact routes — what the workspace screen's
// playbooks section rides on.
//
// A playbook is a file the captain owns, so editing one is the file screen and
// the same PUT /api/artifact a card artifact is saved with: one editor, one
// version check, one 409. That means exactly one widening of the write gate,
// and this file is where its edges live. The gate accepts a `.md` file sitting
// DIRECTLY in <STATE_DIR>/playbooks and nothing else — not a subdirectory, not
// another extension, not a symlink out of it, and no directory prefix from the
// client. The card-artifact path is untouched.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { startServerWithLieutenant, withOwner } = require('./helper');

const sha256 = (s) => crypto.createHash('sha256').update(s).digest('hex');
const uriOf = (f) => 'file://' + f;
const get = (s, uri) => s.api('GET', '/api/artifact?uri=' + encodeURIComponent(uri));

// A workspace with one playbook of its own. `bc-axi init` seeds this dir; a
// server boot does not, so the test does what init would have.
async function boot(files) {
  const s = await startServerWithLieutenant();
  const dir = path.join(s.dir, '.bridge-commander', 'playbooks');
  fs.mkdirSync(dir, { recursive: true });
  for (const [name, body] of Object.entries(files || {})) {
    fs.writeFileSync(path.join(dir, name), body);
  }
  return { s, dir };
}

test('GET /api/playbooks says where each playbook comes from and which file won', async () => {
  const { s, dir } = await boot({ 'default.md': 'MY default\n' });
  try {
    const r = await s.api('GET', '/api/playbooks');
    assert.strictEqual(r.status, 200);
    assert.strictEqual(r.body.dir, dir, 'the workspace dir is still in the answer');
    const by = Object.fromEntries(r.body.items.map((p) => [p.id, p]));

    // overridden in the workspace: the workspace file is the one that wins
    assert.deepStrictEqual(by.default, {
      id: 'default', source: 'workspace', file: path.join(dir, 'default.md'),
    });
    // not overridden: the packaged file, from the install's own playbooks/
    assert.strictEqual(by.investigation.source, 'packaged');
    assert.strictEqual(by.investigation.file,
      path.join(__dirname, '..', 'playbooks', 'investigation.md'));
    assert.ok(fs.existsSync(by.investigation.file), 'and it is a real file on disk');

    // the plain id list the picker and the CLI read is unchanged
    assert.deepStrictEqual(r.body.playbooks, r.body.items.map((p) => p.id));
    assert.ok(r.body.playbooks.includes('no-mistakes'));
  } finally { await s.stop(); }
});

test('a workspace playbook reads and writes through the artifact routes, version check and all', async () => {
  const { s, dir } = await boot({ 'default.md': 'first draft\n' });
  try {
    const uri = uriOf(path.join(dir, 'default.md'));
    const got = await get(s, uri);
    assert.strictEqual(got.status, 200, JSON.stringify(got.body));
    assert.strictEqual(got.body.name, 'default.md');
    assert.strictEqual(got.body.content, 'first draft\n');
    assert.strictEqual(got.body.version, sha256('first draft\n'));

    const put = await s.api('PUT', '/api/artifact', { uri, content: 'second draft\n', version: got.body.version });
    assert.strictEqual(put.status, 200, JSON.stringify(put.body));
    assert.strictEqual(fs.readFileSync(path.join(dir, 'default.md'), 'utf8'), 'second draft\n');

    // …and a stale version is still refused, carrying what is on disk now
    const stale = await s.api('PUT', '/api/artifact', { uri, content: 'mine\n', version: got.body.version });
    assert.strictEqual(stale.status, 409);
    assert.match(stale.body.error, /changed on disk/);
    assert.strictEqual(stale.body.content, 'second draft\n');
    assert.strictEqual(stale.body.version, sha256('second draft\n'));
    assert.strictEqual(fs.readFileSync(path.join(dir, 'default.md'), 'utf8'), 'second draft\n', 'nothing was written');
  } finally { await s.stop(); }
});

test('copy to workspace: a packaged playbook reads, refuses to be written, and copies in', async () => {
  const { s, dir } = await boot();
  try {
    const packaged = (await s.api('GET', '/api/playbooks')).body.items.find((p) => p.id === 'investigation');
    assert.strictEqual(packaged.source, 'packaged');
    // it OPENS — that is what read-only means, and what the copy copies
    const got = await get(s, uriOf(packaged.file));
    assert.strictEqual(got.status, 200, JSON.stringify(got.body));
    const content = got.body.content;
    assert.ok(content.length, 'the packaged playbook has content');

    // …and it is never written in place: the install is a git checkout of this repo
    const nope = await s.api('PUT', '/api/artifact', { uri: uriOf(packaged.file), content: 'pwned\n', version: got.body.version });
    assert.strictEqual(nope.status, 403);
    assert.match(nope.body.error, /packaged playbook/);
    assert.strictEqual(fs.readFileSync(packaged.file, 'utf8'), content, 'the installed file is untouched');

    // The copy is a create in the workspace: version '' = "expect no file".
    const target = path.join(dir, 'investigation.md');
    const put = await s.api('PUT', '/api/artifact', { uri: uriOf(target), content, version: '' });
    assert.strictEqual(put.status, 200, JSON.stringify(put.body));
    assert.strictEqual(fs.readFileSync(target, 'utf8'), content);

    // and now the same id resolves to the workspace copy
    const after = (await s.api('GET', '/api/playbooks')).body.items.find((p) => p.id === 'investigation');
    assert.deepStrictEqual(after, { id: 'investigation', source: 'workspace', file: target });
  } finally { await s.stop(); }
});

// ---------- what the gate refuses ----------
// Each of these is its own test on purpose: they are the reasons this is a
// playbook route and not a workspace file API, and a single collapsed test
// would let one of them rot green.

async function refused(s, uri, content) {
  const g = await get(s, uri);
  assert.strictEqual(g.status, 404, 'GET ' + uri + ' → ' + JSON.stringify(g.body));
  const p = await s.api('PUT', '/api/artifact', { uri, content: content || 'pwned\n', version: '' });
  assert.strictEqual(p.status, 403, 'PUT ' + uri + ' → ' + JSON.stringify(p.body));
}

test('a file outside the playbooks dir is refused', async () => {
  const { s } = await boot({ 'default.md': 'ok\n' });
  try {
    const outside = path.join(s.dir, 'notes.md');
    fs.writeFileSync(outside, 'private\n');
    await refused(s, uriOf(outside));
    assert.strictEqual(fs.readFileSync(outside, 'utf8'), 'private\n');
  } finally { await s.stop(); }
});

test('a traversal out of the playbooks dir is refused — the client never supplies a prefix', async () => {
  const { s, dir } = await boot({ 'default.md': 'ok\n' });
  try {
    const board = path.join(s.dir, '.bridge-commander', 'board.json');
    const before = fs.readFileSync(board, 'utf8');
    await refused(s, uriOf(path.join(dir, '..', '..', 'board.json')));
    // the un-normalized spelling too — the string is what arrives, not a path object
    await refused(s, 'file://' + dir + '/../../board.json');
    assert.strictEqual(fs.readFileSync(board, 'utf8'), before, 'the board is untouched');
  } finally { await s.stop(); }
});

test('a non-.md file in the playbooks dir is refused', async () => {
  const { s, dir } = await boot({ 'default.md': 'ok\n' });
  try {
    const f = path.join(dir, 'notes.txt');
    fs.writeFileSync(f, 'not a playbook\n');
    await refused(s, uriOf(f));
    assert.strictEqual(fs.readFileSync(f, 'utf8'), 'not a playbook\n');
  } finally { await s.stop(); }
});

test('a symlink in the playbooks dir pointing outside it is refused, not followed', async () => {
  const { s, dir } = await boot({ 'default.md': 'ok\n' });
  try {
    const secret = path.join(s.dir, 'secret.md');
    fs.writeFileSync(secret, 'the good stuff\n');
    fs.symlinkSync(secret, path.join(dir, 'sneaky.md'));
    await refused(s, uriOf(path.join(dir, 'sneaky.md')));
    assert.strictEqual(fs.readFileSync(secret, 'utf8'), 'the good stuff\n');
  } finally { await s.stop(); }
});

test('a .md in a SUBDIRECTORY of the playbooks dir is refused — directly inside means directly', async () => {
  const { s, dir } = await boot({ 'default.md': 'ok\n' });
  try {
    fs.mkdirSync(path.join(dir, 'sub'));
    const f = path.join(dir, 'sub', 'nested.md');
    fs.writeFileSync(f, 'nested\n');
    await refused(s, uriOf(f));
    assert.strictEqual(fs.readFileSync(f, 'utf8'), 'nested\n');
  } finally { await s.stop(); }
});

test('a card artifact still reads and writes exactly as it did', async () => {
  const { s } = await boot({ 'default.md': 'ok\n' });
  try {
    const file = path.join(s.dir, 'report.md');
    fs.writeFileSync(file, 'v1\n');
    const cr = await s.api('POST', '/api/cards', withOwner({ title: 'Deliverable' }));
    const add = await s.api('POST', '/api/cards/' + cr.body.card.id + '/artifacts', { uri: file, label: 'report' });
    const uri = add.body.artifact.uri;

    const got = await get(s, uri);
    assert.strictEqual(got.status, 200);
    assert.strictEqual(got.body.version, sha256('v1\n'));
    const put = await s.api('PUT', '/api/artifact', { uri, content: 'v2\n', version: got.body.version });
    assert.strictEqual(put.status, 200, JSON.stringify(put.body));
    assert.strictEqual(fs.readFileSync(file, 'utf8'), 'v2\n');
  } finally { await s.stop(); }
});
