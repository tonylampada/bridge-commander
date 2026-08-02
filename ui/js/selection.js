// selection.js — the board's selection mode: what is selected, what a
// shift-click range means, and what a filter change does to a selection.
// Its own module (not part of board.js/table.js) for the same reason
// panekeys.js and chatmem.js are: those files grab DOM nodes at import time,
// this is pure, and pure is what a unit test can import.
//
// Nothing here is persisted, on purpose: a selection survives a re-render (the
// board redraws constantly from SSE — a selection that evaporated on every
// worker event would be unusable) and dies with the page.

export const SEL = { on: false, ids: new Set(), anchor: null };

export function selectionOn() { return SEL.on; }
export function selectedIds() { return [...SEL.ids]; }
export function selCount() { return SEL.ids.size; }
export function isSelected(id) { return SEL.ids.has(id); }

// Entered deliberately and left deliberately. Entering FROM a card selects it —
// the captain right-clicked that card because he meant it.
export function enterSelection(id) {
  SEL.on = true;
  SEL.ids.clear();
  SEL.anchor = null;
  if (id) { SEL.ids.add(id); SEL.anchor = id; }
}
export function exitSelection() {
  SEL.on = false;
  SEL.ids.clear();
  SEL.anchor = null;
}

// A click on a card while selection mode is on. `order` is the ids in the order
// the view shows them (column by column on the board, row by row in the table).
// Shift with a live anchor SELECTS the whole run between anchor and card — never
// toggles it: a range that unselects half of what it covers is a coin flip.
export function pick(id, shift, order) {
  const list = order || [];
  if (shift && SEL.anchor && SEL.anchor !== id && list.includes(id) && list.includes(SEL.anchor)) {
    const a = list.indexOf(SEL.anchor), b = list.indexOf(id);
    for (const x of list.slice(Math.min(a, b), Math.max(a, b) + 1)) SEL.ids.add(x);
    SEL.anchor = id;
    return;
  }
  if (SEL.ids.has(id)) SEL.ids.delete(id); else SEL.ids.add(id);
  SEL.anchor = id;
}

// the table's header checkbox: everything the view currently shows, or none of it
export function setAll(order, on) {
  for (const id of order || []) { if (on) SEL.ids.add(id); else SEL.ids.delete(id); }
  SEL.anchor = null;
}
export function allSelected(order) {
  return !!(order && order.length) && order.every((id) => SEL.ids.has(id));
}

// Run on every render, against the ids the filters currently show. A selected
// card that is no longer visible (the filter narrowed, or the card was archived
// by someone else) LEAVES the selection: what the captain can see is what the
// next action hits. It only ever removes — so clearing a filter afterwards can
// never silently widen the selection back out.
export function reconcile(visibleIds) {
  const vis = new Set(visibleIds || []);
  for (const id of SEL.ids) if (!vis.has(id)) SEL.ids.delete(id);
  if (SEL.anchor && !vis.has(SEL.anchor)) SEL.anchor = null;
}
