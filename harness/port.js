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
// All seven must EXIST; one that cannot be honored must THROW with the reason
// rather than pretend — a caller that learns why beats one watching text vanish
// into a verb that quietly did nothing.
//
// OPTIONAL capability verbs: beyond the seven REQUIRED verbs a harness MAY
// expose extra verbs for features not every harness can honor. They are
// deliberately NOT validated here — adding one to VERBS would force every
// harness (the fake included) to implement it and break validation. The
// server capability-checks at the call site (`typeof impl.openPane ===
// 'function'`) and degrades gracefully when the verb is absent. Current
// optional verbs — pane viewing (the UI's 👁 peek):
//   openPane(ref, { onFrame, intervalMs?, lines? }) -> { close() }
//       deliver the pane's CURRENT RENDERED SCREEN as successive frames:
//       onFrame(frameString) fires whenever the content changes (identical
//       frames are skipped); a frame MAY carry ANSI SGR escapes. close()
//       stops delivery and releases resources. All async-safe.
//   paneSnapshot(ref, { lines? }) -> Promise<string>
//       one-shot capture — the initial paint / non-streaming fallback.
//   paneInput(ref, { text? | key? }) -> Promise<void>
//       forward RAW input to the pane: `text` typed literally (multi-line
//       rides a bracketed paste), `key` ONE tmux key name ('Enter', 'BSpace',
//       'Up', 'BTab', 'C-c', …). Exactly one of the two; anything else throws,
//       as does an unusable key name, a pane that is gone, or text past
//       PANE_INPUT_MAX. Validate with the SHARED validatePaneInput() below —
//       a harness with its own copy of the rules is a harness that drifts from
//       them. Deliberately NOT
//       send(): that one types, settles, Enters and retries until the composer
//       verifies empty — right for delivering a brief, wrong for a keystroke.
//       A harness MAY offer paneInput while send() throws: "no composer for a
//       brief" and "no way to press a key" are different claims.
//       Implementations that also stream SHOULD speed their feed up briefly
//       after input, so the echo is not stuck behind the poll.
// — migration of a session-granular ref to window granularity (the lieutenant
// whose session it turned out to cohabit with its worker windows):
//   adoptWindow(ref, window, taken?) -> Promise<HarnessRef|null>
//       make the SAME running agent addressable as `session:window` without
//       restarting it. `taken` names windows that belong to someone else and
//       must never be adopted. null = the agent's window cannot be identified;
//       the caller keeps the old ref. Idempotent: a ref that already carries a
//       window comes back unchanged.
// — and slash commands + session status (the UI composer's "/" and the
// context bars; agent-status.js holds the shared machinery):
//   commands(ref?) -> [{ name, description, args? }]
//       the slash commands this harness answers (/status /compact /help
//       where applicable; claude adds /autocompact and /output-style — verified
//       against the binary, the public docs lag behind).
//       `ref`, when given, scopes the answer to that session — claude's style
//       list includes the ones installed in the session's own cwd.
//       `args` is OPTIONAL metadata: [{ value, description }], the values this
//       command accepts as its single argument, for a composer that wants to
//       keep completing AFTER the command name (ui/js/slash.js). A harness that
//       does not send it behaves exactly as before — the picker closes on the
//       space, as it always did — so this is additive for every existing
//       implementation. Everything a caller types after the command name is ONE
//       argument: a `value` may contain spaces, and runCommand must not tokenize
//       it. The server passes the field through untouched.
//   runCommand(ref, command, opts?) -> Promise<string>
//       execute one command line against the session (first token names the
//       command; arguments ride along); resolves to the reply text. opts is
//       the same bag spawn/resume take — `stateDir` is the one field that
//       matters here, since /status reads from it.
//       Pass-through commands (/compact, claude's /autocompact) type the
//       LITERAL line through the verified-submit send path — the harness's
//       own implementation runs in-session; /status formats status(); /help
//       renders commands(). Unknown names throw — and so does a command whose
//       argument is missing or unrecognised, BEFORE it does anything: claude's
//       /output-style writes a setting to disk, and a typo must not sit there
//       waiting to surprise the next conversation. A command that changes
//       something the session only reads at STARTUP says WHEN it applies in
//       its reply (/output-style: the next time this session starts) without
//       naming a command to get there, which a harness cannot know exists —
//       no verb here restarts a session on the caller's behalf.
//   status(ref, opts?) -> Promise<{ model, contextUsed, contextWindow, rateLimits? } | null>
//       model + context usage read from the files the harness already
//       writes (transcript / rollout log); null — never a throw — when
//       nothing is readable. opts.stateDir points at the board's harness
//       state (codex resolves its thread-id from the session-id file there);
//       omitting it falls back to whatever the ref alone can answer. rateLimits only where the harness persists
//       them (codex); claude omits the field.

