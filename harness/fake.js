'use strict';
// fake — in-memory harness implementing the same seven verbs, for unit tests
// of server code. No tmux, no claude, no filesystem.
//
// Refs look like the real thing: { harness: 'fake', session: 'bc-<id>', window?, cwd, resumeId }.
// A window-granular ref (opts.window at spawn — workers as windows in their
// lieutenant's session) is keyed as `session:window` everywhere the plain
// session name would be: the in-memory map, marker files, sends log, and the
// emitted turn-end event's `session` field.
//
// Behavior model:
//   spawn   — creates a live session, records the prompt as transcript[0],
//             emits one turn-end event asynchronously (the "reply" turn).
//   send    — throws on a dead session; records the text; emits a turn-end.
//   alive   — session exists and is not killed.
//   resumable — would resume restore memory? true iff this process holds the
//             session's transcript under a matching resumeId.
//   resume  — revives a dead session; transcript (memory) survives iff the
//             resumeId matches the recorded one.
//   kill    — ends a session for good (idempotent); in file-backed mode also
//             removes the marker, so cross-process alive() flips false.
//   onTurnEnd — hooks fire once per emitted turn, in registration order,
//             only for events after registration. Returns unsubscribe().
//
// Test helpers (not part of the port contract): transcript(ref), reset().
//
// File-backed mode (cross-process observability): when BC_FAKE_STATE names a
// directory, spawn/send also persist there —
//   <session>.json         spawn record { cwd, resumeId, prompt, stateDir }
//   <session>.sends.jsonl  one JSON line per send { ts, session, text }
// and a session unknown to THIS process counts as alive (and accepts sends)
// iff its <session>.json marker exists. That lets a test process watch what a
// server process sent, and pre-register "live" fake sessions by dropping a
// marker file. Without BC_FAKE_STATE the fake stays purely in-memory.
//
// spawn also writes opts.stateDir/<key>.prompt (the SAME source-of-truth file
// the real tmux adapters persist) whenever opts.stateDir is given — distinct
// from BC_FAKE_STATE, and honored even without it, mirroring the real
// harnesses closely enough for callers (card.start's brief-artifact
// auto-attach) to be exercised under test without tmux.

const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');

const sessions = new Map(); // key (session or session:window) -> { alive, cwd, resumeId, transcript, hooks, turns }

function keyOf(session, window) {
  return window ? session + ':' + window : session;
}
function refKey(ref) {
  return keyOf(ref.session, ref.window);
}

function fakeStateDir() {
  const dir = process.env.BC_FAKE_STATE;
  if (!dir) return null;
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}
function markerFile(session) {
  const dir = fakeStateDir();
  return dir ? path.join(dir, session + '.json') : null;
}
function logSend(session, text) {
  const dir = fakeStateDir();
  if (!dir) return;
  fs.appendFileSync(path.join(dir, session + '.sends.jsonl'),
    JSON.stringify({ ts: new Date().toISOString(), session, text }) + '\n');
}

function get(ref) {
  const s = sessions.get(refKey(ref));
  if (!s) throw new Error(`fake: unknown session ${refKey(ref)}`);
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
  const window = opts.window === undefined || opts.window === null ? undefined : String(opts.window);
  const key = keyOf(session, window);
  if (sessions.has(key) && sessions.get(key).alive) {
    throw new Error(`fake: session ${key} already exists`);
  }
  const resumeId = crypto.randomUUID();
  sessions.set(key, {
    alive: true,
    cwd,
    resumeId,
    transcript: [prompt],
    hooks: [],
    turns: 0,
  });
  const marker = markerFile(key);
  if (marker) {
    // stateDir rides along so a watching test can verify what dir the caller
    // plumbed through the port (the fake itself never writes state there).
    fs.writeFileSync(marker,
      JSON.stringify({ cwd, resumeId, prompt, stateDir: opts.stateDir || null }, null, 2) + '\n');
  }
  if (opts.stateDir) {
    fs.mkdirSync(opts.stateDir, { recursive: true });
    fs.writeFileSync(path.join(opts.stateDir, `${key}.prompt`), prompt);
  }
  emitTurnEnd(key);
  const ref = { harness: 'fake', session, cwd, resumeId };
  if (window) ref.window = window;
  return ref;
}

