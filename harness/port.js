'use strict';
// harness port — the multi-harness contract (docs/api/overview.md, "harness port").
//
// The server speaks ONLY this port. An implementation is a module exposing
// exactly these seven verbs (all may be async):
//
//   spawn(cwd, prompt, opts?) -> HarnessRef   birth an agent session
//   send(ref, text)                           type a message into a session (verified submit)
//   alive(ref) -> bool                        liveness
//   resumable(ref, opts?) -> bool             would resume(ref) restore memory? (introspection only)
//   resume(ref) -> HarnessRef                 reincarnate a dead session with memory when possible
//   kill(ref)                                 end a session for good (idempotent; dead ref is a no-op)
//   onTurnEnd(ref, hook) -> unsubscribe()     turn-boundary detection
//
// A HarnessRef is a plain, JSON-serializable object; `harness` names the
// implementation and the rest is that implementation's opaque address:
//   { harness: 'claude', session: 'bc-<id>', window?: 'w-<id>', cwd: '/abs/path', resumeId?: '<uuid>' }
// `window` marks a window-granular ref: the agent lives in a named window of
// a shared session (workers inside their lieutenant's session) instead of
// owning the whole session.
//
// Adding a harness = implementing the seven verbs and registering it here
// (or shipping it as a builtin module). Nothing else.
//
// OPTIONAL capability verbs: beyond the seven REQUIRED verbs a harness MAY
// expose extra verbs for features not every harness can honor. They are
// deliberately NOT validated here — adding one to VERBS would force every
// harness (the fake included) to implement it and break validation. The
// server capability-checks at the call site (`typeof impl.openPane ===
// 'function'`) and degrades gracefully when the verb is absent. Current
// optional verbs (pane viewing — the UI's 👁 peek):
//   openPane(ref, { onFrame, intervalMs?, lines? }) -> { close() }
//       deliver the pane's CURRENT RENDERED SCREEN as successive frames:
//       onFrame(frameString) fires whenever the content changes (identical
//       frames are skipped); a frame MAY carry ANSI SGR escapes. close()
//       stops delivery and releases resources. All async-safe.
//   paneSnapshot(ref, { lines? }) -> Promise<string>
//       one-shot capture — the initial paint / non-streaming fallback.

const VERBS = ['spawn', 'send', 'alive', 'resumable', 'resume', 'kill', 'onTurnEnd'];

// Builtins are lazy-required so requiring port.js never drags in tmux/claude
// machinery for callers that only use the fake.
const BUILTINS = {
  claude: './claude-tmux.js',
  fake: './fake.js',
};

const registry = new Map();

function validateImpl(name, impl) {
  if (!impl || typeof impl !== 'object') {
    throw new TypeError(`harness "${name}": implementation must be an object`);
  }
  for (const verb of VERBS) {
    if (typeof impl[verb] !== 'function') {
      throw new TypeError(`harness "${name}": missing verb ${verb}()`);
    }
  }
  return impl;
}

function registerHarness(name, impl) {
  if (!name || typeof name !== 'string') throw new TypeError('harness name must be a non-empty string');
  registry.set(name, validateImpl(name, impl));
  return impl;
}

function getHarness(name) {
  if (registry.has(name)) return registry.get(name);
  if (Object.prototype.hasOwnProperty.call(BUILTINS, name)) {
    const impl = validateImpl(name, require(BUILTINS[name]));
    registry.set(name, impl);
    return impl;
  }
  throw new Error(`unknown harness "${name}" (known: ${[...new Set([...registry.keys(), ...Object.keys(BUILTINS)])].join(', ')})`);
}

// isHarnessRef — structural check for a persisted/deserialized ref.
function isHarnessRef(ref) {
  return !!ref
    && typeof ref === 'object'
    && typeof ref.harness === 'string' && ref.harness.length > 0
    && typeof ref.session === 'string' && ref.session.length > 0
    && (ref.window === undefined || (typeof ref.window === 'string' && ref.window.length > 0))
    && typeof ref.cwd === 'string' && ref.cwd.length > 0
    && (ref.resumeId === undefined || typeof ref.resumeId === 'string');
}

// harnessFor(ref) — dispatch helper: the implementation a ref belongs to.
function harnessFor(ref) {
  if (!isHarnessRef(ref)) throw new TypeError('not a HarnessRef: ' + JSON.stringify(ref));
  return getHarness(ref.harness);
}

module.exports = { VERBS, registerHarness, getHarness, isHarnessRef, harnessFor };
