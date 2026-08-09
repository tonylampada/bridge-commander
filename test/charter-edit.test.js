'use strict';
// Editing a lieutenant's charter through the artifact routes — what the config
// screen's lieutenants section rides on.
//
// The charter is a file (server/charter.js: <workspace>/lieutenants/<id>/README.md),
// so editing one is the file screen and the same PUT /api/artifact a card
// artifact is saved with: one editor, one version check, one 409. That means
// exactly one more widening of the gate, and this file is where its edges live.
// The accepted shape is the path charterPath() BUILDS from the workspace root
// and a REGISTERED id — nothing else. Not an unregistered id, not another file
// in that folder, not a subdirectory of it, not a symlink, and no directory
// prefix from the client. The playbook and card-artifact paths are untouched.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { startServerWithLieutenant, withOwner } = require('./helper');
const { charterPath } = require('../server/charter.js');

const sha256 = (s) => crypto.createHash('sha256').update(s).digest('hex');
const uriOf = (f) => 'file://' + f;
const get = (s, uri) => s.api('GET', '/api/artifact?uri=' + encodeURIComponent(uri));

// startServerWithLieutenant registers "ada"; her memory folder is not written
// until something writes a charter, which is the interesting starting state.
async function boot(text) {
  const s = await startServerWithLieutenant();
  const file = charterPath(s.dir, 'ada');
  if (text != null) {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, text);
  }
  return { s, file };
}

test('a registered lieutenant’s charter reads and writes through the artifact routes, version check and all', async () => {
  const { s, file } = await boot('# Ada\n\nowns the compiler.\n');
  try {
    const uri = uriOf(file);
    const got = await get(s, uri);
    assert.strictEqual(got.status, 200, JSON.stringify(got.body));
    assert.strictEqual(got.body.name, 'README.md');
    assert.strictEqual(got.body.content, '# Ada\n\nowns the compiler.\n');
    assert.strictEqual(got.body.version, sha256('# Ada\n\nowns the compiler.\n'));

    const put = await s.api('PUT', '/api/artifact', { uri, content: 'rewritten\n', version: got.body.version });
    assert.strictEqual(put.status, 200, JSON.stringify(put.body));
    assert.strictEqual(fs.readFileSync(file, 'utf8'), 'rewritten\n');

    // …and a stale version is still refused, carrying what is on disk now
    const stale = await s.api('PUT', '/api/artifact', { uri, content: 'mine\n', version: got.body.version });
    assert.strictEqual(stale.status, 409);
    assert.match(stale.body.error, /changed on disk/);
    assert.strictEqual(stale.body.content, 'rewritten\n');
    assert.strictEqual(stale.body.version, sha256('rewritten\n'));
    assert.strictEqual(fs.readFileSync(file, 'utf8'), 'rewritten\n', 'nothing was written');
  } finally { await s.stop(); }
});

// A lieutenant registered without --charter-file has no memory file and no
// folder to put one in. The row still offers ✎, so the GET has to answer — with
// the empty document at version '', which is what the PUT reads as "I expect no
// file" (the same create a derived card artifact is written with).
test('a lieutenant with no charter yet opens on the empty document, and the first save creates it', async () => {
  const { s, file } = await boot();
  try {
    assert.ok(!fs.existsSync(path.dirname(file)), 'no memory folder to start with');
    const uri = uriOf(file);
    const got = await get(s, uri);
    assert.strictEqual(got.status, 200, JSON.stringify(got.body));
    assert.deepStrictEqual({ name: got.body.name, content: got.body.content, version: got.body.version },
      { name: 'README.md', content: '', version: '' });

    const put = await s.api('PUT', '/api/artifact', { uri, content: 'first words\n', version: '' });
    assert.strictEqual(put.status, 200, JSON.stringify(put.body));
    assert.strictEqual(fs.readFileSync(file, 'utf8'), 'first words\n');
    assert.strictEqual(put.body.version, sha256('first words\n'));

    // and now it is an ordinary file: the create version no longer applies
    const again = await s.api('PUT', '/api/artifact', { uri, content: 'clobber\n', version: '' });
    assert.strictEqual(again.status, 409);
    assert.strictEqual(fs.readFileSync(file, 'utf8'), 'first words\n');
  } finally { await s.stop(); }
});

// ---------- what the gate refuses ----------
// Each of these is its own test on purpose: they are the reasons this is a
// charter route and not a workspace file API, and a single collapsed test would
// let one of them rot green.

async function refused(s, uri, content) {
  const g = await get(s, uri);
  assert.strictEqual(g.status, 404, 'GET ' + uri + ' → ' + JSON.stringify(g.body));
  const p = await s.api('PUT', '/api/artifact', { uri, content: content || 'pwned\n', version: '' });
  assert.strictEqual(p.status, 403, 'PUT ' + uri + ' → ' + JSON.stringify(p.body));
}

