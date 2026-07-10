#!/usr/bin/env node
'use strict';
// codex-notify.js — the codex turn-end relay (analog of turnend-hook.js).
//
// Wired at launch by codex-tmux.js via
//   -c notify='["node","<this script>","<stateDir>","<key>","<url>"]'
// codex invokes the program at every turn boundary with its payload JSON
// APPENDED AS THE FINAL ARGV (not stdin):
//   { "type": "agent-turn-complete", "thread-id": "<uuid>", "turn-id": "...",
//     "cwd": "/abs/worktree", "input-messages": [...], "last-assistant-message": "..." }
//
// It normalizes that payload into the EXACT event shape the claude Stop-hook
// relay emits, so the server's /api/turn-end and the harness onTurnEnd() tail
// consume codex turn boundaries unchanged:
//   { ts, session: <key>, event: 'turn-end', session_id: <thread-id>, cwd, tmux_session }
//
// It does three things, all best-effort and always exiting 0 fast so it can
// never wedge the agent:
//   1. records the codex thread-id at <stateDir>/<key>.session-id
//      (ground truth for harness.resume, refreshed on every turn)
//   2. appends one JSON line to <stateDir>/<key>.turnend.jsonl —
//      the marker file harness.onTurnEnd() watches
//   3. optionally POSTs the event to a callback URL so a server can learn
//      turn boundaries without polling
//
// Usage (as the notify program): node codex-notify.js <stateDir> <key> [url] <payloadJSON>

const fs = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');

// The relay runs inside the agent's own pane, so its tmux session identifies
// the session exactly (the server attributes lieutenant turn-ends by it).
// Empty when not under tmux; never fails the relay when tmux is absent.
function tmuxSession() {
  if (!process.env.TMUX) return '';
  try {
    return execFileSync('tmux', ['display-message', '-p', '#S'], { encoding: 'utf8' }).trim();
  } catch {
    return '';
  }
}

async function main() {
  const argv = process.argv;
  const stateDir = argv[2];
  const key = argv[3];
  // codex appends the payload as the LAST argv; with a url wired the argv is
  // [node, script, stateDir, key, url, payload], without it one shorter.
  if (!stateDir || !key || argv.length < 5) return;
  const url = (argv.length >= 6 ? argv[4] : '') || process.env.BC_TURNEND_URL || '';

  let payload = {};
  try {
    payload = JSON.parse(argv[argv.length - 1]);
  } catch {
    return; // junk payload: nothing to relay
  }
  if (!payload || payload.type !== 'agent-turn-complete') return; // other notify kinds are not turn boundaries

  const event = {
    ts: new Date().toISOString(),
    session: key,
    event: 'turn-end',
    session_id: payload['thread-id'] || null,
    cwd: payload.cwd || null,
    tmux_session: tmuxSession(),
  };

  try {
    fs.mkdirSync(stateDir, { recursive: true });
    if (event.session_id) {
      fs.writeFileSync(path.join(stateDir, `${key}.session-id`), event.session_id + '\n');
    }
    fs.appendFileSync(path.join(stateDir, `${key}.turnend.jsonl`), JSON.stringify(event) + '\n');
  } catch {
    // never fail the relay
  }

  if (url) {
    try {
      await fetch(url, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(event),
        signal: AbortSignal.timeout(3000),
      });
    } catch {
      // callback is best-effort; the marker file is the reliable channel
    }
  }
}

main().then(() => process.exit(0), () => process.exit(0));
