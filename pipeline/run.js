#!/usr/bin/env node
'use strict';
// run — the pipeline executor. Give it a card id; it walks that card through
// the stages of a YAML file and reports to the board when there is something
// to report.
//
//   pipeline/run.js <card-id> --workspace <dir> [--pipeline <name>] [--check]
//
// It is meant to be launched as a card's worker:
//   bc-axi card start <card-id> --command "<abs>/pipeline/run.js <card-id> --workspace <dir>"
// which hands it a worktree, a branch, a registry entry and supervision for
// free, and makes the CARD's one worker the executor — the two stage agents
// are its children, not the board's.
//
// ── IT IS CODE, NOT A MODEL ──────────────────────────────────────────────────
// Nothing in this file asks anyone what to do next. It reads, validates,
// substitutes, opens a window, waits, counts, and branches. Zero tokens are
// spent by the executor itself; the only two models in a round are inside the
// stages. That is not thrift — it is what makes the YAML mean anything. If a
// model decided the routing, `max_rounds: 3` would be a suggestion, and on a
// bad day four rounds would "make more sense".
//
//   THE EXECUTOR DECIDES WHERE; THE AGENTS DECIDE WHAT.
//
// ── AND IT DOES NOT EXIST, AS FAR AS THE BOARD KNOWS ─────────────────────────
// Nothing in server/, harness/, ui/ or cli/bc-axi mentions this directory —
// test/pipeline-inert.test.js fails if that ever stops being true. The board
// gained one generic primitive (`card start --command`) and no knowledge. It
// talks to the board only through bc-axi, and never `card move`: moving a card
// is the lieutenant's, by doctrine.

const fs = require('node:fs');
const path = require('node:path');
const { getHarness } = require('../harness/port.js');
const { resolve } = require('./config.js');
const { render } = require('./template.js');
const { Board } = require('./board.js');
const { State } = require('./state.js');
const verdict = require('./verdict.js');
const stageLib = require('./stage.js');

const REPO_ROOT = path.join(__dirname, '..');
const CLI = path.join(REPO_ROOT, 'cli', 'bc-axi');
const VERDICT_CLI = path.join(__dirname, 'verdict.js');
const DEFAULT_PIPELINE = 'validated-pr';

function parseArgs(argv) {
  const out = { card: '', workspace: process.env.BC_WORKSPACE || '', pipeline: '', check: false,
    port: Number(process.env.BC_PORT || 0) || 0,
    harness: process.env.BC_PIPELINE_HARNESS || 'claude' };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--workspace') out.workspace = argv[++i];
    else if (a === '--pipeline') out.pipeline = argv[++i];
    else if (a === '--harness') out.harness = argv[++i];
    else if (a === '--port') out.port = parseInt(argv[++i], 10);
    else if (a === '--check') out.check = true;
    else if (!out.card) out.card = a;
    else throw new Error(`unexpected argument ${a}`);
  }
  if (!out.card) {
    throw new Error('usage: pipeline/run.js <card-id> --workspace <dir> [--pipeline <name>] [--check]\n'
      + '  --check validates the pipeline file and prints the prompts it would send. Nothing is spawned.\n'
      + '  --port pins the board port (default: the workspace config.json).');
  }
  if (!out.workspace) throw new Error('--workspace <dir> is required (or BC_WORKSPACE)');
  return out;
}

function log(msg) {
  process.stdout.write(`[pipeline ${new Date().toISOString().slice(11, 19)}] ${msg}\n`);
}
function firstLine(s) {
  return String(s || '').trim().split('\n')[0].slice(0, 300);
}

// variables(ctx, stage, round, runOutput) — the flat map every template is
// rendered against. Flat and complete: config.js validated every name in the
// file against exactly this list, so a render can never quietly produce "".
function variables(ctx, stageName, round, runOutput) {
  const card = ctx.card;
  const thread = (card.thread || [])
    .filter((m) => m && String(m.text || '').trim())
    .map((m) => '- ' + (m.author || 'user') + ': ' + String(m.text).trim().replace(/\n/g, '\n  '))
    .join('\n');
  const to = ctx.state.verdictFile(stageName, round);
  return {
    'card.id': card.id,
    'card.title': card.title,
    'card.task': String(card.body || '').trim() || card.title,
    'card.thread': thread,
    branch: (card.attributes && card.attributes.branch) || '',
    worktree: ctx.cwd,
    workspace: ctx.workspace,
    'project.name': ctx.project.name,
    'project.path': ctx.project.path,
    round,
    max_rounds: ctx.pipeline.max_rounds,
    findings: stageName === 'working' ? ctx.state.findings : '',
    'run.output': runOutput || '',
    bc: CLI,
    done: `${VERDICT_CLI} done --to ${to}`,
    reject: `${VERDICT_CLI} reject --to ${to}`,
  };
}

function compose(ctx, stageName, round, runOutput) {
  const stage = ctx.pipeline[stageName];
  const vars = variables(ctx, stageName, round, runOutput);
  const preamble = ctx.pipeline.preamble ? render(ctx.pipeline.preamble, vars).trim() + '\n\n' : '';
  return preamble + render(stage.prompt, vars).trim() + '\n';
}

