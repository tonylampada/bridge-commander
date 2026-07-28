'use strict';
// state — where the executor is, on disk, at every moment it could be killed.
//
// The session that runs the executor can be resumed, and a resume RE-RUNS THE
// COMMAND from the top (that is the command harness's whole contract). So the
// answer to "where was I" cannot live in memory. It lives here, and every
// question the loop asks is answered by a file:
//
//   state.json                     which stage, which round, the last findings,
//                                  and the agent refs to re-attach to
//   prompt-<stage>-r<round>.md     this round's prompt was DELIVERED (its
//                                  presence is the fact; the text is the record)
//   run-<stage>-r<round>.txt       this round's `run` output, so a restart does
//                                  not pay for an expensive validation run twice
//   verdict-<stage>-r<round>.json  this round's answer, written by the agent
//
// Everything is keyed by stage AND round, so a restart can never mistake the
// last round's answer for this one's. An executor that restarted the pipeline
// from the beginning would silently throw away the implementer's work — the
// exact failure this file exists to prevent.

const fs = require('node:fs');
const path = require('node:path');

class State {
  constructor(dir, initial = {}) {
    this.dir = dir;
    fs.mkdirSync(dir, { recursive: true });
    this.file = path.join(dir, 'state.json');
    let saved = null;
    try { saved = JSON.parse(fs.readFileSync(this.file, 'utf8')); } catch { saved = null; }
    this.resumed = !!saved;
    this.data = Object.assign({
      stage: 'working',
      round: 1,
      findings: '',
      agents: {},
      startedAt: new Date().toISOString(),
    }, initial, saved || {});
  }

  get stage() { return this.data.stage; }
  get round() { return this.data.round; }
  get findings() { return this.data.findings; }
  agent(stage) { return this.data.agents[stage] || null; }

  set(patch) {
    Object.assign(this.data, patch);
    this.save();
  }
  setAgent(stage, ref) {
    this.data.agents[stage] = ref;
    this.save();
  }
  save() {
    this.data.updatedAt = new Date().toISOString();
    const tmp = this.file + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify(this.data, null, 2) + '\n');
    fs.renameSync(tmp, this.file);
  }

  verdictFile(stage, round) { return path.join(this.dir, `verdict-${stage}-r${round}.json`); }
  promptFile(stage, round) { return path.join(this.dir, `prompt-${stage}-r${round}.md`); }
  runFile(stage, round) { return path.join(this.dir, `run-${stage}-r${round}.txt`); }
  harnessDir() { return path.join(this.dir, 'harness'); }
}

module.exports = { State };
