# Architecture

The server IS the harness: board state on disk is the canonical state of the world, and every
delivery to a lieutenant is a durable, at-least-once queue item. The conceptual API in
[docs/api/overview.md](docs/api/overview.md) is the DNA — the spec the implementation follows;
a disagreement between it and the code is a bug in one of them — change deliberately, never let
them drift.

```
        captain (browser UI)                    agents (tmux sessions)
              │  clicks/drags = orders                ▲      ▲
              ▼                                       │      │ spawn/send/kill…
   ┌──────────────────────── server/server.js ────────┴──────┴───────────┐
   │  the harness: routes + SSE     harness port (harness/port.js)       │
   │  board.json  = canonical state    claude-tmux.js │ codex-tmux.js │ fake.js
   │  queue/*.jsonl = write-ahead, at-least-once delivery per lieutenant │
   │  supervision loop: dead lieutenant → resume; dead worker → flag     │
   │  PR watch: merged PR → archive card + release worktree + kill worker│
   │  the clock: schedules (board.json) → hook run → owner on a failure  │
   └──────────────────────────────────────────────────────────────────┬──┘
        ▲ bc-axi (CLI: drain/ack, cards, projects, worker verbs)       │
        │                                                              ▼
   lieutenant sessions (doctrine-launched, wake-driven)      worker worktrees
   first act of every turn: bc-axi drain → handle → ack      (treehouse/git, isolated)
```

- **Delivery is write-ahead and at-least-once**: every append lands in the durable queue
  first, then the server wakes the owning lieutenant — one coalesced
  `[bridge-commander] N pending item(s) — run: bc-axi drain` line typed into its live session,
  with the turn-end hook (`POST /api/turn-end`) re-nudging a lieutenant that ends a turn with
  items still unacked. Only ack removes; a dead session loses nothing; a server restart is a
  non-event.
- **The harness port** is the only seam to agent sessions — seven verbs (`spawn`, `send`,
  `alive`, `resumable`, `resume`, `kill`, `onTurnEnd`); see [harness/README.md](harness/README.md).
  Builtins: `claude` and `codex` over tmux, plus an in-memory `fake` for tests.
- **Workers**: `bc-axi card start <id>` is ONE atomic op — isolated worktree
  (`treehouse get --lease` when available, else `git worktree add`), a real worker session
  launched with the card's brief — the card's playbook, a markdown file from
  `<workspace>/.bridge-commander/playbooks/`, rendered against the card as it stands at start —,
  session/worktree/branch bound to the card, card → Working. Workers report with
  `bc-axi worker signal|done`; the lieutenant verifies and hands off — nothing moves a card
  out of Working automatically — and the move that takes it out of Working is the worker's
  death: the session is killed and the worktree given back, so a card waiting on the captain
  pins neither (a playbook's `keep_worktree: true` holds both for a card reworked in place;
  a worktree still holding work is never released, though its session dies anyway) — running
  the playbook's `teardown` command in the checkout first, best effort, so nothing the run
  started outlives it. A server boot sweeps the leftovers the same way.
- **The clock is a board object**: schedules live in `board.json` (so they travel with the
  repo, unlike host cron) and fire a NAMED HOOK through the same `hook run` every other caller
  uses. A schedule's cursor is the due time of the last window it handled, so a restart neither
  loses a window nor double-fires one; `overlap` and `catch-up` say what happens when a firing
  outlives its interval or the machine slept through one. A failed firing wakes the schedule's
  owner with the hook's output.
- **Supervision is infrastructure**: the server watches sessions, turn-ends, and PRs. Dead
  lieutenants are auto-respawned (resume), dead workers flag their owner, merged PRs archive
  the card, release the worktree, and kill the lingering worker session (never hand-archive
  merged work).

Lineage: UI and board mechanics evolve from
[bridge](https://github.com/tonylampada/claudegoodies); orchestration doctrine distills
firstmate.
