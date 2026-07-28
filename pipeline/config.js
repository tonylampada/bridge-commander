'use strict';
// config — find the pipeline file, merge the layers, and REFUSE a bad one
// before a single token is spent.
//
// Three layers, each optional except the factory one, merged key by key
// (later wins; nested maps merge, lists replace):
//
//   1. <repo>/pipeline/pipelines/<name>.yaml          ships here, the default
//   2. <workspace>/.bridge-commander/pipelines/<name>.yaml   this board's taste
//   3. <project>/.bridge-commander/pipelines/<name>.yaml     this repo's needs
//
// The file is meant to be edited by hand, which means it will be edited
// wrongly. Validation is not politeness: every prompt in it becomes an agent
// launch, so a typo caught here costs nothing and the same typo caught later
// costs a worker's turn. Every error names the FILE and the KEY it came from —
// with three layers in play, "max_rounds must be a positive integer" without a
// filename is a scavenger hunt.

const fs = require('node:fs');
const path = require('node:path');
const yaml = require('./vendor/js-yaml.min.js');
const { refs } = require('./template.js');

// The variables a stage may mention. Anything else is a typo — and a typo in a
// prompt is invisible once it has been rendered, so it is an error here.
const VARIABLES = [
  'card.id', 'card.title', 'card.task', 'card.thread',
  'branch', 'worktree', 'workspace', 'project.name', 'project.path',
  'round', 'max_rounds', 'findings', 'run.output',
  'bc', 'done', 'reject',
];

const TOP_KEYS = ['name', 'worktree', 'max_rounds', 'preamble', 'working', 'validating'];
const STAGE_KEYS = ['prompt', 'run'];
const STAGES = ['working', 'validating'];

function isPlainObject(v) {
  return !!v && typeof v === 'object' && !Array.isArray(v);
}

// layerFiles(opts) -> [path] — factory first, most specific last.
function layerFiles({ repoRoot, workspace, projectPath, name }) {
  const files = [path.join(repoRoot, 'pipeline', 'pipelines', name + '.yaml')];
  if (workspace) files.push(path.join(workspace, '.bridge-commander', 'pipelines', name + '.yaml'));
  if (projectPath) files.push(path.join(projectPath, '.bridge-commander', 'pipelines', name + '.yaml'));
  return files;
}

// loadLayers(files) -> { layers: [{file, data}], errors: [] }
// A file that is not there is not an error (layers 2 and 3 are opt-in); a file
// that is there and unparseable is, with the line js-yaml points at.
function loadLayers(files) {
  const layers = [];
  const errors = [];
  for (const file of files) {
    let text;
    try {
      text = fs.readFileSync(file, 'utf8');
    } catch {
      continue;
    }
    let data;
    try {
      data = yaml.load(text, { filename: file });
    } catch (e) {
      const line = e && e.mark && Number.isInteger(e.mark.line) ? e.mark.line + 1 : null;
      errors.push(`${file}${line ? ':' + line : ''} — not valid YAML: ${String(e.reason || e.message).split('\n')[0]}`);
      continue;
    }
    if (data === null || data === undefined) continue; // an empty override file overrides nothing
    if (!isPlainObject(data)) {
      errors.push(`${file} — a pipeline file must be a map of keys, got ${Array.isArray(data) ? 'a list' : typeof data}`);
      continue;
    }
    layers.push({ file, data });
  }
  return { layers, errors };
}

// merge(layers) — key by key, later layers winning. Nested maps merge so an
// override can change one stage's prompt without restating the other stage;
// lists (a stage's `run`) replace wholesale, because appending to someone
// else's command list is never what you meant.
function merge(layers) {
  const out = {};
  for (const { data } of layers) mergeInto(out, data);
  return out;
}
function mergeInto(target, src) {
  for (const [k, v] of Object.entries(src)) {
    if (isPlainObject(v) && isPlainObject(target[k])) mergeInto(target[k], v);
    else target[k] = v;
  }
}

// sourceOf(layers, keyPath) -> file — which layer last set this key, so an
// error points at the file the reader has to open.
function sourceOf(layers, keyPath) {
  const parts = keyPath.split('.');
  for (let i = layers.length - 1; i >= 0; i--) {
    let node = layers[i].data;
    let found = true;
    for (const p of parts) {
      if (!isPlainObject(node) || !Object.prototype.hasOwnProperty.call(node, p)) { found = false; break; }
      node = node[p];
    }
    if (found) return layers[i].file;
  }
  return layers.length ? layers[layers.length - 1].file : '(no pipeline file)';
}

