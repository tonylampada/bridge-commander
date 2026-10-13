'use strict';
// Web Push (MNC-256): the protocol against RFC 8291's own vector, VAPID signing,
// the subscription store, the event → push policy, 404/410 pruning, and the
// server end to end against a fake push service that decrypts what it receives.
const test = require('node:test');
const assert = require('node:assert');
const crypto = require('node:crypto');
const fs = require('node:fs');
const http = require('node:http');
const os = require('node:os');
const path = require('node:path');
const wp = require('../server/webpush.js');
const { startServerWithLieutenant, withOwner, sleep, LT } = require('./helper');

// RFC 8291 §5 / Appendix A
const V = {
  plaintext: 'When I grow up, I want to be a watermelon',
  asPrivate: 'yfWPiYE-n46HLnH0KqZOF1fJJU3MYrct3AELtAQ-oRw',
  uaPublic: 'BCVxsr7N_eNgVRqvHtD0zTZsEc6-VV-JvLexhqUzORcxaOzi6-AYWXvTBHm4bjyPjs7Vd8pZGH6SRpkNtoIAiw4',
  uaPrivate: 'q1dXpw3UpT5VOmu_cf_v6ih07Aems3njxI-JWgLcM94',
  salt: 'DGv6ra1nlYgDCS1FRnbzlw',
  auth: 'BTBZMqHH6r4Tts7J_aSIgg',
  body: 'DGv6ra1nlYgDCS1FRnbzlwAAEABBBP4z9KsN6nGRTbVYI_c7VJSPQTBtkgcy27ml'
    + 'mlMoZIIgDll6e3vCYLocInmYWAmS6TlzAC8wEqKK6PBru3jl7A_yl95bQpu6cVPT'
    + 'pK4Mqgkf1CXztLVBSt2Ks3oZwbuwXPXLWyouBWLVWGNWQexSgSxsj_Qulcy4a-fN',
};

test('aes128gcm: encrypt reproduces the RFC 8291 example byte for byte', () => {
  const out = wp.encrypt(V.plaintext, { p256dh: V.uaPublic, auth: V.auth }, { salt: V.salt, asPrivate: V.asPrivate });
  assert.strictEqual(out.toString('base64url'), V.body);
});

test('aes128gcm: the RFC body decrypts with the user agent key; random salt/key round-trips', () => {
  assert.strictEqual(wp.decrypt(Buffer.from(V.body, 'base64url'), V.uaPrivate, V.auth).toString(), V.plaintext);
  const out = wp.encrypt('{"title":"hi"}', { p256dh: V.uaPublic, auth: V.auth });
  assert.notStrictEqual(out.toString('base64url'), V.body);
  assert.strictEqual(wp.decrypt(out, V.uaPrivate, V.auth).toString(), '{"title":"hi"}');
  assert.throws(() => wp.encrypt('x', { p256dh: 'AAAA', auth: V.auth }), /bad subscription keys/);
});

test('VAPID: ES256 JWT verifies under the public key, with aud = endpoint origin', () => {
  const keys = wp.generateVapidKeys();
  assert.strictEqual(Buffer.from(keys.publicKey, 'base64url').length, 65);
  assert.strictEqual(Buffer.from(keys.privateKey, 'base64url').length, 32);
  const h = wp.vapidAuthorization('https://web.push.apple.com/QGx/abc', keys, 'mailto:cap@example.com', 1000);
  const m = /^vapid t=([^,]+), k=(\S+)$/.exec(h);
  assert.ok(m, h);
  assert.strictEqual(m[2], keys.publicKey);
  const [hd, cl, sig] = m[1].split('.');
  assert.deepStrictEqual(JSON.parse(Buffer.from(hd, 'base64url')), { typ: 'JWT', alg: 'ES256' });
  assert.deepStrictEqual(JSON.parse(Buffer.from(cl, 'base64url')),
    { aud: 'https://web.push.apple.com', exp: 1000 + 12 * 3600, sub: 'mailto:cap@example.com' });
  const pub = Buffer.from(keys.publicKey, 'base64url');
  const key = crypto.createPublicKey({ format: 'jwk', key: { kty: 'EC', crv: 'P-256',
    x: pub.subarray(1, 33).toString('base64url'), y: pub.subarray(33).toString('base64url') } });
  assert.ok(crypto.verify('sha256', Buffer.from(hd + '.' + cl), { key, dsaEncoding: 'ieee-p1363' }, Buffer.from(sig, 'base64url')));
});

