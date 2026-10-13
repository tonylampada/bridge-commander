// sw.js — the board's service worker, served from /sw.js so its scope is the
// whole board. Push only: no fetch handler, so it never stands between the
// page and the server (nothing cached, nothing stale).
//
// Payload (server/webpush.js pushFor): { title, body, card, url }.
self.addEventListener('install', () => self.skipWaiting());
self.addEventListener('activate', (e) => e.waitUntil(self.clients.claim()));

self.addEventListener('push', (e) => {
  let d = {};
  try { d = e.data ? e.data.json() : {}; } catch (err) { d = { body: e.data ? e.data.text() : '' }; }
  // iOS revokes the subscription of a worker that receives a push and shows
  // nothing, so a notification goes up for every push, whatever it carried.
  e.waitUntil(self.registration.showNotification(d.title || 'Bridge Commander', {
    body: d.body || '',
    icon: '/ui/img/icon-192.png',
    badge: '/ui/img/icon-192.png',
    tag: d.seq != null ? 'bc-' + d.seq : undefined,
    data: { url: d.url || '/', card: d.card || null },
  }));
});

// Tap: an open board takes the card (focus + message — no reload, the chat
// draft survives); no open board → open one on the card's URL.
self.addEventListener('notificationclick', (e) => {
  e.notification.close();
  const data = e.notification.data || {};
  const url = new URL(data.url || '/', self.registration.scope).href;
  e.waitUntil((async () => {
    const wins = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
    const win = wins.find((w) => new URL(w.url).origin === self.location.origin);
    if (win) {
      await win.focus();
      if (data.card) win.postMessage({ type: 'bc-open-card', card: data.card });
      return;
    }
    await self.clients.openWindow(url);
  })());
});

// The push service rotated the subscription: hand the board the new one and the
// endpoint it replaces. Needs the Access cookie like any board request — with
// the Access session expired this POST fails and the device goes quiet until
// the board is opened and the toggle turned on again.
self.addEventListener('pushsubscriptionchange', (e) => {
  e.waitUntil((async () => {
    const old = e.oldSubscription ? e.oldSubscription.endpoint : null;
    let sub = e.newSubscription;
    if (!sub) {
      const k = await fetch('/api/push', { credentials: 'same-origin' }).then((r) => r.json());
      sub = await self.registration.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: k.publicKey });
    }
    await fetch('/api/push/subscribe', {
      method: 'POST', credentials: 'same-origin',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ old, subscription: sub.toJSON() }),
    });
  })());
});
