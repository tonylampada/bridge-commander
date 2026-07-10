#!/usr/bin/env node
'use strict';
// smoke-codex.js — REAL end-to-end smoke for the codex-tmux harness.
//
// Requires: tmux + an authenticated `codex` CLI on PATH; SKIPS (exit 0, loud
// message) when codex is absent so CI without codex stays green. Costs a few
// real turns.
//
//   node harness/smoke-codex.js             # spawn, notify turn-end, reply, send, alive, kill
//   node harness/smoke-codex.js --resume    # also exercise the resume-with-memory leg
//
// What it proves (the codex ground truth the adapter is built on):
//   1. spawn() launches codex in a fresh tmux session with the bypass flags,
//      auto-accepts the directory-trust prompt, settles on the codex UI, and
//      returns a serializable ref born WITHOUT resumeId
//   2. the `-c notify=[...]` relay fires at the turn boundary — onTurnEnd()
//      delivers the normalized event, <key>.session-id records the thread-id
//   3. the first prompt was processed (BC_CODEX_SMOKE_OK in the pane)
//   4. send() submits reliably against the '›' composer and the follow-up
//      gets a reply (BC_CODEX_SMOKE_2)
//   5. alive() is true while running, false after kill
//   6. (--resume) resume() reincarnates a killed session via
//      `codex resume <thread-id>` with memory, and the thread-id stays THE
//      SAME across the death/resume cycle (refs survive repeated cycles)
//
// State is fully isolated in a temp stateDir (passed via opts), so nothing
// touches ~/.bridge-commander or any workspace.

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const { getHarness } = require('./port.js');
const t = require('./tmux.js');

const WITH_RESUME = process.argv.includes('--resume');
const TURN_TIMEOUT_MS = 180000;

function step(msg) {
  console.log(`[smoke-codex] ${msg}`);
}

function waitTurnEnd(h, ref, label, opts) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      unsub();
      reject(new Error(`timed out waiting for turn end (${label})`));
    }, TURN_TIMEOUT_MS);
    const unsub = h.onTurnEnd(ref, (event) => {
      clearTimeout(timer);
      unsub();
      resolve(event);
    }, opts);
  });
}

function assertContains(pane, needle, label) {
  if (!pane.includes(needle)) {
    throw new Error(`${label}: expected pane to contain "${needle}"; pane tail:\n${pane}`);
  }
  step(`${label}: found "${needle}"`);
}