function tmpState() { return fs.mkdtempSync(path.join(os.tmpdir(), 'bc-push-')); }
const SUB = (n) => ({ endpoint: 'https://push.example/' + n, keys: { p256dh: V.uaPublic, auth: V.auth } });

test('store: VAPID generated once, self-ignoring dir, subscriptions deduped by endpoint', () => {
  const dir = tmpState();
  const st = wp.createPushStore(dir);
  assert.deepStrictEqual(st.list(), []);
  const k1 = st.vapid();
  assert.deepStrictEqual(wp.createPushStore(dir).vapid(), k1, 'a second store reads the same keypair');
  assert.match(fs.readFileSync(path.join(dir, 'push', '.gitignore'), 'utf8'), /^\*$/m);
  assert.strictEqual(fs.statSync(path.join(dir, 'push', 'vapid.json')).mode & 0o077, 0, 'key file private');

  const D = wp.defaultPushCategories();
  assert.deepStrictEqual(st.add(SUB('a')), { ok: true, count: 1, categories: D });
  assert.deepStrictEqual(st.add(SUB('b'), { ua: 'iPhone' }), { ok: true, count: 2, categories: D });
  assert.deepStrictEqual(st.add(SUB('a')), { ok: true, count: 2, categories: D }, 'same device re-subscribing replaces');
  assert.deepStrictEqual(st.list().map((s) => s.endpoint).sort(), ['https://push.example/a', 'https://push.example/b']);
  assert.ok(st.add({ endpoint: 'ftp://x', keys: SUB('x').keys }).error);
  assert.ok(st.add({ endpoint: 'https://x', keys: { p256dh: 'AA', auth: V.auth } }).error);
  assert.strictEqual(st.remove('https://push.example/a'), true);
  assert.strictEqual(st.remove('https://push.example/a'), false);
  assert.strictEqual(wp.createPushStore(dir).list().length, 1, 'persisted');
});

test('categories: defaults are everything but other — worker-stopped included in the off one', () => {
  assert.deepStrictEqual(wp.defaultPushCategories(), { done: true, chat: true, error: true, other: false });
  assert.deepStrictEqual(wp.PUSH_CATEGORIES, ['done', 'chat', 'error', 'other']);
  const P = (kind, level) => wp.pushFor({ kind, level, actor: 'ada', text: 'x' }, {}).category;
  assert.strictEqual(P('worker-stopped', 2), 'other');
  assert.strictEqual(P('worker-done', 2), 'done');
  assert.strictEqual(P('handoff', 1), 'done');
  assert.strictEqual(P('needs-captain', 1), 'error');
  assert.strictEqual(P('question', 1), 'chat');
  assert.strictEqual(P('signal', 2), 'other');
  assert.strictEqual(wp.defaultPushCategories()[P('worker-stopped', 2)], false, 'a stopped worker does not buzz by default');
});

test('store: per-device categories — read, patch, persist, unknown device', () => {
  const dir = tmpState();
  const st = wp.createPushStore(dir);
  st.add(SUB('a'));
  st.add(SUB('b'));
  assert.deepStrictEqual(st.setCategories(SUB('a').endpoint, { other: true, chat: false, bogus: true, done: 'yes' }),
    { done: true, chat: false, error: true, other: true }, 'booleans for known keys only');
  assert.deepStrictEqual(st.setCategories(SUB('a').endpoint, { error: false }),
    { done: true, chat: false, error: false, other: true }, 'a patch, not a replace');
  assert.strictEqual(st.setCategories('https://push.example/nobody', { done: false }), null);
  const again = wp.createPushStore(dir);
  const byEp = (e) => again.list().find((s) => s.endpoint === e);
  assert.deepStrictEqual(again.categoriesOf(byEp(SUB('a').endpoint)), { done: true, chat: false, error: false, other: true }, 'survives a restart');
  assert.deepStrictEqual(again.categoriesOf(byEp(SUB('b').endpoint)), wp.defaultPushCategories(), 'the other device untouched');
  assert.deepStrictEqual(again.categoriesOf({ endpoint: 'x' }), wp.defaultPushCategories(), 'a pre-categories record reads as the defaults');
});

