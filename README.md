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

## Development

```sh
node server/server.js <workspace> [--port N]   # start the server (default port 4780)
cli/bc-axi open                                 # or: bootstrap + start from a workspace dir
node --test test/*.test.js                      # unit tests
node e2e/run.js                                 # API-level end-to-end suite (throwaway workspace)
```

`bc-axi` with no arguments prints full CLI usage. Everything is Node built-ins only — no
dependencies, nothing to install.
