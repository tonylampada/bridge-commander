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
// The same facts as an APPEND-only log, one JSON line per launch, spawn AND
// resume: a lieutenant is relaunched by paths a test cannot drive one at a time
// (a supervision tick, a harness switch), so what it needs is the sequence, not
// the last one. Off unless BC_REC_LOG names a file.
const LOG = process.env.BC_REC_LOG || '';
function log(verb, extraArgs, ref) {
  if (!LOG) return;
  try {
    fs.appendFileSync(LOG, JSON.stringify({
      ts: new Date().toISOString(), verb, extraArgs: extraArgs || [],
      session: ref && ref.session, window: ref && ref.window, resumeId: (ref && ref.resumeId) || null,
    }) + '\n');
  } catch { /* the log is an observation, never a precondition */ }
}

// A recording harness under `name`. It answers with its OWN name in the refs it
// returns — the fake hardcodes 'fake', and a ref that lies about which harness
// runs it is a ref that dispatches to the wrong adapter. TWO of them are
// registered because a harness SWITCH needs somewhere to switch to that is
// still observable: `recfake` and `recfake2` stand in for claude and codex.
function recording(name) {
  return Object.assign({}, fake, {
    async spawn(cwd, prompt, opts = {}) {
      if (OUT) fs.writeFileSync(OUT, JSON.stringify({ extraArgs: opts.extraArgs || [] }) + '\n');
      const ref = { ...(await fake.spawn(cwd, prompt, opts)), harness: name };
      log('spawn', opts.extraArgs, ref);
      return ref;
    },
    async resume(ref, opts = {}) {
      const out = { ...(await fake.resume(ref, opts)), harness: name };
      log('resume', opts.extraArgs, out);
      return out;
    },
  });
}

registerHarness('recfake', recording('recfake'));
registerHarness('recfake2', recording('recfake2'));
