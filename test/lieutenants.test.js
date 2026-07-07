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
