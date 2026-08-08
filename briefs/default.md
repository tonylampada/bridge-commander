# {{CARD_TITLE}} ({{CARD_ID}})

**Load the `bridge-commander-worker` skill first.** It is your job description here: the
worktree you own, and the two verbs that reach the board.

- card `{{CARD_ID}}` · project `{{PROJECT}}`
- your worktree: `{{WORKTREE}}` — the project clone `{{PROJECT_PATH}}` is not yours
- board CLI: `{{CLI}}`

## The task

{{TASK}}

{{THREAD}}

## Branch

Your worktree starts on a detached HEAD of the default branch. Cut your branch first:

```
git checkout -b {{BRANCH}}    # or `git checkout {{BRANCH}}` if a previous worker made it
```

Every commit goes there.

## Delivery

Implement, commit, then ship it the way the project allows:

- **The project has a remote** — push and open the PR yourself:
  `git push -u origin {{BRANCH}}` then `gh pr create`. Report the full PR URL in your done
  outcome.
- **No remote** (`git remote -v` is empty) — never push, never open a PR. Stop when the work
  is complete and committed, and report exactly `ready in branch {{BRANCH}}` plus a one-line
  summary.

Check which one you are in before you finish. Guessing costs you the whole delivery.
