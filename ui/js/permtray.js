// permtray.js — the approvals tray: a fixed stack of every permission prompt
// an agent is blocked on, visible from any screen while one is pending. Also
// owns the ONE delegated handler for approval blocks, wherever they are drawn
// (tray or chat tail), so neither view re-wires buttons after a rebuild.
import { S, card, render } from './state.js';
import { api } from './api.js';
import { refreshAgoLabels } from './util.js';
import { openCardConversation, openLieutenantChat } from './chat.js';
import { docPermissions, permBlockHtml, prunePermUi, permUi, setBusy, setError, setReason, reasonFor,
  setJsonOpen, capturePermFocus, hydratePermInputs } from './perms.js';

let root = null;
let lastHtml = null;
let collapsed = false;

function ensureRoot() {
  if (root) return root;
  root = document.createElement('div');
  root.id = 'perm-tray';
  root.setAttribute('role', 'region');
  root.setAttribute('aria-label', 'permission requests');
  document.body.appendChild(root);
  return root;
}

export async function decide(id, decision) {
  if (!id || permUi(id).busy) return; // one POST per prompt
  const message = decision === 'deny' ? reasonFor(id).trim() : '';
  setBusy(id, decision);
  setError(id, '');
  render();
  try {
    await api.decidePermission(id, decision, message);
    // stays busy until the broadcast drops the item — no flash of live buttons
  } catch (e) {
    setBusy(id, '');
    // 404: the agent stopped waiting (interrupted, timed out); the next board
    // update removes it, so say why rather than offer a retry that cannot work
    setError(id, e.status === 404 ? 'this request is no longer waiting' : 'could not send: ' + e.message);
    render();
  }
}

function go(id) {
  const p = docPermissions(S.doc).find((x) => x.id === id);
  if (!p) return;
  if (p.card && card(p.card)) openCardConversation(p.card);
  else if (p.lieutenant) openLieutenantChat(p.lieutenant);
}

// Capture phase: a surrounding click handler (feed, tile, click-away) must not
// see a click that was meant for the approval.
document.addEventListener('click', (e) => {
  const blk = e.target.closest && e.target.closest('.perm-block');
  if (blk) {
    const act = e.target.closest('[data-perm-act]');
    if (act) { e.stopPropagation(); if (!act.disabled) decide(blk.dataset.permId, act.dataset.permAct); return; }
    if (e.target.closest('[data-perm-go]')) { e.stopPropagation(); go(blk.dataset.permId); }
    return;
  }
  const t = e.target.closest && e.target.closest('#perm-tray .pt-toggle');
  if (t) { collapsed = !collapsed; renderPermTray(); }
}, true);
document.addEventListener('input', (e) => {
  if (e.target.classList && e.target.classList.contains('perm-reason')) {
    const id = e.target.dataset.permId;
    setReason(id, e.target.value);
    // the same prompt may be drawn twice (tray + chat): keep both inputs in step
    for (const el of document.querySelectorAll('.perm-reason')) {
      if (el !== e.target && el.dataset.permId === id) el.value = e.target.value;
    }
  }
});
document.addEventListener('keydown', (e) => {
  if (e.key !== 'Enter' || e.isComposing || !(e.target.classList && e.target.classList.contains('perm-reason'))) return;
  e.preventDefault();
  decide(e.target.dataset.permId, 'deny'); // a typed reason IS a deny
});
// `toggle` does not bubble; capture reaches it on the way down
document.addEventListener('toggle', (e) => {
  const d = e.target;
  if (d.classList && d.classList.contains('perm-json')) {
    const blk = d.closest('.perm-block');
    if (blk) setJsonOpen(blk.dataset.permId, d.open);
  }
}, true);

export function renderPermTray() {
  const perms = docPermissions(S.doc);
  prunePermUi(S.doc);
  if (!perms.length && !root) return;
  const el = ensureRoot();
  const n = perms.length;
  const html = !n ? '' :
    '<button type="button" class="pt-toggle" aria-expanded="' + !collapsed + '" title="' + (collapsed ? 'show' : 'hide') + ' the requests">' +
      '<span class="pt-dot"></span>' + n + ' permission request' + (n === 1 ? '' : 's') + ' waiting' +
      '<span class="grow"></span><span class="pt-chev">' + (collapsed ? '▴' : '▾') + '</span></button>' +
    (collapsed ? '' : '<div class="pt-list">' + perms.map((p) => permBlockHtml(p, 'tray')).join('') + '</div>');
  el.hidden = !n;
  if (html === lastHtml) return;
  lastHtml = html;
  const focus = capturePermFocus();
  el.innerHTML = html;
  hydratePermInputs(el, focus);
  refreshAgoLabels(el); // the render guard may skip the global post-pass
}
