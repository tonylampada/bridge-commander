# harness — the multi-harness port

The server speaks ONLY this port ([docs/api/overview.md](../docs/api/overview.md), "harness port").
Seven verbs, nothing else:

| Verb | Signature | Purpose |
|---|---|---|
| `spawn` | `(cwd, prompt, opts?) → HarnessRef` | birth an agent session |
| `send` | `(ref, text)` | type into a session, with **verified** submission |
| `alive` | `(ref) → bool` | liveness |
| `resumable` | `(ref, opts?) → bool` | introspection: would `resume` restore memory? |
| `resume` | `(ref) → HarnessRef` | reincarnate a dead session with memory when possible |
| `kill` | `(ref)` | end a session for good — idempotent, dead ref is a no-op |
| `onTurnEnd` | `(ref, hook) → unsubscribe()` | turn-boundary detection, push not poll |

All verbs may be async. Zero dependencies — plain Node (>= 18; uses `node:test`, `fetch`).
Beyond the seven, a harness MAY expose **optional capability verbs** — see below.

## Optional capability verbs (pane viewing)

Optional verbs are features not every harness can honor, so `port.js` never
validates them — adding one to the required list would force every harness
(the `fake` included) to implement it and break validation. The server
capability-checks at the call site (`typeof impl.openPane === 'function'`)
and degrades gracefully when the verb is absent (the pane endpoints answer
`unsupported`). Current optional verbs:

| Verb | Signature | Purpose |
|---|---|---|
| `openPane` | `(ref, {onFrame, intervalMs?, lines?}) → {close()}` | deliver the pane's CURRENT RENDERED SCREEN as successive frames: `onFrame(frameString)` fires whenever the content changes (identical frames are skipped); `close()` stops delivery and releases resources |
| `paneSnapshot` | `(ref, {lines?}) → Promise<string>` | one-shot capture — the initial paint / non-streaming fallback |

`intervalMs` defaults to ~1000, `lines` (scrollback depth) to ~200. A frame is
a string that MAY carry ANSI SGR escapes (colors/bold).