// validate(pipeline, layers) -> [error strings]
function validate(pipeline, layers) {
  const errors = [];
  const at = (keyPath, msg) => errors.push(`${sourceOf(layers, keyPath)}: ${keyPath} — ${msg}`);

  for (const key of Object.keys(pipeline)) {
    if (!TOP_KEYS.includes(key)) at(key, `unknown key (known: ${TOP_KEYS.join(', ')})`);
  }
  if ('name' in pipeline && typeof pipeline.name !== 'string') at('name', 'must be a string');
  if ('worktree' in pipeline && typeof pipeline.worktree !== 'boolean') at('worktree', 'must be true or false');
  if (!Number.isInteger(pipeline.max_rounds) || pipeline.max_rounds < 1) {
    at('max_rounds', 'must be a whole number of rounds, 1 or more');
  }
  if ('preamble' in pipeline && typeof pipeline.preamble !== 'string') at('preamble', 'must be text');

  const templates = [];
  if (typeof pipeline.preamble === 'string') templates.push(['preamble', pipeline.preamble, null]);

  for (const name of STAGES) {
    const stage = pipeline[name];
    if (stage === undefined) {
      if (name === 'working') at(name, 'is required — a pipeline with no implementer does nothing');
      else at(name, "is required — use `validating: none` to ship straight from working");
      continue;
    }
    if (stage === null || stage === 'none') continue; // deliberately skipped
    if (!isPlainObject(stage)) {
      at(name, `must be a map of ${STAGE_KEYS.join('/')} (or \`none\` to skip the stage)`);
      continue;
    }
    for (const key of Object.keys(stage)) {
      if (!STAGE_KEYS.includes(key)) at(`${name}.${key}`, `unknown stage key (known: ${STAGE_KEYS.join(', ')})`);
    }
    if (typeof stage.prompt !== 'string' || !stage.prompt.trim()) {
      at(`${name}.prompt`, 'must be non-empty text — it is what the agent is told to do');
    } else {
      templates.push([`${name}.prompt`, stage.prompt, name]);
    }
    if ('run' in stage) {
      if (!Array.isArray(stage.run) || !stage.run.length) {
        at(`${name}.run`, 'must be a non-empty list of command lines');
      } else {
        stage.run.forEach((line, i) => {
          if (typeof line !== 'string' || !line.trim()) at(`${name}.run[${i}]`, 'must be a command line');
          else templates.push([`${name}.run[${i}]`, line, name]);
        });
      }
    }
  }
  if (pipeline.working === null || pipeline.working === 'none') {
    at('working', 'cannot be skipped — it is the stage that does the work');
  }

  // Template references: unknown names, unbalanced sections, and {{run.output}}
  // in a stage that runs nothing (a reference to output that cannot exist).
  for (const [keyPath, text, stageName] of templates) {
    const r = refs(text);
    for (const name of [...r.vars, ...r.sections]) {
      if (!VARIABLES.includes(name)) {
        at(keyPath, `unknown variable {{${name}}} (known: ${VARIABLES.join(', ')})`);
      }
    }
    for (const name of r.unbalanced) at(keyPath, `unbalanced section {{#${name}}} … {{/${name}}}`);
    const stage = stageName ? pipeline[stageName] : null;
    if (r.vars.has('run.output') && !(isPlainObject(stage) && Array.isArray(stage.run) && stage.run.length)) {
      at(keyPath, `references {{run.output}} but ${stageName || 'the preamble'} runs nothing`);
    }
  }
  return errors;
}

// resolve(opts) -> { pipeline, layers, files, errors }
// errors non-empty = refuse. The caller reports them and stops; nothing is
// spawned, nothing is spent.
function resolve(opts) {
  const files = layerFiles(opts);
  const { layers, errors: loadErrors } = loadLayers(files);
  if (!layers.length) {
    return {
      pipeline: null, layers, files,
      errors: loadErrors.length ? loadErrors
        : [`no pipeline named "${opts.name}" — looked in:\n  ` + files.join('\n  ')],
    };
  }
  const pipeline = merge(layers);
  const errors = loadErrors.concat(validate(pipeline, layers));
  return { pipeline, layers, files, errors };
}

module.exports = { VARIABLES, TOP_KEYS, STAGE_KEYS, STAGES, layerFiles, loadLayers, merge, sourceOf, validate, resolve };
