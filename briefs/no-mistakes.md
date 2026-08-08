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

## Delivery — the no-mistakes gate

1. Implement and commit on `{{BRANCH}}`.
2. Invoke `/no-mistakes` in this session and drive it through review, tests, push, PR and CI
   until the PR is green. Pass the task above as your `--intent`, enriched with the decisions
   and tradeoffs you made while doing the work.
3. Findings come back with an action. `auto-fix` is yours to fix and re-run. `ask-user` is a
   finding that challenges what the card asked for — signal it and wait for your lieutenant;
   do not answer it yourself and do not fix your way around it.
4. Report the full PR URL in your done outcome.
