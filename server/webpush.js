// webpush.js — Web Push from the board to the captain's devices, in-repo:
// VAPID (RFC 8292) + aes128gcm payload encryption (RFC 8291 / RFC 8188).
// Node built-ins only, zero deps — the protocol is two HKDFs, one ECDH, one
// AES-GCM and one ES256 signature, which is less code than vendoring a library.
//
// Three parts, kept apart so each is testable on its own:
//   - the protocol: generateVapidKeys, vapidAuthorization, encrypt, sendPush
//   - the store: VAPID keypair + subscriptions in <stateDir>/push/, a directory
//     that git-ignores itself (the workspace commits .bridge-commander/, and a
//     private key in git history is a private key forever)
//   - the policy: pushFor(event) — which board events reach the phone, and what
//     they say there
'use strict';
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

// ---------- base64url ----------
function b64u(buf) { return Buffer.from(buf).toString('base64url'); }
function unb64u(s) { return Buffer.from(String(s), 'base64url'); }

// ---------- VAPID ----------
// Keys travel as base64url: the public key is the 65-byte uncompressed P-256
// point (what the browser's applicationServerKey takes), the private key the
// 32-byte scalar.
function generateVapidKeys() {
  const ecdh = crypto.createECDH('prime256v1');
  ecdh.generateKeys();
  return { publicKey: b64u(ecdh.getPublicKey()), privateKey: b64u(ecdh.getPrivateKey()) };
}

function privateKeyObject(publicKey, privateKey) {
  const pub = unb64u(publicKey);
  return crypto.createPrivateKey({
    format: 'jwk',
    key: { kty: 'EC', crv: 'P-256', d: b64u(unb64u(privateKey)), x: b64u(pub.subarray(1, 33)), y: b64u(pub.subarray(33, 65)) },
  });
}

// The Authorization header for one push service: `vapid t=<jwt>, k=<pub>`.
// `aud` is the endpoint's origin; `exp` must be under 24h out (12h here).
// `sub` must be a mailto: or https: contact — Apple rejects anything else.
function vapidAuthorization(endpoint, vapid, subject, nowSec) {
  const t = nowSec == null ? Math.floor(Date.now() / 1000) : nowSec;
  const header = b64u(JSON.stringify({ typ: 'JWT', alg: 'ES256' }));
  const claims = b64u(JSON.stringify({ aud: new URL(endpoint).origin, exp: t + 12 * 3600, sub: subject }));
  const input = header + '.' + claims;
  const sig = crypto.sign('sha256', Buffer.from(input), {
    key: privateKeyObject(vapid.publicKey, vapid.privateKey), dsaEncoding: 'ieee-p1363',
  });
  return 'vapid t=' + input + '.' + b64u(sig) + ', k=' + vapid.publicKey;
}

// ---------- aes128gcm (RFC 8291 §3, RFC 8188 §2) ----------
// One record, so the record size only has to exceed the ciphertext; 4096 is
// what every implementation sends. `opts.salt` / `opts.asPrivate` pin the
// otherwise-random salt and ephemeral key — the test vector needs both.
const RECORD_SIZE = 4096;
function encrypt(payload, keys, opts) {
  const o = opts || {};
  const uaPublic = unb64u(keys.p256dh);
  const authSecret = unb64u(keys.auth);
  if (uaPublic.length !== 65 || authSecret.length !== 16) throw new Error('bad subscription keys');
  const salt = o.salt ? unb64u(o.salt) : crypto.randomBytes(16);
  const ecdh = crypto.createECDH('prime256v1');
  if (o.asPrivate) ecdh.setPrivateKey(unb64u(o.asPrivate)); else ecdh.generateKeys();
  const asPublic = ecdh.getPublicKey();
  const ecdhSecret = ecdh.computeSecret(uaPublic);

  const hkdf = (ikm, s, info, len) => Buffer.from(crypto.hkdfSync('sha256', ikm, s, info, len));
  const keyInfo = Buffer.concat([Buffer.from('WebPush: info\0'), uaPublic, asPublic]);
  const ikm = hkdf(ecdhSecret, authSecret, keyInfo, 32);
  const cek = hkdf(ikm, salt, Buffer.from('Content-Encoding: aes128gcm\0'), 16);
  const nonce = hkdf(ikm, salt, Buffer.from('Content-Encoding: nonce\0'), 12);

  const cipher = crypto.createCipheriv('aes-128-gcm', cek, nonce);
  // 0x02: the last-record padding delimiter, no padding after it
  const body = Buffer.concat([cipher.update(Buffer.concat([Buffer.from(payload), Buffer.from([2])])), cipher.final(), cipher.getAuthTag()]);
  const rs = Buffer.alloc(4);
  rs.writeUInt32BE(RECORD_SIZE);
  return Buffer.concat([salt, rs, Buffer.from([asPublic.length]), asPublic, body]);
}

