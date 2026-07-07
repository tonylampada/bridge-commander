#!/usr/bin/env node
'use strict';
// smoke.js — REAL end-to-end smoke for the claude-tmux harness.
//
// Requires: tmux + an authenticated `claude` CLI. Costs a few real turns.
//
//   node harness/smoke.js             # spawn, turn-end hook, reply, send, alive, kill
//   node harness/smoke.js --resume    # also exercise the resume-with-memory leg
//
// What it proves:
//   1. spawn() launches claude in a fresh tmux session (auto-accepting the
//      folder-trust dialog) and returns a serializable ref
//   2. onTurnEnd() fires via the Stop hook — no pane polling
//   3. the first prompt was processed (BC_SMOKE_OK in the pane)
//   4. send() submits reliably and the follow-up gets a reply (BC_SMOKE_2)
//   5. alive() is true while running, false after kill
//   6. (--resume) resume() reincarnates a killed session with memory

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { getHarness } = require('./port.js');
const t = require('./tmux.js');

const WITH_RESUME = process.argv.includes('--resume');
const TURN_TIMEOUT_MS = 180000;

function waitTurnEnd(h, ref, label) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      unsub();
      reject(new Error(`timed out waiting for turn end (${label})`));
    }, TURN_TIMEOUT_MS);
    const unsub = h.onTurnEnd(ref, (event) => {
      clearTimeout(timer);
      unsub();
      resolve(event);
    });
  });
}

function step(msg) {
  console.log(`[smoke] ${msg}`);
}

function assertContains(pane, needle, label) {
  if (!pane.includes(needle)) {
    throw new Error(`${label}: expected pane to contain "${needle}"; pane tail:\n${pane}`);
  }
  step(`${label}: found "${needle}"`);
}

async function main() {
  const h = getHarness('claude');
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'bc-smoke-'));
  step(`workdir ${cwd}`);
  let ref = null;
  let ok = false;
  try {
    // 1. spawn + wait for the first turn end (arrives via the Stop hook)
    step('spawning claude session...');
    ref = await h.spawn(cwd, 'Reply with exactly: BC_SMOKE_OK');
    step(`spawned ${ref.session} resumeId=${ref.resumeId}`);
    const firstTurn = waitTurnEnd(h, ref, 'first turn');
    if (JSON.stringify(ref) !== JSON.stringify(JSON.parse(JSON.stringify(ref)))) {
      throw new Error('ref is not JSON-serializable');
    }
    const ev1 = await firstTurn;
    step(`turn end via hook: ${JSON.stringify(ev1)}`);
    if (ev1.session_id !== ref.resumeId) {
      throw new Error(`hook session_id ${ev1.session_id} != ref.resumeId ${ref.resumeId}`);
    }

    // 2. the prompt was processed
    assertContains(await t.capture(`=${ref.session}:`, 80), 'BC_SMOKE_OK', 'first reply');

    // 3. alive while running
    if (!(await h.alive(ref))) throw new Error('alive() false while session is running');
    step('alive() true while running');

    // 4. send a follow-up with verified submission; expect a reply
    const secondTurn = waitTurnEnd(h, ref, 'second turn');
    await h.send(ref, 'Now reply with exactly: BC_SMOKE_2');
    step('follow-up submitted');
    await secondTurn;
    assertContains(await t.capture(`=${ref.session}:`, 80), 'BC_SMOKE_2', 'second reply');

    if (WITH_RESUME) {
      // 5. kill, resume with memory, verify recall
      step('killing session for the resume leg...');
      await t.tmux('kill-session', '-t', `=${ref.session}:`);
      if (await h.alive(ref)) throw new Error('alive() true after kill-session');
      step('alive() false after kill');
      ref = await h.resume(ref);
      step(`resumed ${ref.session} resumeId=${ref.resumeId}`);
      if (!(await h.alive(ref))) throw new Error('alive() false after resume');
      const recallTurn = waitTurnEnd(h, ref, 'recall turn');
      await h.send(ref, 'What was the FIRST marker I asked you to reply with? Answer with just that marker.');
      await recallTurn;
      assertContains(await t.capture(`=${ref.session}:`, 80), 'BC_SMOKE_OK', 'resume memory recall');
    }

    // 6. kill; alive flips false
    await t.tmux('kill-session', '-t', `=${ref.session}:`);
    if (await h.alive(ref)) throw new Error('alive() true after final kill-session');
    step('alive() false after kill');

    ok = true;
    console.log(`\nSMOKE OK${WITH_RESUME ? ' (with resume)' : ''}`);
  } finally {
    // cleanup: session, state files, workdir
    if (ref) {
      if (!ok) {
        console.error(`[smoke] FAILED — pane tail of ${ref.session} (if still up):`);
        console.error(await t.capture(`=${ref.session}:`, 40));
      }
      await t.tryTmux('kill-session', '-t', `=${ref.session}:`);
      const stateDir = process.env.BC_HARNESS_STATE
        || path.join(os.homedir(), '.bridge-command', 'harness');
      for (const suffix of ['.prompt', '.session-id', '.turnend.jsonl']) {
        try { fs.unlinkSync(path.join(stateDir, ref.session + suffix)); } catch { /* absent */ }
      }
    }
    fs.rmSync(cwd, { recursive: true, force: true });
  }
}

main().catch((err) => {
  console.error('[smoke] FAILED:', err.message);
  process.exit(1);
});
