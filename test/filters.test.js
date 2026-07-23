'use strict';
// ui/js/state.js — the tri-state owner/label filter seams: setFilter (the
// popup's 3-position switch), toggleFilter (board/table/detail include
// toggles), and selMatches/cardVisible semantics (excludes drop the card
// outright; includes are OR within a dimension, AND across). state.js touches
// no DOM at import, so it's imported directly (state-actor.test.js pattern).
const test = require('node:test');
const assert = require('node:assert');
const path = require('node:path');
const { pathToFileURL } = require('node:url');

let S, setFilter, toggleFilter, filterMode, filterSelected, cardVisible, clearFilters, activeFilterCount;
test.before(async () => {
  ({ S, setFilter, toggleFilter, filterMode, filterSelected, cardVisible, clearFilters, activeFilterCount } =
    await import(pathToFileURL(path.join(__dirname, '..', 'ui', 'js', 'state.js')).href));
});

const CARDS = [
  { id: 'a', owner: 'monica', labels: ['infra'] },
  { id: 'b', owner: 'rex', labels: ['ux', 'infra'] },
  { id: 'c', owner: 'rex', labels: [] },
  { id: 'd', owner: 'ada', labels: ['ux'] },
];
function visible() { return CARDS.filter(cardVisible).map((c) => c.id).join(''); }
test.beforeEach(() => { S.filters = { text: '', age: '', sel: [], types: [], columns: [] }; });

test('no owner/label selections: everything visible', () => {
  assert.strictEqual(visible(), 'abcd');
});

test('include-only: owner include keeps only that owner; two includes OR', () => {
  setFilter('owner', 'monica', 'in');
  assert.strictEqual(visible(), 'a');
  setFilter('owner', 'ada', 'in');
  assert.strictEqual(visible(), 'ad');
});

test('include-only: label includes OR within the dimension', () => {
  setFilter('label', 'infra', 'in');
  assert.strictEqual(visible(), 'ab');
  setFilter('label', 'ux', 'in');
  assert.strictEqual(visible(), 'abd');
});

test('exclude-only: excluded owner/label cards are dropped, rest untouched', () => {
  setFilter('owner', 'rex', 'out');
  assert.strictEqual(visible(), 'ad');
  setFilter('label', 'ux', 'out');
  assert.strictEqual(visible(), 'a');
});

test('mixed: include and exclude compose across dimensions', () => {
  setFilter('label', 'infra', 'in');
  setFilter('owner', 'rex', 'out');
  assert.strictEqual(visible(), 'a'); // infra cards minus rex's
});

test('mixed within one dimension: include one owner, exclude another', () => {
  setFilter('owner', 'monica', 'in');
  setFilter('owner', 'rex', 'out');
  assert.strictEqual(visible(), 'a');
});

test('setFilter: direct set, overwrite, and back to dont-care', () => {
  setFilter('owner', 'rex', 'out');
  assert.strictEqual(filterMode('owner', 'rex'), 'out');
  setFilter('owner', 'rex', 'in');
  assert.strictEqual(filterMode('owner', 'rex'), 'in');
  assert.strictEqual(S.filters.sel.length, 1); // overwrote, not stacked
  setFilter('owner', 'rex', '');
  assert.strictEqual(filterMode('owner', 'rex'), '');
  assert.strictEqual(S.filters.sel.length, 0);
});

test('toggleFilter stays a plain include on/off; an exclude flips to include', () => {
  toggleFilter('label', 'ux');
  assert.strictEqual(filterMode('label', 'ux'), 'in');
  toggleFilter('label', 'ux');
  assert.strictEqual(filterMode('label', 'ux'), '');
  setFilter('label', 'ux', 'out');
  toggleFilter('label', 'ux');
  assert.strictEqual(filterMode('label', 'ux'), 'in');
});

test('filterSelected means include only; excludes count in the badge', () => {
  setFilter('owner', 'rex', 'out');
  assert.strictEqual(filterSelected('owner', 'rex'), false);
  setFilter('owner', 'monica', 'in');
  assert.strictEqual(filterSelected('owner', 'monica'), true);
  assert.strictEqual(activeFilterCount(), 2);
});

test('mode-less entries (older paths) behave as includes', () => {
  S.filters.sel.push({ kind: 'owner', value: 'monica' });
  assert.strictEqual(filterMode('owner', 'monica'), 'in');
  assert.strictEqual(visible(), 'a');
});

test('clearFilters wipes includes and excludes', () => {
  setFilter('owner', 'rex', 'out');
  setFilter('label', 'infra', 'in');
  clearFilters();
  assert.strictEqual(S.filters.sel.length, 0);
  assert.strictEqual(visible(), 'abcd');
});
