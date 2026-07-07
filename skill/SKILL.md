---
name: bridge-command
description: Turn the current directory into a Bridge Command workspace and become its founding lieutenant (the teleport), or re-enter an existing one. Use when the user asks to init/set up bridge command, open the bridge board, or orchestrate work through the kanban board.
---

# Bridge Command — the teleport

Bridge Command is an agent-orchestration harness whose control surface is a kanban board.
Invoking this skill turns YOU into a **lieutenant** on the workspace board: durable
orchestrator, one tmux session, supervised through durable delivery queues.

`bc-axi` is the board CLI. If it is not on PATH, use `<bridge-command checkout>/cli/bc-axi`
(this skill lives in that checkout's `skill/` directory; run it bare for full usage).

## 1. Verify you are inside tmux

Check `$TMUX`. If it is empty, REFUSE to init and tell the user exactly this, then stop:

> Bridge Command lieutenants live in tmux sessions — I need to be running inside one.
> Please start `tmux new -s <workspace-name>`, launch me again in there, and re-invoke
> this skill.

(Your tmux session becomes your permanent address: the server wakes you by typing into it,
and the captain can always `tmux attach` to it.)

## 2. Confirm you are in the intended workspace directory

Before initializing, run `pwd` and confirm it is the directory the captain meant to turn
into a workspace. Your cwd can drift from the tmux session's start dir, and `init` uses cwd
by default — initializing the wrong directory (e.g. `$HOME`) is the single most common init
mistake. If `pwd` is not the intended workspace, either `cd` into it or pass
`--workspace <dir>` explicitly. `init` echoes the resolved target and whether it is NEW;
read that banner and stop if the workspace is wrong.

## 3. Initialize the workspace (idempotent)

Agree on your lieutenant name with the user (suggest one if they don't care), then from the
workspace directory run:

```sh
bc-axi init --name "<your-name>" [--charter-file <f|->]
```

This is mechanical and safe to re-run: it creates `.bridge-command/`, boots the board server
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
the captain in outcomes. A `[bridge-command] N pending item(s)` line appearing in your
session is a wake: drain immediately.
