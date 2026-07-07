# Bridge Command

Bridge Command is an agent-orchestration **harness** whose control surface is a kanban board.
The captain pilots N **lieutenants** — durable orchestrator agents, shown as a horizontal lane
above the columns — and every unit of work is a card owned by exactly one lieutenant. The
server IS the harness: board state on disk is the canonical state of the world, and every
delivery to a lieutenant is a durable, at-least-once queue item. The conceptual API in
[docs/api/overview.md](docs/api/overview.md) is the DNA — the spec the implementation follows.

Lieutenants never implement: each started card gets a **worker** (one fresh agent, one tmux
session, one isolated git worktree) that ships through the project's delivery mode. UI and
board mechanics evolve from [bridge](https://github.com/tonylampada/claudegoodies);
orchestration doctrine distills firstmate. Zero dependencies — plain Node ≥ 18, nothing to install.

## Quickstart (the teleport)

1. **Install the skill** so your agent can invoke it — symlink this checkout's `skill/`
   directory into your user-level skills:

   ```sh
   git clone https://github.com/tonylampada/bridge-command.git
   ln -s "$(pwd)/bridge-command/skill" ~/.claude/skills/bridge-command
   ```

   (or use your skills installer of choice pointed at `skill/`). Optionally put `cli/bc-axi`
   on PATH; everything also works via its absolute path.

2. **Start a tmux session in your workspace directory** — the calling agent's tmux session
   becomes the founding lieutenant's permanent address:

   ```sh
   mkdir myfleet && cd myfleet
   tmux new -s myfleet
   ```

3. **Launch your agent inside it and invoke the skill** (e.g. run `claude`, then ask for
   "bridge command" / `/bridge-command`). The skill refuses outside tmux, agrees a lieutenant
   name with you, and runs:

   ```sh
   bc-axi init --name "<name>"
   ```

   which bootstraps `.bridge-command/`, boots the board server detached, registers the caller
   as the founding lieutenant, installs the turn-end Stop hook, and scaffolds workspace memory
   (`AGENTS.md`, `captain.md`, `learnings/`).

4. **Open the printed board URL** (default `http://localhost:4780/`) — that is the captain's
   cockpit. Talk to lieutenants through their chats and card threads; drag cards to issue
   orders. New lieutenants are born from the lane's ＋ button (the server spawns a real
   session with doctrine + charter as launch prompt); repos join via
   `bc-axi project add <url|path> --mode no-mistakes|direct-PR|local-only`.

## Architecture

```
        captain (browser UI)                    agents (tmux sessions)
              │  clicks/drags = orders                ▲      ▲
              ▼                                       │      │ spawn/send/kill…
   ┌──────────────────────── server/server.js ────────┴──────┴───────────┐
   │  the harness: routes + SSE     harness port (harness/port.js)       │
   │  board.json  = canonical state          claude-tmux.js │ fake.js    │
   │  queue/*.jsonl = write-ahead, at-least-once delivery per lieutenant │
   │  supervision loop: dead lieutenant → resume; dead worker → flag     │
   │  PR watch: merged PR → archive card + release worktree + kill worker│
   └──────────────────────────────────────────────────────────────────┬──┘
        ▲ bc-axi (CLI: drain/ack, cards, projects, worker verbs)       │
        │                                                              ▼
   lieutenant sessions (doctrine-launched, wake-driven)      worker worktrees
   first act of every turn: bc-axi drain → handle → ack      (treehouse/git, isolated)
```

- **Delivery is write-ahead and at-least-once**: every append lands in the durable queue
  first, then the server wakes the owning lieutenant — one coalesced
  `[bridge-command] N pending item(s) — run: bc-axi drain` line typed into its live session,
  with the turn-end hook (`POST /api/turn-end`) re-nudging a lieutenant that ends a turn with
  items still unacked. Only ack removes; a dead session loses nothing; a server restart is a
  non-event.
- **The harness port** is the only seam to agent sessions — seven verbs (`spawn`, `send`,
  `alive`, `resumable`, `resume`, `kill`, `onTurnEnd`); see [harness/README.md](harness/README.md).
  v0 ships `claude` over tmux, plus an in-memory `fake` for tests.
- **Workers**: `bc-axi card start <id>` is ONE atomic op — isolated worktree
  (`treehouse get --lease` when available, else `git worktree add`), a real worker session
  launched with the generated brief (task + card thread + the project's delivery-mode
  contract), session/worktree/branch bound to the card, card → Working. Workers report with
  `bc-axi worker signal|done`; the lieutenant verifies and hands off — nothing moves a card
  out of Working automatically.
- **Supervision is infrastructure**: the server watches sessions, turn-ends, and PRs. Dead
  lieutenants are auto-respawned (resume), dead workers flag their owner, merged PRs archive
  the card, release the worktree, and kill the lingering worker session (never hand-archive
  merged work).

## Tests

