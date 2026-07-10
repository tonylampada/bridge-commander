'use strict';
// Lieutenant entity: create/list, validation, persistence, colors.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { startServer, runCli } = require('./helper');

test('lieutenant create: slug id, palette color, charter; duplicates conflict', async () => {
  const s = await startServer();
  try {
    let r = await s.api('POST', '/api/lieutenants', { name: 'Grace Hopper', charter: 'own the compiler domain' });
    assert.strictEqual(r.status, 200);
    const lt = r.body.lieutenant;
    assert.strictEqual(lt.id, 'grace-hopper'); // slugged from name
    assert.strictEqual(lt.name, 'Grace Hopper');
    assert.match(lt.color, /^#[0-9a-fA-F]{6}$/); // auto-assigned from the palette
    assert.strictEqual(lt.charter, 'own the compiler domain');
    assert.deepStrictEqual(lt.chat, []);

    // explicit id and color
    r = await s.api('POST', '/api/lieutenants', { name: 'Ada', id: 'ada', color: '#ff00ff' });
    assert.strictEqual(r.body.lieutenant.color, '#ff00ff');

    // second lieutenant got a different auto color than the first
    const list = (await s.api('GET', '/api/lieutenants')).body.lieutenants;
    assert.strictEqual(list.length, 2);

    // duplicate id conflicts; name required; bad id rejected
    r = await s.api('POST', '/api/lieutenants', { name: 'Ada again', id: 'ada' });
    assert.strictEqual(r.status, 409);
    r = await s.api('POST', '/api/lieutenants', { name: '  ' });
    assert.strictEqual(r.status, 400);
    r = await s.api('POST', '/api/lieutenants', { name: 'X', id: 'bad id!' });
    assert.strictEqual(r.status, 400);
  } finally {
    await s.stop();
  }
});

test('emoji-safe naming: id is the ASCII slug, display name keeps the emoji, session stays ASCII', async () => {
  const fdir = fs.mkdtempSync(path.join(os.tmpdir(), 'bc-fake-'));
  const s = await startServer({ env: { BC_FAKE_STATE: fdir } });
  try {
    // ZWJ emoji sequence + name → emoji stripped from the id, kept in the name
    let r = await s.api('POST', '/api/lieutenants', {
      name: '👩‍🦰 marcela', spawn: true, harness: 'fake',
    });
    assert.strictEqual(r.status, 200, JSON.stringify(r.body));
    assert.strictEqual(r.body.lieutenant.id, 'marcela');
    assert.strictEqual(r.body.lieutenant.name, '👩‍🦰 marcela', 'display keeps the emoji');
    assert.match(r.body.lieutenant.ref.session, /^bc-[A-Za-z0-9-]+-lt-marcela$/, 'emoji never reach tmux');
    // eslint-disable-next-line no-control-regex
    assert.match(r.body.lieutenant.ref.session, /^[\x21-\x7e]+$/, 'session name is pure ASCII');

    // pure-emoji names still yield usable, unique ids (fallback 'lt', deduped)
    r = await s.api('POST', '/api/lieutenants', { name: '👩‍🦰' });
    assert.strictEqual(r.status, 200);
    assert.strictEqual(r.body.lieutenant.id, 'lt');
    assert.strictEqual(r.body.lieutenant.name, '👩‍🦰');
    r = await s.api('POST', '/api/lieutenants', { name: '🧔' });
    assert.strictEqual(r.status, 200);
    assert.strictEqual(r.body.lieutenant.id, 'lt-2');
  } finally {
    await s.stop();
    fs.rmSync(fdir, { recursive: true, force: true });
  }
});

test('lieutenants persist with the board and survive a restart', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bc-test-'));
  const s1 = await startServer({ dir });
  try {
    await s1.api('POST', '/api/lieutenants', { name: 'Ada', id: 'ada', charter: 'ship the harness' });
  } finally {
    await s1.stop();
  }
  const s2 = await startServer({ dir });
  try {
    const list = (await s2.api('GET', '/api/lieutenants')).body.lieutenants;
    assert.strictEqual(list.length, 1);
    assert.strictEqual(list[0].id, 'ada');
    assert.strictEqual(list[0].charter, 'ship the harness');
  } finally {
    await s2.stop();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('harness ref: persisted with the lieutenant, survives restart, PATCH updates it', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bc-test-'));
  const ref = { harness: 'fake', session: 'bc-r1', cwd: '/tmp' };
  const s1 = await startServer({ dir });
  try {
    let r = await s1.api('POST', '/api/lieutenants', { name: 'Ref Bearer', id: 'refb', ref });
    assert.strictEqual(r.status, 200);
    assert.deepStrictEqual(r.body.lieutenant.ref, ref);
    // a malformed ref is rejected outright
    r = await s1.api('POST', '/api/lieutenants', { name: 'Bad', id: 'bad', ref: { harness: 'fake' } });
    assert.strictEqual(r.status, 400);
  } finally {
    await s1.stop();
  }
  const s2 = await startServer({ dir });
  try {
    let lt = (await s2.api('GET', '/api/lieutenants')).body.lieutenants[0];
    assert.deepStrictEqual(lt.ref, ref, 'ref survives a restart (board is truth)');
    // PATCH: refresh the ref (init idempotency), reject junk, clear with null
    const ref2 = { harness: 'fake', session: 'bc-r2', cwd: '/tmp', resumeId: 'uuid-r2' };
    let r = await s2.api('PATCH', '/api/lieutenants/refb', { ref: ref2 });
    assert.strictEqual(r.status, 200);
    assert.deepStrictEqual(r.body.lieutenant.ref, ref2);
    r = await s2.api('PATCH', '/api/lieutenants/refb', { ref: { nope: 1 } });
    assert.strictEqual(r.status, 400);
    r = await s2.api('PATCH', '/api/lieutenants/refb', { ref: null, charter: 'updated charter' });
    assert.strictEqual(r.status, 200);
    lt = (await s2.api('GET', '/api/lieutenants')).body.lieutenants[0];
    assert.strictEqual(lt.ref, null);
    assert.strictEqual(lt.charter, 'updated charter');
    assert.strictEqual((await s2.api('PATCH', '/api/lieutenants/nobody', {})).status, 404);
  } finally {
    await s2.stop();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('lieutenant.retire: refuses with owned cards; else kills session, removes queue, level-1 event', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'bc-retire-'));
  const fakeDir = path.join(root, 'fake');
  fs.mkdirSync(fakeDir, { recursive: true });
  // pre-register a "live" fake session for the lieutenant (file-backed mode:
  // a marker on disk counts as alive; kill removes it)
  const marker = path.join(fakeDir, 'bc-lt-ret.json');
  fs.writeFileSync(marker, '{}');
  const s = await startServer({ env: { BC_FAKE_STATE: fakeDir, BC_SUPERVISE_INTERVAL_MS: '0', BC_PRWATCH_INTERVAL_MS: '0' } });
  try {
    await s.api('POST', '/api/lieutenants', {
      name: 'Retiree', id: 'ret', ref: { harness: 'fake', session: 'bc-lt-ret', cwd: '/tmp' },
    });
    await s.api('POST', '/api/cards', { title: 'Held', id: 'held', owner: 'ret' });
    await s.api('POST', '/api/feedback', { target: 'lieutenant:ret', text: 'note' });
    const queueFile = path.join(s.dir, '.bridge-commander', 'queue', 'ret.jsonl');
    assert.ok(fs.existsSync(queueFile), 'queue file exists before retire');

    // refused while the lieutenant owns non-archived cards
    let r = await s.api('DELETE', '/api/lieutenants/ret');
    assert.strictEqual(r.status, 409);
    assert.match(r.body.error, /still owns 1 card.*held/);

    // archive the card, retire goes through
    await s.api('POST', '/api/cards/held/archive', { reason: 'killed' });
    r = await s.api('DELETE', '/api/lieutenants/ret', { actor: 'user' });
    assert.strictEqual(r.status, 200);
    assert.strictEqual((await s.api('GET', '/api/lieutenants')).body.lieutenants.length, 0);
    assert.ok(!fs.existsSync(marker), 'live session killed (fake marker removed)');
    assert.ok(!fs.existsSync(queueFile), 'delivery queue removed');
    const b = (await s.api('GET', '/api/board')).body;
    const ev = b.events.find((e) => /Retiree retired/.test(e.text));
    assert.ok(ev, 'retired event on the board stream');
    assert.strictEqual(ev.level, 1, 'retirement is loud');

    // unknown lieutenant 404s
    assert.strictEqual((await s.api('DELETE', '/api/lieutenants/nobody')).status, 404);
  } finally {
    await s.stop();
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('cli: lieutenant retire', async () => {
  const s = await startServer();
  const args = ['--workspace', s.dir, '--port', String(s.port)];
  try {
    await s.api('POST', '/api/lieutenants', { name: 'Gone', id: 'gone' });
    const r = await runCli(['lieutenant', 'retire', 'gone', ...args]);
    assert.strictEqual(r.code, 0, r.stderr);
    assert.match(r.stdout, /retired gone/);
    assert.strictEqual((await s.api('GET', '/api/lieutenants')).body.lieutenants.length, 0);
  } finally {
    await s.stop();
  }
});

test('cli: lieutenant create (charter via stdin file) and list', async () => {
  const s = await startServer();
  const args = ['--workspace', s.dir, '--port', String(s.port)];
  try {
    const charterFile = path.join(s.dir, 'charter.md');
    fs.writeFileSync(charterFile, 'Own the API surface.\nEscalate breaking changes.');
    let r = await runCli(['lieutenant', 'create', '--name', 'Ada', '--color', '#58b6ff', '--charter-file', charterFile, ...args]);
    assert.strictEqual(r.code, 0, r.stderr);
    assert.match(r.stdout, /lieutenant ada created \(#58b6ff\)/);

    r = await runCli(['lieutenant', 'list', ...args]);
    assert.strictEqual(r.code, 0, r.stderr);
    assert.match(r.stdout, /ada\tAda\t#58b6ff\tOwn the API surface\./);

    r = await runCli(['lieutenant', 'list', '--json', ...args]);
    const parsed = JSON.parse(r.stdout);
    assert.strictEqual(parsed[0].charter, 'Own the API surface.\nEscalate breaking changes.');
  } finally {
    await s.stop();
  }
});
