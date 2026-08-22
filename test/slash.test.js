'use strict';
// ui/js/slash.js — the composer picker's two stages: complete a command NAME,
// then, for a command that reports `args`, keep completing its VALUES past the
// space. The module is ESM (it ships to the browser), hence dynamic import —
// same shape as panekeys.test.js.
const test = require('node:test');
const assert = require('node:assert');
const path = require('node:path');
const { pathToFileURL } = require('node:url');

let slashOptions;
test.before(async () => {
  ({ slashOptions } = await import(
    pathToFileURL(path.join(__dirname, '..', 'ui', 'js', 'slash.js')).href));
});

// The shape /api/commands actually returns: a couple of argument-less commands
// and one that reports its own options.
const ITEMS = [
  { name: '/status', description: 'model, context usage and rate limits' },
  { name: '/compact', description: 'compact the conversation to free context' },
  { name: '/help', description: 'list the available commands' },
  {
    name: '/output-style',
    description: "switch this session's output style",
    args: [
      { value: 'default', description: 'efficient and concise' },
      { value: 'Explanatory', description: 'explains its choices' },
      { value: 'ELI5', description: 'keep it simple pls' },
      { value: 'Two Words', description: 'a name with a space in it' },
    ],
  },
];
const names = (r) => r.matches.map((m) => m.name);

test('stage one is unchanged: a single leading-"/" token completes command names', () => {
  const all = slashOptions('/', ITEMS);
  assert.strictEqual(all.stage, 'command');
  assert.deepStrictEqual(names(all), ['/status', '/compact', '/help', '/output-style']);

  assert.deepStrictEqual(names(slashOptions('/st', ITEMS)), ['/status']);
  assert.deepStrictEqual(names(slashOptions('/output-st', ITEMS)), ['/output-style'],
    'still completing the NAME while there is no space');
  assert.deepStrictEqual(names(slashOptions('/nope', ITEMS)), [], 'no match, no rows');
});

test('an argument-less command inserts itself and closes; one WITH args opens the next stage', () => {
  const bare = slashOptions('/st', ITEMS).matches[0];
  assert.strictEqual(bare.insert, '/status', 'no trailing space — the pick is complete');

  const withArgs = slashOptions('/output-st', ITEMS).matches[0];
  assert.strictEqual(withArgs.insert, '/output-style ',
    'the trailing space IS the second stage trigger, so picking it shows the values');
});

test('stage two: the trailing space lists that command\'s args instead of closing', () => {
  const r = slashOptions('/output-style ', ITEMS);
  assert.strictEqual(r.stage, 'arg');
  assert.strictEqual(r.command, '/output-style');
  assert.deepStrictEqual(names(r), ['default', 'Explanatory', 'ELI5', 'Two Words']);
  // rows carry name + description, exactly like the command stage
  assert.strictEqual(r.matches[2].description, 'keep it simple pls');
});

test('stage two filters case-insensitively', () => {
  assert.deepStrictEqual(names(slashOptions('/output-style eli', ITEMS)), ['ELI5']);
  assert.deepStrictEqual(names(slashOptions('/output-style ELI', ITEMS)), ['ELI5']);
  assert.deepStrictEqual(names(slashOptions('/output-style e', ITEMS)), ['Explanatory', 'ELI5']);
  assert.deepStrictEqual(names(slashOptions('/output-style zzz', ITEMS)), []);
});

test('picking an arg inserts "<command> <value>"', () => {
  const m = slashOptions('/output-style eli', ITEMS).matches[0];
  assert.strictEqual(m.insert, '/output-style ELI5');
});

test('a value containing a space round-trips: matched whole, inserted verbatim', () => {
  // The argument is never tokenized, so a two-word style is both reachable and
  // re-typable — and needs no quoting, because the harness reads back the same
  // string the picker inserted.
  const typed = slashOptions('/output-style Two W', ITEMS);
  assert.deepStrictEqual(names(typed), ['Two Words']);
  assert.strictEqual(typed.matches[0].insert, '/output-style Two Words');
  // and that exact inserted text still resolves to the same single row
  assert.deepStrictEqual(names(slashOptions('/output-style Two Words', ITEMS)), ['Two Words']);
});

test('a command with no args closes on the space, exactly as the picker always did', () => {
  for (const v of ['/compact ', '/status ', '/help x']) {
    const r = slashOptions(v, ITEMS);
    assert.strictEqual(r.stage, null, v);
    assert.deepStrictEqual(r.matches, [], v);
  }
});

test('an unknown command name never opens a second stage', () => {
  assert.strictEqual(slashOptions('/ghost ', ITEMS).stage, null);
  // ...and neither does a command whose args came back empty (a harness may
  // report the field and have nothing to put in it)
  assert.strictEqual(slashOptions('/x ', [{ name: '/x', args: [] }]).stage, null);
});

test('a harness that never sends args behaves exactly as before', () => {
  const plain = ITEMS.slice(0, 3); // no command reports args
  assert.deepStrictEqual(names(slashOptions('/', plain)), ['/status', '/compact', '/help']);
  for (const m of slashOptions('/', plain).matches) {
    assert.ok(!/ $/.test(m.insert), m.name + ' inserts with no trailing space');
  }
  assert.strictEqual(slashOptions('/status ', plain).stage, null, 'and the space still closes it');
});

test('a second line closes the picker: that is a message being written, not a command', () => {
  assert.strictEqual(slashOptions('/output-style ELI5\nand another line', ITEMS).stage, null);
  assert.strictEqual(slashOptions('/status\nmore', ITEMS).stage, null);
});

test('junk off the wire is survivable, never a throw', () => {
  for (const items of [null, undefined, 'nope', [null, 42, {}, { name: 7 }]]) {
    assert.deepStrictEqual(slashOptions('/', items).matches, []);
  }
  assert.deepStrictEqual(slashOptions(null, ITEMS).matches, []);
  assert.deepStrictEqual(slashOptions(undefined, ITEMS).matches, []);
  assert.deepStrictEqual(slashOptions('', ITEMS).matches, [], 'an empty composer is not a picker');
  assert.deepStrictEqual(slashOptions('hello', ITEMS).matches, [], 'and neither is plain prose');
  // an args entry that is not shaped right is skipped, not crashed on
  assert.deepStrictEqual(
    names(slashOptions('/x ', [{ name: '/x', args: [null, { value: 5 }, { value: 'ok' }] }])),
    ['ok']);
});
