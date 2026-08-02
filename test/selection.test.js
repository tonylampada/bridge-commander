'use strict';
// ui/js/selection.js — the selection behind bulk actions: what is selected,
// what a shift-click range means, and what a filter change does to it. Plus the
// decisions ui/js/bulk.js makes per card (which labels a card ends up with,
// what refuses to archive, what the one report says).
//
// Both modules are DOM-free at import — that is the whole reason they are their
// own files — so they import straight into node. ESM (they ship to the
// browser), hence the dynamic import, same shape as panekeys.test.js.
const test = require('node:test');
const assert = require('node:assert');
const path = require('node:path');
const { pathToFileURL } = require('node:url');

const load = (f) => import(pathToFileURL(path.join(__dirname, '..', 'ui', 'js', f)).href);

let sel, bulk, state;
test.before(async () => {
  sel = await load('selection.js');
  bulk = await load('bulk.js');
  state = await load('state.js');
});
// The board doc the client actually holds. `workers` is the worker REGISTRY —
// the ground truth the server itself consults before it kills a session — and
// it is what "is this card archivable" has to be asked of.
function board(cards, workers) { state.S.doc = { cards, workers: workers || [], columns: [] }; }
// module-level state, like the board's own: every test starts from off
const reset = () => sel.exitSelection();

const ORDER = ['a', 'b', 'c', 'd', 'e'];

test('selection mode is off until it is entered, and entering from a card selects it', () => {
  reset();
  assert.strictEqual(sel.selectionOn(), false);
  assert.strictEqual(sel.selCount(), 0);
  sel.enterSelection('c');
  assert.strictEqual(sel.selectionOn(), true);
  assert.deepStrictEqual(sel.selectedIds(), ['c']);
  sel.exitSelection();
  assert.strictEqual(sel.selectionOn(), false);
  assert.strictEqual(sel.selCount(), 0, 'leaving drops the selection — it never outlives the mode');
});

test('a plain click toggles one card and moves the anchor', () => {
  reset();
  sel.enterSelection();
  sel.pick('b', false, ORDER);
  sel.pick('d', false, ORDER);
  assert.deepStrictEqual(sel.selectedIds().sort(), ['b', 'd']);
  sel.pick('b', false, ORDER);
  assert.deepStrictEqual(sel.selectedIds(), ['d'], 'clicking a selected card unselects it');
});

test('shift takes the whole run between anchor and card, in either direction', () => {
  reset();
  sel.enterSelection('b');
  sel.pick('d', true, ORDER);
  assert.deepStrictEqual(sel.selectedIds().sort(), ['b', 'c', 'd'], 'inclusive at both ends');

  reset();
  sel.enterSelection('d');
  sel.pick('b', true, ORDER);
  assert.deepStrictEqual(sel.selectedIds().sort(), ['b', 'c', 'd'], 'backwards is the same range');
});

test('a shift-range only ever selects — it never unselects half of what it covers', () => {
  reset();
  sel.enterSelection('a');
  sel.pick('c', false, ORDER); // c selected, anchor c
  sel.pick('e', true, ORDER);  // range c..e over an already-selected c
  assert.deepStrictEqual(sel.selectedIds().sort(), ['a', 'c', 'd', 'e']);
});

test('shift with no anchor, or over ids the view does not show, is a plain toggle', () => {
  reset();
  sel.enterSelection();
  sel.pick('c', true, ORDER); // nothing anchored yet
  assert.deepStrictEqual(sel.selectedIds(), ['c']);
  sel.pick('zz', true, ORDER); // not in the rendered order
  assert.deepStrictEqual(sel.selectedIds().sort(), ['c', 'zz']);
});

test('the header checkbox takes everything the view shows, or none of it', () => {
  reset();
  sel.enterSelection();
  assert.strictEqual(sel.allSelected(ORDER), false);
  sel.setAll(ORDER, true);
  assert.strictEqual(sel.selCount(), 5);
  assert.strictEqual(sel.allSelected(ORDER), true);
  sel.setAll(ORDER, false);
  assert.strictEqual(sel.selCount(), 0);
  assert.strictEqual(sel.allSelected([]), false, 'an empty view is not "all selected"');
});

test('a filter change only ever NARROWS the selection', () => {
  reset();
  sel.enterSelection();
  sel.setAll(ORDER, true);
  // the captain narrows the filter: only b and c are on screen now
  sel.reconcile(['b', 'c']);
  assert.deepStrictEqual(sel.selectedIds().sort(), ['b', 'c'], 'what he cannot see is not in the action');
  // …and clears it again: the twelve cards do not come back
  sel.reconcile(ORDER);
  assert.deepStrictEqual(sel.selectedIds().sort(), ['b', 'c'], 'clearing a filter never widens what an action hits');
});

