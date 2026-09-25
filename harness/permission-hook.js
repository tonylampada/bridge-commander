#!/usr/bin/env node
'use strict';
// permission-hook.js — the Claude Code PermissionRequest-hook relay.
//
// Registered by claude-tmux.js installHooks next to the Stop hook. Claude Code
// runs it when it is about to show a permission dialog, with the request as a
// JSON payload on stdin ({ session_id, cwd, tool_name, tool_input, ... }).
//
// It POSTs the request to the board and WAITS: the server holds the response
// open until the captain approves or denies on the board. The answer becomes
// the hook's decision on stdout. Anything else (no server, a timeout, a null
// decision, bad JSON) prints nothing, so claude falls back to its own
// in-terminal dialog — a broken relay must never approve or deny on its own.
// Always exits 0.
//
// Usage (as a hook command): node permission-hook.js <stateDir> <session> <url>

const { execFileSync } = require('node:child_process');
const http = require('node:http');

// Just under the hook's own 3600s timeout, so the request gives up (and claude
// shows its dialog) before claude kills the hook.
const FETCH_TIMEOUT_MS = 3550 * 1000;
const DEFAULT_DENY = 'Denied by the captain on the board';

// Same as turnend-hook.js: the pane's tmux session lets the server attribute
// the request when the state key alone does not.
function tmuxSession() {
  if (!process.env.TMUX) return '';
  try {
    return execFileSync('tmux', ['display-message', '-p', '#S'], { encoding: 'utf8' }).trim();
  } catch {
    return '';
  }
}

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

// postJson(url, body) -> parsed JSON reply, or null. Not fetch: undici drops a
// request whose response headers take over 300s, and the captain may take longer.
function postJson(url, body) {
  return new Promise((resolve) => {
    let req;
    try {
      const data = JSON.stringify(body);
      req = http.request(url, {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'content-length': Buffer.byteLength(data) },
      }, (res) => {
        let text = '';
        res.setEncoding('utf8');
        res.on('data', (c) => (text += c));
        res.on('end', () => {
          if (res.statusCode < 200 || res.statusCode >= 300) return resolve(null);
          try { resolve(JSON.parse(text)); } catch { resolve(null); }
        });
        res.on('error', () => resolve(null));
      });
      req.setTimeout(FETCH_TIMEOUT_MS, () => req.destroy());
      req.on('error', () => resolve(null));
      req.end(data);
    } catch {
      resolve(null);
    }
  });
}

// decisionOutput(reply) -> the stdout claude reads, or '' for "no decision".
function decisionOutput(reply) {
  if (!reply || typeof reply !== 'object') return '';
  let decision;
  if (reply.decision === 'allow') decision = { behavior: 'allow' };
  else if (reply.decision === 'deny') {
    const msg = typeof reply.message === 'string' && reply.message.trim() ? reply.message.trim() : DEFAULT_DENY;
    decision = { behavior: 'deny', message: msg };
  } else return '';
  return JSON.stringify({ hookSpecificOutput: { hookEventName: 'PermissionRequest', decision } });
}

async function main() {
  const session = process.argv[3];
  const url = process.argv[4];
  if (!session || !url) return;

  let payload;
  try {
    payload = JSON.parse(await readStdin());
  } catch {
    return; // nothing to ask about — let claude show its dialog
  }
  if (!payload || typeof payload !== 'object') return;

  const body = {
    ts: new Date().toISOString(),
    session,
    session_id: payload.session_id || null,
    cwd: payload.cwd || null,
    tmux_session: tmuxSession(),
    tool_name: payload.tool_name || null,
    tool_input: payload.tool_input && typeof payload.tool_input === 'object' ? payload.tool_input : {},
    permission_mode: payload.permission_mode || null,
  };

  const reply = await postJson(url, body); // null: unreachable, timed out or not JSON
  const out = decisionOutput(reply);
  if (out) process.stdout.write(out + '\n');
}

if (require.main === module) {
  main().then(() => process.exit(0), () => process.exit(0));
}

module.exports = { decisionOutput };
