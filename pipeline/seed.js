#!/usr/bin/env node
'use strict';
// seed — copy the pipelines that ship with the executor into a workspace, once.
//
//   pipeline/seed.js --workspace <dir>
//
// After this runs, <workspace>/.bridge-commander/pipelines/ is the ONLY place
// a pipeline is read from. The copies belong to the board: edit them, add to
// them, extend them. That is the point — a file you can edit beats a factory
// default you have to override from somewhere else.
//
// It NEVER overwrites. A file you have edited is the whole value of the folder,
// and a seeder that clobbers it on the next setup run is a seeder nobody can
// afford to run twice. Re-running is safe and says what it kept.
//
// The cost of copying instead of layering is drift: a newer executor may ship
// keys your copy has never heard of. That is why `--check` validates every key
// against the executor's current schema and names the file — a stale copy fails
// loudly at the door instead of quietly at round three.

const fs = require('node:fs');
const path = require('node:path');
const { pipelinesDir } = require('./config.js');

const SHIPPED = path.join(__dirname, 'pipelines');

function parseArgs(argv) {
  const out = { workspace: process.env.BC_WORKSPACE || '' };
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--workspace') out.workspace = argv[++i];
    else throw new Error(`unexpected argument ${argv[i]}`);
  }
  if (!out.workspace) {
    throw new Error('usage: pipeline/seed.js --workspace <dir>   (or BC_WORKSPACE)\n'
      + '  copies the shipped pipelines into <dir>/.bridge-commander/pipelines/, never overwriting.');
  }
  return out;
}

// seed(workspace) -> { dir, written: [name], kept: [name] }
function seed(workspace) {
  const dir = pipelinesDir(workspace);
  fs.mkdirSync(dir, { recursive: true });

  const written = [];
  const kept = [];
  for (const file of fs.readdirSync(SHIPPED).filter((f) => f.endsWith('.yaml')).sort()) {
    const dest = path.join(dir, file);
    if (fs.existsSync(dest)) { kept.push(file); continue; }
    fs.copyFileSync(path.join(SHIPPED, file), dest);
    written.push(file);
  }
  return { dir, written, kept };
}

function main(argv) {
  const { workspace } = parseArgs(argv);
  const r = seed(workspace);
  process.stdout.write(`pipelines: ${r.dir}\n`);
  for (const f of r.written) process.stdout.write(`  seeded ${f}\n`);
  for (const f of r.kept) process.stdout.write(`  kept   ${f} (yours — not overwritten)\n`);
  if (!r.written.length && !r.kept.length) process.stdout.write('  nothing shipped to seed\n');
  return 0;
}

module.exports = { seed, SHIPPED };

if (require.main === module) {
  try {
    process.exit(main(process.argv.slice(2)));
  } catch (e) {
    process.stderr.write(String(e.message || e) + '\n');
    process.exit(1);
  }
}
