'use strict';
// Preloaded into the SERVER process (via NODE_OPTIONS=--require) by the
// card-start harness/model fallback test. Registers a 'recfake' harness: the
// real fake plus a capture of the extraArgs card.start builds (so a test can
// assert the --model extraArg the stored hint produces). Lives in test/ — the
// harness port (harness/) stays untouched; this only *registers* through it.
const fs = require('node:fs');
const { registerHarness } = require('../harness/port.js');
const fake = require('../harness/fake.js');

// Where to record the last spawn's extraArgs (JSON). The test reads it after
// each card.start to see what --model (if any) was plumbed through.
const OUT = process.env.BC_REC_EXTRAARGS || '';

const recfake = Object.assign({}, fake, {
  async spawn(cwd, prompt, opts = {}) {
    if (OUT) fs.writeFileSync(OUT, JSON.stringify({ extraArgs: opts.extraArgs || [] }) + '\n');
    return fake.spawn(cwd, prompt, opts);
  },
});

registerHarness('recfake', recfake);
