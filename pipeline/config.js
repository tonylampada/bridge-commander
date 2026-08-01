'use strict';
// config — find the pipeline file, walk what it extends, and REFUSE a bad one
// before a single token is spent.
//
// ONE folder holds every pipeline this board can run:
//
//   <workspace>/.bridge-commander/pipelines/<name>.yaml
//
// The files are seeded there at setup (`pipeline/seed.js`) from the ones that
// ship with the executor, and from then on they belong to the board. There is
// no second place to look, so "which file is this?" always has one answer.
//
// Reuse is written down, never positional. A file that wants another as its
// base says so by name, on a line you can read:
//
//   extends: validated-pr
//
// The chain is merged base-first, key by key (nested maps merge, lists
// replace), so an extending file restates only what it changes. Bases resolve
// by NAME inside the folder — never by path, because a path is how a second
// place to look gets in.
//
// The file is meant to be edited by hand, which means it will be edited
// wrongly. Validation is not politeness: every prompt in it becomes an agent
// launch, so a typo caught here costs nothing and the same typo caught later
// costs a worker's turn. Every error names the FILE and the KEY it came from.

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

const TOP_KEYS = ['name', 'extends', 'worktree', 'max_rounds', 'preamble', 'working', 'validating'];
const STAGE_KEYS = ['prompt', 'run'];
const STAGES = ['working', 'validating'];

// How deep an extends chain may go before we call it a mistake. Nobody needs
// eight levels of pipeline inheritance; a number this size only ever appears
// by accident.
const MAX_CHAIN = 8;

function isPlainObject(v) {
  return !!v && typeof v === 'object' && !Array.isArray(v);
}

// pipelinesDir(workspace) -> the one folder. Exported because the seeder and
// the error messages both need to name it, and they must never disagree.
function pipelinesDir(workspace) {
  return path.join(workspace, '.bridge-commander', 'pipelines');
}
function pipelineFile(workspace, name) {
  return path.join(pipelinesDir(workspace), name + '.yaml');
}

// available(workspace) -> [name] — what is actually in the folder. A refusal
// that lists the real alternatives beats one that only says "not found".
function available(workspace) {
  try {
    return fs.readdirSync(pipelinesDir(workspace))
      .filter((f) => f.endsWith('.yaml'))
      .map((f) => f.slice(0, -'.yaml'.length))
      .sort();
  } catch {
    return [];
  }
}

// readOne(file) -> { data } | { error }
function readOne(file) {
  let text;
  try {
    text = fs.readFileSync(file, 'utf8');
  } catch {
    return { missing: true };
  }
  let data;
  try {
    data = yaml.load(text, { filename: file });
  } catch (e) {
    const line = e && e.mark && Number.isInteger(e.mark.line) ? e.mark.line + 1 : null;
    return { error: `${file}${line ? ':' + line : ''} — not valid YAML: ${String(e.reason || e.message).split('\n')[0]}` };
  }
  if (data === null || data === undefined) return { data: {} }; // an empty file adds nothing
  if (!isPlainObject(data)) {
    return { error: `${file} — a pipeline file must be a map of keys, got ${Array.isArray(data) ? 'a list' : typeof data}` };
  }
  return { data };
}

// chain(workspace, name) -> { layers, files, errors }
// Layers come back BASE FIRST, so merging them in order lets the file the
// caller actually asked for win. `extends` is followed by name in the same
// folder; a loop, a missing base or a silly depth is refused by name.
function chain(workspace, name) {
  const layers = [];
  const files = [];
  const seen = [];
  let current = name;

  while (current) {
    const file = pipelineFile(workspace, current);
    files.push(file);

    if (seen.includes(current)) {
      return {
        layers: [], files,
        errors: [`${file}: extends — loops back to "${current}" (${seen.concat(current).join(' → ')})`],
      };
    }
    seen.push(current);

    if (seen.length > MAX_CHAIN) {
      return { layers: [], files, errors: [`${file}: extends — chain is more than ${MAX_CHAIN} files deep (${seen.join(' → ')})`] };
    }

    const r = readOne(file);
    if (r.error) return { layers: [], files, errors: [r.error] };
    if (r.missing) {
      const known = available(workspace);
      const where = layers.length
        ? `${files[files.length - 2]}: extends — no pipeline named "${current}" in ${pipelinesDir(workspace)}`
        : `no pipeline named "${current}" — ${pipelinesDir(workspace)} has no ${current}.yaml`;
      return {
        layers: [], files,
        errors: [where + (known.length ? `\n  it holds: ${known.join(', ')}` : '\n  the folder is empty — seed it with pipeline/seed.js')],
      };
    }

    const base = r.data.extends;
    if (base !== undefined && (typeof base !== 'string' || !base.trim())) {
      return { layers: [], files, errors: [`${file}: extends — must be the name of another pipeline in ${pipelinesDir(workspace)}`] };
    }

    layers.unshift({ file, data: r.data }); // base first
    current = base ? base.trim() : '';
  }

  return { layers, files, errors: [] };
}

// merge(layers) — key by key, later layers winning. Nested maps merge so an
// extending file can change one stage's prompt without restating the other
// stage; lists (a stage's `run`) replace wholesale, because appending to
// someone else's command list is never what you meant.
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

// resolve({ workspace, name }) -> { pipeline, layers, files, errors }
// errors non-empty = refuse. The caller reports them and stops; nothing is
// spawned, nothing is spent.
function resolve({ workspace, name }) {
  const { layers, files, errors: chainErrors } = chain(workspace, name);
  if (chainErrors.length) return { pipeline: null, layers, files, errors: chainErrors };

  const pipeline = merge(layers);
  // `extends` did its job during the walk; it is not a runtime key, and leaving
  // it in would put a name nothing reads into the thing agents are launched from.
  delete pipeline.extends;
  return { pipeline, layers, files, errors: validate(pipeline, layers) };
}

module.exports = {
  VARIABLES, TOP_KEYS, STAGE_KEYS, STAGES, MAX_CHAIN,
  pipelinesDir, pipelineFile, available, chain, merge, sourceOf, validate, resolve,
};
