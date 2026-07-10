# Bridge Command

Agent-orchestration harness whose control surface is a kanban board. The captain (you, in a
browser) pilots N **lieutenants** — durable orchestrator agents — and every unit of work is a
card owned by exactly one of them. Lieutenants never implement: each started card gets a
**worker** (one fresh agent, one tmux session, one isolated git worktree) that ships through
the project's delivery mode, up to a real reviewed PR.

Use it to delegate real engineering work to a fleet of agents and steer it from anywhere: you
glance at the board, drag cards to issue orders, and talk through per-card chat threads; the
lieutenants brief, supervise, and verify; the workers write the code.

How it works inside: [ARCHITECTURE.md](ARCHITECTURE.md). The conceptual API
([docs/api/overview.md](docs/api/overview.md)) is the spec the implementation follows.

## Install

```sh
git clone https://github.com/tonylampada/bridge-command.git
ln -s "$(pwd)/bridge-command/skill" ~/.claude/skills/bridge-command
```

Optionally put `cli/bc-axi` on PATH; everything also works via its absolute path.

## Dependencies

The server is dependency-free (plain Node, zero npm deps), but the harness drives real agent
sessions and real PRs:

| Tool | Required? | Why |
|---|---|---|
| Node ≥ 18 | **yes** | runs the server and `bc-axi` |
| `tmux` | **yes** | every lieutenant and worker lives in a tmux session |
| `git` | **yes** | projects, worker worktrees, branches |
| [Claude Code](https://claude.com/claude-code) (`claude`), authenticated | **yes** | the default agent harness for lieutenants and workers |
| [GitHub CLI](https://cli.github.com/) (`gh`), authenticated | **yes** for PR flows | PR watch (auto-archive on merge) and the `direct-PR`/`no-mistakes` delivery modes; `local-only` projects work without it |
| [OpenAI Codex CLI](https://github.com/openai/codex) (`codex`), authenticated | optional | only for `--harness codex` workers/lieutenants |
| [treehouse](https://github.com/kunchenguid/treehouse) | optional | worktree leasing for workers; auto-detected — without it, plain `git worktree` is used |

**Dependent skill:** projects registered with `--mode no-mistakes` generate worker briefs that
invoke the user-level **`/no-mistakes`** skill. Install
[no-mistakes](https://github.com/kunchenguid/no-mistakes) and run `no-mistakes init` in the
project before using that mode, or register projects as `direct-PR` / `local-only` instead —
those modes have no skill dependency.

## Run (the teleport)

1. **Start a tmux session in your workspace directory** — the calling agent's tmux session
   becomes the founding lieutenant's permanent address:

   ```sh
   mkdir myfleet && cd myfleet
   tmux new -s myfleet
   ```

2. **Launch your agent inside it and invoke the skill** (run `claude`, then `/bridge-command`).
   The skill agrees a lieutenant name with you and runs `bc-axi init --name "<name>"`, which
   bootstraps `.bridge-command/`, boots the board server detached, registers the caller as the
   founding lieutenant, and scaffolds workspace memory (`AGENTS.md`, `captain.md`, `learnings/`).

3. **Open the printed board URL** (default `http://localhost:4780/`) — the captain's cockpit.
   Talk to lieutenants through their chats and card threads; drag cards to issue orders. New
   lieutenants are born from the lane's ＋ button; repos join via
   `bc-axi project add <url|path> --mode no-mistakes|direct-PR|local-only`.

Run `bc-axi` bare for full CLI usage, or start the server by hand:
`node server/server.js <workspace> [--port N]`.

## Configuration

Per-workspace config lives in `.bridge-command/config.json`:

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
| `BC_HARNESS_STATE` | `~/.bridge-command/harness` | harness state dir (prompts, session ids, turn-end logs) |
| `BC_GH_CMD` | `gh` | gh binary used by the PR watch |
| `BC_TURNEND_URL` | — | default callback URL baked into installed turn-end hooks |
| `BC_SEND_RETRIES` / `BC_SEND_SLEEP_MS` | `3` / `400` | verified-submit tuning for `harness.send` |

### Network exposure

The board has **no application-level auth** — whoever reaches the bind address fully controls
the board, including starting workers (running code). Security = bind address + the network
boundary in front of it:

- **Default (recommended): loopback only** (`127.0.0.1`).
- To expose over a private mesh (e.g. Tailscale), set `host` to that interface's address
  (`--host` > `config.json` > loopback). A non-loopback bind also keeps a loopback listener so
  local CLI/browser keep working. The mesh is your only auth boundary — only on a tailnet you
  fully trust.
- **Never bind `0.0.0.0`.**
