# First run — for the agent the user already has

You are the user's own Claude Code (or Codex) session, in whatever folder they opened you in, and
they have just asked for Bridge Commander for the first time. **This file covers only that: getting
a board up with lieutenant Bridget on it.** The moment she is talking, you are finished — the rest
of the setup is a conversation she has with them, not a document you follow.

Read the whole file before you start. It is short on purpose.

## What you are aiming at

One command does the work:

```sh
bc-axi init --onboard
```

It refuses to eat a code project, brings the board up, writes Bridget's charter, starts her session
in a tmux session of its own, and leaves a welcome message on the board before the person has said
anything. It installs nothing, and it is safe to run again — a second run resumes where the first
one stopped.

`bc-axi` is at `<checkout>/cli/bc-axi`; SKILL.md step 0 tells you how to resolve the checkout.

## Rules that are not negotiable

- **Never ask the person to type a tmux command.** Not in a step, not in an error message, not as a
  suggestion. tmux is underneath; they never have to know it is there. If you catch yourself writing
  `tmux new -s ...` into a message to them, that is a bug in this flow — report it instead.
- **Install nothing without asking.** Ask a yes/no question with the actual command in it, wait for
  the answer, then run it yourself.
- **Stop where Bridget starts.** Do not install `treehouse` or `no-mistakes`, do not register a
  project, do not create cards, do not explain the board. That is hers, and doing it for her leaves
  the person with a board they have never used.

## 1. Is this folder allowed to be a workspace?

A workspace is its own folder, **beside** the code, never inside it — it holds the board, its
lieutenants, and the worktrees workers run in.

`init --onboard` decides this itself, before it writes anything, in this order:

1. **`.bridge-commander/` present** → an existing workspace. It continues; this is a re-run.
   (This check is first because a workspace is itself a git repo, and every later signal would
   misread it.)
2. **empty folder** → go.
3. **a `.git/`, a manifest (`package.json`, `pyproject.toml`, `go.mod`, `Cargo.toml`, …), or source
   files** → refused, naming what it found.
4. **non-empty and none of those** → refused as a judgement call, listing what is in there.

If you already know you are sitting in a repo, you can skip the refusal and go straight to asking —
but run the command anyway when unsure. Guessing is what it is there to stop.

## 2. Run it

```sh
cd <the workspace folder>
bc-axi init --onboard
```

Everything it prints is for you, not for them. Three failures are worth knowing by name — each one
prints its own block, and each one is recoverable without losing anything:

**`first run refused (project)` / `(unclear)`** — you are in the wrong folder. Tell them what it
found, in their words: *"this looks like your code — Bridge Commander wants a folder of its own,
next to it."* Then propose a path (`~/myfleet` is a fine default), **ask**, create it yourself,
`cd` in, and run the command again. Only pass `--here` if they explicitly say this folder is the
one — never on your own initiative.

**`first run blocked (tmux-missing)`** — tmux is not installed. Say why it is needed in one line
(*"lieutenants are real agent sessions and they live in tmux; you will never have to touch it"*),
show the install command the block printed for this machine, **ask**, install it on a yes, and run
the command again. On a no: there is no board without it — say so plainly and stop.

**`first run blocked (port-busy)`** — everything from 4780 up is taken. Ask which port they want and
pass `--port <N>`.

There is also a **git identity** warning (`user.name` / `user.email` unset). It is a warning, not a
failure: the board comes up regardless, it is recorded in the first-run state, and Bridget picks it
up before the first card. Do not stop for it.

## 3. Give them the URL, and stop

The command's last lines are the board URL. Hand it over as-is:

> Your board is at **http://localhost:4780/** — open it. Bridget is already there with a message.

**If you are on a remote machine** (ssh, a devbox, a container), `localhost` means the remote box,
not their laptop. Tell them to forward the port from their own machine:

```sh
ssh -L 4780:127.0.0.1:4780 <the host they ssh'd to>
```

Then the same URL works in their browser.

**If Bridget's session did not start** (the command says so, loudly), the board is still up and her
message is still on it — she just cannot answer. It is almost always the `claude` CLI: missing, or
not logged in. Get that sorted with them, then run the same command again.

## 4. That is the end of your job

Say one line — *"Bridget will take it from here; talk to her on the board"* — and stop. Do not
narrate the board, do not stay in the loop, do not pre-answer her questions.

If they come back to this same session later and ask for the board again, `bc-axi open` prints the
URL and starts the server if it is down. That is the whole re-entry.