// The receiving side — what a browser does with the body. Only the tests and the
// local check use it, but it is the proof that encrypt() is the protocol and not
// merely self-consistent.
function decrypt(body, uaPrivate, authSecretB64) {
  const salt = body.subarray(0, 16);
  const idlen = body[20];
  const asPublic = body.subarray(21, 21 + idlen);
  const ecdh = crypto.createECDH('prime256v1');
  ecdh.setPrivateKey(unb64u(uaPrivate));
  const uaPublic = ecdh.getPublicKey();
  const hkdf = (ikm, s, info, len) => Buffer.from(crypto.hkdfSync('sha256', ikm, s, info, len));
  const keyInfo = Buffer.concat([Buffer.from('WebPush: info\0'), uaPublic, asPublic]);
  const ikm = hkdf(ecdh.computeSecret(asPublic), unb64u(authSecretB64), keyInfo, 32);
  const cek = hkdf(ikm, salt, Buffer.from('Content-Encoding: aes128gcm\0'), 16);
  const nonce = hkdf(ikm, salt, Buffer.from('Content-Encoding: nonce\0'), 12);
  const ct = body.subarray(21 + idlen);
  const d = crypto.createDecipheriv('aes-128-gcm', cek, nonce);
  d.setAuthTag(ct.subarray(ct.length - 16));
  const plain = Buffer.concat([d.update(ct.subarray(0, ct.length - 16)), d.final()]);
  let end = plain.length - 1;
  while (end >= 0 && plain[end] === 0) end--; // strip padding back to the delimiter
  return plain.subarray(0, end);
}

// POST one message to one subscription. Resolves {status, gone, text} and
// never throws on an HTTP status: 404/410 is the push service saying the
// subscription is dead (`gone`), which the caller prunes. A network error does
// reject — that says nothing about the subscription.
async function sendPush(sub, payload, vapid, subject, opts) {
  const o = opts || {};
  const body = encrypt(typeof payload === 'string' ? payload : JSON.stringify(payload), sub.keys);
  const res = await (o.fetch || fetch)(sub.endpoint, {
    method: 'POST',
    headers: {
      Authorization: vapidAuthorization(sub.endpoint, vapid, subject),
      'Content-Encoding': 'aes128gcm',
      'Content-Type': 'application/octet-stream',
      TTL: String(o.ttl == null ? 86400 : o.ttl),
      Urgency: 'high',
    },
    body,
    signal: AbortSignal.timeout(o.timeoutMs || 15000),
  });
  let text = '';
  try { text = (await res.text()).slice(0, 500); } catch (e) {}
  return { status: res.status, gone: res.status === 404 || res.status === 410, text };
}

// ---------- store ----------
// <stateDir>/push/ holds vapid.json (generated on first use, then never again —
// a new keypair orphans every subscription) and subscriptions.json. The dir
// carries its own `.gitignore: *`, so no workspace .gitignore has to know.
function createPushStore(stateDir) {
  const dir = path.join(stateDir, 'push');
  const VAPID = path.join(dir, 'vapid.json');
  const SUBS = path.join(dir, 'subscriptions.json');
  function ensureDir() {
    fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
    const gi = path.join(dir, '.gitignore');
    if (!fs.existsSync(gi)) fs.writeFileSync(gi, '# VAPID private key and device subscriptions: never committed\n*\n');
  }
  function writeJson(file, obj) {
    ensureDir();
    const tmp = file + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify(obj, null, 2), { mode: 0o600 });
    fs.renameSync(tmp, file);
  }
  function readJson(file) {
    try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch (e) { return null; }
  }
  function vapid() {
    const v = readJson(VAPID);
    if (v && typeof v.publicKey === 'string' && typeof v.privateKey === 'string') return v;
    const fresh = Object.assign(generateVapidKeys(), { created: new Date().toISOString() });
    writeJson(VAPID, fresh);
    return fresh;
  }
  function list() {
    const s = readJson(SUBS);
    return Array.isArray(s) ? s.filter(validSubscription) : [];
  }
  // Same endpoint again = the same device re-subscribing: replace, never duplicate.
  function add(sub, meta) {
    if (!validSubscription(sub)) return { error: 'subscription needs endpoint (https URL) and keys {p256dh, auth}' };
    const rec = { endpoint: sub.endpoint, keys: { p256dh: sub.keys.p256dh, auth: sub.keys.auth },
      ua: String((meta && meta.ua) || '').slice(0, 300), added: new Date().toISOString() };
    const all = list().filter((s) => s.endpoint !== rec.endpoint);
    all.push(rec);
    writeJson(SUBS, all);
    return { ok: true, count: all.length };
  }
  function remove(endpoint) {
    const all = list();
    const kept = all.filter((s) => s.endpoint !== endpoint);
    if (kept.length !== all.length) writeJson(SUBS, kept);
    return kept.length !== all.length;
  }
  return { dir, vapid, list, add, remove };
}

