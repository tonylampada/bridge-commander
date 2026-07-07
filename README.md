# Bridge Command

Bridge Command is an agent-orchestration **harness** whose control surface is a kanban board.
The captain pilots N **lieutenants** — durable orchestrator agents, shown as a horizontal lane
above the columns — and every unit of work is a card owned by exactly one lieutenant. The
server IS the harness: board state on disk is the canonical state of the world, and every
delivery to a lieutenant is a durable, at-least-once queue item. The conceptual API in
[docs/api/overview.md](docs/api/overview.md) is the DNA — the spec the implementation follows.

One workspace = one board. A zero-dependency Node server keeps all state in
`<workspace>/.bridge-command/` (board, archive, config, per-lieutenant delivery queues) and
serves a vanilla-JS UI: fixed column frame (📋 Backlog → 🔨 Working → 👀 Your review →
🤝 Peer review, no Done — cards leave by archive), per-lieutenant chats, card threads whose
interlocutor is always the owning lieutenant, and captain drag-orders (backlog→working and
review→backlog queue an order to the lieutenant instead of moving the card). `bc-axi` is the
CLI lieutenants and workers drive the board with. UI and board mechanics evolve from
[bridge](https://github.com/tonylampada/claudegoodies); orchestration doctrine distills firstmate.

Delivery is write-ahead and at-least-once: every append lands in the durable queue first,
then the server wakes the owning lieutenant through the harness port — one coalesced
`[bridge-command] N pending item(s) — run: bc-axi drain` line typed into its live session
(the persisted HarnessRef), with the turn-end hook (`POST /api/turn-end`) re-nudging a
lieutenant that ends a turn with items still unacked. A server restart is a non-event.

The **teleport**: invoking the [skill](skill/SKILL.md) in a fresh directory (inside tmux)
runs `bc-axi init`, which boots the server, registers the calling agent's tmux session as
the founding lieutenant, installs the turn-end Stop hook, and scaffolds workspace memory
(`AGENTS.md`, `captain.md`, `learnings/`). New lieutenants are born from the lane's ＋
button or `bc-axi lieutenant create --spawn`: the server spawns a real session in the
workspace root with [doctrine](skill/DOCTRINE.md) + charter as the launch prompt.

**Workers**: repos join the workspace via `bc-axi project add <url|path> --mode
no-mistakes|direct-PR|local-only` (cloned under `projects/`). `bc-axi card start <id>` is
ONE atomic op — an isolated git worktree (`treehouse get --lease` when available, else
`git worktree add`), a real worker session launched with the generated brief (task + card
thread + the project's delivery-mode contract), session/worktree/branch bound to the card,
card → Working. Workers report with `bc-axi worker signal` and `bc-axi worker done`; the
lieutenant verifies and hands off — nothing moves a card out of Working automatically. The
server supervises: dead lieutenants are auto-respawned (resume), dead workers flag their
owner, and merged PRs archive the card and release the worktree (never hand-archive merged
work).

## Development

```sh
node server/server.js <workspace> [--port N]   # start the server (default port 4780)
cli/bc-axi open                                 # or: bootstrap + start from a workspace dir
cli/bc-axi init --name <lt>                     # workspace.init — the teleport (run inside tmux)
node --test test/*.test.js                      # unit tests
node e2e/run.js                                 # API-level end-to-end suite (throwaway workspace)
node e2e/wake.e2e.js                            # wake/teleport e2e — REAL tmux + REAL claude sessions
node e2e/worker.e2e.js                          # worker e2e — card start → REAL claude worker in a
                                                #   REAL isolated worktree → signal/done → verified change
```

`bc-axi` with no arguments prints full CLI usage. Everything is Node built-ins only — no
dependencies, nothing to install.