const VERBS = ['spawn', 'send', 'alive', 'resumable', 'resume', 'kill', 'onTurnEnd'];

// ---------- paneInput payload validation (the port contract, in one place) ----------
// Lives HERE, not in an implementation, because every harness that offers
// paneInput must enforce the SAME contract: a fake that is laxer than the real
// thing turns route tests green against payloads tmux would choke on. port.js
// has no dependencies, so both the tmux adapters and the fake can require it.
//
// KEY_RE — tmux's key-name grammar. Anchored, and no branch can begin with '-':
// tmux is spawned via execFile (an argv array, so no shell) and sendKey passes
// `--`, but a name that looks like a flag has no business reaching argv at all.
// The punctuation branch is the five control keys that are not letters — C-[
// (Escape on a lot of muscle memory), C-\, C-], C-^, C-_ — every one verified
// accepted by tmux 3.4. The client emits them, so the grammar must too.
const KEY_RE = /^(C-|M-|S-)*([A-Za-z0-9]+|[[\\\]^_])$/;
// One POST must not be able to shove a whole file into a live agent's pane —
// and, more sharply, must not hand tmux more than tmux can take. Single-line
// text rides `send-keys -l -- <text>` in ARGV, and a tmux client packs one
// command into a single imsg: MAX_IMSGSIZE 16384 minus the 16-byte header, so
// the whole NUL-packed argv must fit in 16368 bytes. Measured against tmux 3.4:
// `send-keys -t <target> -l -- <text>` succeeds while
// target.length + text.length <= 16343 and fails at 16344 with "failed to send
// command" — the same total for an 8-char target and a 49-char one, which is
// how we know the budget is the command, not the payload. Multi-line text is
// unconstrained (it rides load-buffer's STDIN), but one cap is honest and does
// not drift; 16 KB less 512 bytes leaves room for the longest pane target plus
// the fixed argv words.
const PANE_INPUT_MAX = 16 * 1024 - 512;

// validatePaneInput(input) -> { key, text } — exactly one of the two is
// non-empty. Throws with the reason otherwise; callers let it propagate.
function validatePaneInput(input) {
  const key = input && input.key != null ? String(input.key) : '';
  const text = input && input.text != null ? String(input.text) : '';
  if (key && text) throw new Error('paneInput: pass key or text, not both');
  if (!key && !text) throw new Error('paneInput: nothing to send (pass key or text)');
  if (key && !KEY_RE.test(key)) throw new Error(`paneInput: invalid tmux key name "${key}"`);
  // BYTES, not String.length: argv is UTF-8, so 16384 emoji is 65536 bytes and
  // would sail past a UTF-16-unit check to die as `spawn E2BIG`.
  const bytes = Buffer.byteLength(text, 'utf8');
  if (bytes > PANE_INPUT_MAX) {
    throw new Error(`paneInput: text too long (${bytes} > ${PANE_INPUT_MAX} bytes)`);
  }
  return { key, text };
}

// Builtins are lazy-required so requiring port.js never drags in tmux/claude
// machinery for callers that only use the fake.
const BUILTINS = {
  claude: './claude-tmux.js',
  codex: './codex-tmux.js',
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

module.exports = { VERBS, registerHarness, getHarness, isHarnessRef, harnessFor,
  validatePaneInput, KEY_RE, PANE_INPUT_MAX };