async function send(ref, text) {
  const key = refKey(ref);
  const s = sessions.get(key);
  if (!s) {
    // Cross-process fake session: alive iff its marker file exists.
    const marker = markerFile(key);
    if (marker && fs.existsSync(marker)) return logSend(key, text);
    throw new Error(`fake: unknown session ${key}`);
  }
  if (!s.alive) throw new Error(`session ${key} is not alive`);
  s.transcript.push(text);
  logSend(key, text);
  emitTurnEnd(key);
}

async function alive(ref) {
  const s = sessions.get(refKey(ref));
  if (s) return s.alive;
  const marker = markerFile(refKey(ref));
  return !!(marker && fs.existsSync(marker));
}

// resumable — introspection only: memory survives a resume iff this process
// still holds the session's transcript under the same resumeId.
async function resumable(ref) {
  const s = sessions.get(refKey(ref));
  return !!(s && ref.resumeId && ref.resumeId === s.resumeId);
}

async function resume(ref) {
  const key = refKey(ref);
  const s = sessions.get(key);
  if (s && s.alive) return { ...ref };
  const out = { harness: 'fake', session: ref.session, cwd: ref.cwd, resumeId: ref.resumeId };
  if (ref.window) out.window = ref.window;
  if (s && ref.resumeId === s.resumeId) {
    s.alive = true; // memory (transcript) preserved
    return { ...out, cwd: s.cwd };
  }
  // No matching memory: fresh session under the same name (transcript lost).
  out.resumeId = crypto.randomUUID();
  sessions.set(key, {
    alive: true,
    cwd: ref.cwd,
    resumeId: out.resumeId,
    transcript: [],
    hooks: s ? s.hooks : [],
    turns: 0,
  });
  return out;
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

// kill(ref) — port verb: end the session for good. Idempotent (unknown or
// already-dead sessions are a no-op). File-backed mode also removes the
// marker so a WATCHING process sees alive() flip false.
function kill(ref) {
  const s = sessions.get(refKey(ref));
  if (s) s.alive = false;
  const marker = markerFile(refKey(ref));
  if (marker) { try { fs.unlinkSync(marker); } catch { /* already gone */ } }
}

// ---------- pane viewing (OPTIONAL capability verbs — see port.js) ----------
// openPane emits deterministic counter frames on the interval — each frame
// differs from the last, so change-detecting consumers always deliver — letting
// server tests assert subscribe → frames → teardown without tmux. In
// file-backed mode every open/close also appends to <key>.pane.jsonl, so a
// WATCHING test process can assert refcounting (one open, one close) across
// the process boundary.
//   BC_FAKE_PANE_MS   default frame interval (callers' intervalMs still wins)
//   BC_FAKE_NO_PANE   hides both verbs — the "harness without pane support"
function logPane(session, event) {
  const dir = fakeStateDir();
  if (!dir) return;
  fs.appendFileSync(path.join(dir, session + '.pane.jsonl'),
    JSON.stringify({ ts: new Date().toISOString(), session, event }) + '\n');
}

function openPane(ref, opts = {}) {
  const key = refKey(ref);
  const onFrame = typeof opts.onFrame === 'function' ? opts.onFrame : () => {};
  const intervalMs = opts.intervalMs > 0 ? opts.intervalMs
    : (parseInt(process.env.BC_FAKE_PANE_MS, 10) > 0 ? parseInt(process.env.BC_FAKE_PANE_MS, 10) : 1000);
  let n = 0;
  let closed = false;
  const emit = () => {
    if (closed) return;
    n += 1;
    try { onFrame('fake pane ' + key + ' — frame ' + n + '\n'); } catch { /* subscriber's problem */ }
  };
  logPane(key, 'open');
  const timer = setInterval(emit, intervalMs);
  timer.unref?.();
  emit(); // immediate first frame
  return {
    close() {
      if (closed) return;
      closed = true;
      clearInterval(timer);
      logPane(key, 'close');
    },
  };
}

async function paneSnapshot(ref) {
  return 'fake pane ' + refKey(ref) + ' — snapshot\n';
}

// --- test helpers ---

function transcript(ref) {
  return [...get(ref).transcript];
}

function reset() {
  sessions.clear();
}

const impl = { spawn, send, alive, resumable, resume, onTurnEnd, kill, transcript, reset };
// Pane verbs are OPTIONAL by contract; BC_FAKE_NO_PANE simulates a harness
// that never implemented them (capability-absent degradation under test).
if (!process.env.BC_FAKE_NO_PANE) {
  impl.openPane = openPane;
  impl.paneSnapshot = paneSnapshot;
}
module.exports = impl;
