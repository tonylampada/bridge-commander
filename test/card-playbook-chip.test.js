'use strict';
// The playbook chip on the card detail screen. Two claims, both about WHO the
// pointer is readable and editable by: the word on the chip is "playbook" (never
// "brief" — that is the rendered text the worker receives, not the template it
// comes from), and the ✎ that opens the picker belongs to Backlog alone. A card
// that already started rendered its brief from the playbook it had; repointing
// it afterwards changes nothing about the worker, so the editor is not offered.
// util.js is browser ES-module code that touches no DOM at import time, so the
// renderer is imported directly (detail.js cannot be — it binds DOM at import).
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const { pathToFileURL } = require('node:url');

const utilMod = import(pathToFileURL(path.join(__dirname, '..', 'ui', 'js', 'util.js')).href);
const uiDir = path.join(__dirname, '..', 'ui');
const cardIn = (column, playbook) =>
  ({ id: 'MNC-1', type: 'implementation', column, playbook });

test('a Backlog card shows the playbook and offers the picker', async () => {
  const { playbookAttrHtml } = await utilMod;
  const html = playbookAttrHtml(cardIn('backlog', 'default'), true);
  assert.match(html, /<span class="k">playbook<\/span>/, 'the chip is labelled playbook');
  assert.match(html, /<span class="v">default<\/span>/, 'it shows the card\'s playbook');
  assert.match(html, /<button type="button" class="owner-edit"/, 'the ✎ opens the picker');
});

test('a card outside Backlog shows the playbook and no editor', async () => {
  const { playbookAttrHtml } = await utilMod;
  for (const column of ['working', 'review', 'peer']) {
    const html = playbookAttrHtml(cardIn(column, 'default'), false);
    assert.match(html, /<span class="v">default<\/span>/, column + ': the playbook is still shown');
    assert.doesNotMatch(html, /<button/, column + ': no editor is offered');
  }
});

test('no playbook reads as a card that cannot start, editable or not', async () => {
  const { playbookAttrHtml } = await utilMod;
  for (const editable of [true, false]) {
    const html = playbookAttrHtml(cardIn(editable ? 'backlog' : 'working', ''), editable);
    assert.match(html, /class="attr attr-playbook none"/, 'the chip carries the none state');
    assert.match(html, /none — cannot start/);
  }
  // a plan card never starts, so it has no playbook to show at all
  assert.strictEqual(playbookAttrHtml({ id: 'MNC-2', type: 'plan', column: 'backlog', playbook: '' }, true), '');
});

test('the detail panel only ever draws the ✎ from the Backlog branch', () => {
  // the gate is one argument, and it is this one — a later hand adding a second
  // way to draw the chip has to come back through playbookAttrHtml
  const src = fs.readFileSync(path.join(uiDir, 'js', 'detail.js'), 'utf8');
  assert.match(src, /playbookAttrHtml\(c, !arch && c\.column === 'backlog'\)/);
  assert.doesNotMatch(src, /attr-playbook'/, 'the chip markup is not rebuilt inline');
});
