// push.js — the "phone push" switch in the settings panel: Web Push from the
// board to this device, through /sw.js. Separate from the toast+sound rows
// above it: those need the tab open, this reaches a locked phone.
//
// It also owns this device's push categories (the 📲 column in the rows above,
// drawn by notifysettings.js): the server keeps them per subscription, this
// file mirrors them in localStorage so a device re-subscribing after a prune
// or an off/on hands them back instead of starting from the defaults.
//
// States: on · off · denied · unsupported. iOS exposes PushManager only to the
// home-screen app, so Safari in a tab reads as unsupported and says how to fix it.
// The permission prompt MUST come from the tap itself (iOS rule), so the worker
// is registered and the key fetched at load — the tap's first await is the prompt.

const btn = document.getElementById('push-btn');
const testBtn = document.getElementById('push-test');
const hint = document.getElementById('push-hint');

const supported = typeof window !== 'undefined' && window.isSecureContext
  && 'serviceWorker' in navigator && 'PushManager' in window && 'Notification' in window;
const ios = /iPhone|iPad|iPod/.test(navigator.userAgent);
const standalone = (window.matchMedia && window.matchMedia('(display-mode: standalone)').matches) || navigator.standalone === true;

let reg = null;
let publicKey = null;
let state = 'unsupported';
let busy = false;
let note = '';
let endpoint = null;

const CATS_KEY = 'bc-push-cats';
let categories = null; // null until the server has answered for this device
function rememberedCategories() {
  try { const c = JSON.parse(localStorage.getItem(CATS_KEY)); return c && typeof c === 'object' ? c : undefined; } catch (e) { return undefined; }
}
function adoptCategories(c) {
  if (!c) return;
  categories = c;
  try { localStorage.setItem(CATS_KEY, JSON.stringify(c)); } catch (e) {}
}

// notifysettings.js redraws its rows when the switch or the categories change.
const listeners = [];
export function onPushChange(fn) { listeners.push(fn); }
function changed() { for (const fn of listeners) { try { fn(); } catch (e) {} } }
// The 📲 column shows only while this device is subscribed and knows its categories.
export function pushCategories() { return state === 'on' && categories ? categories : null; }
// Optimistic: the box flips now, the server write follows; a failure flips it back.
export async function setPushCategory(cat, on) {
  if (!endpoint || !categories) return;
  const before = categories;
  adoptCategories(Object.assign({}, categories, { [cat]: on }));
  try {
    adoptCategories((await call('POST', '/api/push/prefs', { endpoint, categories: { [cat]: on } })).categories);
    note = '';
  } catch (err) {
    adoptCategories(before);
    note = String((err && err.message) || err);
  }
  render();
  changed();
}
async function subscribeHere(sub) {
  const r = await call('POST', '/api/push/subscribe', { subscription: sub.toJSON(), categories: rememberedCategories() });
  endpoint = sub.endpoint;
  adoptCategories(r.categories);
  changed();
}

// Cloudflare Access answers an expired session with a redirect to its login
// page. Followed, that is a cross-origin CORS failure with no useful message, so
// the redirect is caught here and named instead.
async function call(method, url, body) {
  const r = await fetch(url, {
    method, redirect: 'manual', credentials: 'same-origin',
    headers: body ? { 'Content-Type': 'application/json' } : {},
    body: body ? JSON.stringify(body) : undefined,
  });
  if (r.type === 'opaqueredirect' || (r.status >= 300 && r.status < 400)) throw new Error('board login expired — reload the page');
  if (!r.ok) {
    let msg = 'HTTP ' + r.status;
    try { msg = (await r.json()).error || msg; } catch (e) {}
    throw new Error(msg);
  }
  return r.json();
}

function render() {
  if (!btn) return;
  const label = { on: '📲 on', off: '📲 off', denied: '📲 blocked', unsupported: '📲 n/a' }[state];
  btn.textContent = busy ? '📲 …' : label;
  btn.classList.toggle('on', state === 'on');
  btn.disabled = busy || state === 'unsupported' || state === 'denied';
  testBtn.hidden = state !== 'on';
  let h = note;
  if (!h && state === 'unsupported') {
    h = !window.isSecureContext ? 'needs https (the bc.… address, not localhost over the LAN)'
      : ios && !standalone ? 'open the board from its home-screen icon (Share → Add to Home Screen)'
      : 'this browser has no Web Push';
  }
  if (!h && state === 'denied') h = 'notifications are blocked for this site — allow them in the system settings';
  hint.textContent = h;
  hint.hidden = !h;
}

async function refresh() {
  if (!supported) { state = 'unsupported'; return render(); }
  if (Notification.permission === 'denied') { state = 'denied'; return render(); }
  const sub = reg ? await reg.pushManager.getSubscription() : null;
  state = sub && Notification.permission === 'granted' ? 'on' : 'off';
  if (state !== 'on') endpoint = null;
  render();
  changed();
  return sub;
}

async function turnOn() {
  // first await of the tap: the permission prompt
  const perm = await Notification.requestPermission();
  if (perm !== 'granted') return;
  if (!publicKey) publicKey = (await call('GET', '/api/push')).publicKey;
  const r = reg || await navigator.serviceWorker.ready;
  let sub = await r.pushManager.getSubscription();
  if (!sub) sub = await r.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: publicKey });
  await subscribeHere(sub);
}

async function turnOff() {
  const sub = reg && await reg.pushManager.getSubscription();
  if (!sub) return;
  const ep = sub.endpoint;
  await sub.unsubscribe();
  await call('POST', '/api/push/unsubscribe', { endpoint: ep });
}

if (btn) {
  btn.onclick = async (e) => {
    e.stopPropagation();
    if (busy) return;
    busy = true; note = ''; render();
    try { if (state === 'on') await turnOff(); else await turnOn(); }
    catch (err) { note = String((err && err.message) || err); }
    busy = false;
    await refresh();
  };
  testBtn.onclick = async (e) => {
    e.stopPropagation();
    note = '';
    try {
      const r = await call('POST', '/api/push/test', {});
      const bad = (r.results || []).filter((x) => x.error || x.status >= 300);
      note = (r.results || []).length + ' device(s), ' + bad.length + ' failed';
    } catch (err) { note = String((err && err.message) || err); }
    render();
  };
}

// The tap on a notification, with the board already open: the worker focuses
// this window and posts the card here.
let cardOpener = null;
export function onOpenCard(fn) { cardOpener = fn; }
if ('serviceWorker' in navigator) {
  navigator.serviceWorker.addEventListener('message', (e) => {
    if (e.data && e.data.type === 'bc-open-card' && e.data.card && cardOpener) cardOpener(e.data.card);
  });
}

(async () => {
  render();
  if (!supported) return;
  try {
    reg = await navigator.serviceWorker.register('/sw.js', { scope: '/' });
    publicKey = (await call('GET', '/api/push')).publicKey;
  } catch (err) { note = String((err && err.message) || err); }
  const sub = await refresh();
  // re-assert a live subscription: the server may have pruned it, or this may
  // be a board whose push/ dir was wiped. Same endpoint = replace, never a twin.
  // The answer carries this device's categories, which draws the 📲 column.
  if (sub) subscribeHere(sub).catch(() => {});
})();
