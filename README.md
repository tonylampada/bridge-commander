# Bridge Commander

Agent-orchestration harness whose control surface is a kanban board: the captain (you, in a
browser) pilots **lieutenants** — durable orchestrator agents — who brief, supervise and verify
**workers** (one fresh agent per card, in an isolated git worktree) that write the code and ship
it up to a real reviewed PR. You glance at the board, drag cards to issue orders, and talk
through per-card chat threads — from anywhere, phone included.

![the board](docs/img/board.png)

## Quickstart

- Open a tmux session in a directory, run your agent, invoke `/bridge-commander` — it becomes
  the founding lieutenant and hands you the board URL.
- Register your repos, then create cards and drag them to order work; chat with lieutenants on
  the board.
- Lieutenants start workers on cards; workers ship PRs; merged PRs archive themselves.

## Install

```sh
# bridge-commander (server + CLI + skill — the whole repo installs as one skill)
npx skills add tonylampada/bridge-commander -g

# dependencies
curl -fsSL https://kunchenguid.github.io/treehouse/install.sh | sh
curl -fsSL https://raw.githubusercontent.com/kunchenguid/no-mistakes/main/docs/install.sh | sh
```

Dev mode (hack on the tool): clone and symlink the whole repo into your skills dir —
`git clone https://github.com/tonylampada/bridge-commander.git && ln -s "$(pwd)/bridge-commander" ~/.claude/skills/bridge-commander`.

## Dependencies

- Node ≥ 18, `tmux`, `git`
- [Claude Code](https://claude.com/claude-code), authenticated — the default agent harness
- [GitHub CLI](https://cli.github.com/), authenticated — PR flows
- [treehouse](https://github.com/kunchenguid/treehouse) — worker worktrees (optional; falls back to `git worktree`)
- [no-mistakes](https://github.com/kunchenguid/no-mistakes) — only for `no-mistakes`-mode projects; the `/no-mistakes` skill appears after running `no-mistakes init` in the project
- [OpenAI Codex CLI](https://github.com/openai/codex) — only for `--harness codex` (optional)

## Run

```sh
mkdir myfleet && cd myfleet && tmux new -s myfleet
claude   # then: /bridge-commander
```

Open the printed board URL (default `http://localhost:4780/`). Add repos with
`bc-axi project add <url|path> --mode no-mistakes|direct-PR|local-only`. Run `bc-axi` bare for
full CLI usage.

## Configuration

Per-workspace config lives in `.bridge-commander/config.json`:

| Key | Default | Meaning |
|---|---|---|
| `port` | `4780` | server port (also `--port N` on `init`/`open`) |
| `host` | `127.0.0.1` | bind address — see network exposure below |
| `harness` | `claude` | default agent harness (`claude` \| `codex`) |
| `voices` | — | UI text-to-speech voice filter |

Env knobs (set on the server process):

| Variable | Default | Meaning |
|---|---|---|
| `BC_SUPERVISE_INTERVAL_MS` | `30000` | supervision tick (lieutenant respawn, dead-worker detection); `0` disables |
| `BC_PRWATCH_INTERVAL_MS` | `120000` | PR watch tick; `0` disables |
| `BC_UPLOAD_MAX_BYTES` | `10485760` | per-file chat upload cap |
| `BC_WORKER_TTL_SECS` | `600` | card status lease TTL — `working`/`needs-you` decays to `idle` past it |
| `BC_WORKTREE_TOOL` | auto | `treehouse` \| `git` — worker worktree provisioning |
| `BC_HARNESS_STATE` | `~/.bridge-commander/harness` | harness state dir (prompts, session ids, turn-end logs) |
| `BC_GH_CMD` | `gh` | gh binary used by the PR watch |
| `BC_TURNEND_URL` | — | default callback URL baked into installed turn-end hooks |
| `BC_SEND_RETRIES` / `BC_SEND_SLEEP_MS` | `3` / `400` | verified-submit tuning for `harness.send` |

### Network exposure

The board has **no application-level auth** — whoever reaches the bind address fully controls
the board, including starting workers (running code):

- **Default (recommended): loopback only** (`127.0.0.1`).
- Private mesh (e.g. Tailscale): set `host` to that interface's address; a loopback listener is
  kept alongside. The mesh is your only auth boundary.
- **Never bind `0.0.0.0`.**

How it works inside: [ARCHITECTURE.md](ARCHITECTURE.md). The conceptual API
([docs/api/overview.md](docs/api/overview.md)) is the spec the implementation follows.
