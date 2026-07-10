# Operating the bridge-commander tool

On-demand reference for a lieutenant or agent running a live board server or shipping changes
to the tool itself. The doctrine governs how you orchestrate; this governs how you keep the
harness running under you. Read it when a restart, a deploy, or a wedged respawn is on your
plate — not before.

## Reliable server restart

`bc-axi`'s ensureServer boots the server detached with stdio ignored, so it can fail silently —
a bare "it started" is not proof. Restart deliberately:

- Find the listening pid: `ss -ltnp | grep :<port>`.
- Kill it, then poll until the port actually frees (a relaunch onto a still-held port no-ops).
- Relaunch detached: `setsid nohup node server/server.js <workspace> --port <port> > <log> 2>&1 < /dev/null &`.
- Verify BOTH: `/api/status` returns 200 AND the listening pid changed. A stale duplicate can
  hold the port and fake a successful restart — same-pid means nothing restarted.
- Preserve any env-only config the operator set; a bare restart silently drops env vars.
- Restarting never kills worker/lieutenant tmux sessions — they reattach to the fresh server.

## Deploying a merged PR to the tool

The board runs from a checkout on disk; a merged PR is not live until that checkout advances.

- Pull the checkout the server actually runs from (not your worktree).
- Restart the server only if `server/` or `harness/` changed.
- UI-only changes need just a browser refresh — no restart.

## Updating the tool

Which update path applies depends on how the skill dir was installed — check for `.git`:

- **skills-CLI copy** (no `.git`): `npx skills add` copied the folder, so `git pull` won't work.
  Update = re-run `npx skills add tonylampada/bridge-commander -g`, then restart the server.
- **Dev checkout** (`.git` present): update via `git pull`, then follow the deploy section above.

## The stale-UI trap

After a UI deploy the board can LOOK live while running old JS: SSE reconnects and re-renders
current data, so the page feels fresh even though its code is stale. Data freshness ≠ code
freshness.

- When a shipped UI feature "doesn't work", first confirm the tab was reloaded post-deploy.
- Reproduce in a clean browser (or hard reload) before you touch code — most "bugs" here are
  just an un-reloaded tab.

## Orphan tmux session wedging a lieutenant respawn

Supervised respawn targets a fixed session name (`bc-<ws>-lt-<id>`). If an orphan already holds
that name, respawn fails "tmux session already exists", gives up after 3 tries, and never
retries on its own.

- Recover: `tmux kill-session -t <target>` to free the name.
- Then restart the server — that clears the in-memory retry counter so respawn runs again.

## Developing the tool — test notes

- Run the full suite from the repo root or a repo-ADJACENT worktree:
  `node --test test/*.test.js harness/test/*.test.js`.
- Never run it under `/tmp` — the ui/js ESM files fail to load there and tests go red for the
  wrong reason.
- `stale.test.js` and `prwatch.test.js` are load-sensitive: re-run the failing one alone before
  calling it red.
- `test/install/docker-install-test.sh` verifies the README install procedure end-to-end in a
  pristine Docker container; `--demo` also populates a demo board on port 4790 (the fixture
  behind the README screenshot) and keeps the container running.
