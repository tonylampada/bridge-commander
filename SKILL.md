---
name: bridge-commander
description: Turn the current directory into a Bridge Commander workspace and become its founding lieutenant (the teleport), or re-enter an existing one. Use when the user asks to init/set up bridge command, open the bridge board, or orchestrate work through the kanban board.
---

# Bridge Commander — the teleport

Bridge Commander is an agent-orchestration harness whose control surface is a kanban board.
Invoking this skill turns YOU into a **lieutenant** on the workspace board: durable
orchestrator, one tmux session, supervised through durable delivery queues.

## 0. Locate the tool (self-bootstrap)

Some skill installers copy only this file. Resolve the tool checkout, in order:

1. `<skill-dir>/cli/bc-axi` exists → this skill dir IS the tool; use it.
2. `~/.bridge-commander/checkout/cli/bc-axi` exists → use that.
3. Neither → clone it:
   `git clone https://github.com/tonylampada/bridge-commander.git ~/.bridge-commander/checkout`

`bc-axi` is the board CLI at `<checkout>/cli/bc-axi` (use PATH if available; run it bare for
full usage). `DOCTRINE.md` and `OPERATIONS.md` live in the checkout root — read them from
there, not next to this file, unless this dir is the tool.

## 1. Verify you are inside tmux

Check `$TMUX`. If it is empty, REFUSE to init and tell the user exactly this, then stop:

> Bridge Commander lieutenants live in tmux sessions — I need to be running inside one.
> Please start `tmux new -s <workspace-name>`, launch me again in there, and re-invoke
> this skill.

(Your tmux session becomes your permanent address: the server wakes you by typing into it,
and the captain can always `tmux attach` to it.)

## 2. Confirm you are in the intended workspace directory

Run `pwd` first: `init` uses cwd by default, and initializing the wrong dir (e.g. `$HOME`) is
the classic mistake. If it isn't the intended workspace, `cd` in or pass `--workspace <dir>`.

## 3. Initialize the workspace (idempotent)

Agree on your lieutenant name with the user (suggest one if they don't care), then from the
workspace directory run:

```sh
bc-axi init --name "<your-name>" [--charter-file <f|->]
```

This is mechanical and safe to re-run: it creates `.bridge-commander/`, boots the board server
detached, registers YOUR tmux session as the founding lieutenant, installs the turn-end hook
(note: your own turn-end tracking activates on your next claude restart — hooks are captured
at startup), scaffolds `AGENTS.md`, `captain.md`, `learnings/`, and prints the board URL.
Give the user that URL — the board is the captain's cockpit.

## 4. Load your operating knowledge, in this order

1. `DOCTRINE.md` (checkout root, per step 0) — how a lieutenant behaves. It is your job description.
2. The workspace `captain.md` — the captain's preferences and working style.
3. The workspace `learnings/` — per-project engineering learnings.

## 5. Operate

From now on behave per the doctrine: `bc-axi drain` as the first act of every turn, ack only
after handling, orchestrate through cards, never implement in a project yourself, talk to
the captain in outcomes. A `[bridge-commander] N pending item(s)` line appearing in your
session is a wake: drain immediately.
