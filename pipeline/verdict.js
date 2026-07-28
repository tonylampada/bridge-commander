#!/usr/bin/env node
'use strict';
// verdict — how a stage agent answers the executor. Two verbs:
//
//   verdict.js done   --to <file> --outcome "<what landed>"
//   verdict.js reject --to <file> --findings <file|->
//
// These live HERE and not in `bc-axi` on purpose. `reject` is a pipeline idea:
// it only means something when there is a stage to bounce back to. Teaching it
// to bc-axi would make the Bridge Commander carry a concept only the executor
// uses, and the one-way dependency would be broken by the very verb that
// exists to serve it.
//
// The executor renders the whole prefix (`--to` included) into the stage
// prompt as {{done}} / {{reject}}, so the agent only ever appends its own half.
//
// A rejection with no text is refused, loudly, with a non-zero exit. A bounce
// that arrives empty sends the implementer back into a round with nothing to
// fix — the failure this pipeline exists to prevent, and the one that hides
// best. Better to make the validator write it twice than lose the round.

const fs = require('node:fs');
const path = require('node:path');

// write(file, verdict) — atomic: the executor polls for this file and must
// never read half of one.
function write(file, verdict) {
  const body = JSON.stringify({ ts: new Date().toISOString(), ...verdict }, null, 2) + '\n';
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = file + '.tmp';
  fs.writeFileSync(tmp, body);
  fs.renameSync(tmp, file);
}

// read(file) -> verdict | null
function read(file) {
  try {
    const v = JSON.parse(fs.readFileSync(file, 'utf8'));
    return v && (v.kind === 'done' || v.kind === 'reject') ? v : null;
  } catch {
    return null;
  }
}

function main(argv) {
  const kind = argv[0];
  const opts = {};
  for (let i = 1; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--to') opts.to = argv[++i];
    else if (a === '--outcome') opts.outcome = argv[++i];
    else if (a === '--findings') opts.findings = argv[++i];
    else return fail(`unknown argument ${a}`);
  }
  if (kind !== 'done' && kind !== 'reject') {
    return fail('usage: verdict.js done --to <file> --outcome "<text>"\n'
      + '       verdict.js reject --to <file> --findings <file|->');
  }
  if (!opts.to) return fail('--to <file> is required (the executor renders it into the prompt for you)');

  if (kind === 'done') {
    const outcome = String(opts.outcome || '').trim();
    if (!outcome) return fail('done needs --outcome "<what landed>" — the executor reports it to the board verbatim');
    write(opts.to, { kind: 'done', text: outcome });
    process.stdout.write('reported done — the pipeline takes it from here\n');
    return 0;
  }

  if (!opts.findings) {
    return fail('reject needs --findings <file> — write what is wrong and how to reproduce it, then point here.\n'
      + 'The file goes VERBATIM into the implementer\'s next round; there is nothing else to go on.');
  }
  let text;
  try {
    text = fs.readFileSync(opts.findings === '-' ? 0 : opts.findings, 'utf8');
  } catch (e) {
    return fail(`cannot read the findings file ${opts.findings}: ${e.message}`);
  }
  if (!text.trim()) {
    return fail(`the findings file ${opts.findings} is empty — a rejection with no text sends the implementer\n`
      + 'back into a round with nothing to fix. Write the findings, then run this again.');
  }
  write(opts.to, { kind: 'reject', text: text.trim() });
  process.stdout.write('rejection recorded — the findings go to the implementer\n');
  return 0;
}

function fail(msg) {
  process.stderr.write(msg + '\n');
  return 1;
}

if (require.main === module) process.exit(main(process.argv.slice(2)));

module.exports = { read, write, main };
