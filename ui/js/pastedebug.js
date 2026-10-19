// pastedebug.js — opt-in event log for "the first Cmd+V after coming back to the
// window does nothing" (MNC-280). It only reproduces on the captain's Mac, so
// this is the instrument that runs there: open the board with ?pastedebug=1 (it
// sticks in localStorage; ?pastedebug=0 turns it off) and reproduce. Nothing to
// copy — every couple of seconds the log goes to POST /api/pastedebug, which
// appends it to <workspace>/.bridge-commander/pastedebug.log.
//
// Imported FIRST by main.js so its capture listeners run before anyone else's,
// and its bubble listeners on window run last: the gap between the two is how
// long the board's own handlers held the event, and defaultPrevented at the end
// says whether one of them swallowed it.

const FLAG = 'bc-pastedebug';
const q = new URLSearchParams(typeof location === 'undefined' ? '' : location.search).get('pastedebug');
try { if (q === '1') localStorage.setItem(FLAG, '1'); else if (q === '0') localStorage.removeItem(FLAG); } catch (e) {}
let on = false;
try { on = localStorage.getItem(FLAG) === '1'; } catch (e) {}
// A/B for the composer's own paste hook (chat.js reads clipboardData.items):
// ?pastehook=0 turns it off (sticky), ?pastehook=1 back on.
const HOOK = 'bc-pastedebug-nohook';
const h = new URLSearchParams(typeof location === 'undefined' ? '' : location.search).get('pastehook');
try { if (h === '0') localStorage.setItem(HOOK, '1'); else if (h === '1') localStorage.removeItem(HOOK); } catch (e) {}
let noHook = false;
try { noHook = on && localStorage.getItem(HOOK) === '1'; } catch (e) {}
export const pasteHookOff = noHook;
// chat.js writes its own lines into the log through this; a no-op when off.
export let debugLog = () => {};

