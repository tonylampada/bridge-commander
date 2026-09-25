// perms.js — the permission prompts agents are blocked on (board payload
// `permissions`, oldest first). Selectors, the one approval-block markup the
// tray and the chat share, and the per-item view state. DOM-free at import, so
// node --test loads it directly; the DOM helpers only touch `document` when called.
import { esc, agoSpanHtml } from './util.js';

export function docPermissions(doc) {
  return doc && Array.isArray(doc.permissions) ? doc.permissions : [];
}
export function cardPermissions(doc, cardId) {
  return docPermissions(doc).filter((p) => p.card === cardId);
}
// A lieutenant's main chat shows only its OWN prompts; a worker's prompt lives
// in its card's thread.
export function mainChatPermissions(doc, ltId) {
  return docPermissions(doc).filter((p) => !p.card && p.lieutenant === ltId);
}

// Ids in `doc` not yet in `seen`, in payload order; mutates `seen`. The caller
// seeds on the first doc so a reload does not re-announce what is on screen.
export function selectNewPermissions(seen, doc) {
  const out = [];
  for (const p of docPermissions(doc)) {
    if (!p || p.id == null || seen.has(p.id)) continue;
    seen.add(p.id);
    out.push(p);
  }
  return out;
}

// ---------- view state, keyed by permission id ----------
// Kept out of the markup where it changes per keystroke (the reason text), so
// the skip-identical render guards do not rebuild the block mid-typing.
const busy = new Map();    // id -> 'allow'|'deny' while the POST is in flight
const errors = new Map();  // id -> last POST error text
const reasons = new Map(); // id -> deny reason draft
const openJson = new Set(); // ids whose full tool_input is expanded

export function permUi(id) {
  return { busy: busy.get(id) || '', error: errors.get(id) || '', open: openJson.has(id) };
}
export function setBusy(id, decision) { if (decision) busy.set(id, decision); else busy.delete(id); }
export function setError(id, msg) { if (msg) errors.set(id, msg); else errors.delete(id); }
export function setReason(id, text) { if (text) reasons.set(id, text); else reasons.delete(id); }
export function reasonFor(id) { return reasons.get(id) || ''; }
export function setJsonOpen(id, open) { if (open) openJson.add(id); else openJson.delete(id); }
// Drop state for prompts that are gone: a decided one must not leave a
// disabled button behind if the same view ever shows it again.
export function prunePermUi(doc) {
  const live = new Set(docPermissions(doc).map((p) => p.id));
  for (const m of [busy, errors, reasons]) for (const id of m.keys()) if (!live.has(id)) m.delete(id);
  for (const id of openJson) if (!live.has(id)) openJson.delete(id);
}

function inputJson(p) {
  try { return JSON.stringify(p.tool_input == null ? {} : p.tool_input, null, 2); } catch (e) { return String(p.tool_input); }
}

// One approval block. `where` ('tray'|'chat') only scopes the reason input so
// the same prompt shown twice keeps two independent inputs in the DOM.
export function permBlockHtml(p, where) {
  const ui = permUi(p.id);
  const dis = ui.busy ? ' disabled' : '';
  const id = esc(p.id);
  const label = esc(p.agentLabel || 'agent');
  // in the tray the label is the way to the conversation; in the chat it IS it
  const who = where === 'tray'
    ? '<button type="button" class="perm-who" data-perm-go="' + id + '" title="open this conversation">' + label + '</button>'
    : '<span class="perm-who">' + label + '</span>';
  return '<div class="perm-block' + (ui.busy ? ' busy' : '') + '" data-perm-id="' + id + '" data-perm-where="' + esc(where) + '">' +
    '<div class="perm-head"><span class="perm-ic" aria-hidden="true">🔐</span>' + who +
      '<span class="perm-tool">' + esc(p.tool_name || 'tool') + '</span>' +
      '<span class="grow"></span>' + agoSpanHtml(p.ts, 'perm-ago') + '</div>' +
    '<div class="perm-sum">' + esc(p.summary || '') + '</div>' +
    '<details class="perm-json"' + (ui.open ? ' open' : '') + '><summary>tool input</summary><pre>' + esc(inputJson(p)) + '</pre></details>' +
    '<div class="perm-acts">' +
      '<button type="button" class="perm-allow" data-perm-act="allow"' + dis + '>' + (ui.busy === 'allow' ? 'approving…' : 'Approve') + '</button>' +
      '<button type="button" class="perm-deny" data-perm-act="deny"' + dis + '>' + (ui.busy === 'deny' ? 'denying…' : 'Deny') + '</button>' +
      '<input class="perm-reason" data-perm-id="' + id + '" placeholder="reason (optional)" maxlength="300" autocomplete="off"' + dis + '>' +
    '</div>' +
    (ui.error ? '<div class="perm-err">' + esc(ui.error) + '</div>' : '') +
    '</div>';
}

// ---------- DOM helpers (called after a rebuild; never at import) ----------
// The focused reason input, so a rebuild under the captain's cursor can put
// him back where he was.
export function capturePermFocus() {
  const a = typeof document !== 'undefined' ? document.activeElement : null;
  if (!a || !a.classList || !a.classList.contains('perm-reason')) return null;
  const blk = a.closest('.perm-block');
  return { id: a.dataset.permId, where: blk ? blk.dataset.permWhere : '', start: a.selectionStart, end: a.selectionEnd };
}
// Refill reason drafts and restore focus inside `root`.
export function hydratePermInputs(root, focus) {
  if (!root) return;
  for (const el of root.querySelectorAll('.perm-reason')) {
    const v = reasonFor(el.dataset.permId);
    if (el.value !== v) el.value = v;
    if (focus && el.dataset.permId === focus.id && document.activeElement !== el) {
      const blk = el.closest('.perm-block');
      if (blk && blk.dataset.permWhere === focus.where) {
        el.focus();
        try { el.setSelectionRange(focus.start, focus.end); } catch (e) {}
      }
    }
  }
}