function skipped(stage) {
  return stage === null || stage === undefined || stage === 'none';
}

// runStage — one stage, one round. Returns the agent's verdict, or null when
// the agent died twice without answering (the caller escalates).
async function runStage(ctx, stageName) {
  const round = ctx.state.round;
  const stage = ctx.pipeline[stageName];
  const vFile = ctx.state.verdictFile(stageName, round);

  const already = verdict.read(vFile);
  if (already) { // resumed after this stage had already answered
    log(`${stageName} round ${round}: answer already on disk (${already.kind})`);
    return already;
  }

  // `run` first: its output is material for the prompt. Cached per round, so a
  // restart never pays twice for a validation run that already happened.
  let runOutput = '';
  if (Array.isArray(stage.run) && stage.run.length) {
    const runFile = ctx.state.runFile(stageName, round);
    if (fs.existsSync(runFile)) {
      runOutput = fs.readFileSync(runFile, 'utf8');
      log(`${stageName} round ${round}: reusing the recorded run output`);
    } else {
      log(`${stageName} round ${round}: running ${stage.run.length} command(s)`);
      // The command lines are templates too — `--intent "{{card.title}}"` is
      // the whole reason the run knows what it is looking at.
      const vars = variables(ctx, stageName, round, '');
      runOutput = await stageLib.runCommands(stage.run.map((line) => render(line, vars)), ctx.cwd);
      fs.writeFileSync(runFile, runOutput);
    }
  }

  const prompt = compose(ctx, stageName, round, runOutput);
  const promptFile = ctx.state.promptFile(stageName, round);
  const fresh = stageName === 'validating'; // a reader who did not write the code
  const window = stageLib.windowName(ctx.card.id, stageName, round);
  let ref = ctx.state.agent(stageName);

  if (!fs.existsSync(promptFile)) {
    ref = await stageLib.deliver({
      harness: ctx.harness, cwd: ctx.cwd, session: ctx.session, window, prompt,
      stateDir: ctx.state.harnessDir(), ref, fresh,
    });
    ctx.state.setAgent(stageName, ref);
    fs.writeFileSync(promptFile, prompt);
    ctx.board.signal(ctx.card.id,
      `pipeline ${ctx.pipelineName}: ${stageName} round ${round}/${ctx.pipeline.max_rounds} — agent in `
      + `${ref.session}${ref.window ? ':' + ref.window : ''}`);
    log(`${stageName} round ${round}: agent open in ${ref.session}:${ref.window || ''}`);
  } else {
    log(`${stageName} round ${round}: prompt was already delivered — waiting on the agent`);
  }

  const r = await stageLib.waitForVerdict({
    harness: ctx.harness, ref, file: vFile,
    onRevive: (revived) => {
      ctx.state.setAgent(stageName, revived);
      ctx.board.signal(ctx.card.id, `pipeline ${ctx.pipelineName}: ${stageName} round ${round} agent died — revived it`);
    },
  });
  ctx.state.setAgent(stageName, r.ref);
  return r.verdict;
}

async function killAgents(ctx) {
  for (const [name, ref] of Object.entries(ctx.state.data.agents)) {
    if (!ref) continue;
    try { await getHarness(ctx.harness).kill(ref); } catch { /* already gone */ }
    log(`closed the ${name} agent`);
  }
}

// escalate — the card stops bouncing and becomes the lieutenant's problem. A
// level-1 event is the loud, permanent record on the card; `worker done` is
// what actually reaches the lieutenant's queue (and stops supervision from
// reporting the executor's exit as a crash). The card is NOT moved.
async function escalate(ctx, text) {
  log('ESCALATING: ' + firstLine(text));
  ctx.board.event(ctx.card.id, { level: 1, text: `🔔 pipeline ${ctx.pipelineName} needs you\n\n${text}` });
  await killAgents(ctx);
  ctx.state.set({ finished: new Date().toISOString() });
  ctx.board.done(ctx.card.id, `pipeline ${ctx.pipelineName} STOPPED without a PR — ${firstLine(text)}`);
}

async function finish(ctx, outcome) {
  await killAgents(ctx);
  const rounds = ctx.state.round;
  ctx.state.set({ finished: new Date().toISOString() });
  ctx.board.done(ctx.card.id,
    `pipeline ${ctx.pipelineName} finished in ${rounds} round${rounds === 1 ? '' : 's'}: ${outcome}`);
  log('done: ' + firstLine(outcome));
}