| Suite | Command | Proves |
|---|---|---|
| server unit | `node --test test/*.test.js` | board ops, cards, orders, queues/ack, chat, events/bell, kinds, labels, archive/restore, status leases, projects, workers, supervision, PR watch (gh stubbed), turn-end resolution, retire, CLI |
| harness unit | `node --test harness/test/*.test.js` | port contract (seven verbs), ref shape, fake behavior, tmux ANSI/composer parsing |
| API e2e | `node e2e/run.js` | full API flow on a real server + throwaway workspace: init → lieutenants → cards → orders → archive/restore → bell → restart survival |
| harness smoke | `node harness/smoke.js [--resume]` | REAL claude session: spawn → turn-end hook → send → alive/kill (→ resume with memory) |
| wake e2e | `node e2e/wake.e2e.js` | REAL tmux + claude: the teleport (init), wake lines landing in panes, coalescing, drain/ack by a real lieutenant |
| worker e2e | `node e2e/worker.e2e.js` | REAL worker in a REAL isolated worktree: card start → branch → exact change → signal/done → card stays Working |
| prwatch e2e | `node e2e/prwatch.e2e.js` | REAL GitHub round trip on the private scratch repo `bc-e2e-scratch`: worker pushes a real PR → gh merge → PR watch archives, releases the worktree, kills the worker session |
| **fullloop e2e** | `node e2e/fullloop.e2e.js` | **the master test**: one captain chat message → a REAL lieutenant agentically creates the card, starts a REAL worker, verifies the change, rewrites the body, and hands off to review — no scripted lieutenant steps |

The e2e suites run on throwaway workspaces and PRIVATE tmux servers (`TMUX_TMPDIR`), clean up
everything they create, and never touch your own sessions. `wake`, `worker`, `prwatch`,
`fullloop`, and the smoke need `tmux` + an authenticated `claude`; `prwatch` also needs an
authenticated `gh`.

## Env knobs

| Variable | Default | Meaning |
|---|---|---|
| `BC_SUPERVISE_INTERVAL_MS` | `30000` | supervision tick (lieutenant respawn, dead-worker detection); `0` disables |
| `BC_PRWATCH_INTERVAL_MS` | `120000` | PR watch tick; `0` disables |
| `BC_GH_CMD` | `gh` | gh binary used by the PR watch (tests inject a stub) |
| `BC_WORKER_TTL_SECS` | `600` | card status lease TTL — `working`/`needs-you` decays to `idle` past it |
| `BC_WORKTREE_TOOL` | auto | `treehouse` \| `git` — worker worktree provisioning (auto-detects treehouse) |
| `BC_HARNESS_STATE` | `~/.bridge-command/harness` | harness state dir (prompts, session ids, turn-end logs) |
| `BC_TURNEND_URL` | — | default callback URL baked into installed turn-end hooks |
| `BC_SEND_RETRIES` / `BC_SEND_SLEEP_MS` | `3` / `400` | verified-submit tuning for `harness.send` |
| `BC_FAKE_STATE` | — | file-backed fake-harness dir (cross-process test observability) |

Server config per workspace lives in `.bridge-command/config.json`: `port` (default 4780),
`host` (bind address, default loopback), `harness` (default `claude`), `voices` (UI TTS filter).

### Network exposure

The board server has **no application-level auth** — no token, no password. Whoever can
reach the bind address has full control of the board, including starting workers, which
means running code. Security is therefore the bind address plus whatever network boundary
sits in front of it.

- **Default (recommended): loopback only.** With no `host` set the server binds `127.0.0.1`,
  reachable only from the same machine.
- **Set the bind host** via either the CLI flag or config, in precedence order
  `--host` > `config.json` "host" > `127.0.0.1`:
  - `bc-axi init --host <addr>` / `bc-axi open --host <addr>` (also `--port N`), or
  - `.bridge-command/config.json`: `{ "port": 4780, "host": "<addr>" }`.
  Same for the port: `--port N` > `config.json` "port" > `4780`.
- **Exposing over a private mesh (e.g. Tailscale):** set `host` to that interface's address
  (your `100.x.y.z` Tailscale IP). When the bind host is non-loopback the server *also* keeps
  a loopback listener, so the local CLI and browser keep working alongside the mesh address.
  The mesh (WireGuard, device-authenticated) is your only auth boundary — only do this on a
  tailnet you fully trust, since every device on it gets full board control.
- **Never bind `0.0.0.0`.** That exposes the board on every interface with no auth, and it is
  deliberately excluded from the loopback-companion behavior above.

## Development

```sh
node server/server.js <workspace> [--port N]    # start the server by hand
cli/bc-axi open                                 # or: bootstrap + start from a workspace dir
cli/bc-axi                                      # full CLI usage
```

The DNA ([docs/api/overview.md](docs/api/overview.md)) is the spec: a disagreement between it
and the code is a bug in one of them — change deliberately, never let them drift.
