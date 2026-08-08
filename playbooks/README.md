# Playbooks

Each file here is a **playbook** — a repeatable procedure for a recurring kind of work, and how
much ceremony that work gets. `default` is implement and ship. `no-mistakes` adds a review gate
and CI. The card picks one, so the bureaucracy is a per-card choice rather than a property of
the repository.

One markdown file per playbook; the file name is the id. A card's `playbook` is that id, and
`card start` renders the file against the card as it stands at that moment into the worker's
**brief** — so the body you edited five seconds ago is the body the worker reads. A card with no
playbook does not start.

These are workspace-wide, one list for every project. Add one when a kind of work recurs and
none of these fit. Expect ten of them, not fifty — past that nobody remembers which is which,
and the dropdown stops being a decision.

A `codereview` playbook is the classic one to write here and the reason it ships with nothing:
its whole value is the pointer at a review methodology, and that methodology is yours, not
bridge-commander's.

## Frontmatter — what runs the card

A playbook MAY open with a block naming how the card starts. Everything below the closing `---`
is what renders into the brief. A playbook without the block behaves exactly as it always has.

```yaml
---
harness: codex
model: gpt-5.6-sol
requires: [pr_url, pr_number, repo_slug]
branch: false
keep_worktree: true
---
```

| key | is |
|---|---|
| `harness` | what the worker session runs on (`claude`, `codex`, …) |
| `model` | the model that session starts with |
| `requires` | card attributes this playbook cannot work without — `card start` refuses before provisioning anything and names the missing one |
| `branch` | `false` = detached HEAD, no branch cut, nothing to push. Omitted, the card type decides as before (an investigation gets no branch) |
| `keep_worktree` | `true` = the worktree is never released automatically. Omitted, the board gives it back when the card leaves Working |

All five are optional. **An explicit CLI flag beats the frontmatter, which beats the config
default** — so `--harness claude` still overrides a playbook that says `codex`.

This is not YAML and does not want to be: `key: value`, `key: [a, b, c]`, `true`/`false`, and
those five keys. Anything else in the block is an error naming the line, because a guess here
silently starts the wrong worker. A playbook that wants a conditional wants to be two playbooks.

`requires` is how a playbook says "this placeholder is not a typo": an unknown `{{NAME}}` stays
literal on purpose, so a `codereview` brief with no `pr_url` would otherwise launch a worker to
discover that for itself.

`keep_worktree` is the exception, not the habit: a worktree is a full checkout, and fifteen
finished cards used to hold fifteen of them. Everything else gets its worktree back **at the
handoff** — the move out of Working, once the lieutenant has read the diff in it — with
archive as the backstop. Reach for the key when the card is expected to be **reworked in
place** — `worker send` for another turn, `card start --resume` — where throwing the checkout
away costs a re-clone; both of those refuse once the worktree is gone, and point at a fresh
`card start`.

A worktree still holding work is never released, kept or not — uncommitted changes, or commits
on a HEAD no branch, tag or remote ref reaches (a worktree is created detached, so a run that
commits without cutting a branch is referenced by nothing else). The release is refused, the
card timeline says which path and why, and the directory stays exactly as it is.

## Worker duties

The duties are a skill, `bridge-commander-worker`, shipped inside bridge-commander and
symlinked into your skills dir — so an upgrade to the tool updates the duties, without a copy
going stale in a workspace.

The **order to load it** is a line in the playbook, and that line is yours. Every playbook
here opens with it. Delete it and the worker runs without the duties; that is your call to
make, not the server's.

## Placeholders

Substituted at card start. An unknown placeholder is left as-is, so a typo shows up in the
brief rather than vanishing.

| placeholder | is |
|---|---|
| `{{CARD_ID}}` | the card id, e.g. `MNC-36` |
| `{{CARD_TITLE}}` | the card title |
| `{{TASK}}` | the card body, or the lieutenant's `--brief-file` text |
| `{{THREAD}}` | the captain↔lieutenant card thread, or empty |
| `{{PROJECT}}` | the project name as registered on the board |
| `{{PROJECT_PATH}}` | the project clone — read-only to a worker |
| `{{WORKTREE}}` | the worker's own worktree |
| `{{BRANCH}}` | `bc/{{CARD_ID}}`, empty when no branch is cut (`branch: false`, or an investigation card) |
| `{{WORKSPACE}}` | this workspace root |
| `{{CLI}}` | the `bc-axi` invocation, workspace flag included |
| `{{REPORT_FILE}}` | `{{WORKSPACE}}/.bridge-commander/reports/{{CARD_ID}}.md` |
| `{{ATTR_<NAME>}}` | card attribute `<name>` — `{{ATTR_PR_URL}}` is `--attr pr_url=…` |

## Editing

These are yours. Change one and the next card started uses it — no release, no restart. They
are versioned with the workspace, so `git log .bridge-commander/playbooks/` is the history of
how work has been asked for here.

The packaged copies ship inside bridge-commander and seed this folder on init. A file here
always wins over the packaged one, so an upgrade never overwrites an edit.
