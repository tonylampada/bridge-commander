# Handoff — memory reorg (2026-07-10)

For: Tony's review of https://github.com/tonylampada/bridge-command/pull/25 (already merged &
deployed under yolo — this documents what happened and what deserves a skeptical read).
Written by lieutenant monica at session end.

## The story

The captain asked for a critical analysis of the Bridge Command memory files — the workspace's
`AGENTS.md`/`captain.md`/`learnings/` and the skill itself — through the lens of the
`writing-great-skills` skill. The analysis found three diseases across ~23 KB in 6 files:

- **Duplication** — the same fact in 2–3 places (e.g. "a card is in Working iff a live worker
  exists" lived in DOCTRINE.md, captain.md AND learnings; the iOS silent-switch paragraph was
  copied wholesale into two files).
- **Misplaced knowledge** — generic, hard-won lessons trapped in the captain's personal
  workspace memory (worker process-safety, server-restart protocol, the stale-UI trap), where a
  fresh install of the skill would never see them.
- **Sediment** — workarounds for already-fixed bugs, pure history, and no mention of new
  capabilities (codex harness, `--effort`).

The organizing principle applied: **each fact lives in exactly one place, at the right level** —

> captain preference → workspace · lieutenant behavior → skill · universal worker rule → code

The full proposal was published as an interactive guided-reading site (with per-card TTS audio):
https://smooth-rafter-f5fz.here.now/ — thesis 5 ("How knowledge flows down into workers")
explains the 3-channel mechanism (brief.js template / claude environment / lieutenant's brief)
that motivated the brief.js change.

## What landed

- **PR https://github.com/tonylampada/bridge-command/pull/25** (this repo, merged, deployed):
  - `server/brief.js` — Process-safety ground rule now in EVERY worker brief (capture pid via
    `$!`, only signal `$PID`, never pgrep/pkill/kill by pattern — a worker once froze itself
    this way). Pinned by new `test/brief.test.js`.
  - `skill/DOCTRINE.md` — absorbed "the timeline never goes silent" (narrate stalls with level-2
    events) and "real verification" (the exact end-user path, not a proxy); points at
    OPERATIONS.md. +11.6% words.
  - `skill/OPERATIONS.md` — NEW on-demand tool-maintenance reference: reliable restart, deploying
    a merged PR, the stale-UI trap, orphan-tmux respawn recovery, dev/test notes.
  - `skill/SKILL.md` — step 2 slimmed to 2 lines.
- **Workspace commit** `roboflow-commander@8d24f20` — `captain.md` 3.5→1.4 KB (only
  Tony-specific preferences), `learnings/bridge-command-operations.md` 7→1 KB (only
  install-specific facts: port, upload env var, bc-axi path, iOS quirk, papercut pointer).

Verification done: full diff read (exactly the 5 briefed files; `harness/` and
`server/server.js` at 0 diff lines), suite 239/239 green in a repo-adjacent worktree, server
restarted (pid changed, status 200, env preserved), installed skill copy confirmed in sync
(hardlinks to this checkout).

## What Tony should review skeptically

- **DOCTRINE.md wording** (diff in PR #25): the two absorbed behaviors were compressed to fit
  the ≤15% growth cap — check nothing load-bearing was lost vs the old captain.md/learnings
  phrasing (pre-reorg text is in `roboflow-commander` git history before `8d24f20`).
- **brief.js rule phrasing**: it's now in every worker's prompt forever — is the wording tight
  and non-alarming enough?
- **The deletions**: `roboflow-commander@8d24f20` removed ~87 lines from captain.md/learnings on
  the claim they were duplicated, promoted, or dead. `git show 8d24f20` in the workspace repo is
  the audit surface.
- Housekeeping: an accidental duplicate here.now site exists (`still-serenity-9y2x` — first
  publish; the real one is `smooth-rafter-f5fz`). Delete at will.

## Suggested skills (next session)

- `bridge-command` — re-enter the workspace as lieutenant (the doctrine/OPERATIONS just changed;
  the next lieutenant boots with the new text).
- `writing-great-skills` — if the review prompts another editing pass on the skill docs.
- `spleak2me` — if the captain wants the review findings turned into another guided-reading page.
