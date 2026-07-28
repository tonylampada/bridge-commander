'use strict';
// board — everything the executor is allowed to say to the Bridge Commander,
// which is exactly what any worker may say: through `bc-axi`, and nothing else.
//
// It never touches board.json and never requires anything from server/. The
// dependency runs ONE WAY: this knows the board, the board does not know this.
// Keeping that true is what makes the executor droppable — and the reason the
// five verbs below are the whole surface.
//
//   card(id)              read the card (title, body, attributes, thread)
//   projects()            the project registry (where the clone lives)
//   signal(id, text)      a milestone — reaches the lieutenant's queue
//   event(id, {...})      a card event; level 1 is the loud one
//   done(id, outcome)     the pipeline is over, for good or for bad
//
// Not `card move`. Moving a card is the lieutenant's, by doctrine; the
// executor reports and the human decides.

const { execFileSync } = require('node:child_process');

class Board {
  constructor({ cli, workspace, port = 0, node = process.execPath }) {
    this.cli = cli;
    this.workspace = workspace;
    // Normally bc-axi finds the port in the workspace's config.json; an explicit
    // one is here so a test board can never be mistaken for the real one.
    this.port = port;
    this.node = node;
  }

  // run(args, input?) -> stdout. Throws with bc-axi's own stderr — its errors
  // are written for an agent to read, so passing them through beats rewording.
  run(args, input) {
    try {
      const flags = ['--workspace', this.workspace].concat(this.port ? ['--port', String(this.port)] : []);
      return execFileSync(this.node, [this.cli, ...args, ...flags], {
        encoding: 'utf8',
        input: input === undefined ? '' : input,
        stdio: ['pipe', 'pipe', 'pipe'],
      });
    } catch (e) {
      const why = String((e.stderr || '') + (e.stdout || '')).trim() || String(e.message);
      throw new Error(`bc-axi ${args[0]} ${args[1] || ''} failed: ${why}`);
    }
  }

  card(id) {
    return JSON.parse(this.run(['card', 'show', id, '--json']));
  }

  projects() {
    return JSON.parse(this.run(['project', 'list', '--json']));
  }

  signal(id, text) {
    this.run(['worker', 'signal', id, '--text-file', '-'], text);
  }

  event(id, { text, level = 2, kind = null }) {
    const args = ['event', id, '--text-file', '-', '--level', String(level)];
    if (kind) args.push('--kind', kind);
    this.run(args, text);
  }

  done(id, outcome) {
    this.run(['worker', 'done', id, '--text-file', '-'], outcome);
  }
}

module.exports = { Board };
