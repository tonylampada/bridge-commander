'use strict';
// The seatbelt: the pipeline file is meant to be edited by hand, which means
// it WILL be edited wrongly. Every prompt in it becomes an agent launch, so a
// mistake caught here costs nothing and the same mistake caught later costs a
// worker's turn. What is pinned below is that the refusal happens, and that it
// says WHERE — an error without a filename is a scavenger hunt.
//
// It also pins the shape of the lookup itself: ONE folder, and reuse that is
// written down (`extends: <name>`) instead of inferred from which directory a
// file happens to sit in.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { resolve, merge, sourceOf, validate, chain, available, pipelinesDir, MAX_CHAIN } = require('../pipeline/config.js');
const { seed } = require('../pipeline/seed.js');
const { render, refs } = require('../pipeline/template.js');

// A workspace on disk, so resolution is tested the way it runs.
function write(ws, name, body) {
  const dir = pipelinesDir(ws);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, name + '.yaml'), body);
}
function withWorkspace(fn, { seeded = true } = {}) {
  const ws = fs.mkdtempSync(path.join(os.tmpdir(), 'bc-pipe-cfg-'));
  try {
    if (seeded) seed(ws);
    return fn(ws);
  } finally {
    fs.rmSync(ws, { recursive: true, force: true });
  }
}

test('a seeded workspace validates as shipped', () => {
  withWorkspace((ws) => {
    const r = resolve({ workspace: ws, name: 'validated-pr' });
    assert.deepStrictEqual(r.errors, []);
    assert.strictEqual(r.pipeline.name, 'validated-pr');
    assert.strictEqual(r.pipeline.max_rounds, 3);
    assert.ok(r.pipeline.working.prompt.includes('{{done}}'), 'the implementer is told how to report');
    assert.ok(r.pipeline.validating.run.length, 'validation runs something before it judges');
  });
});

test('seeding is a copy into the workspace, and it never clobbers your edits', () => {
  withWorkspace((ws) => {
    const mine = path.join(pipelinesDir(ws), 'validated-pr.yaml');
    assert.ok(fs.existsSync(mine), 'the first seed wrote it');

    fs.writeFileSync(mine, 'max_rounds: 9\nworking:\n  prompt: mine\nvalidating: none\n');
    const again = seed(ws);
    assert.deepStrictEqual(again.written, [], 'nothing was written the second time');
    assert.ok(again.kept.includes('validated-pr.yaml'), 'and it says what it kept');
    assert.strictEqual(resolve({ workspace: ws, name: 'validated-pr' }).pipeline.max_rounds, 9,
      'the edited file survived — that is the whole point of the folder');
  });
});

test('extends merges base first: nested maps merge, lists replace, the extender wins', () => {
  withWorkspace((ws) => {
    write(ws, 'ours', 'extends: validated-pr\nmax_rounds: 5\nvalidating:\n  run:\n    - node --test\n');
    const r = resolve({ workspace: ws, name: 'ours' });
    assert.deepStrictEqual(r.errors, []);
    assert.strictEqual(r.pipeline.max_rounds, 5, 'the extending file won');
    assert.deepStrictEqual(r.pipeline.validating.run, ['node --test'], 'a list replaces, it does not append');
    assert.ok(r.pipeline.validating.prompt.includes('{{run.output}}'),
      'the untouched half of the overridden stage still comes from the base');
    assert.ok(r.pipeline.preamble.includes('Ground rules'), 'and so does everything nobody overrode');
    assert.strictEqual(r.pipeline.extends, undefined, 'extends did its job during the walk; it is not a runtime key');
    assert.deepStrictEqual(r.layers.map((l) => path.basename(l.file)),
      ['validated-pr.yaml', 'ours.yaml'], 'layers come back base first, in merge order');
  });
});