test('the README of an id no lieutenant holds is refused', async () => {
  const { s } = await boot('mine\n');
  try {
    const ghost = charterPath(s.dir, 'mallory');
    fs.mkdirSync(path.dirname(ghost), { recursive: true });
    fs.writeFileSync(ghost, 'not a lieutenant\n');
    await refused(s, uriOf(ghost));
    assert.strictEqual(fs.readFileSync(ghost, 'utf8'), 'not a lieutenant\n');
  } finally { await s.stop(); }
});

test('another file in the lieutenant’s own folder is refused — the charter is README.md and only that', async () => {
  const { s, file } = await boot('mine\n');
  try {
    const other = path.join(path.dirname(file), 'notes.md');
    fs.writeFileSync(other, 'private\n');
    await refused(s, uriOf(other));
    assert.strictEqual(fs.readFileSync(other, 'utf8'), 'private\n');
  } finally { await s.stop(); }
});

test('a README in a SUBDIRECTORY of the lieutenant’s folder is refused — the folder is not a tree to edit', async () => {
  const { s, file } = await boot('mine\n');
  try {
    const sub = path.join(path.dirname(file), 'examples');
    fs.mkdirSync(sub, { recursive: true });
    const nested = path.join(sub, 'README.md');
    fs.writeFileSync(nested, 'nested\n');
    await refused(s, uriOf(nested));
    assert.strictEqual(fs.readFileSync(nested, 'utf8'), 'nested\n');
  } finally { await s.stop(); }
});

test('a charter that is a symlink is refused, not followed', async () => {
  const { s, file } = await boot();
  try {
    const secret = path.join(s.dir, 'secret.md');
    fs.writeFileSync(secret, 'the good stuff\n');
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.symlinkSync(secret, file);
    await refused(s, uriOf(file));
    assert.strictEqual(fs.readFileSync(secret, 'utf8'), 'the good stuff\n');
  } finally { await s.stop(); }
});

test('a traversal out of the lieutenants folder is refused — the client never supplies a prefix', async () => {
  const { s, file } = await boot('mine\n');
  try {
    const brd = path.join(s.dir, '.bridge-commander', 'board.json');
    const before = fs.readFileSync(brd, 'utf8');
    const dir = path.dirname(file);
    await refused(s, uriOf(path.join(dir, '..', '..', '.bridge-commander', 'board.json')));
    // the un-normalized spelling too — the string is what arrives, not a path object
    await refused(s, 'file://' + dir + '/../../.bridge-commander/board.json');
    // …and one that spells its way BACK to a real charter is still not one
    await refused(s, 'file://' + dir + '/../ada/README.md');
    assert.strictEqual(fs.readFileSync(brd, 'utf8'), before, 'the board is untouched');
    assert.strictEqual(fs.readFileSync(file, 'utf8'), 'mine\n', 'and so is the charter');
  } finally { await s.stop(); }
});

test('a retired lieutenant’s charter stops being editable — the id is what the gate matches', async () => {
  const { s, file } = await boot('mine\n');
  try {
    assert.strictEqual((await get(s, uriOf(file))).status, 200);
    const r = await s.api('DELETE', '/api/lieutenants/ada', { actor: 'user' });
    assert.strictEqual(r.status, 200, JSON.stringify(r.body));
    await refused(s, uriOf(file));
    assert.strictEqual(fs.readFileSync(file, 'utf8'), 'mine\n', 'the file is kept, just not writable from here');
  } finally { await s.stop(); }
});

test('a card artifact and a playbook still read and write exactly as they did', async () => {
  const { s } = await boot('mine\n');
  try {
    const f = path.join(s.dir, 'report.md');
    fs.writeFileSync(f, 'v1\n');
    const cr = await s.api('POST', '/api/cards', withOwner({ title: 'Deliverable' }));
    const add = await s.api('POST', '/api/cards/' + cr.body.card.id + '/artifacts', { uri: f, label: 'report' });
    const uri = add.body.artifact.uri;
    const got = await get(s, uri);
    assert.strictEqual(got.status, 200);
    const put = await s.api('PUT', '/api/artifact', { uri, content: 'v2\n', version: got.body.version });
    assert.strictEqual(put.status, 200, JSON.stringify(put.body));
    assert.strictEqual(fs.readFileSync(f, 'utf8'), 'v2\n');

    const packaged = (await s.api('GET', '/api/playbooks')).body.items.find((p) => p.source === 'packaged');
    assert.strictEqual((await get(s, uriOf(packaged.file))).status, 200, 'a packaged playbook still opens');
  } finally { await s.stop(); }
});