test('store: resubscribe keeps the categories — same endpoint, rotation, and the device-remembered copy', () => {
  const st = wp.createPushStore(tmpState());
  const mine = { done: false, chat: true, error: true, other: true };
  st.add(SUB('a'));
  st.setCategories(SUB('a').endpoint, mine);
  assert.deepStrictEqual(st.add(SUB('a'), { categories: { done: true } }).categories, mine, 'the server record wins over the device copy');
  // rotation: pushsubscriptionchange hands over the old endpoint
  const r = st.add(SUB('a2'), { old: SUB('a').endpoint });
  assert.deepStrictEqual(r, { ok: true, count: 1, categories: mine });
  assert.deepStrictEqual(st.list().map((s) => s.endpoint), [SUB('a2').endpoint], 'the old endpoint is gone');
  // pruned (410) or turned off and on: the device brings its last-known copy
  st.remove(SUB('a2').endpoint);
  assert.deepStrictEqual(st.add(SUB('a3'), { categories: mine }).categories, mine);
  assert.deepStrictEqual(st.add(SUB('fresh'), { categories: 'junk' }).categories, wp.defaultPushCategories());
});

test('broadcast: a categorised payload reaches only the devices that take it', async () => {
  const st = wp.createPushStore(tmpState());
  for (const n of ['all', 'quiet']) st.add(SUB(n));
  st.setCategories(SUB('all').endpoint, { other: true });
  st.setCategories(SUB('quiet').endpoint, { done: false });
  const sent = [];
  const fakeFetch = async (url) => { sent.push(url.split('/').pop()); return new Response('', { status: 201 }); };
  const go = async (category) => {
    sent.length = 0;
    await wp.broadcastPush(st, { title: 't', category }, 'mailto:a@b.c', { fetch: fakeFetch });
    return sent.slice().sort();
  };
  assert.deepStrictEqual(await go('done'), ['all']);
  assert.deepStrictEqual(await go('error'), ['all', 'quiet']);
  assert.deepStrictEqual(await go('other'), ['all']);
  assert.deepStrictEqual(await go(undefined), ['all', 'quiet'], 'uncategorised (the test push) goes everywhere');
});

test('broadcast: 404 and 410 prune the subscription; 201 and 5xx keep it', async () => {
  const st = wp.createPushStore(tmpState());
  for (const n of ['ok', 'gone', 'missing', 'flaky']) st.add(SUB(n));
  const status = { ok: 201, gone: 410, missing: 404, flaky: 503 };
  const seen = [];
  const fakeFetch = async (url, init) => {
    seen.push({ url, init });
    return new Response('', { status: status[url.split('/').pop()] });
  };
  const rows = await wp.broadcastPush(st, { title: 't' }, 'mailto:a@b.c', { fetch: fakeFetch });
  assert.strictEqual(rows.length, 4);
  assert.deepStrictEqual(st.list().map((s) => s.endpoint).sort(), ['https://push.example/flaky', 'https://push.example/ok']);
  const h = seen[0].init.headers;
  assert.strictEqual(h['Content-Encoding'], 'aes128gcm');
  assert.match(h.Authorization, /^vapid t=.+, k=/);
  assert.strictEqual(wp.decrypt(Buffer.from(seen[0].init.body), V.uaPrivate, V.auth).toString(), '{"title":"t"}');
});