function validSubscription(s) {
  if (!s || typeof s !== 'object' || typeof s.endpoint !== 'string') return false;
  let u;
  try { u = new URL(s.endpoint); } catch (e) { return false; }
  if (u.protocol !== 'https:' && u.protocol !== 'http:') return false;
  const k = s.keys || {};
  return typeof k.p256dh === 'string' && unb64u(k.p256dh).length === 65
    && typeof k.auth === 'string' && unb64u(k.auth).length === 16;
}

// Fan one payload out to every stored subscription; prune the dead ones.
// Resolves [{endpoint, status?, gone?, error?}] — one row per device.
async function broadcastPush(store, payload, subject, opts) {
  const vapid = store.vapid();
  return Promise.all(store.list().map(async (sub) => {
    try {
      const r = await sendPush(sub, payload, vapid, subject, opts);
      if (r.gone) store.remove(sub.endpoint);
      return Object.assign({ endpoint: sub.endpoint }, r);
    } catch (e) {
      return { endpoint: sub.endpoint, error: String((e && e.message) || e) };
    }
  }));
}

// ---------- policy: which events reach the phone ----------
// ev: a board event (card events carry `card`/`cardTitle` once flattened);
// ctx: { emoji(kind) → string, reviewTitle }.
// The captain's own clicks never buzz his pocket (actor 'user'). Otherwise:
//   a card entering Your review · worker done · worker stopped · any level-1
//   event (the bell — that is what "rings the captain" means on this board).
// Returns null or { title, body, card, url } — title + one line + the card id,
// the url opening the board on that card.
function oneLine(s, max) {
  const t = String(s || '').replace(/\s+/g, ' ').trim();
  return t.length > max ? t.slice(0, max - 1) + '…' : t;
}
function pushFor(ev, ctx) {
  if (!ev || ev.actor === 'user') return null;
  const c = ctx || {};
  const cardId = ev.card || null;
  const url = cardId ? '/?card=' + encodeURIComponent(cardId) : '/';
  const where = cardId || ev.actor || 'board';
  const text = String(ev.text || '');
  const intoReview = (ev.kind === 'handoff' || ev.kind === 'moved') && c.reviewTitle
    && text.endsWith('→ ' + c.reviewTitle);
  let title;
  let body;
  if (intoReview) {
    title = '👀 ' + where + ' · in your review';
    body = ev.cardTitle || text;
  } else if (ev.kind === 'worker-done') {
    title = '✅ ' + where + ' · worker done';
    body = text.replace(/^worker done:\s*/, '');
  } else if (ev.kind === 'worker-stopped') {
    title = '⏸️ ' + where + ' · worker stopped';
    body = text;
  } else if (ev.level === 1) {
    const em = (c.emoji && ev.kind && c.emoji(ev.kind)) || '🔔';
    title = em + ' ' + where + (ev.kind ? ' · ' + ev.kind : '');
    body = text;
  } else {
    return null;
  }
  return { title: oneLine(title, 80), body: oneLine(body, 160), card: cardId, url };
}

module.exports = {
  generateVapidKeys, vapidAuthorization, encrypt, decrypt, sendPush,
  createPushStore, validSubscription, broadcastPush, pushFor,
};
