'use strict';
// Label registry: born on first use, palette colors, rename/recolor/delete ripple to cards.
const test = require('node:test');
const assert = require('node:assert');
const { startServerWithColumns } = require('./helper');

test('labels are auto-registered from card labels with palette colors', async () => {
  const s = await startServerWithColumns();
  try {
    await s.api('POST', '/api/cards', { title: 'Tagged', labels: ['blue', 'green'] });
    const board = (await s.api('GET', '/api/board')).body;
    assert.deepStrictEqual(board.labels.map((l) => l.name), ['blue', 'green']);
    for (const l of board.labels) assert.match(l.color, /^#[0-9a-fA-F]{6}$/);
    // re-using a label does not duplicate it
    await s.api('POST', '/api/cards', { title: 'Also tagged', labels: ['blue'] });
    assert.strictEqual((await s.api('GET', '/api/board')).body.labels.length, 2);
  } finally {
    await s.stop();
  }
});

test('label create / rename / recolor / delete, rippling to cards', async () => {
  const s = await startServerWithColumns();
  try {
    // create with explicit color; creating again updates the color in place
    let r = await s.api('POST', '/api/labels', { create: { name: 'urgent', color: '#ff0000' } });
    assert.strictEqual(r.status, 200);
    assert.deepStrictEqual(r.body.labels, [{ name: 'urgent', color: '#ff0000' }]);
    r = await s.api('POST', '/api/labels', { create: { name: 'urgent', color: '#00ff00' } });
    assert.deepStrictEqual(r.body.labels, [{ name: 'urgent', color: '#00ff00' }]);

    await s.api('POST', '/api/cards', { title: 'Hot', labels: ['urgent', 'later'] });

    // rename updates every card and dedupes
    r = await s.api('POST', '/api/labels', { rename: { from: 'urgent', to: 'later' } });
    assert.strictEqual(r.status, 400); // collides with existing label
    r = await s.api('POST', '/api/labels', { rename: { from: 'urgent', to: 'now' } });
    assert.strictEqual(r.status, 200);
    let card = (await s.api('GET', '/api/cards/hot')).body;
    assert.deepStrictEqual(card.labels, ['now', 'later']);

    // recolor validates the color and the name
    r = await s.api('POST', '/api/labels', { recolor: { name: 'now', color: 'red' } });
    assert.strictEqual(r.status, 400);
    r = await s.api('POST', '/api/labels', { recolor: { name: 'ghost', color: '#123456' } });
    assert.strictEqual(r.status, 404);
    r = await s.api('POST', '/api/labels', { recolor: { name: 'now', color: '#123456' } });
    assert.strictEqual(r.status, 200);

    // delete removes from the registry and from cards
    r = await s.api('POST', '/api/labels', { delete: { name: 'now' } });
    assert.strictEqual(r.status, 200);
    assert.deepStrictEqual(r.body.labels.map((l) => l.name), ['later']);
    card = (await s.api('GET', '/api/cards/hot')).body;
    assert.deepStrictEqual(card.labels, ['later']);

    // unknown verb rejected
    r = await s.api('POST', '/api/labels', { frobnicate: {} });
    assert.strictEqual(r.status, 400);
  } finally {
    await s.stop();
  }
});