async function main() {
  try {
    execFileSync('codex', ['--version'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] });
  } catch {
    console.log('[smoke-codex] SKIP — codex CLI not on PATH');
    return;
  }

  const h = getHarness('codex');
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'bc-smoke-codex-'));
  const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), 'bc-smoke-codex-state-'));
  const opts = { stateDir };
  step(`workdir ${cwd}, stateDir ${stateDir}`);
  let ref = null;
  let ok = false;
  try {
    // 1. spawn + wait for the first turn end (arrives via the notify relay).
    //    The fresh cwd exercises the directory-trust auto-accept.
    step('spawning codex session...');
    ref = await h.spawn(cwd, 'Reply with exactly: BC_CODEX_SMOKE_OK', opts);
    step(`spawned ${ref.session} (resumeId at birth: ${ref.resumeId === undefined ? 'none — codex assigns the thread-id' : ref.resumeId})`);
    if (ref.resumeId !== undefined) {
      throw new Error('a codex ref must be born WITHOUT resumeId (the thread-id arrives with the first notify)');
    }
    if (JSON.stringify(ref) !== JSON.stringify(JSON.parse(JSON.stringify(ref)))) {
      throw new Error('ref is not JSON-serializable');
    }
    const ev1 = await waitTurnEnd(h, ref, 'first turn', opts);
    step(`turn end via notify relay: ${JSON.stringify(ev1)}`);
    if (ev1.event !== 'turn-end') throw new Error(`event kind ${ev1.event} != turn-end`);
    if (ev1.session !== ref.session) throw new Error(`event session ${ev1.session} != ${ref.session}`);
    if (!ev1.session_id) throw new Error('notify event carries no thread-id (session_id)');
    const threadId = ev1.session_id;

    // 2. the relay recorded the thread-id — the resume ground truth
    const recorded = fs.readFileSync(path.join(stateDir, `${ref.session}.session-id`), 'utf8').trim();
    if (recorded !== threadId) throw new Error(`.session-id file "${recorded}" != notify thread-id "${threadId}"`);
    step(`thread-id recorded: ${threadId}`);
    if (!(await h.resumable(ref, opts))) throw new Error('resumable() false with a recorded thread-id');
    step('resumable() true via the recorded thread-id (ref still carries none)');

    // 3. the prompt was processed
    assertContains(await t.capture(`=${ref.session}:`, 80), 'BC_CODEX_SMOKE_OK', 'first reply');

    // 4. alive while running (pane_current_command must be codex, not a shell)
    if (!(await h.alive(ref))) throw new Error('alive() false while session is running');
    const cmd = (await t.tryTmux('display-message', '-p', '-t', `=${ref.session}:`, '#{pane_current_command}') || '').trim();
    step(`alive() true while running (pane_current_command=${cmd})`);

    // 5. send a follow-up with verified submission against the '›' composer
    const secondTurn = waitTurnEnd(h, ref, 'second turn', opts);
    await h.send(ref, 'Now reply with exactly: BC_CODEX_SMOKE_2');
    step('follow-up submitted (verified — composer cleared)');
    await secondTurn;
    assertContains(await t.capture(`=${ref.session}:`, 80), 'BC_CODEX_SMOKE_2', 'second reply');

    if (WITH_RESUME) {
      // 6. kill, resume with memory via the thread-id, verify recall AND
      //    thread-id continuity across the death/resume cycle.
      step('killing session for the resume leg...');
      await t.tmux('kill-session', '-t', `=${ref.session}:`);
      if (await h.alive(ref)) throw new Error('alive() true after kill-session');
      step('alive() false after kill');
      ref = await h.resume(ref, opts);
      step(`resumed ${ref.session} resumeId=${ref.resumeId}`);
      if (ref.resumeId !== threadId) {
        throw new Error(`resume() must adopt the recorded thread-id (${ref.resumeId} != ${threadId})`);
      }
      if (!(await h.alive(ref))) throw new Error('alive() false after resume');
      const recallTurn = waitTurnEnd(h, ref, 'recall turn', opts);
      await h.send(ref, 'What was the FIRST marker I asked you to reply with? Answer with just that marker.');
      const evRecall = await recallTurn;
      assertContains(await t.capture(`=${ref.session}:`, 80), 'BC_CODEX_SMOKE_OK', 'resume memory recall');
      // The empirical continuity check: codex resume keeps the SAME thread-id
      // (were it to fork, the relay would have refreshed .session-id and the
      // server would adopt the new id from this very event — but the adapter
      // is built on non-forking resume, so a fork fails the smoke loudly).
      if (evRecall.session_id !== threadId) {
        throw new Error(`codex resume FORKED the thread-id: ${threadId} -> ${evRecall.session_id} — `
          + 'refs would drift; re-verify `codex resume` semantics');
      }
      step(`thread-id continuity confirmed across kill/resume: ${evRecall.session_id}`);
    }

    // 7. kill; alive flips false
    await h.kill(ref);
    if (await h.alive(ref)) throw new Error('alive() true after final kill');
    step('alive() false after kill');

    ok = true;
    console.log(`\nSMOKE-CODEX OK${WITH_RESUME ? ' (with resume)' : ''}`);
  } finally {
    // cleanup: session, isolated state dir, workdir
    if (ref) {
      if (!ok) {
        console.error(`[smoke-codex] FAILED — pane tail of ${ref.session} (if still up):`);
        console.error(await t.capture(`=${ref.session}:`, 40));
      }
      await t.tryTmux('kill-session', '-t', `=${ref.session}:`);
    }
    fs.rmSync(stateDir, { recursive: true, force: true });
    fs.rmSync(cwd, { recursive: true, force: true });
  }
}

main().catch((err) => {
  console.error('[smoke-codex] FAILED:', err.message);
  process.exit(1);
});