test('policy: what events and messages say on the phone, and their category', () => {
  const ctx = { emoji: (k) => ({ 'needs-captain': '🚨' })[k] || '', reviewTitle: '👀 Your review' };
  const card = { card: 'MNC-9', cardTitle: 'Fix the thing' };
  const P = (ev) => wp.pushFor(Object.assign({ seq: 1, actor: 'ada' }, ev), ctx);

  assert.deepStrictEqual(P(Object.assign({ kind: 'handoff', level: 1, text: '🔨 Working → 👀 Your review' }, card)),
    { title: '👀 MNC-9 · in your review', body: 'Fix the thing', card: 'MNC-9', url: '/?card=MNC-9', category: 'done' });
  assert.deepStrictEqual(P(Object.assign({ kind: 'worker-done', level: 2, text: 'worker done: PR open\nmore' }, card)),
    { title: '✅ MNC-9 · worker done', body: 'PR open more', card: 'MNC-9', url: '/?card=MNC-9', category: 'done' });
  assert.strictEqual(P(Object.assign({ kind: 'worker-stopped', level: 2, text: 'stopped' }, card)).title, '⏸️ MNC-9 · worker stopped');
  assert.deepStrictEqual(P({ kind: 'needs-captain', level: 1, text: 'help' }),
    { title: '🚨 ada · needs-captain', body: 'help', card: null, url: '/', category: 'error' });
  assert.strictEqual(P({ level: 1, text: 'plain bell' }).title, '🔔 ada');

  const sig = P(Object.assign({ kind: 'signal', level: 2, text: 'tests green' }, card));
  assert.strictEqual(sig.category, 'other', 'level-2 chatter is other: off unless the device asks for it');
  assert.strictEqual(P(Object.assign({ kind: 'moved', level: 2, text: '👀 Your review → 📋 Backlog' }, card)).title, '🔔 MNC-9 · moved', 'out of review is not into review');
  assert.strictEqual(wp.pushFor({ kind: 'handoff', level: 1, actor: 'user', text: 'x → 👀 Your review' }, ctx), null, "the captain's own act");
  assert.ok(P({ level: 1, text: 'x'.repeat(500) }).body.length <= 160);

  assert.deepStrictEqual(wp.pushForMessage('card:MNC-9', { author: 'ada', text: 'look at this' }),
    { title: '💬 MNC-9 · ada', body: 'look at this', card: 'MNC-9', url: '/?card=MNC-9', category: 'chat' });
  assert.deepStrictEqual(wp.pushForMessage('lieutenant:ada', { author: 'ada', text: 'hi' }),
    { title: '💬 ada', body: 'hi', card: null, url: '/', category: 'chat' });
  assert.strictEqual(wp.pushForMessage('lieutenant:ada', { author: 'user', text: 'mine' }), null);
  assert.strictEqual(wp.pushForMessage('card:MNC-9', { author: 'ada', text: 'ctx 40%', cmd: { name: '/status', reply: true } }), null);
});

// A push service on loopback: records each delivery, decrypts it, answers 201
// (or 410 for the endpoint told to die).
function fakePushService() {
  const got = [];
  const srv = http.createServer((req, res) => {
    const chunks = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => {
      const body = Buffer.concat(chunks);
      got.push({ path: req.url, headers: req.headers, payload: JSON.parse(wp.decrypt(body, V.uaPrivate, V.auth).toString()) });
      res.writeHead(req.url.endsWith('/dead') ? 410 : 201);
      res.end();
    });
  });
  return new Promise((r) => srv.listen(0, '127.0.0.1', () => r({ got, base: 'http://127.0.0.1:' + srv.address().port, close: () => srv.close() })));
}
async function until(fn, ms = 3000) {
  const t0 = Date.now();
  while (Date.now() - t0 < ms) { if (fn()) return true; await sleep(25); }
  return false;
}

test('server: subscribe → a handoff to review and a level-1 event push; level 2 does not; 410 prunes', async () => {
  const ps = await fakePushService();
  const s = await startServerWithLieutenant();
  try {
    let r = await s.api('GET', '/api/push');
    assert.strictEqual(Buffer.from(r.body.publicKey, 'base64url').length, 65);
    assert.strictEqual(r.body.devices, 0);
    assert.ok(fs.existsSync(path.join(s.dir, '.bridge-commander', 'push', '.gitignore')));

    const sw = await fetch(s.base + '/sw.js');
    assert.strictEqual(sw.status, 200);
    assert.match(sw.headers.get('content-type'), /javascript/);
    assert.match(await sw.text(), /notificationclick/);

    const sub = (name) => ({ endpoint: ps.base + '/' + name, keys: { p256dh: V.uaPublic, auth: V.auth } });
    r = await s.api('POST', '/api/push/subscribe', { subscription: sub('phone') });
    assert.deepStrictEqual(r.body, { ok: true, count: 1, categories: wp.defaultPushCategories() });
    r = await s.api('POST', '/api/push/subscribe', { subscription: { endpoint: 'nope' } });
    assert.strictEqual(r.status, 400);

    await s.api('POST', '/api/cards', withOwner({ title: 'Pushy' }));        // level 2: silent
    await s.api('POST', '/api/cards/pushy/move', { column: 'review' });     // handoff
    await s.api('POST', '/api/events', { text: 'come look', kind: 'needs-captain', actor: 'ada' }); // level 1
    assert.ok(await until(() => ps.got.length >= 2), 'two pushes arrive');
    await sleep(200);
    assert.strictEqual(ps.got.length, 2, 'and only two');
    assert.deepStrictEqual(ps.got[0].payload.title, '👀 pushy · in your review');
    assert.strictEqual(ps.got[0].payload.url, '/?card=pushy');
    assert.strictEqual(ps.got[1].payload.title, '🚨 ada · needs-captain');
    assert.strictEqual(ps.got[0].headers['content-encoding'], 'aes128gcm');
    assert.match(ps.got[0].headers.authorization, /^vapid t=/);

    // a second device that the push service has forgotten: pruned on first use
    await s.api('POST', '/api/push/subscribe', { subscription: sub('dead') });
    r = await s.api('POST', '/api/push/test', {});
    assert.deepStrictEqual(r.body.results.map((x) => x.status).sort(), [201, 410]);
    r = await s.api('GET', '/api/push');
    assert.strictEqual(r.body.devices, 1);

    r = await s.api('POST', '/api/push/unsubscribe', { endpoint: ps.base + '/phone' });
    assert.deepStrictEqual(r.body, { ok: true, removed: true, devices: 0 });
  } finally {
    await s.stop();
    ps.close();
  }
});

