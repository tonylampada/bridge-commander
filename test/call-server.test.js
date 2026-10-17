'use strict';
// Call mode's server half: a captain message posted with `via: 'call'` carries
// that channel in its queue envelope (so drain tells the lieutenant he is on a
// call and the reply will be spoken) and on the chat message (so the thread
// shows the words were spoken). His text is never touched.
const test = require('node:test');
const assert = require('node:assert');
const { startServerWithLieutenant, runCli, LT } = require('./helper');

test('via: call rides the envelope and the chat message, and drain says so', async () => {
  const s = await startServerWithLieutenant();
  try {
    const r = await s.api('POST', '/api/feedback', { target: 'lieutenant:' + LT, text: 'como está o deploy?', via: 'call' });
    assert.strictEqual(r.status, 200);
    assert.strictEqual(r.body.via, 'call');

    const board = (await s.api('GET', '/api/board')).body;
    const lt = board.lieutenants.find((l) => l.id === LT);
    const m = lt.chat[lt.chat.length - 1];
    assert.strictEqual(m.text, 'como está o deploy?');
    assert.strictEqual(m.via, 'call');

    const out = await runCli(['drain', '--lieutenant', LT, '--workspace', s.dir, '--port', String(s.port)]);
    assert.strictEqual(out.code, 0, out.stderr);
    assert.match(out.stdout, /ON A CALL/);
    assert.match(out.stdout, /1–3 short spoken sentences/);
    assert.match(out.stdout, /como está o deploy\?/);
    assert.doesNotMatch(out.stdout, /captain message \(your main chat\)/);
  } finally {
    await s.stop();
  }
});

test('any other via is ignored: an ordinary message stays ordinary', async () => {
  const s = await startServerWithLieutenant();
  try {
    const r = await s.api('POST', '/api/feedback', { target: 'lieutenant:' + LT, text: 'oi', via: 'carrier-pigeon' });
    assert.strictEqual(r.status, 200);
    assert.strictEqual(r.body.via, undefined);
    const lt = (await s.api('GET', '/api/board')).body.lieutenants.find((l) => l.id === LT);
    assert.strictEqual(lt.chat[lt.chat.length - 1].via, undefined);
    const out = await runCli(['drain', '--lieutenant', LT, '--workspace', s.dir, '--port', String(s.port)]);
    assert.match(out.stdout, /captain message \(your main chat\)/);
  } finally {
    await s.stop();
  }
});

// publicUrl: the board's https address, named to an http page that cannot
// open a microphone. Only an https URL is passed on.
test('/api/config carries publicUrl when it is an https address, and only then', async () => {
  const fs = require('node:fs');
  const path = require('node:path');
  const { startServer } = require('./helper');
  const seed = (cfg) => (dir) => {
    const sd = path.join(dir, '.bridge-commander');
    fs.mkdirSync(sd, { recursive: true });
    fs.writeFileSync(path.join(sd, 'config.json'), JSON.stringify(cfg));
  };
  let s = await startServer({ seed: seed({ publicUrl: ' https://jarbas.tail925c5f.ts.net ' }) });
  try { assert.equal((await s.api('GET', '/api/config')).body.publicUrl, 'https://jarbas.tail925c5f.ts.net'); } finally { await s.stop(); }
  s = await startServer({ seed: seed({ publicUrl: 'http://jarbas:4780' }) });
  try { assert.equal((await s.api('GET', '/api/config')).body.publicUrl, undefined); } finally { await s.stop(); }
});
