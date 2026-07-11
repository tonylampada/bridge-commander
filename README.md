# Bridge Commander

Use Claude Code / Codex as multiple chiefs of staff. Work items get done by independent agent
sessions and are tracked realtime in a kanban board.

![the board](docs/img/board.png)

## Install

There are two ways in:

1. **Use the skill** inside Claude Code / Hermes (the intended captain/lieutenant flow)
2. **Run the tool checkout directly** with `node cli/bc-axi ...` (best for a first local test)

Install the skill like this:

```sh
# optional helper tools
curl -fsSL https://kunchenguid.github.io/treehouse/install.sh | sh
curl -fsSL https://raw.githubusercontent.com/kunchenguid/no-mistakes/main/docs/install.sh | sh

# bridge-commander skill
npx skills add tonylampada/bridge-commander -g -y   # first /bridge-commander run clones the full tool
```

Or clone the repo and run the checkout directly:

```sh
git clone https://github.com/tonylampada/bridge-commander.git
cd bridge-commander
```

## 5-minute first run

This is the fastest way to prove the board works locally.

### Minimum needed just to boot the board

- Node ≥ 18
- `tmux`
- `git`

Example (Debian/Ubuntu):

```sh
sudo apt-get install -y tmux
```

Then:

```sh
mkdir myfleet
cd myfleet
tmux new -s myfleet
# now you are inside tmux
node /path/to/bridge-commander/cli/bc-axi init --name "Founding Lieutenant"
```

That should print a board URL such as:

```text
http://localhost:4780/
```

Open that URL in your browser.

### What `init` actually does

- creates `.bridge-commander/`
- starts the board server
- registers the current tmux session as the founding lieutenant
- installs the turn-end hook
- scaffolds `AGENTS.md`, `captain.md`, and `learnings/`

## Quickstart (skill / guided flow)

- Create an empty folder (e.g. `myfleet`)
- Start `claude` in that folder, **inside tmux**
- Run `/bridge-commander`
- Open the printed board URL (default `http://localhost:4780/`)
- Talk to your lieutenant from there — he'll guide you through the rest of the setup

## Dependencies

### Minimum to boot the board

- Node ≥ 18
- `tmux`
- `git`

### Needed for the default real-agent flow

- [Claude Code](https://claude.com/claude-code), authenticated — the default agent harness

### Needed for PR / GitHub flows

- [GitHub CLI](https://cli.github.com/), authenticated

### Optional extras

- [OpenAI Codex CLI](https://github.com/openai/codex), authenticated — only for `--harness codex`
- [treehouse](https://github.com/kunchenguid/treehouse) — worker worktrees (optional; falls back to `git worktree`)
- [no-mistakes](https://github.com/kunchenguid/no-mistakes) — only for `no-mistakes`-mode projects; the `/no-mistakes` skill appears after running `no-mistakes init` in the project

## Troubleshooting first run

### `not inside tmux`

`bc-axi init` must be run from inside a tmux session because the lieutenant's durable address is the tmux session itself.

```sh
tmux new -s myfleet
```

Then re-run `init` inside that session.

### Board boots, but no real agents can work

That usually means a harness dependency is missing:

- Claude flow: `claude` must be installed and authenticated
- Codex flow: `codex` must be installed and authenticated
- PR flows: `gh` should be installed and authenticated

A common failure mode is: the board opens fine, but the harness CLI stops on a sign-in screen.

### Which entrypoint should I use?

- Use **`/bridge-commander`** when you are inside the skill-driven agent workflow.
- Use **`node cli/bc-axi ...`** when you want to test the tool checkout directly.

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