test('server: the device\'s categories pick what pushes — prefs saved per toggle, chat messages ride chat, kept across resubscribe', async () => {
  const ps = await fakePushService();
  const s = await startServerWithLieutenant();
  try {
    const phone = { endpoint: ps.base + '/phone', keys: { p256dh: V.uaPublic, auth: V.auth } };
    await s.api('POST', '/api/push/subscribe', { subscription: phone });
    const titles = () => ps.got.map((g) => g.payload.title);

    // defaults: a lieutenant's chat message pushes (chat), a stopped-looking
    // level-2 'other' event does not
    await s.api('POST', '/api/message', { target: 'lieutenant:' + LT, text: 'got a minute?' });
    await s.api('POST', '/api/events', { text: 'tests green', kind: 'signal', actor: 'ada' });
    assert.ok(await until(() => ps.got.length >= 1));
    await sleep(200);
    assert.deepStrictEqual(titles(), ['💬 Ada'], 'chat on, other off');
    assert.strictEqual(ps.got[0].payload.body, 'got a minute?');

    // untick 'error' and 'chat', tick 'other'
    let r = await s.api('POST', '/api/push/prefs', { endpoint: phone.endpoint, categories: { error: false } });
    assert.deepStrictEqual(r.body, { ok: true, categories: { done: true, chat: true, error: false, other: false } });
    r = await s.api('POST', '/api/push/prefs', { endpoint: phone.endpoint, categories: { chat: false, other: true } });
    assert.deepStrictEqual(r.body.categories, { done: true, chat: false, error: false, other: true });
    r = await s.api('POST', '/api/push/prefs', { endpoint: ps.base + '/stranger', categories: { done: false } });
    assert.strictEqual(r.status, 404);

    ps.got.length = 0;
    await s.api('POST', '/api/events', { text: 'come look', kind: 'needs-captain', actor: 'ada' }); // error: off now
    await s.api('POST', '/api/message', { target: 'lieutenant:' + LT, text: 'again' });                // chat: off now
    await s.api('POST', '/api/events', { text: 'tests green', kind: 'signal', actor: 'ada' });           // other: on now
    assert.ok(await until(() => ps.got.length >= 1));
    await sleep(200);
    assert.deepStrictEqual(titles(), ['📡 ada · signal']);

    // the page re-asserting the same subscription, and a rotation, both keep them
    r = await s.api('POST', '/api/push/subscribe', { subscription: phone });
    assert.deepStrictEqual(r.body.categories, { done: true, chat: false, error: false, other: true });
    const rotated = { endpoint: ps.base + '/phone2', keys: phone.keys };
    r = await s.api('POST', '/api/push/subscribe', { old: phone.endpoint, subscription: rotated });
    assert.deepStrictEqual(r.body, { ok: true, count: 1, categories: { done: true, chat: false, error: false, other: true } });
  } finally {
    await s.stop();
    ps.close();
  }
});