The claude implementation polls `capture-pane -e` — deliberately **rendered
frames, not a `pipe-pane` byte stream**: the target is a full-screen TUI that
repaints in place, so raw pty bytes would need a client-side terminal emulator
(a dependency we won't add), while `capture-pane` returns the already-composed
screen and keeps the client a plain `<pre>`. When the pane disappears it emits
a final `\n[pane gone]` frame and stops. The fake emits deterministic counter
frames (file-backed mode logs open/close to `<key>.pane.jsonl` for
cross-process refcount assertions); `BC_FAKE_NO_PANE=1` hides both verbs to
test capability-absent degradation, `BC_FAKE_PANE_MS` overrides its default
frame interval.

## HarnessRef

A plain JSON-serializable object — it is persisted in board state and must
survive a server restart:

```json
{ "harness": "claude", "session": "bc-a1b2c3", "cwd": "/abs/worktree", "resumeId": "<uuid>" }
```

`session` is the tmux session name (`bc-*` — predictable, so `tmux attach -t bc-a1b2c3`
is the captain's escape hatch). `resumeId` is the harness-native conversation id.

## Files

- `port.js` — the contract: `getHarness(name)`, `registerHarness(name, impl)`, `harnessFor(ref)`, `isHarnessRef(ref)`
- `claude-tmux.js` — the claude implementation over tmux (v0's real harness)
- `tmux.js` — shared tmux primitives (composer state, ghost-text stripping, verified submit)
- `turnend-hook.js` — the Stop-hook relay claude runs at every turn boundary
- `fake.js` — in-memory implementation for unit-testing server code; set
  `BC_FAKE_STATE=<dir>` for file-backed mode (cross-process: spawn writes a
  `<session>.json` marker, sends append to `<session>.sends.jsonl`, and a
  marker on disk counts as a live session)
- `smoke.js` — real end-to-end smoke (spawns actual claude sessions)
- `test/` — unit tests (`node --test harness/test/*.test.js`)

## The claude implementation

- **spawn** — `tmux new-session -d -s bc-<id> -c <cwd>`, then launches
  `CLAUDE_CODE_ENABLE_PROMPT_SUGGESTION=false claude --dangerously-skip-permissions --session-id <uuid> "$(cat <promptfile>)"`.
  The uuid is generated up front, so `resumeId` is known deterministically at birth.
  The prompt rides in a file expanded by the pane's shell — no quoting hazards.
  A fresh cwd shows claude's folder-trust dialog even in bypass mode; spawn detects
  and auto-accepts it, and only returns once the main UI is up.
  `opts.installHooks: false` skips the per-spawn Stop-hook install (spawn and
  resume both honor it) — for sessions born into a cwd that already carries a
  workspace-level hook, which a per-spawn install would clobber (one bc entry
  per settings file). `installHooks` is also exported beyond the seven verbs so
  `bc-axi init` can install that workspace-level hook itself.
- **send** — text is typed ONCE (single-line via `send-keys -l`; multi-line via a
  bracketed paste so embedded newlines don't submit mid-text), then Enter is sent
  and verified: the composer's cursor line is captured with ANSI styling, dim
  ghost text and box borders are stripped, and if real text is still sitting
  there, Enter is retried (never the text — a retype would duplicate it).
  A positively-confirmed swallow throws.
- **alive** — tmux session exists AND the pane is not sitting back at a bare
  shell (claude exiting returns the pane to bash).
- **kill** — `tmux kill-session` on the ref's session (missing session = no-op).
  Harness state files stay behind on purpose: a later `resume(ref)` can still
  reincarnate the conversation if the kill was premature.
- **resume** — kills the dead session's leftovers and relaunches
  `claude --resume <resumeId>` in a fresh tmux session under the same name.
  `--resume` keeps the SAME session id (no fork by default), so refs stay valid
  across any number of death/resume cycles. The Stop hook also records the live
  session id to `<stateDir>/<session>.session-id`, which resume prefers over the
  ref (ground truth wins). Without any id: fresh session, memory lost.
- **onTurnEnd** — spawn merges a `Stop` hook into the worktree's
  `.claude/settings.local.json` (kept out of git via `info/exclude`) running
  `turnend-hook.js`, which appends one JSON line per turn boundary to
  `<stateDir>/<session>.turnend.jsonl` and optionally POSTs it to a callback URL
  (`opts.callbackUrl` / `BC_TURNEND_URL`). `onTurnEnd()` tails that file
  (fs.watch + 1s polling backstop) and fires the hook per event.

State lives in `opts.stateDir` — the server and CLI always pass the
workspace's `.bridge-command/harness/` (`BC_HARNESS_STATE` overrides; the
global `~/.bridge-command/harness/` is a last-resort for bare embedders only):
`<session>.prompt`, `<session>.session-id`, `<session>.turnend.jsonl`.

## Adding a new harness

Implement the seven verbs in one module and register it:

```js
const { registerHarness } = require('./port.js');
registerHarness('codex', require('./codex-tmux.js'));
```

Rules of the road, learned the hard way (from firstmate's verified adapters):

1. **Refs are values.** Everything needed to find, kill, or resume the session
   must be in the ref or derivable from `stateDir` — no in-process state.
2. **Verify submission.** TUIs swallow Enter (slash-command popups, multi-line
   paste). Type once, verify the composer cleared, retry Enter only.
3. **Turn ends are pushed.** Use the harness's own hook/notify mechanism
   (claude: Stop hooks; codex: `-c notify=[...]`), never pane polling.
4. **Full autonomy at launch.** The agent must run unattended
   (claude: `--dangerously-skip-permissions`; handle any trust dialog at spawn).
5. **Never dirty the worktree.** Hook/config files written into the worktree go
   into `.git/info/exclude`.
6. Verify each behavior empirically in a real session before relying on it.

## Running the tests

```sh
node --test harness/test/*.test.js   # unit: registry, ref shape, fake, ANSI stripping
node harness/smoke.js                # REAL e2e: spawn → hook turn-end → reply →
                                     # send → reply → alive/kill (needs tmux + claude)
node harness/smoke.js --resume       # + kill → resume → memory-recall leg
```

The smoke prints `SMOKE OK` and exits 0 on success; on failure it dumps the
pane tail. It cleans up its tmux sessions, temp workdir, and state files.
