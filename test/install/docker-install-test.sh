#!/usr/bin/env bash
# Verify the README install procedure end-to-end in a pristine Docker container.
#
#   test/install/docker-install-test.sh          install test only; PASS/FAIL; container removed
#   test/install/docker-install-test.sh --demo   also populate a demo board (fixture for the
#                                                README screenshot) and KEEP the container
#                                                running — board at http://localhost:4790/
#
# The container runs on the host network so the board is reachable from the host for a
# screenshot; the demo board uses port 4790 to stay clear of a real workspace on 4780.
# Demo workers are spawned through a fake `claude` shim (prints the composer signatures the
# spawn detector looks for, then sleeps), so card start exercises the real worktree + tmux
# machinery without an authenticated agent.
set -uo pipefail

DEMO=0
[ "${1:-}" = "--demo" ] && DEMO=1
CONTAINER=bc-install-test
IMAGE=node:22-bookworm
PORT=4790

docker rm -f $CONTAINER >/dev/null 2>&1
docker run -d --name $CONTAINER --network host $IMAGE sleep infinity >/dev/null

TMP=$(mktemp -d)
trap 'rm -rf "$TMP"' EXIT

# ---------------------------------------------------------------- phase 1: install per README
cat > "$TMP/phase-install.sh" <<'PHASE1'
#!/bin/bash
set -uxo pipefail
export HOME=/root
cd /root

echo "=== prerequisites (README Dependencies: Node >= 18, tmux, git) ==="
apt-get update -qq >/dev/null && apt-get install -y -qq tmux >/dev/null 2>&1
node --version && git --version && tmux -V || exit 1

echo "=== README Install: npx skills add ==="
npx -y skills add tonylampada/bridge-commander -g -y || exit 1
test -f ~/.agents/skills/bridge-commander/SKILL.md || exit 1

echo "=== README Install: treehouse ==="
curl -fsSL https://kunchenguid.github.io/treehouse/install.sh | sh || exit 1
export PATH="$HOME/.local/bin:$HOME/bin:$PATH"
command -v treehouse || exit 1

echo "=== README Install: no-mistakes ==="
curl -fsSL https://raw.githubusercontent.com/kunchenguid/no-mistakes/main/docs/install.sh | sh || exit 1
command -v no-mistakes || exit 1

echo "=== SKILL.md step 0: self-bootstrap (what the agent does on first /bridge-commander) ==="
if [ ! -x ~/.agents/skills/bridge-commander/cli/bc-axi ]; then
  git clone --quiet https://github.com/tonylampada/bridge-commander.git ~/.local/share/bridge-commander || exit 1
fi
test -x ~/.local/share/bridge-commander/cli/bc-axi || exit 1

echo "=== teleport: bc-axi init inside tmux ==="
git config --global user.email demo@example.com
git config --global user.name "Demo User"
git config --global init.defaultBranch main
BC=/root/.local/share/bridge-commander/cli/bc-axi
mkdir -p /root/myfleet
tmux new-session -d -s myfleet "cd /root/myfleet && $BC init --name Dax --id dax --port 4790 > /root/init.log 2>&1; sleep infinity"
for i in $(seq 1 30); do grep -q "http://" /root/init.log 2>/dev/null && break; sleep 1; done
cat /root/init.log
grep -q "founding lieutenant" /root/init.log || exit 1
curl -sf http://127.0.0.1:4790/api/status | grep -q '"workspace":"/root/myfleet"' || exit 1
echo INSTALL_TEST_PASS
PHASE1

# ------------------------------------------------- phase 2 (--demo): populate the demo board
cat > "$TMP/phase-demo.sh" <<'PHASE2'
#!/bin/bash
set -ux
export HOME=/root PATH="/root/.local/bin:/root/bin:$PATH"
BC=/root/.local/share/bridge-commander/cli/bc-axi
cd /root/myfleet

# fake harness: pane command must not be a shell, and the tail must show claude UI signatures
cat >/usr/local/bin/claude <<'SHIM'
#!/bin/bash
echo ""
echo "❯ "
echo "  bypass permissions"
exec sleep infinity
SHIM
chmod +x /usr/local/bin/claude

for p in nimbus-web nimbus-api; do
  mkdir -p /root/src/$p && cd /root/src/$p
  git init -q
  echo "# $p" > README.md && mkdir -p src && echo "console.log('$p')" > src/index.js
  git add -A && git commit -qm "init $p"
done
cd /root/myfleet

