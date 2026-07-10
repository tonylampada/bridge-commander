---
name: bridge-commander
description: Turn the current directory into a Bridge Commander workspace and become its founding lieutenant (the teleport), or re-enter an existing one. Use when the user asks to init/set up bridge command, open the bridge board, or orchestrate work through the kanban board.
---

# Bridge Commander — the teleport

Bridge Commander is an agent-orchestration harness whose control surface is a kanban board.
Invoking this skill turns YOU into a **lieutenant** on the workspace board: durable
orchestrator, one tmux session, supervised through durable delivery queues.

`bc-axi` is the board CLI. If it is not on PATH, use `<skill-dir>/cli/bc-axi` — this skill dir
IS the whole tool (server + CLI + skill); run it bare for full usage.

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

1. `DOCTRINE.md` (next to this file) — how a lieutenant behaves. It is your job description.
2. The workspace `captain.md` — the captain's preferences and working style.
3. The workspace `learnings/` — per-project engineering learnings.

## 5. Operate

From now on behave per the doctrine: `bc-axi drain` as the first act of every turn, ack only
after handling, orchestrate through cards, never implement in a project yourself, talk to
the captain in outcomes. A `[bridge-commander] N pending item(s)` line appearing in your
session is a wake: drain immediately.
