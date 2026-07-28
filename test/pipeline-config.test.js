'use strict';
// The seatbelt: the pipeline file is meant to be edited by hand, which means
// it WILL be edited wrongly. Every prompt in it becomes an agent launch, so a
// mistake caught here costs nothing and the same mistake caught later costs a
// worker's turn. What is pinned below is that the refusal happens, and that it
// says WHERE — with three layers in play, an error without a filename is a
// scavenger hunt.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { resolve, merge, sourceOf, validate } = require('../pipeline/config.js');
const { render, refs } = require('../pipeline/template.js');

const REPO = path.join(__dirname, '..');

// A workspace/project layer on disk, so precedence is tested the way it runs.
function layerDir(root, kind, name, body) {
  const dir = kind === 'workspace'
    ? path.join(root, 'ws', '.bridge-commander', 'pipelines')
    : path.join(root, 'proj', '.bridge-commander', 'pipelines');
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, name + '.yaml'), body);
  return dir;
}
function withRoot(fn) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'bc-pipe-cfg-'));
  try { return fn(root); } finally { fs.rmSync(root, { recursive: true, force: true }); }
}
function resolveIn(root, name = 'validated-pr') {
  return resolve({
    repoRoot: REPO, workspace: path.join(root, 'ws'), projectPath: path.join(root, 'proj'), name,
  });
}

test('the factory pipeline validates as shipped', () => {
  const r = resolveIn(path.join(os.tmpdir(), 'no-such-root'));
  assert.deepStrictEqual(r.errors, []);
  assert.strictEqual(r.pipeline.name, 'validated-pr');
  assert.strictEqual(r.pipeline.max_rounds, 3);
  assert.ok(r.pipeline.working.prompt.includes('{{done}}'), 'the implementer is told how to report');
  assert.ok(r.pipeline.validating.run.length, 'validation runs something before it judges');
});

test('layers merge key by key: nested maps merge, lists replace, later wins', () => {
  withRoot((root) => {
    layerDir(root, 'workspace', 'validated-pr', 'max_rounds: 5\nvalidating:\n  run:\n    - echo ws\n');
    layerDir(root, 'project', 'validated-pr', 'working:\n  prompt: |\n    just do it, {{card.id}}\n');
    const r = resolveIn(root);
    assert.deepStrictEqual(r.errors, []);
    assert.strictEqual(r.pipeline.max_rounds, 5, 'the workspace layer won');
    assert.strictEqual(r.pipeline.working.prompt.trim(), 'just do it, {{card.id}}', 'the project layer won');
    assert.deepStrictEqual(r.pipeline.validating.run, ['echo ws'], 'a list replaces, it does not append');
    assert.ok(r.pipeline.validating.prompt.includes('{{run.output}}'),
      'the untouched half of the overridden stage still comes from the factory');
    assert.ok(r.pipeline.preamble.includes('Ground rules'), 'and so does everything nobody overrode');
  });
});

test('an error names the file the key actually came from', () => {
  withRoot((root) => {
    layerDir(root, 'workspace', 'validated-pr', 'max_rounds: 0\n');
    const r = resolveIn(root);
    assert.strictEqual(r.errors.length, 1, r.errors.join('\n'));
    assert.match(r.errors[0], /ws\/\.bridge-commander\/pipelines\/validated-pr\.yaml: max_rounds/);
    assert.match(r.errors[0], /1 or more/);
  });
});

test('refusals: unknown keys, malformed stages, and a stage that cannot report', () => {
  const layers = [{ file: 'p.yaml', data: {} }];
  const errs = (doc) => validate(doc, [{ file: 'p.yaml', data: doc }]);

  let e = errs({ max_rounds: 3, rounds: 4, working: { prompt: 'x' }, validating: 'none' });
  assert.strictEqual(e.length, 1);
  assert.match(e[0], /rounds — unknown key/);

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
  withRoot((root) => {
    layerDir(root, 'workspace', 'validated-pr', 'max_rounds: 3\nworking:\n  prompt: [unclosed\n');
    const r = resolveIn(root);
    assert.match(r.errors[0], /validated-pr\.yaml:\d+ — not valid YAML/);
  });
});

test('a pipeline nobody wrote is a refusal that lists where it looked', () => {
  withRoot((root) => {
    const r = resolveIn(root, 'no-such-pipeline');
    assert.strictEqual(r.pipeline, null);
    assert.match(r.errors[0], /no pipeline named "no-such-pipeline"/);
    assert.match(r.errors[0], /pipeline\/pipelines\/no-such-pipeline\.yaml/);
  });
});

test('sourceOf points at the LAST layer that set the key', () => {
  const layers = [
    { file: 'factory.yaml', data: { max_rounds: 3, working: { prompt: 'a', run: ['x'] } } },
    { file: 'ws.yaml', data: { working: { prompt: 'b' } } },
  ];
  assert.strictEqual(sourceOf(layers, 'max_rounds'), 'factory.yaml');
  assert.strictEqual(sourceOf(layers, 'working.prompt'), 'ws.yaml');
  assert.strictEqual(sourceOf(layers, 'working.run'), 'factory.yaml');
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