if (on) {
  const session = Math.random().toString(36).slice(2, 8);
  let buf = [];
  const name = (n) => !n ? '-' : n === window ? 'window' : n === document ? 'document'
    : (n.tagName || '?').toLowerCase() + (n.id ? '#' + n.id : '') + (n.className && typeof n.className === 'string' ? '.' + n.className.split(' ')[0] : '');
  const state = () => 'act=' + name(document.activeElement) + ' hasFocus=' + document.hasFocus() + ' vis=' + document.visibilityState;
  const log = (s) => { buf.push(new Date().toISOString() + ' ' + s); if (buf.length > 2000) buf.shift(); };
  debugLog = log;
  const flush = (beacon) => {
    if (!buf.length) return;
    const body = JSON.stringify({ session, ua: navigator.userAgent, lines: buf });
    buf = [];
    if (beacon && navigator.sendBeacon) { navigator.sendBeacon('/api/pastedebug', new Blob([body], { type: 'application/json' })); return; }
    fetch('/api/pastedebug', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body, keepalive: true }).catch(() => {});
  };
  const keyOf = (e) => (e.metaKey ? 'Meta+' : '') + (e.ctrlKey ? 'Ctrl+' : '') + (e.altKey ? 'Alt+' : '') + (e.shiftKey ? 'Shift+' : '') + e.key;

  const started = new WeakMap();
  for (const type of ['keydown', 'keyup', 'paste', 'beforeinput', 'input']) {
    window.addEventListener(type, (e) => {
      started.set(e, performance.now());
      let extra = '';
      if (type.startsWith('key')) extra = ' ' + keyOf(e) + (e.repeat ? ' repeat' : '') + (e.isTrusted ? '' : ' UNTRUSTED');
      if (type === 'paste') extra = ' types=' + (e.clipboardData ? [...e.clipboardData.types].join(',') : 'none');
      if (type === 'beforeinput' || type === 'input') extra = ' ' + e.inputType;
      log(type + ' target=' + name(e.target) + extra + ' ' + state());
    }, true);
    window.addEventListener(type, (e) => {
      const ms = performance.now() - (started.get(e) || performance.now());
      if (e.defaultPrevented || ms > 8) log('  ' + type + ' handled in ' + ms.toFixed(1) + 'ms' + (e.defaultPrevented ? ' PREVENTED' : ''));
    });
  }
  // A keydown nobody prevented that produced no paste is the bug itself — the
  // listeners above cannot see the absence, so say it out loud.
  let pendingV = null;
  window.addEventListener('keydown', (e) => {
    if ((e.metaKey || e.ctrlKey) && (e.key === 'v' || e.key === 'V')) {
      clearTimeout(pendingV);
      pendingV = setTimeout(() => log('!! Cmd/Ctrl+V with NO paste event within 500ms ' + state()), 500);
    }
  }, true);
  window.addEventListener('paste', () => clearTimeout(pendingV), true);

  // An uncancelled insertFromPaste that never becomes an input event is the
  // bug as the first log showed it. Snapshot the field at beforeinput, and 50ms
  // later say whether the text ever landed.
  const fieldState = (t) => 'len=' + (t.value || '').length + ' sel=' + t.selectionStart + '-' + t.selectionEnd +
    ' readOnly=' + t.readOnly + ' disabled=' + t.disabled + ' maxLength=' + t.maxLength;
  let inputSeen = 0;
  window.addEventListener('input', () => { inputSeen++; }, true);
  const inputAtPaste = new WeakMap(); // taken before any handler can insert
  window.addEventListener('paste', (e) => inputAtPaste.set(e, inputSeen), true);
  window.addEventListener('paste', (e) => {
    let len = '?';
    try { len = e.clipboardData ? e.clipboardData.getData('text/plain').length : 'none'; } catch (err) { len = 'threw'; }
    log('  paste after handlers: text/plain len=' + len + ' cancelable=' + e.cancelable);
    // Whoever inserts it (the browser, or the composer's workaround), a paste
    // with text must end in an input event.
    const seen = inputAtPaste.has(e) ? inputAtPaste.get(e) : inputSeen, t = e.target;
    if (len > 0) setTimeout(() => {
      if (inputSeen > seen) log('  paste landed: len=' + (t.value || '').length);
      else log('!! paste with text but NO input within 50ms defaultPrevented=' + e.defaultPrevented + ' ' + state());
    }, 50);
  });
  window.addEventListener('beforeinput', (e) => {
    if (e.inputType !== 'insertFromPaste') return;
    const t = e.target;
    let dt = 'null';
    try { if (e.dataTransfer) dt = String(e.dataTransfer.getData('text/plain').length); } catch (err) { dt = 'threw'; }
    log('  beforeinput paste: data.len=' + (e.data == null ? 'null' : e.data.length) + ' dataTransfer.len=' + dt +
      ' cancelable=' + e.cancelable + ' composing=' + e.isComposing + ' ' + fieldState(t));
    const seen = inputSeen, before = (t.value || '').length;
    setTimeout(() => {
      const landed = inputSeen > seen;
      log((landed ? '  ' : '!! ') + 'paste 50ms later: input=' + landed + ' len ' + before + '→' + (t.value || '').length + ' ' + fieldState(t) + ' ' + state());
    }, 50);
  }, true);

  for (const type of ['focus', 'blur']) window.addEventListener(type, (e) => log(type + ' target=' + name(e.target) + ' ' + state()), true);
  for (const type of ['focusin', 'focusout']) document.addEventListener(type, (e) => log(type + ' target=' + name(e.target) + ' related=' + name(e.relatedTarget) + ' ' + state()), true);
  document.addEventListener('visibilitychange', () => log('visibilitychange ' + state()), true);
  window.addEventListener('pageshow', (e) => log('pageshow persisted=' + e.persisted + ' ' + state()), true);
  window.addEventListener('pagehide', () => { log('pagehide'); flush(true); }, true);
  // The focused node being replaced is invisible to every event above.
  new MutationObserver((ms) => {
    for (const m of ms) for (const n of m.removedNodes) {
      if (n.nodeType === 1 && (n.matches('textarea,iframe') || n.querySelector('textarea,iframe'))) log('removed ' + name(n) + ' ' + state());
    }
  }).observe(document.documentElement, { childList: true, subtree: true });

  log('armed session=' + session + ' pastehook=' + (noHook ? 'off' : 'on') + ' ' + state());
  setInterval(flush, 2000);
  // Visible, so nobody forgets it is on — and inert, so it can never take focus.
  const mount = () => {
    const badge = document.createElement('div');
    badge.textContent = 'paste debug · ' + session + (noHook ? ' · hook off' : '');
    badge.style.cssText = 'position:fixed;left:6px;bottom:6px;z-index:2147483647;pointer-events:none;font:10px ui-monospace,monospace;color:#9f9;background:#000a;padding:2px 5px;border-radius:4px';
    badge.setAttribute('aria-hidden', 'true');
    document.body.appendChild(badge);
  };
  if (document.body) mount(); else document.addEventListener('DOMContentLoaded', mount);
}