$BC project add /root/src/nimbus-web --mode direct-PR
$BC project add /root/src/nimbus-api --mode local-only
$BC lieutenant create --name Kira --id kira

# ---------- Backlog ----------
$BC card create --id q3-image-pipeline --title "Q3 plan: move image processing to background workers" \
  --owner dax --type plan --attr repo=nimbus-web --body-file - <<'EOF'
Draft plan: today thumbnails are generated inline in the upload request (p95 4.2s).
Proposal: enqueue to a worker pool, serve a placeholder until ready.
Open questions: queue tech (pg-boss vs redis), backfill of existing images.
EOF

$BC card create --id signup-dip --title "Investigate last week's signup conversion dip" \
  --owner kira --type investigation --attr repo=nimbus-api --body-file - <<'EOF'
Conversion dropped 3.1% week-over-week starting Tuesday. Correlate with the
Tuesday deploys and the new e-mail verification flow. Deliverable: report, no code.
EOF

$BC card create --id node-22 --title "Upgrade all services to Node 22" \
  --owner dax --attr repo=nimbus-web --label chore --body-file - <<'EOF'
Node 20 hits maintenance EOL soon. Bump engines, CI images and Dockerfiles across services.
EOF

# ---------- Review (full lifecycle: start -> worker done -> verify -> handoff) ----------
$BC card create --id flaky-session-test --title "Fix flaky session-refresh test" \
  --owner kira --attr repo=nimbus-api --label bug --body-file - <<'EOF'
session-refresh.test.js fails ~1 in 8 CI runs on the TTL assertion.
EOF
$BC card start flaky-session-test --brief-file - <<'EOF'
Find the root cause of the flaky session-refresh test and fix it for real (no retries, no sleeps).
EOF
sleep 2
$BC worker signal flaky-session-test "reproduced locally: fails when the test crosses a second boundary — clock skew in the TTL assertion"
$BC worker done flaky-session-test --outcome "Root cause: real-clock TTL assertion. Fixed with fake timers; 200 consecutive green runs. PR https://github.com/nimbus/nimbus-api/pull/142"
$BC worker pause flaky-session-test
$BC card patch flaky-session-test --body-file - <<'EOF'
**Fixed and verified.** Root cause: the test asserted token TTL against the real clock,
so runs crossing a second boundary failed. Fix: fake timers around the refresh window.

- 200 consecutive local runs green, CI green
- PR: https://github.com/nimbus/nimbus-api/pull/142 — ready for your review
EOF
$BC card move flaky-session-test review

$BC card create --id dark-mode --title "Dashboard dark mode" \
  --owner dax --attr repo=nimbus-web --label feature --body-file - <<'EOF'
Add a dark theme to the dashboard, honoring prefers-color-scheme with a manual toggle.
EOF
$BC card start dark-mode --brief-file - <<'EOF'
Implement dashboard dark mode: token-level palette, prefers-color-scheme default, manual toggle persisted.
EOF
sleep 2
$BC worker signal dark-mode "palette extracted to CSS custom properties; toggle wired, persisting to localStorage"
$BC worker done dark-mode --outcome "Dark mode shipped behind prefers-color-scheme + manual toggle. All 14 dashboard views checked in both themes. PR https://github.com/nimbus/nimbus-web/pull/87"
$BC worker pause dark-mode
$BC card patch dark-mode --body-file - <<'EOF'
**Ready for review.** Token-level palette (CSS custom properties), defaults to the OS
preference, manual toggle persisted per user. Checked all 14 dashboard views in both themes.

- PR: https://github.com/nimbus/nimbus-web/pull/87
EOF
$BC card move dark-mode review

# ---------- Working ----------
$BC card create --id csv-export --title "Reports: CSV export with date-range filter" \
  --owner dax --attr repo=nimbus-web --label feature --body-file - <<'EOF'
Users want to pull filtered report data into spreadsheets. Add an Export CSV button
to the reports page that respects the active date-range filter.
EOF
$BC card start csv-export --brief-file - <<'EOF'
Add CSV export to the reports page. Stream rows server-side (some reports are 500k rows), respect the active date-range filter.
EOF
sleep 2
$BC worker signal csv-export "branch created; approach: stream rows server-side with a cursor, no full materialization"
$BC worker signal csv-export "endpoint + button implemented; streaming 500k-row fixture in 3.8s; writing tests"

$BC card create --id rate-limit-search --title "Rate-limit the public search endpoint" \
  --owner kira --attr repo=nimbus-api --body-file - <<'EOF'
