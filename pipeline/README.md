# The pipeline executor (alpha)

A card walks through stages written in a YAML file: an implementer commits, a validator
runs the local checks and either bounces findings back or approves and opens the PR
itself. The routing between them is code — this directory — and the two judgements
inside them are agents.

> **The executor knows the Bridge Commander. The Bridge Commander does not know the
> executor.** It travels on master and is inert for anyone who installs the board.
> Nothing in `server/`, `harness/`, `ui/` or `cli/bc-axi` mentions it, and
> `test/pipeline-inert.test.js` fails the moment that stops being true. Turning it on is
> a person typing a command.

This is alpha, for our own board.

## Running one

```sh
bc-axi card start <card-id> --command \
  "/abs/path/to/pipeline/run.js <card-id> --workspace /abs/path/to/workspace"
```

`--command` is the board's only new primitive: a worker session that runs a command line
instead of launching an agent with a brief (the `command` harness — `harness/README.md`).
The card gets its worktree, its branch, its registry entry and its supervision exactly as
always, and its ONE worker is the executor. The two stage agents are the executor's
children, not the board's.

Before spending anything on it:

```sh
pipeline/run.js <card-id> --workspace <dir> --check
```

validates every key and every `{{variable}}` in the resolved file and prints the exact
prompts it would send. Nothing is spawned.

## What it does, in order

1. Reads the card (`bc-axi card show --json`).
2. Resolves the pipeline file: factory → workspace → project, key by key.
3. **Validates before spending a token.** Unknown key, misspelled variable, malformed
   stage, `{{run.output}}` where nothing runs — refused, naming the file and the key.
4. Composes `preamble` + the stage's prompt, variables substituted.
5. Opens the agent as a **window of the executor's own session**, so a lieutenant who
   attaches finds the implementer and the validator next to the executor.
6. In `validating`, runs the stage's `run` commands first and injects the output as
   `{{run.output}}`.
7. Rejection → the findings go into `{{findings}}`, the card goes back to `working`, the
   round counter goes up. Rounds exhausted → a level-1 event calling the lieutenant.
8. Approval → the validator pushed and opened the PR. The executor reports and stops.

## It is code, not a model

Zero tokens are spent by the executor. It reads, validates, substitutes, opens a window,
waits, counts, and branches. The only two models in a round are inside the stages.

That is not thrift — it is what makes the file mean anything. If a model decided the
routing, `max_rounds: 3` would be a suggestion, and on a bad day four would "make more
sense".

**The executor decides WHERE; the agents decide WHAT.**

## Talking to the board

Only through `bc-axi`, like any worker: `card show --json`, `worker signal`, `event`,
`worker done`. It never touches `board.json`, never imports from `server/`, and never
runs `card move` — moving a card is the lieutenant's, by doctrine. The executor reports;
a human decides.

`worker send` into an executor fails loudly, by design: the session runs a program, and
there is no composer to type into.

## How a stage agent answers

`pipeline/verdict.js`, rendered into the prompt as `{{done}}` and `{{reject}}` with the
right file already filled in:

```sh
{{done}}   --outcome "<what landed, PR URL if any>"
{{reject}} --findings <file>
```

`reject` lives here and not in `bc-axi` on purpose: bouncing only means something when
there is a stage to bounce back to, and teaching the board that idea would break the
one-way rule. An empty findings file is refused — a bounce that arrives with nothing to
fix is the failure this pipeline exists to prevent, and it hides well.

## Resume

The command harness's `resume` re-runs the command from the top, so "where was I" cannot
live in memory. It lives in `<workspace>/.bridge-commander/pipeline/<card-id>/`: the
stage, the round, the last findings, the agent refs, one prompt file and one verdict file
per stage per round, and the `run` output cached per round so a restart never pays for an
expensive validation run twice. A restarted executor re-attaches to the agent it was
waiting on. An executor that restarted the pipeline instead would throw away the
implementer's work, quietly — `test/pipeline-run.test.js` pins that it does not.

## The files

| file | what |
|---|---|
| `run.js` | the entry and the loop: stages, rounds, escalation |
| `config.js` | layer resolution, key-by-key merge, and the refusals |
| `template.js` | `{{name}}` and `{{#name}}…{{/name}}`, and nothing else |
| `stage.js` | run the commands, open the agent as a window, wait for the answer |
| `state.js` | everything a restart needs to know, on disk |
| `board.js` | the five things it may say to the board, through `bc-axi` |
| `verdict.js` | `done` / `reject`, the stage agent's side |
| `pipelines/validated-pr.yaml` | the factory default, and the document that explains it |
| `vendor/` | js-yaml, committed (the repo has no install step) |

Tests live with the board's (`test/pipeline-*.test.js`) so the one suite command still
covers everything: `node --test test/*.test.js harness/test/*.test.js`.

## Known alpha warts

- The card's 👁 shows the **executor's** pane, not the stage agent's — the board's worker
  ref points at the executor, and changing it would mean the executor writing board
  state. Attach to the tmux session (the signal names the window) to watch a stage.
- A long stage emits nothing, so the board's silence watchdog can fire on a healthy run.
  The executor signals at every stage boundary, which is what keeps it quiet in practice.
- One revival per stage: an agent that dies twice without answering rings the lieutenant.
