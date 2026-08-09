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

**`first run blocked (root)`** — you are uid 0, and Claude Code refuses `--dangerously-skip-permissions`
as root, so Bridget could never start. The block prints the two ways forward; **ask which one**.
The normal-user route (`useradd -m dev && su - dev`, then install the skill and run again there) is
the right default. `--allow-root` launches her with `IS_SANDBOX=1`, turning off a guard that exists
for good reasons — offer it only for a container they are about to delete, and only if they say yes.

**`first run blocked (port-busy)`** — everything from 4780 up is taken. Ask which port they want and
pass `--port <N>`.

**The board comes up but Bridget's session does not.** The command prints her pane verbatim and
names the cause from what is in it. Two you will meet on a fresh machine:

- **the `claude` CLI has never been run** — her pane is parked on Claude Code's own setup wizard
  (the theme picker), which appears *before* any login question.
- **the folder-trust question** — `Quick safety check: Is this a project you created or one you
  trust?`. Claude Code asks it for any directory it has not seen before, also before login.
- **not installed / not logged in** — the block names which, from the pane.

For all of these the recipe is the same and the **directory matters**: have them run

```sh
cd <the workspace folder> && claude
```

answer whatever it asks, `/exit`, then run the first-run command again. Running `claude` in their
home directory does **not** clear the trust question — Bridget is spawned in the workspace, so the
question is about that folder. Never answer those wizards for them: they pick a theme, a login
method, and what a machine is trusted with.

In every one of these the board is already up and her welcome message is already on it. Re-running
the same command is always the way forward; nothing is lost.

There is also a **git identity** warning (`user.name` / `user.email` unset). It is a warning, not a
failure: the board comes up regardless, it is recorded in the first-run state, and Bridget picks it
up before the first card. Do not stop for it.

## 3. Give them the URL, and stop

The command's last lines are the board URL. Hand it over as-is:

> Your board is at **http://localhost:4780/** — open it. Bridget is already there with a message.

**If the board is not on the machine their browser is on**, `localhost` is the wrong machine. The
server binds `127.0.0.1` on purpose — there is no app auth, so anything that can reach the port can
drive the fleet. Do not widen the bind to fix a browser problem. In order of preference:

1. **Run the workspace where the browser is.** This is the normal case, and the reason the default
   is loopback. A workspace is a folder; it does not have to live on a server.
2. **Over ssh** — a tunnel from their own machine, nothing on the board changes:
   ```sh
   ssh -L 4780:127.0.0.1:4780 <the host they ssh'd to>
   ```
   Then the same `http://localhost:4780/` works in their browser.
3. **In a container** — `docker run -p` will *not* reach a loopback bind, and publishing the port
   is not a workaround for it. Either ssh into the host and tunnel as above, or, if the container
   is on a private bridge network they control, re-run with an address the host can reach:
   ```sh
   bc-axi init --onboard --host <container-ip>
   ```
   Say the trade plainly **before** you run it: anything that can reach that address can drive the
   board, with no login. Their call, not yours.

   Asking for this after the board is already up is fine — that is the normal order, since nobody
   discovers the browser cannot reach it until they try. The command restarts the server on the new
   address, says so, writes the bind into `config.json` so it survives, and prints the URL that
   actually works. Hand over **that** URL, not `localhost`.

**If Bridget's session did not start** (the command says so, loudly), the board is still up and her
message is still on it — she just cannot answer. It is almost always the `claude` CLI: missing, or
not logged in. Get that sorted with them, then run the same command again.

## 4. That is the end of your job

Say one line — *"Bridget will take it from here; talk to her on the board"* — and stop. Do not
narrate the board, do not stay in the loop, do not pre-answer her questions.

If they come back to this same session later and ask for the board again, `bc-axi open` prints the
URL and starts the server if it is down. That is the whole re-entry.
