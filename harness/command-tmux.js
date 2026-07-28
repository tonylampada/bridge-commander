'use strict';
// command-tmux — the FIFTH harness: run any command line in a tmux pane.
//
// The other adapters drive an interactive agent. This one drives a program:
// `card start <card> --command "<cmd>"` births a session that runs <cmd>
// instead of an agent with a brief, and everything else about a worker —
// worktree, branch, registry entry, supervision, the 👁 peek — is unchanged.
// What the command DOES is none of this file's business.
//
// HarnessRef: { harness: 'command', session, window?, cwd, command }
//   command — the line the pane runs. It is part of the ref (and therefore of
//             the saved board) because that is what resume() needs: there is no
//             conversation to reincarnate, only a program to run again.
//
// The seven verbs, mapped onto a process:
//   spawn      create the pane, type the line, press Enter
//   send       ALWAYS THROWS — see below
//   alive      the pane exists and is not back at a bare shell
//   resumable  true when the ref carries a command (re-running is possible)
//   resume     run the same line again in a fresh pane
//   kill       kill the pane
//   onTurnEnd  the process exiting IS the turn boundary
//
// Three consequences worth stating out loud, because callers meet them:
//
// 1. send() has nowhere to go. A program is not a composer; text typed at it
//    would either be swallowed by whatever it reads from stdin or land in a
//    shell after it exits. So send() throws with the reason and the command
//    line, and `bc-axi worker send` surfaces that as a 502 with the message —
//    never a silent success.
// 2. onTurnEnd fires ONCE, on exit. A long-running command emits nothing in
//    between, so the board's silence watchdog has nothing to feed on: a command
//    that runs for a while should report its own milestones (worker signal).
// 3. resume() re-runs the line from the top. Any notion of "where I was" has to
//    live in the command's own state, not here — this harness keeps none.
//
// The pane is deliberately left sitting at its shell after the command exits,
// so the last screen (the error, the summary) is still there to read through
// the 👁 peek. That is also how alive() tells "finished" from "running".

const fs = require('node:fs');
const path = require('node:path');
const t = require('./tmux.js');
const s = require('./tmux-session.js');

// The pane's shell needs a beat between the typed line and Enter (same 300ms
// the agent adapters use before their first Enter) — a fresh pane still
// running its rc files swallows keys sent back-to-back.
const ENTER_DELAY_MS = 300;

function commandOf(ref) {
  const line = String((ref && ref.command) || '').trim();
  if (!line) throw new Error('command harness: ref carries no command line');
  return line;
}

async function runLine(session, window, cwd, line) {
  await s.createPane(session, window, cwd);
  const target = s.paneTarget(session, window);
  try {
    await t.sendLiteral(target, line);
    await t.sleep(ENTER_DELAY_MS);
    await t.sendKey(target, 'Enter');
  } catch (err) {
    await s.killPane(session, window);
    throw err;
  }
}

// spawn(cwd, command, opts?) -> HarnessRef
// The second argument is the COMMAND LINE (where an agent adapter takes a
// prompt): a caller that passes a brief here gets a shell trying to run it.
// opts: { session?, window? } — same naming rules as every tmux adapter.
// No prompt file is written: there is no brief, and a `.prompt` file would make
// the board attach a "brief" artifact for a session that never read one.
async function spawn(cwd, command, opts = {}) {
  const cwdAbs = path.resolve(cwd);
  if (!fs.existsSync(cwdAbs)) throw new Error(`spawn cwd does not exist: ${cwdAbs}`);
  const line = String(command || '').trim();
  if (!line) throw new Error('command harness: nothing to run (empty command line)');
  const { session, window } = await s.claimPaneNames(opts);
  await runLine(session, window, cwdAbs, line);
  const ref = { harness: 'command', session, cwd: cwdAbs, command: line };
  if (window) ref.window = window;
  return ref;
}

// send(ref, text) — always throws, and says why. A caller reaching for send on
// one of these sessions has the wrong mental model (it is a program, not an
// agent); failing loudly with the command line in the message is the only way
// that mistake is cheap.
async function send(ref, text) {
  const key = s.stateKey(ref.session, ref.window);
  throw new Error(`${key} runs a command, not an agent — there is no composer to type into`
    + ` (it runs: ${(ref && ref.command) || '?'}).`
    + ' Whatever this text was meant to change belongs in the command\'s own inputs.');
}

// alive(ref) — the pane exists AND is not back at a bare shell. A finished
// command leaves its shell in the pane, which is exactly the "not alive" the
// board reads as "this worker stopped".
async function alive(ref) {
  if (!(await s.paneExists(ref.session, ref.window))) return false;
  const cmd = await s.paneCommand(s.paneTarget(ref.session, ref.window));
  return cmd !== null && !s.SHELLS.has(cmd);
}

// resumable(ref) — could resume(ref) do anything? Yes whenever the ref carries
// its command line. Note the port's question is "would resume restore memory?":
// here there is no memory to restore, only the same line run again, and a
// command that must survive a restart carries its own state.
async function resumable(ref) {
  return !!(ref && ref.command);
}

// resume(ref) -> HarnessRef — run the same line again in a fresh pane. A live
// session is left alone (idempotent, like the agent adapters).
async function resume(ref) {
  if (await alive(ref)) return { ...ref };
  const line = commandOf(ref);
  await s.killPane(ref.session, ref.window); // clear a dead pane still holding the name
  await runLine(ref.session, ref.window, ref.cwd, line);
  const out = { harness: 'command', session: ref.session, cwd: ref.cwd, command: line };
  if (ref.window) out.window = ref.window;
  return out;
}

async function kill(ref) {
  await s.killPane(ref.session, ref.window);
}

// onTurnEnd(ref, hook) -> unsubscribe()
// A process has one turn boundary: the moment it stops running. The pane is
// polled and the hook fires ONCE, with the same event shape the agent adapters
// emit, the first time the pane reads not-alive. Then it unsubscribes itself —
// there is no second turn.
//   opts.intervalMs   poll period (default 2000)
function onTurnEnd(ref, hook, opts = {}) {
  const intervalMs = opts.intervalMs > 0 ? opts.intervalMs : 2000;
  const key = s.stateKey(ref.session, ref.window);
  let closed = false;
  let busy = false;

  async function tick() {
    if (closed || busy) return;
    busy = true;
    try {
      if (await alive(ref)) return;
      close();
      try {
        hook({ ts: new Date().toISOString(), session: key, event: 'exit', cwd: ref.cwd }, ref);
      } catch {
        // a throwing hook must not break the watcher
      }
    } finally {
      busy = false;
    }
  }

  const timer = setInterval(tick, intervalMs);
  timer.unref?.();
  function close() { closed = true; clearInterval(timer); }
  return close;
}

// openPane / paneSnapshot — the shared implementations (OPTIONAL capability
// verbs, port.js): a pane is a pane, and watching a program run is the same
// capture-pane the agent adapters use. No commands/runCommand/status: those
// address an agent session, and there is none here.
const { openPane, paneSnapshot } = s;

module.exports = { spawn, send, alive, resumable, resume, kill, onTurnEnd, openPane, paneSnapshot };
