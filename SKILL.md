---
name: bridge-commander
description: Set up Bridge Commander for the first time (an empty folder becomes a board with a lieutenant already on it), or turn the current directory into a workspace and become its founding lieutenant (the teleport), or re-enter an existing one. Use when the user asks to init/set up bridge command, open the bridge board, or orchestrate work through the kanban board.
---

# Bridge Commander — the teleport

Bridge Commander is an agent-orchestration harness whose control surface is a kanban board.
Invoking this skill turns YOU into a **lieutenant** on the workspace board: durable
orchestrator, one tmux session, supervised through durable delivery queues.

## 0. Locate the tool (self-bootstrap)

Some skill installers copy only this file. Resolve the tool checkout, in order:

1. `<skill-dir>/cli/bc-axi` exists → this skill dir IS the tool; use it.
2. `~/.local/share/bridge-commander/cli/bc-axi` exists → use that.
3. Neither → clone it:
   `git clone https://github.com/tonylampada/bridge-commander.git ~/.local/share/bridge-commander`

`bc-axi` is the board CLI at `<checkout>/cli/bc-axi` (use PATH if available; run it bare for
full usage). `DOCTRINE.md` and `OPERATIONS.md` live in the checkout root — read them from
there, not next to this file, unless this dir is the tool.

## 1. Which of the two runs is this?

**Is there a `.bridge-commander/` directory here (or in a parent)?**

- **No — this is a first run.** Read **`FIRST-RUN.md` in the checkout** and follow it, instead of
  the rest of this file. It is one command, and it ends with a board and a lieutenant named
  Bridget already talking to the user; onboarding is hers from there. Do not ask the user to
  start tmux — the first run handles tmux itself and never mentions it to them.
- **Yes — a workspace exists.** Continue below: you are joining it as a lieutenant.

## 2. Verify you are inside tmux

Check `$TMUX`. If it is empty you cannot BE a lieutenant of this workspace from here — a
lieutenant's tmux session is its permanent address (the server wakes it by typing into it, and
the captain can `tmux attach` to it). Do not ask the user to start one. Instead:

- Print the board URL for them: `bc-axi open`.
- Say that the board's lieutenants are already reachable there, and that you can act as their
  hands in this terminal but are not on the board yourself.

## 3. Confirm you are in the intended workspace directory

Run `pwd` first: `init` uses cwd by default, and initializing the wrong dir (e.g. `$HOME`) is
the classic mistake. If it isn't the intended workspace, `cd` in or pass `--workspace <dir>`.

## 4. Initialize the workspace (idempotent)

Agree on your lieutenant name with the user (suggest one if they don't care), then from the
workspace directory run:

```sh
bc-axi init --name "<your-name>" [--charter-file <f|->]
```

This is mechanical and safe to re-run: it creates `.bridge-commander/`, boots the board server
detached, registers YOUR tmux session as the founding lieutenant, installs the turn-end hook
(note: your own turn-end tracking activates on your next claude restart — hooks are captured
at startup), scaffolds `AGENTS.md`, `captain.md`, `learnings/`, and prints the board URL.
`--charter-file` CREATES `lieutenants/<your-id>/README.md` when it is absent — your standing
memory, and what a future session of yours is launched on. It never replaces an existing one
(a re-run says so and leaves it alone); edit the file to change your charter.
Give the user that URL — the board is the captain's cockpit.

## 5. Load your operating knowledge, in this order

1. `DOCTRINE.md` (checkout root, per step 0) — how a lieutenant behaves. It is your job description.
2. The workspace `captain.md` — the captain's preferences and working style.
3. The workspace `learnings/` — per-project engineering learnings.

## 6. Operate

From now on behave per the doctrine: `bc-axi drain` as the first act of every turn, ack only
after handling, orchestrate through cards, never implement in a project yourself, talk to
the captain in outcomes. A `[bridge-commander] N pending item(s)` line appearing in your
session is a wake: drain immediately.