/v1/search is getting hammered by a few anonymous clients (40% of API CPU).
Add per-key rate limiting with sane anonymous defaults.
EOF
$BC card start rate-limit-search --brief-file - <<'EOF'
Add token-bucket rate limiting to /v1/search: 60 req/min per API key, 10 req/min anonymous, 429 + Retry-After.
EOF
sleep 2
$BC worker signal rate-limit-search "token-bucket middleware in place: 60/min keyed, 10/min anonymous; adding Retry-After headers and tests"

$BC card create --id webhook-secret --title "Rotate the payments webhook secret" \
  --owner kira --attr repo=nimbus-api --label security --body-file - <<'EOF'
The payments provider flagged our webhook secret as older than 12 months.
Rotate with zero missed events (dual-secret window during the swap).
EOF
$BC card start webhook-secret --brief-file - <<'EOF'
Rotate the payments webhook secret with a dual-secret verification window so no event is dropped mid-swap.
EOF
sleep 2
$BC worker signal webhook-secret "dual-secret verification implemented; ready to swap — need the NEW secret value from the vault"
$BC event webhook-secret --level 1 --kind needs-you --text-file - <<'EOF'
Worker is ready to swap but needs the new secret from the vault — only you have access.
EOF

# ---------- card threads ----------
$BC say card:csv-export --actor captain --text-file - <<'EOF'
Nice. Make sure the filename includes the date range, e.g. reports_2026-06-01_2026-06-30.csv
EOF
$BC say card:csv-export --text-file - <<'EOF'
Done — passed it to the worker; filename now carries the active range exactly in that format.
EOF
$BC say card:webhook-secret --text-file - <<'EOF'
Dual-secret window is implemented and tested. I need you to paste the new secret from the vault (or drop it in the provider dashboard yourself) — everything else is ready.
EOF
$BC say card:flaky-session-test --actor captain --text-file - <<'EOF'
Great find. Was it only this test asserting against the real clock?
EOF
$BC say card:flaky-session-test --text-file - <<'EOF'
Checked the whole suite: two other tests had the same pattern but inside already-faked timers. This was the only real offender.
EOF

# ---------- lieutenant thread (the left chat panel) ----------
echo "Morning Dax — how is the reports CSV export coming along?" | $BC say lieutenant:dax --actor captain --text-file -
echo "Streaming implementation is in and handles the 500k-row reports in under 4s. Worker is writing tests now — expect it in Your review today." | $BC say lieutenant:dax --text-file -
echo "Nice. Once that lands, I want eyes on the signup conversion dip." | $BC say lieutenant:dax --actor captain --text-file -
echo "Already queued as an investigation card for Kira — she picks it up right after the rate-limit work." | $BC say lieutenant:dax --text-file -

# ---------- worker leases (green status pills) ----------
$BC status csv-export working --worker w-csv-export --ttl 3600
$BC status rate-limit-search working --worker w-rate-limit-search --ttl 3600
$BC status webhook-secret needs-you --worker w-webhook-secret --ttl 3600

# ---------- tidy the queue (lieutenants handled their items) ----------
for L in dax kira; do
  SEQ=$($BC drain --lieutenant $L --json 2>/dev/null | node -e "let d='';process.stdin.on('data',c=>d+=c).on('end',()=>{const ls=d.trim().split('\n').filter(Boolean);let m=0;for(const l of ls){try{m=Math.max(m,JSON.parse(l).seq)}catch(e){}};console.log(m||'')})")
  [ -n "$SEQ" ] && $BC ack "$SEQ"
done

$BC board
echo DEMO_BOARD_READY
PHASE2

docker cp "$TMP/phase-install.sh" $CONTAINER:/root/phase-install.sh
if ! docker exec $CONTAINER bash /root/phase-install.sh 2>&1 | tail -20; then
  echo "INSTALL TEST: FAIL (container $CONTAINER kept for inspection)"
  exit 1
fi
echo "INSTALL TEST: PASS"

if [ $DEMO -eq 1 ]; then
  docker cp "$TMP/phase-demo.sh" $CONTAINER:/root/phase-demo.sh
  docker exec $CONTAINER bash /root/phase-demo.sh 2>&1 | grep -vE '^\+{1,3} ' | tail -25
  echo "demo board: http://localhost:$PORT/  (container $CONTAINER left running; docker rm -f $CONTAINER to clean up)"
else
  docker rm -f $CONTAINER >/dev/null
fi