test('a chain of three resolves, and depth is bounded', () => {
  withWorkspace((ws) => {
    write(ws, 'mid', 'extends: validated-pr\nmax_rounds: 7\n');
    write(ws, 'top', 'extends: mid\nname: top\n');
    const r = resolve({ workspace: ws, name: 'top' });
    assert.deepStrictEqual(r.errors, []);
    assert.strictEqual(r.pipeline.max_rounds, 7, 'inherited through the middle file');
    assert.strictEqual(r.pipeline.name, 'top');
    assert.ok(r.pipeline.working.prompt.includes('{{done}}'), 'and the root is still in there');

    for (let i = 0; i < MAX_CHAIN + 2; i++) write(ws, 'deep' + i, `extends: deep${i + 1}\n`);
    const deep = resolve({ workspace: ws, name: 'deep0' });
    assert.match(deep.errors[0], new RegExp(`more than ${MAX_CHAIN} files deep`));
  });
});

test('a loop is refused by name, not by running out of stack', () => {
  withWorkspace((ws) => {
    write(ws, 'a', 'extends: b\n');
    write(ws, 'b', 'extends: a\n');
    const r = resolve({ workspace: ws, name: 'a' });
    assert.strictEqual(r.pipeline, null);
    assert.match(r.errors[0], /extends — loops back to "a"/);
    assert.match(r.errors[0], /a → b → a/);
  });
});

test('extending something that is not there names the file that asked for it', () => {
  withWorkspace((ws) => {
    write(ws, 'ours', 'extends: no-such-base\n');
    const r = resolve({ workspace: ws, name: 'ours' });
    assert.match(r.errors[0], /ours\.yaml: extends — no pipeline named "no-such-base"/);
    assert.match(r.errors[0], /it holds: .*validated-pr/, 'and it lists what you could have meant');
  });
});

test('extends must be a name in the folder — never a path', () => {
  withWorkspace((ws) => {
    write(ws, 'ours', 'extends: 4\n');
    assert.match(resolve({ workspace: ws, name: 'ours' }).errors[0], /extends — must be the name of another pipeline/);

    write(ws, 'pathy', 'extends: "../../elsewhere/validated-pr"\n');
    const r = resolve({ workspace: ws, name: 'pathy' });
    assert.ok(r.errors.length, 'a path does not resolve to a pipeline');
    assert.match(r.errors[0], /no pipeline named/);
  });
});

test('an error names the file the key actually came from', () => {
  withWorkspace((ws) => {
    write(ws, 'ours', 'extends: validated-pr\nmax_rounds: 0\n');
    const r = resolve({ workspace: ws, name: 'ours' });
    assert.strictEqual(r.errors.length, 1, r.errors.join('\n'));
    assert.match(r.errors[0], /pipelines\/ours\.yaml: max_rounds/);
    assert.match(r.errors[0], /1 or more/);
  });
});

test('refusals: unknown keys, malformed stages, and a stage that cannot report', () => {
  const layers = [{ file: 'p.yaml', data: {} }];
  const errs = (doc) => validate(doc, [{ file: 'p.yaml', data: doc }]);

  let e = errs({ max_rounds: 3, rounds: 4, working: { prompt: 'x' }, validating: 'none' });
  assert.strictEqual(e.length, 1);
  assert.match(e[0], /rounds — unknown key/);
  assert.match(e[0], /known: name, extends/, 'and extends is listed as a thing you may write');

  e = errs({ max_rounds: 3, working: { prompt: 'x', retry: true }, validating: 'none' });
  assert.match(e[0], /working\.retry — unknown stage key/);

  e = errs({ max_rounds: 3, working: { prompt: '   ' }, validating: 'none' });
  assert.match(e[0], /working\.prompt — must be non-empty/);

  e = errs({ max_rounds: 3, working: 'none', validating: 'none' });
  assert.match(e.join('\n'), /working — cannot be skipped/);

  e = errs({ max_rounds: 3, working: { prompt: 'x' } });
  assert.match(e[0], /validating — is required/);

  e = errs({ max_rounds: 3, working: { prompt: 'x', run: [] }, validating: 'none' });
  assert.match(e[0], /working\.run — must be a non-empty list/);

  assert.deepStrictEqual(errs({ max_rounds: 1, working: { prompt: 'x' }, validating: 'none' }), [],
    'a one-stage pipeline is a legitimate pipeline');
  assert.strictEqual(layers.length, 1);
});

