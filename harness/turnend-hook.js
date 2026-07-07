#!/usr/bin/env node
'use strict';
// turnend-hook.js — the Claude Code Stop-hook relay.
//
// Registered by claude-tmux.js in the spawned session's worktree
// .claude/settings.local.json. Claude Code runs it at every turn boundary
// with a JSON payload on stdin ({ session_id, hook_event_name, cwd, ... }).
//
// It does three things, all best-effort and always exiting 0 fast so it can
// never wedge the agent:
//   1. records the claude session id at <stateDir>/<session>.session-id
//      (ground truth for harness.resume, refreshed on every event)
//   2. appends one JSON line to <stateDir>/<session>.turnend.jsonl —
//      the marker file harness.onTurnEnd() watches
//   3. optionally POSTs the event to a callback URL (argv[4] or
//      BC_TURNEND_URL) so a server can learn turn boundaries without polling
//
// Usage (as a hook command): node turnend-hook.js <stateDir> <session> [url]

const fs = require('node:fs');
const path = require('node:path');

function readStdin() {
  return new Promise((resolve) => {
    let data = '';
    const timer = setTimeout(() => resolve(data), 3000);
    process.stdin.setEncoding('utf8');
    process.stdin.on('data', (c) => (data += c));
    process.stdin.on('end', () => {
      clearTimeout(timer);
      resolve(data);
    });
    process.stdin.on('error', () => {
      clearTimeout(timer);
      resolve(data);
    });
  });
}

async function main() {
  const stateDir = process.argv[2];
  const session = process.argv[3];
  const url = process.argv[4] || process.env.BC_TURNEND_URL || '';
  if (!stateDir || !session) return;

  let payload = {};
  try {
    payload = JSON.parse(await readStdin());
  } catch {
    // no/bad payload: still record the turn boundary
  }

  const event = {
    ts: new Date().toISOString(),
    session,
    event: payload.hook_event_name || 'Stop',
    session_id: payload.session_id || null,
    cwd: payload.cwd || null,
  };

  try {
    fs.mkdirSync(stateDir, { recursive: true });
    if (event.session_id) {
      fs.writeFileSync(path.join(stateDir, `${session}.session-id`), event.session_id + '\n');
    }
    fs.appendFileSync(path.join(stateDir, `${session}.turnend.jsonl`), JSON.stringify(event) + '\n');
  } catch {
    // never fail the hook
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
