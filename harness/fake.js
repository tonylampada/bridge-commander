'use strict';
// fake — in-memory harness implementing the same five verbs, for unit tests
// of server code. No tmux, no claude, no filesystem.
//
// Refs look like the real thing: { harness: 'fake', session: 'bc-<id>', cwd, resumeId }.
//
// Behavior model:
//   spawn   — creates a live session, records the prompt as transcript[0],
//             emits one turn-end event asynchronously (the "reply" turn).
//   send    — throws on a dead session; records the text; emits a turn-end.
//   alive   — session exists and is not killed.
//   resume  — revives a dead session; transcript (memory) survives iff the
//             resumeId matches the recorded one.
//   onTurnEnd — hooks fire once per emitted turn, in registration order,
//             only for events after registration. Returns unsubscribe().
//
// Test helpers (not part of the port contract): kill(ref), transcript(ref),
// reset().

const crypto = require('node:crypto');

const sessions = new Map(); // session name -> { alive, cwd, resumeId, transcript, hooks, turns }

function get(ref) {
  const s = sessions.get(ref.session);
  if (!s) throw new Error(`fake: unknown session ${ref.session}`);
  return s;
}

function emitTurnEnd(name) {
  const s = sessions.get(name);
  if (!s || !s.alive) return;
  s.turns += 1;
  const event = {
    ts: new Date().toISOString(),
    session: name,
    event: 'Stop',
    session_id: s.resumeId,
    cwd: s.cwd,
    turn: s.turns,
  };
  const hooks = [...s.hooks];
  setImmediate(() => {
    for (const h of hooks) {
      try {
        h.fn(event, h.ref);
      } catch {
        // hooks must not break the fake
      }
    }
  });
}

async function spawn(cwd, prompt, opts = {}) {
  const session = opts.session || 'bc-' + crypto.randomBytes(3).toString('hex');
  if (sessions.has(session) && sessions.get(session).alive) {
    throw new Error(`fake: session ${session} already exists`);
  }
  const resumeId = crypto.randomUUID();
  sessions.set(session, {
    alive: true,
    cwd,
    resumeId,
    transcript: [prompt],
    hooks: [],
    turns: 0,
  });
  emitTurnEnd(session);
  return { harness: 'fake', session, cwd, resumeId };
}

async function send(ref, text) {
  const s = get(ref);
  if (!s.alive) throw new Error(`session ${ref.session} is not alive`);
  s.transcript.push(text);
  emitTurnEnd(ref.session);
}

async function alive(ref) {
  const s = sessions.get(ref.session);
  return !!s && s.alive;
}

async function resume(ref) {
  const s = sessions.get(ref.session);
  if (s && s.alive) return { ...ref };
  if (s && ref.resumeId === s.resumeId) {
    s.alive = true; // memory (transcript) preserved
    return { harness: 'fake', session: ref.session, cwd: s.cwd, resumeId: s.resumeId };
  }
  // No matching memory: fresh session under the same name (transcript lost).
  const resumeId = crypto.randomUUID();
  sessions.set(ref.session, {
    alive: true,
    cwd: ref.cwd,
    resumeId,
    transcript: [],
    hooks: s ? s.hooks : [],
    turns: 0,
  });
  return { harness: 'fake', session: ref.session, cwd: ref.cwd, resumeId };
}

function onTurnEnd(ref, hook) {
  const s = get(ref);
  const entry = { fn: hook, ref };
  s.hooks.push(entry);
  return function unsubscribe() {
    const i = s.hooks.indexOf(entry);
    if (i !== -1) s.hooks.splice(i, 1);
  };
}

// --- test helpers ---

function kill(ref) {
  const s = sessions.get(ref.session);
  if (s) s.alive = false;
}

function transcript(ref) {
  return [...get(ref).transcript];
}

function reset() {
  sessions.clear();
}

module.exports = { spawn, send, alive, resume, onTurnEnd, kill, transcript, reset };
