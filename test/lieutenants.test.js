'use strict';
// Lieutenant entity: create/list, validation, persistence, colors.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { startServer, runCli } = require('./helper');
const { charterPath, writeCharter } = require('../server/charter.js');

test('lieutenant create: slug id, palette color; a charter sent by a client is ignored; duplicates conflict', async () => {
  const s = await startServer();
  try {
    let r = await s.api('POST', '/api/lieutenants', { name: 'Grace Hopper', charter: 'own the compiler domain' });
    assert.strictEqual(r.status, 200);
    const lt = r.body.lieutenant;
    assert.strictEqual(lt.id, 'grace-hopper'); // slugged from name
    assert.strictEqual(lt.name, 'Grace Hopper');
    assert.match(lt.color, /^#[0-9a-fA-F]{6}$/); // auto-assigned from the palette
    // the charter is the lieutenant's memory file, never board state
    assert.ok(!('charter' in lt), 'POST does not store a charter');
    assert.ok(!fs.existsSync(charterPath(s.dir, 'grace-hopper')), 'and does not write one either');
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
    await s1.api('POST', '/api/lieutenants', { name: 'Ada', id: 'ada' });
  } finally {
    await s1.stop();
  }
  const s2 = await startServer({ dir });
  try {
    const list = (await s2.api('GET', '/api/lieutenants')).body.lieutenants;
    assert.strictEqual(list.length, 1);
    assert.strictEqual(list[0].id, 'ada');
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
    assert.ok(!('charter' in lt), 'PATCH ignores a charter sent by a client');
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
    // The memory file outlives the record — retire has to say so, with the path,
    // because the next lieutenant minted on this id would be launched on it.
    writeCharter(s.dir, 'gone', 'own the departures lounge');
    const r = await runCli(['lieutenant', 'retire', 'gone', ...args]);
    assert.strictEqual(r.code, 0, r.stderr);
    assert.match(r.stdout, /retired gone/);
    assert.ok(r.stdout.includes(charterPath(s.dir, 'gone')), 'retire names the memory file it kept');
    assert.strictEqual(fs.readFileSync(charterPath(s.dir, 'gone'), 'utf8'), 'own the departures lounge\n');
    assert.strictEqual((await s.api('GET', '/api/lieutenants')).body.lieutenants.length, 0);
  } finally {
    await s.stop();
  }
});

test('avatar: create with valid index, absent by default, out-of-range rejected; PATCH sets/clears', async () => {
  const s = await startServer();
  try {
    // absent by default — graceful colored-dot fallback
    let r = await s.api('POST', '/api/lieutenants', { name: 'No Face', id: 'noface' });
    assert.strictEqual(r.status, 200);
    assert.strictEqual(r.body.lieutenant.avatar, undefined);

    // valid index (including boundary 0 and 63)
    r = await s.api('POST', '/api/lieutenants', { name: 'Face Zero', id: 'face0', avatar: 0 });
    assert.strictEqual(r.status, 200);
    assert.strictEqual(r.body.lieutenant.avatar, 0);
    r = await s.api('POST', '/api/lieutenants', { name: 'Face Last', id: 'face63', avatar: 63 });
    assert.strictEqual(r.status, 200);
    assert.strictEqual(r.body.lieutenant.avatar, 63);

    // out-of-range / non-integer rejected on create
    r = await s.api('POST', '/api/lieutenants', { name: 'Bad', id: 'bad1', avatar: 64 });
    assert.strictEqual(r.status, 400);
    r = await s.api('POST', '/api/lieutenants', { name: 'Bad', id: 'bad2', avatar: -1 });
    assert.strictEqual(r.status, 400);
    r = await s.api('POST', '/api/lieutenants', { name: 'Bad', id: 'bad3', avatar: 1.5 });
    assert.strictEqual(r.status, 400);

    // PATCH sets avatar, then clears it back to fallback with null; out-of-range rejected
    r = await s.api('PATCH', '/api/lieutenants/noface', { avatar: 12 });
    assert.strictEqual(r.status, 200);
    assert.strictEqual(r.body.lieutenant.avatar, 12);
    r = await s.api('PATCH', '/api/lieutenants/noface', { avatar: 99 });
    assert.strictEqual(r.status, 400);
    r = await s.api('PATCH', '/api/lieutenants/noface', { avatar: null });
    assert.strictEqual(r.status, 200);
    assert.strictEqual(r.body.lieutenant.avatar, undefined);

    // color also PATCHable on an existing lieutenant, alongside avatar
    r = await s.api('PATCH', '/api/lieutenants/face0', { avatar: 7, color: '#123456' });
    assert.strictEqual(r.status, 200);
    assert.strictEqual(r.body.lieutenant.avatar, 7);
    assert.strictEqual(r.body.lieutenant.color, '#123456');
  } finally {
    await s.stop();
  }
});

test('cli: lieutenant create --avatar and lieutenant patch', async () => {
  const s = await startServer();
  const args = ['--workspace', s.dir, '--port', String(s.port)];
  try {
    let r = await runCli(['lieutenant', 'create', '--name', 'Avi', '--id', 'avi', '--avatar', '5', ...args]);
    assert.strictEqual(r.code, 0, r.stderr);
    let lt = (await s.api('GET', '/api/lieutenants')).body.lieutenants.find((l) => l.id === 'avi');
    assert.strictEqual(lt.avatar, 5);

    r = await runCli(['lieutenant', 'create', '--name', 'Bad', '--id', 'bad', '--avatar', '64', ...args]);
    assert.notStrictEqual(r.code, 0);
    assert.match(r.stderr, /--avatar must be an integer 0-63/);

    r = await runCli(['lieutenant', 'patch', 'avi', '--avatar', '9', '--color', '#abcdef', ...args]);
    assert.strictEqual(r.code, 0, r.stderr);
    assert.match(r.stdout, /lieutenant avi updated \(avatar=9 color=#abcdef prefix=AVI\)/);

    r = await runCli(['lieutenant', 'patch', 'avi', '--avatar', 'none', ...args]);
    assert.strictEqual(r.code, 0, r.stderr);
    assert.match(r.stdout, /avatar=none/);
    lt = (await s.api('GET', '/api/lieutenants')).body.lieutenants.find((l) => l.id === 'avi');
    assert.strictEqual(lt.avatar, undefined);
  } finally {
    await s.stop();
  }
});

test('cli: lieutenant create writes the charter to the memory file, and list reads it back', async () => {
  const s = await startServer();
  const args = ['--workspace', s.dir, '--port', String(s.port)];
  try {
    const charterFile = path.join(s.dir, 'charter.md');
    fs.writeFileSync(charterFile, 'Own the API surface.\nEscalate breaking changes.');
    let r = await runCli(['lieutenant', 'create', '--name', 'Ada', '--color', '#58b6ff', '--charter-file', charterFile, ...args]);
    assert.strictEqual(r.code, 0, r.stderr);
    assert.match(r.stdout, /lieutenant ada created \(#58b6ff, mints ADA-n\)/);

    r = await runCli(['lieutenant', 'list', ...args]);
    assert.strictEqual(r.code, 0, r.stderr);
    assert.match(r.stdout, /ada\tAda\t#58b6ff\tADA-1\tOwn the API surface\./);

    // --charter-file wrote the memory file, and the board record stayed clean
    assert.strictEqual(fs.readFileSync(charterPath(s.dir, 'ada'), 'utf8'),
      'Own the API surface.\nEscalate breaking changes.\n');
    r = await runCli(['lieutenant', 'list', '--json', ...args]);
    const parsed = JSON.parse(r.stdout);
    assert.ok(!('charter' in parsed[0]), 'the charter is not board state');

    // A second create against the same id leaves the memory file alone — the
    // lieutenant may have rewritten it, and it says so instead of clobbering.
    fs.writeFileSync(charterPath(s.dir, 'ada'), 'What Ada learned since.\n');
    fs.writeFileSync(charterFile, 'a replacement nobody asked for');
    r = await runCli(['lieutenant', 'create', '--name', 'Ada', '--charter-file', charterFile, ...args]);
    assert.notStrictEqual(r.code, 0, 'the duplicate id still 409s');
    assert.match(r.stdout, /charter left alone/);
    assert.strictEqual(fs.readFileSync(charterPath(s.dir, 'ada'), 'utf8'), 'What Ada learned since.\n');

    // an id the server would refuse never reaches the filesystem
    r = await runCli(['lieutenant', 'create', '--name', 'Esc', '--id', '../../escapee', '--charter-file', charterFile, ...args]);
    assert.notStrictEqual(r.code, 0);
    assert.match(r.stderr, /bad lieutenant id/);
    assert.ok(!fs.existsSync(charterPath(s.dir, '../../escapee')), 'nothing written outside the workspace');
  } finally {
    await s.stop();
  }
});

// The charter used to be a board field. Boot moves what is left of it into the
// lieutenant's memory file — but only where no file exists yet, because a second
// boot must not overwrite what the lieutenant has since written for itself.
test('boot migration: a leftover charter becomes the memory file, and the key is dropped', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bc-charter-'));
  const boardFile = path.join(dir, '.bridge-commander', 'board.json');
  const seed = (d) => {
    fs.mkdirSync(path.join(d, '.bridge-commander'), { recursive: true });
    fs.writeFileSync(path.join(d, '.bridge-commander', 'board.json'), JSON.stringify({
      lieutenants: [
        { id: 'ada', name: 'Ada', color: '#58b6ff', charter: 'own the API surface', chat: [] },
        { id: 'bo', name: 'Bo', color: '#2aa876', charter: 'stale — a file already says otherwise', chat: [] },
      ],
    }));
    // Bo has already written its own memory: the migration must not touch it.
    writeCharter(d, 'bo', 'what Bo actually wrote');
  };
  let s = await startServer({ dir, seed });
  try {
    assert.strictEqual(fs.readFileSync(charterPath(dir, 'ada'), 'utf8'), 'own the API surface\n');
    assert.strictEqual(fs.readFileSync(charterPath(dir, 'bo'), 'utf8'), 'what Bo actually wrote\n');
    const stored = JSON.parse(fs.readFileSync(boardFile, 'utf8'));
    assert.ok(stored.lieutenants.every((l) => !('charter' in l)), 'the key is gone from board.json either way');
    for (const lt of (await s.api('GET', '/api/lieutenants')).body.lieutenants) {
      assert.ok(!('charter' in lt), 'and gone from the served record');
    }

    // A second boot changes nothing — not the files, not the board.
    const before = fs.readFileSync(boardFile, 'utf8');
    await s.stop();
    s = await startServer({ dir });
    assert.strictEqual(fs.readFileSync(charterPath(dir, 'ada'), 'utf8'), 'own the API surface\n');
    assert.strictEqual(fs.readFileSync(charterPath(dir, 'bo'), 'utf8'), 'what Bo actually wrote\n');
    assert.strictEqual(fs.readFileSync(boardFile, 'utf8'), before, 'no rewrite on the second boot');
  } finally {
    await s.stop();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

// lieutenant.voice: the engine's opaque voice id. ABSENT is the default and it
// means "the board's voice speaks for me" — so clearing must really remove it,
// not store an empty string that some later reader mistakes for a choice.
test('lieutenant voice: set on create, patched, cleared back to the board voice, and on the board payload', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bc-voice-'));
  let s = await startServer({ dir });
  try {
    // no voice chosen: the field is simply not there
    await s.api('POST', '/api/lieutenants', { name: 'Ada', id: 'ada' });
    let lt = (await s.api('GET', '/api/lieutenants')).body.lieutenants.find((l) => l.id === 'ada');
    assert.strictEqual(lt.voice, undefined, 'no pick = inherit the board voice');

    // create with one, and patch the other's
    let r = await s.api('POST', '/api/lieutenants', { name: 'Grace', id: 'grace', voice: 'pt_BR-faber-medium' });
    assert.strictEqual(r.body.lieutenant.voice, 'pt_BR-faber-medium');
    r = await s.api('PATCH', '/api/lieutenants/ada', { voice: '  pt_BR-edresson-low  ' });
    assert.strictEqual(r.status, 200);
    assert.strictEqual(r.body.lieutenant.voice, 'pt_BR-edresson-low', 'trimmed, stored as given');

    // the board payload carries it — that is what the speaking UI reads
    const lts = (await s.api('GET', '/api/board')).body.lieutenants;
    assert.strictEqual(lts.find((l) => l.id === 'ada').voice, 'pt_BR-edresson-low');
    assert.strictEqual(lts.find((l) => l.id === 'grace').voice, 'pt_BR-faber-medium');

    // survives a restart
    await s.stop();
    s = await startServer({ dir });
    lt = (await s.api('GET', '/api/lieutenants')).body.lieutenants.find((l) => l.id === 'grace');
    assert.strictEqual(lt.voice, 'pt_BR-faber-medium');

    // "" and null clear the pick back to the board's voice
    for (const clear of ['', null]) {
      await s.api('PATCH', '/api/lieutenants/grace', { voice: 'pt_BR-faber-medium' });
      r = await s.api('PATCH', '/api/lieutenants/grace', { voice: clear });
      assert.strictEqual(r.status, 200);
      assert.strictEqual(r.body.lieutenant.voice, undefined, 'cleared with ' + JSON.stringify(clear));
      assert.ok(!('voice' in r.body.lieutenant), 'the key is gone, not empty');
    }

    // an untouched voice is left alone by an unrelated patch
    await s.api('PATCH', '/api/lieutenants/ada', { color: '#ff00ff' });
    lt = (await s.api('GET', '/api/lieutenants')).body.lieutenants.find((l) => l.id === 'ada');
    assert.strictEqual(lt.voice, 'pt_BR-edresson-low');
  } finally {
    await s.stop();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

// ---------- the card-id prefix (the head of every id this lieutenant mints) ----------

test('prefix: defaulted from the name, nudged aside when taken, explicit one refused instead', async () => {
  const s = await startServer();
  try {
    let r = await s.api('POST', '/api/lieutenants', { name: 'Monica' });
    assert.strictEqual(r.body.lieutenant.prefix, 'MON'); // first three letters
    assert.strictEqual(r.body.lieutenant.cardSeq, 0); // nothing minted yet

    // accents fold, emoji and punctuation drop
    r = await s.api('POST', '/api/lieutenants', { name: '🛰️ Wáldir' });
    assert.strictEqual(r.body.lieutenant.prefix, 'WAL');
    r = await s.api('POST', '/api/lieutenants', { name: '🤖', id: 'bot' });
    assert.strictEqual(r.body.lieutenant.prefix, 'LT'); // no letters at all

    // a DEFAULT that is taken is nudged aside — two lieutenants never share one
    r = await s.api('POST', '/api/lieutenants', { name: 'Monique' });
    assert.strictEqual(r.body.lieutenant.prefix, 'MO2');

    // an EXPLICIT one that is taken is refused, so the pick is never silently changed
    r = await s.api('POST', '/api/lieutenants', { name: 'Montana', prefix: 'mon' });
    assert.strictEqual(r.status, 409);
    assert.match(r.body.error, /prefix MON already belongs to Monica \(monica\)/);

    // an explicit free one is honored, uppercased
    r = await s.api('POST', '/api/lieutenants', { name: 'Montana', prefix: 'mtn' });
    assert.strictEqual(r.status, 200);
    assert.strictEqual(r.body.lieutenant.prefix, 'MTN');

    // shape is validated
    for (const bad of ['', '1st', '-', 'waytoolongprefix']) {
      r = await s.api('POST', '/api/lieutenants', { name: 'Bad ' + bad, id: 'bad-' + bad, prefix: bad });
      if (bad === '') { assert.strictEqual(r.status, 200); continue; } // "" = no pick, default applies
      assert.strictEqual(r.status, 400, JSON.stringify(bad));
      assert.match(r.body.error, /bad prefix/);
    }
  } finally {
    await s.stop();
  }
});

test('prefix patch: applies, refuses one another lieutenant holds, leaves minted ids alone', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bc-test-'));
  let s = await startServer({ dir });
  try {
    await s.api('POST', '/api/lieutenants', { name: 'Monica', id: 'monica' });
    await s.api('POST', '/api/lieutenants', { name: 'Waldir', id: 'waldir' });
    const first = (await s.api('POST', '/api/cards', { title: 'Before', owner: 'monica' })).body.card;
    assert.strictEqual(first.id, 'MON-1');

    // taken → 409, and NOTHING else in the same patch applies
    let r = await s.api('PATCH', '/api/lieutenants/monica', { prefix: 'WAL', color: '#123456' });
    assert.strictEqual(r.status, 409);
    assert.match(r.body.error, /already belongs to Waldir/);
    let lt = (await s.api('GET', '/api/lieutenants')).body.lieutenants.find((l) => l.id === 'monica');
    assert.strictEqual(lt.prefix, 'MON');
    assert.notStrictEqual(lt.color, '#123456');

    // its own prefix is not "taken" by itself
    r = await s.api('PATCH', '/api/lieutenants/monica', { prefix: 'MON' });
    assert.strictEqual(r.status, 200);

    // a free one applies; the counter carries on, and the card already minted keeps its id
    r = await s.api('PATCH', '/api/lieutenants/monica', { prefix: 'mnc' });
    assert.strictEqual(r.status, 200);
    assert.strictEqual(r.body.lieutenant.prefix, 'MNC');
    const next = (await s.api('POST', '/api/cards', { title: 'After', owner: 'monica' })).body.card;
    assert.strictEqual(next.id, 'MNC-2');
    assert.strictEqual((await s.api('GET', '/api/cards/MON-1')).body.id, 'MON-1');

    // survives a restart
    await s.stop();
    s = await startServer({ dir });
    lt = (await s.api('GET', '/api/lieutenants')).body.lieutenants.find((l) => l.id === 'monica');
    assert.strictEqual(lt.prefix, 'MNC');
    assert.strictEqual(lt.cardSeq, 2);
  } finally {
    await s.stop();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('prefix + counter are backfilled for lieutenants that predate them, without touching their cards', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bc-test-'));
  const s = await startServer({
    dir,
    seed(d) {
      fs.mkdirSync(path.join(d, '.bridge-commander'), { recursive: true });
      fs.writeFileSync(path.join(d, '.bridge-commander', 'board.json'), JSON.stringify({
        lieutenants: [
          { id: 'monica', name: 'Monica', color: '#7c5cff', chat: [] },
          { id: 'monique', name: 'Monique', color: '#2aa876', chat: [] },
        ],
        cards: [{ id: 'pane-interactive', title: 'Old slug card', type: 'implementation',
          owner: 'monica', column: 'backlog', labels: [], attributes: {}, body: '',
          events: [], thread: [] }],
      }));
    },
  });
  try {
    const lts = (await s.api('GET', '/api/lieutenants')).body.lieutenants;
    assert.strictEqual(lts.find((l) => l.id === 'monica').prefix, 'MON');
    assert.strictEqual(lts.find((l) => l.id === 'monique').prefix, 'MO2'); // no two share one
    assert.strictEqual(lts.find((l) => l.id === 'monica').cardSeq, 0);

    // the slug card is untouched and still answers to its id everywhere
    const card = (await s.api('GET', '/api/cards/pane-interactive')).body;
    assert.strictEqual(card.id, 'pane-interactive');
    assert.strictEqual((await s.api('PATCH', '/api/cards/pane-interactive', { title: 'Renamed' })).status, 200);

    // and the counter numbers what comes NEXT, blind to the slugs already there
    assert.strictEqual((await s.api('POST', '/api/cards', { title: 'New', owner: 'monica' })).body.card.id, 'MON-1');
  } finally {
    await s.stop();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
