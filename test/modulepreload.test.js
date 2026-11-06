'use strict';
// ui/index.html names the board's whole static import tree as
// <link rel="modulepreload">, so a browser asks for every module at once
// instead of one import level per round trip. The block is generated
// (dev/modulepreload.js); this is the check that keeps it from drifting.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const { importTree, render, INDEX, BEGIN, END } = require('../dev/modulepreload.js');

const html = fs.readFileSync(INDEX, 'utf8');

test('the modulepreload block in ui/index.html is the current import tree', () => {
  assert.ok(html.includes(BEGIN) && html.includes(END), 'the block is there');
  assert.strictEqual(render(html, importTree()), html,
    'stale modulepreload block: run `node dev/modulepreload.js` and commit ui/index.html');
});

test('the tree reaches every board module, and every link points at a real file', () => {
  const tree = importTree();
  const ui = path.join(__dirname, '..', 'ui');
  for (const u of tree) assert.ok(fs.existsSync(path.join(ui, u.replace(/^\/ui\//, ''))), u);
  // every module beside main.js is in the board's tree today; one that is not
  // would be dead code or a lazy import, and should be a deliberate choice
  const own = fs.readdirSync(path.join(ui, 'js')).filter((f) => f.endsWith('.js') && f !== 'main.js');
  for (const f of own) assert.ok(tree.includes('/ui/js/' + f), f + ' is preloaded');
  assert.ok(!tree.includes('/ui/js/main.js'), 'the entry loads itself');
  assert.strictEqual(new Set(tree).size, tree.length, 'each module once');
});

test('the generator follows multi-line imports and side-effect imports, not dynamic ones', () => {
  const fixture = path.join(__dirname, 'fixtures', 'modulepreload');
  fs.rmSync(fixture, { recursive: true, force: true });
  fs.mkdirSync(path.join(fixture, 'js'), { recursive: true });
  const w = (f, src) => fs.writeFileSync(path.join(fixture, 'js', f), src);
  try {
    w('entry.js', "import {\n  a,\n  b } from './a.js';\nimport './side.js';\nexport { c } from './c.js';\nconst lazy = () => import('./lazy.js');\n");
    w('a.js', "import { b } from './sub/../b.js';\nexport const a = 1;\n");
    w('b.js', 'export const b = 2;\n');
    w('c.js', 'export const c = 3;\n');
    w('side.js', '// nothing\n');
    w('lazy.js', 'export default 0;\n');
    const tree = importTree('/ui/js/entry.js', fixture);
    assert.deepStrictEqual(tree, ['/ui/js/a.js', '/ui/js/b.js', '/ui/js/side.js', '/ui/js/c.js']);
  } finally {
    fs.rmSync(fixture, { recursive: true, force: true });
  }
});