test('reconcile drops an anchor that left the view, so the next shift-click cannot span it', () => {
  reset();
  sel.enterSelection('a');
  sel.reconcile(['c', 'd', 'e']);
  assert.deepStrictEqual(sel.selectedIds(), []);
  sel.pick('e', true, ORDER);
  assert.deepStrictEqual(sel.selectedIds(), ['e'], 'no anchor, so no range back to the vanished card');
});

// ---------- what a bulk action decides, per card ----------

test('labels ADD and REMOVE against the card\'s own list — they never replace it', () => {
  assert.deepStrictEqual(bulk.labelsAfter(['ui', 'bug'], 'urgent', null), ['ui', 'bug', 'urgent']);
  assert.deepStrictEqual(bulk.labelsAfter(['ui', 'bug'], null, 'ui'), ['bug']);
  assert.deepStrictEqual(bulk.labelsAfter(['ui', 'bug'], 'ui', null), ['ui', 'bug'], 'already there = unchanged');
  assert.deepStrictEqual(bulk.labelsAfter(['ui'], null, 'gone'), ['ui'], 'removing what is not there = unchanged');
  assert.deepStrictEqual(bulk.labelsAfter(undefined, 'first', null), ['first'], 'a card with no labels yet');
});

test('a live worker refuses the archive — and "live" is the registry, not the advisory lease', () => {
  // The shape the real board records for a card being worked on RIGHT NOW: it
  // sits in Working, it has NO card.status at all (nothing on the workspace
  // calls status.set), and its liveness lives entirely in board.workers.
  const working = { id: 'bulk-actions', column: 'working' };
  board([working], [{ card: 'bulk-actions', done: false, branch: 'bc/bulk-actions' }]);
  assert.strictEqual(bulk.archiveRefusal(working), 'live worker on bc/bulk-actions',
    'the guard has to fire on the card as the real board records it');

  // done = the worker finished; the entry stays until the card is archived or released
  board([working], [{ card: 'bulk-actions', done: true }]);
  assert.strictEqual(bulk.archiveRefusal(working), null);

  // no registry entry at all
  board([working], []);
  assert.strictEqual(bulk.archiveRefusal(working), null);

  // the lease is asked SECOND, never alone: `absent` proves nothing, but a set
  // lease with no registry entry is still worth refusing
  board([working], []);
  assert.strictEqual(bulk.archiveRefusal({ id: 'x', status: { worker: { id: 'w1', state: 'working' } } }), 'worker working');
  assert.strictEqual(bulk.archiveRefusal({ id: 'x', status: { worker: { id: null, state: 'absent' } } }), null);
});

test('the archive plan splits the selection before anything happens', () => {
  const list = [{ id: 'a' }, { id: 'b' }, { id: 'c' }];
  board(list, [{ card: 'b', done: false }, { card: 'c', done: true }]);
  const plan = bulk.archivePlan(list);
  assert.deepStrictEqual(plan.go.map((c) => c.id), ['a', 'c']);
  assert.deepStrictEqual(plan.refused.map((c) => c.id), ['b']);
});

test('the destructive confirm says what will happen, with the count, before it happens', () => {
  const live = { id: 'b', title: 'live one', column: 'working' };
  const list = [{ id: 'a', title: 'one' }, live, { id: 'c', title: 'three' }];
  board(list, [{ card: 'b', done: false }]);
  const c = bulk.archiveConfirmText(list);
  assert.strictEqual(c.n, 2);
  assert.match(c.text, /Archive 2 cards\?/);
  assert.match(c.text, /restorable/i, 'it does not pretend the cards evaporate');
  assert.strictEqual(c.refused, '1 refused, live worker: live one');

  const none = bulk.archiveConfirmText([live]);
  assert.strictEqual(none.n, 0);
  assert.match(none.text, /Nothing to archive/);
});

test('one action, many cards, one report — naming everything that did not go plainly', () => {
  const r = bulk.reportText('Archived', [
    { title: 'one', ok: true, note: '' },
    { title: 'two', ok: true, note: '' },
    { title: 'three', ok: false, note: 'worker working' },
  ]);
  assert.strictEqual(r.text, 'Archived 2 of 3 cards');
  assert.strictEqual(r.sub, 'three — worker working');
  assert.strictEqual(r.allOk, false);
  const clean = bulk.reportText('Moved', [{ title: 'one', ok: true, note: '' }]);
  assert.strictEqual(clean.text, 'Moved 1 of 1 card');
  assert.strictEqual(clean.sub, '', 'nothing to say when everything went plainly');
  assert.strictEqual(clean.allOk, true);
});

test('partial success is the normal case: a card that did something else still counts as done', () => {
  const r = bulk.reportText('Moved', [
    { title: 'one', ok: true, note: '' },
    { title: 'two', ok: true, note: 'start-order sent to scout' },
  ]);
  assert.strictEqual(r.text, 'Moved 2 of 2 cards');
  assert.strictEqual(r.sub, 'two — start-order sent to scout');
});