async function loop(ctx) {
  for (;;) {
    if (ctx.state.stage === 'working') {
      const v = await runStage(ctx, 'working');
      if (!v) return escalate(ctx, `the implementer died twice in round ${ctx.state.round} without reporting.`);
      if (v.kind !== 'done') {
        return escalate(ctx, `the implementer answered with a rejection, which only the validator may do:\n\n${v.text}`);
      }
      ctx.board.signal(ctx.card.id, `pipeline ${ctx.pipelineName}: working round ${ctx.state.round} done — ${firstLine(v.text)}`);
      if (skipped(ctx.pipeline.validating)) return finish(ctx, v.text);
      ctx.state.set({ stage: 'validating' });
      continue;
    }

    const v = await runStage(ctx, 'validating');
    if (!v) return escalate(ctx, `the validator died twice in round ${ctx.state.round} without reporting.`);
    if (v.kind === 'done') return finish(ctx, v.text);

    // Rejected. The findings are the whole point of the bounce, so they go on
    // the card too — a round that comes back with nothing to fix is the
    // failure mode this pipeline exists to prevent, and it hides well.
    ctx.board.event(ctx.card.id, {
      level: 2, kind: 'signal',
      text: `pipeline ${ctx.pipelineName}: validation REJECTED round ${ctx.state.round}\n\n${v.text}`.slice(0, 2000),
    });
    if (ctx.state.round >= ctx.pipeline.max_rounds) {
      return escalate(ctx, `${ctx.pipeline.max_rounds} rounds exhausted — the card stops bouncing.\n\n`
        + `Last findings:\n\n${v.text}`);
    }
    ctx.state.set({ stage: 'working', round: ctx.state.round + 1, findings: v.text });
    ctx.board.signal(ctx.card.id,
      `pipeline ${ctx.pipelineName}: rejected — back to working, round ${ctx.state.round}/${ctx.pipeline.max_rounds}`);
  }
}

async function main(argv) {
  const opts = parseArgs(argv);
  const board = new Board({ cli: CLI, workspace: opts.workspace, port: opts.port });
  const card = board.card(opts.card);
  const repo = card.attributes && card.attributes.repo;
  const project = board.projects().find((p) => p.name === repo);
  if (!project) throw new Error(`card ${card.id} has no registered project (repo attribute: ${repo || 'unset'})`);

  const pipelineName = opts.pipeline || project.pipeline || DEFAULT_PIPELINE;
  const r = resolve({
    repoRoot: REPO_ROOT, workspace: opts.workspace, projectPath: project.path, name: pipelineName,
  });

  const runDir = path.join(opts.workspace, '.bridge-commander', 'pipeline', card.id);
  if (r.errors.length) {
    // Refused BEFORE a single token: this file is meant to be edited by hand,
    // and the point of the seatbelt is that a hand slip stays recoverable.
    const text = `pipeline "${pipelineName}" refused — ${r.errors.length} problem(s):\n\n`
      + r.errors.map((e) => '- ' + e).join('\n');
    process.stderr.write(text + '\n');
    if (!opts.check) {
      board.event(card.id, { level: 1, text: '🔔 ' + text.slice(0, 1900) });
      board.done(card.id, `pipeline ${pipelineName} refused its own file (${r.errors.length} problem(s)) — nothing was spawned`);
    }
    return 1;
  }

  const state = new State(runDir, { card: card.id, pipeline: pipelineName });
  const ctx = {
    board, card, project, state, pipelineName,
    pipeline: r.pipeline,
    workspace: opts.workspace,
    harness: opts.harness,
    session: stageLib.ownSession(),
    cwd: r.pipeline.worktree === false
      ? project.path
      : (card.attributes && card.attributes.worktree) || project.path,
  };

  if (opts.check) {
    process.stdout.write(`pipeline ${pipelineName} is valid (layers: ${r.layers.map((l) => l.file).join(', ')})\n`);
    for (const name of ['working', 'validating']) {
      if (skipped(r.pipeline[name])) { process.stdout.write(`\n=== ${name}: skipped ===\n`); continue; }
      process.stdout.write(`\n=== ${name} (round ${state.round}) ===\n` + compose(ctx, name, state.round, '<run output>') + '\n');
    }
    return 0;
  }

  log(`card ${card.id} · pipeline ${pipelineName} · cwd ${ctx.cwd}`);
  if (state.data.finished) {
    // A resume re-runs the command, and this run already ended. Reporting done
    // a second time would put a second item in the lieutenant's queue for work
    // that landed once. Say so on the pane and stop.
    log(`this pipeline already finished at ${state.data.finished} — nothing to do.`);
    log(`to run it again, remove ${state.file}`);
    return 0;
  }
  if (state.resumed) {
    log(`resuming at stage ${state.stage}, round ${state.round} (state: ${state.file})`);
    board.signal(card.id, `pipeline ${pipelineName}: executor restarted — resuming at ${state.stage} round ${state.round}`);
  } else {
    board.signal(card.id, `pipeline ${pipelineName}: started (${r.pipeline.max_rounds} rounds max)`);
  }
  await loop(ctx);
  return 0;
}

if (require.main === module) {
  main(process.argv.slice(2)).then(
    (code) => process.exit(code || 0),
    (err) => {
      process.stderr.write(String((err && err.stack) || err) + '\n');
      process.exit(1);
    }
  );
}

module.exports = { main, compose, variables, runStage, loop, parseArgs };