test('a misspelled variable is an error, because a rendered typo is invisible', () => {
  const errs = (doc) => validate(doc, [{ file: 'p.yaml', data: doc }]);

  let e = errs({ max_rounds: 3, working: { prompt: 'fix {{card.titel}}' }, validating: 'none' });
  assert.strictEqual(e.length, 1);
  assert.match(e[0], /working\.prompt — unknown variable \{\{card\.titel\}\}/);
  assert.match(e[0], /known: card\.id/, 'and it lists what you could have meant');

  e = errs({ max_rounds: 3, working: { prompt: '{{#findings}}fix them' }, validating: 'none' });
  assert.match(e[0], /unbalanced section \{\{#findings\}\}/);

  e = errs({ max_rounds: 3, working: { prompt: 'read {{run.output}}' }, validating: 'none' });
  assert.match(e[0], /references \{\{run\.output\}\} but working runs nothing/);

  e = errs({ max_rounds: 3, working: { prompt: 'read {{run.output}}', run: ['echo hi'] }, validating: 'none' });
  assert.deepStrictEqual(e, [], 'with a run, the reference is real');

  e = errs({ max_rounds: 3, preamble: 'you are {{whoever}}', working: { prompt: 'x' }, validating: 'none' });
  assert.match(e[0], /preamble — unknown variable \{\{whoever\}\}/);
});

test('broken YAML is refused with the line, not a stack trace', () => {
  withWorkspace((ws) => {
    write(ws, 'ours', 'max_rounds: 3\nworking:\n  prompt: [unclosed\n');
    const r = resolve({ workspace: ws, name: 'ours' });
    assert.match(r.errors[0], /ours\.yaml:\d+ — not valid YAML/);
  });
});

test('a pipeline nobody wrote is a refusal that names the one folder', () => {
  withWorkspace((ws) => {
    const r = resolve({ workspace: ws, name: 'no-such-pipeline' });
    assert.strictEqual(r.pipeline, null);
    assert.match(r.errors[0], /no pipeline named "no-such-pipeline"/);
    assert.match(r.errors[0], /pipelines has no no-such-pipeline\.yaml/);
    assert.match(r.errors[0], /it holds: .*validated-pr/);
  });
});

test('an unseeded workspace says so instead of pointing at a file nobody has', () => {
  withWorkspace((ws) => {
    assert.deepStrictEqual(available(ws), [], 'nothing seeded');
    const r = resolve({ workspace: ws, name: 'validated-pr' });
    assert.match(r.errors[0], /the folder is empty — seed it with pipeline\/seed\.js/);
  }, { seeded: false });
});

test('the chain is the only place a pipeline is read from', () => {
  withWorkspace((ws) => {
    const { files } = chain(ws, 'validated-pr');
    assert.strictEqual(files.length, 1);
    assert.strictEqual(files[0], path.join(ws, '.bridge-commander', 'pipelines', 'validated-pr.yaml'),
      'one folder, one file — no repo layer, no project layer');
  });
});

test('sourceOf points at the LAST layer that set the key', () => {
  const layers = [
    { file: 'base.yaml', data: { max_rounds: 3, working: { prompt: 'a', run: ['x'] } } },
    { file: 'ours.yaml', data: { working: { prompt: 'b' } } },
  ];
  assert.strictEqual(sourceOf(layers, 'max_rounds'), 'base.yaml');
  assert.strictEqual(sourceOf(layers, 'working.prompt'), 'ours.yaml');
  assert.strictEqual(sourceOf(layers, 'working.run'), 'base.yaml');
  assert.deepStrictEqual(merge(layers).working, { prompt: 'b', run: ['x'] });
});

test('the template language is two forms and nothing else', () => {
  const vars = { name: 'ada', findings: '', 'run.output': 'boom' };
  assert.strictEqual(render('hi {{name}}', vars), 'hi ada');
  assert.strictEqual(render('a{{#findings}}FIX{{/findings}}b', vars), 'ab', 'empty drops the block');
  assert.strictEqual(render('a{{#run.output}}saw: {{run.output}}{{/run.output}}b', vars), 'asaw: boomb');
  assert.throws(() => render('{{nope}}', vars), /unknown variable \{\{nope\}\}/);
  const r = refs('{{a}} {{#b}}{{c}}{{/b}} {{#d}}');
  assert.deepStrictEqual([...r.vars], ['a', 'c']);
  assert.deepStrictEqual([...r.sections], ['b', 'd']);
  assert.deepStrictEqual(r.unbalanced, ['d']);
});
