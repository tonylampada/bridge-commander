# Brief templates

Each file here is a **flavour of SDLC** — how much ceremony a piece of work gets. `default` is
implement and ship. `no-mistakes` adds a review gate and CI. The card picks one, so the
bureaucracy is a per-card choice rather than a property of the repository.

One markdown file per template; the file name is the id. A card's `brief` is that id, and
`card start` renders the file against the card as it stands at that moment — so the body you
edited five seconds ago is the body the worker reads. A card with no brief does not start.

These are workspace-wide, one list for every project. Add one when a kind of work recurs and
none of these fit. Expect ten of them, not fifty — past that nobody remembers which is which,
and the dropdown stops being a decision.

## Worker duties

The duties are a skill, `bridge-commander-worker`, shipped inside bridge-commander and
symlinked into your skills dir — so an upgrade to the tool updates the duties, without a copy
going stale in a workspace.

The **order to load it** is a line in the template, and that line is yours. Every template
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
| `{{BRANCH}}` | `bc/{{CARD_ID}}`, empty for investigations |
| `{{WORKSPACE}}` | this workspace root |
| `{{CLI}}` | the `bc-axi` invocation, workspace flag included |
| `{{REPORT_FILE}}` | `{{WORKSPACE}}/.bridge-commander/reports/{{CARD_ID}}.md` |
| `{{ATTR_<NAME>}}` | card attribute `<name>` — `{{ATTR_PR_URL}}` is `--attr pr_url=…` |

## Editing

These are yours. Change one and the next card started uses it — no release, no restart. They
are versioned with the workspace, so `git log .bridge-commander/briefs/` is the history of how
work has been asked for here.

The packaged copies ship inside bridge-commander and seed this folder on init. A file here
always wins over the packaged one, so an upgrade never overwrites an edit.
