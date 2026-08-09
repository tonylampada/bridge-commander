#!/usr/bin/env bash
# Verify the README install + FIRST-RUN procedure end-to-end in a pristine Docker container:
# a stranger's machine, nothing installed that the instructions do not name.
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
# The checkout the container clones. Defaults to the published main; point them at a
# branch to test a first run BEFORE it merges — which is the only way to test one.
REPO_URL=${BC_REPO_URL:-https://github.com/tonylampada/bridge-commander.git}
REF=${BC_REF:-main}

docker rm -f $CONTAINER >/dev/null 2>&1
docker run -d --name $CONTAINER --network host $IMAGE sleep infinity >/dev/null

TMP=$(mktemp -d)
trap 'rm -rf "$TMP"' EXIT

# ---------------------------------------------------------------- phase 1: the first run, per README
# This is the stranger test: a bare image, and NOTHING is installed that the README and
# FIRST-RUN.md do not say to install. Every step here mirrors what the user's own agent
# does on a first `/bridge-commander` — including hitting the tmux-missing block before
# tmux exists, which is exactly what a fresh machine gives you.
cat > "$TMP/phase-install.sh" <<PHASE1
#!/bin/bash
set -uxo pipefail
export HOME=/root
export BC_REPO_URL="$REPO_URL" BC_REF="$REF"
cd /root
PHASE1
cat >> "$TMP/phase-install.sh" <<'PHASE1'

echo "=== README Install: one skill, nothing else ==="
npx -y skills add tonylampada/bridge-commander -g -y || exit 1
test -f ~/.agents/skills/bridge-commander/SKILL.md || exit 1

echo "=== SKILL.md step 0: self-bootstrap (what the agent does on first /bridge-commander) ==="
if [ ! -x ~/.agents/skills/bridge-commander/cli/bc-axi ]; then
  git clone --quiet --branch "$BC_REF" "$BC_REPO_URL" ~/.local/share/bridge-commander || exit 1
fi
BC=/root/.local/share/bridge-commander/cli/bc-axi
test -x $BC || exit 1
test -f /root/.local/share/bridge-commander/FIRST-RUN.md || exit 1

echo "=== FIRST-RUN.md: a code project is refused, naming what it found ==="
mkdir -p /root/somerepo && cd /root/somerepo && git init -q && echo '{}' > package.json && mkdir -p src
$BC init --onboard > /root/refuse.log 2>&1
test $? -eq 1 || { echo "a code project was NOT refused"; exit 1; }
cat /root/refuse.log
grep -q "first run refused (project)" /root/refuse.log || exit 1
grep -q "package.json" /root/refuse.log || exit 1
grep -q "src/" /root/refuse.log || exit 1
test -d /root/somerepo/.bridge-commander && { echo "it wrote state into a refused dir"; exit 1; }

echo "=== FIRST-RUN.md: no tmux yet -> blocked, with an install command and NO tmux command ==="
mkdir -p /root/myfleet && cd /root/myfleet
$BC init --onboard --port 4790 > /root/notmux.log 2>&1
test $? -eq 1 || { echo "a machine without tmux was NOT blocked"; exit 1; }
cat /root/notmux.log
grep -q "first run blocked (tmux-missing)" /root/notmux.log || exit 1
grep -q "apt-get install -y tmux" /root/notmux.log || exit 1
grep -qE "tmux (new|attach|new-session)" /root/notmux.log && { echo "it asked someone to type a tmux command"; exit 1; }

echo "=== what the agent does after asking: install tmux, run the same command again ==="
apt-get update -qq >/dev/null && apt-get install -y -qq tmux >/dev/null 2>&1
tmux -V || exit 1

echo "=== the first run itself (no authenticated claude in here — the board must come up anyway) ==="
cd /root/myfleet
$BC init --onboard --port 4790 > /root/init.log 2>&1
cat /root/init.log
grep -q "board: http://localhost:4790/" /root/init.log || exit 1
curl -sf http://127.0.0.1:4790/api/status | grep -q '"workspace":"/root/myfleet"' || exit 1

echo "=== Bridget: registered, chartered, and already talking ==="
test -s /root/myfleet/lieutenants/bridget/README.md || exit 1
curl -sf http://127.0.0.1:4790/api/board > /root/board.json
grep -q '"id":"bridget"' /root/board.json || exit 1
grep -q "Welcome aboard" /root/board.json || exit 1
curl -sf http://127.0.0.1:4790/api/onboarding | grep -q '"step":"board-up"' || exit 1

echo "=== the git-identity warning is a warning, not a wall ==="
grep -q "git has no identity here" /root/init.log || exit 1

echo "=== twice in a row: a re-run resumes, it does not restart ==="
$BC init --onboard --port 4790 > /root/init2.log 2>&1
cat /root/init2.log
grep -q "charter left alone" /root/init2.log || exit 1
grep -q "welcome message already on the board" /root/init2.log || exit 1
grep -q "resuming, not restarting" /root/init2.log || exit 1
test "$(grep -c 'Welcome aboard' /root/board.json)" = "1" || exit 1

echo "=== the tools the README no longer asks for, installed the way Bridget would ==="
export PATH="$HOME/.local/bin:$HOME/bin:$PATH"
curl -fsSL https://kunchenguid.github.io/treehouse/install.sh | sh || exit 1
command -v treehouse || exit 1
curl -fsSL https://raw.githubusercontent.com/kunchenguid/no-mistakes/main/docs/install.sh | sh || exit 1
command -v no-mistakes || exit 1

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

# The git identity the demo commits need. The first run only WARNED about it missing —
# it is not a precondition for a board, only for a commit.
git config --global user.email demo@example.com
git config --global user.name "Demo User"
git config --global init.defaultBranch main

for p in nimbus-web nimbus-api; do
  mkdir -p /root/src/$p && cd /root/src/$p
  git init -q
  echo "# $p" > README.md && mkdir -p src && echo "console.log('$p')" > src/index.js
  git add -A && git commit -qm "init $p"
done
cd /root/myfleet

$BC project add /root/src/nimbus-web
$BC project add /root/src/nimbus-api
# Phase 1 leaves Bridget (the onboarding lieutenant) on the board; these two own the
# demo cards.
$BC lieutenant create --name Dax --id dax
$BC lieutenant create --name Kira --id kira

# The demo board is READ, so its cards carry readable ids — and the CLI no
# longer takes one (the owner mints it). The API still does, so the fixture
# creates through it. A failed create stops the run: a silently empty board is
# worse than a loud stop.
#   card_create <id> <title> <owner> <type> <repo> [label]   — body on stdin
card_create() {
  BC_ID="$1" BC_TITLE="$2" BC_OWNER="$3" BC_TYPE="$4" BC_REPO="$5" BC_LABEL="${6:-}" BC_BODY="$(cat)" \
  node -e '
    const e = process.env;
    fetch("http://127.0.0.1:4790/api/cards", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        id: e.BC_ID, title: e.BC_TITLE, owner: e.BC_OWNER, type: e.BC_TYPE,
        attributes: { repo: e.BC_REPO }, labels: e.BC_LABEL ? [e.BC_LABEL] : [],
        body: e.BC_BODY,
      }),
    }).then(async (r) => {
      const t = await r.text();
      if (!r.ok) throw new Error(r.status + " " + t);
      console.log("created " + e.BC_ID);
    }).catch((err) => {
      console.error("card create failed: " + e.BC_ID + ": " + err.message);
      process.exit(1);
    });
  ' || exit 1
}

# ---------- Backlog ----------
card_create q3-image-pipeline "Q3 plan: move image processing to background workers" \
  dax plan nimbus-web <<'EOF'
Draft plan: today thumbnails are generated inline in the upload request (p95 4.2s).
Proposal: enqueue to a worker pool, serve a placeholder until ready.
Open questions: queue tech (pg-boss vs redis), backfill of existing images.
EOF

card_create signup-dip "Investigate last week's signup conversion dip" \
  kira investigation nimbus-api <<'EOF'
Conversion dropped 3.1% week-over-week starting Tuesday. Correlate with the
Tuesday deploys and the new e-mail verification flow. Deliverable: report, no code.
EOF

card_create node-22 "Upgrade all services to Node 22" \
  dax implementation nimbus-web chore <<'EOF'
Node 20 hits maintenance EOL soon. Bump engines, CI images and Dockerfiles across services.
EOF

# ---------- Review (full lifecycle: start -> worker done -> verify -> handoff) ----------
card_create flaky-session-test "Fix flaky session-refresh test" \
  kira implementation nimbus-api bug <<'EOF'
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

card_create dark-mode "Dashboard dark mode" \
  dax implementation nimbus-web feature <<'EOF'
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
card_create csv-export "Reports: CSV export with date-range filter" \
  dax implementation nimbus-web feature <<'EOF'
Users want to pull filtered report data into spreadsheets. Add an Export CSV button
to the reports page that respects the active date-range filter.
EOF
$BC card start csv-export --brief-file - <<'EOF'
Add CSV export to the reports page. Stream rows server-side (some reports are 500k rows), respect the active date-range filter.
EOF
sleep 2
$BC worker signal csv-export "branch created; approach: stream rows server-side with a cursor, no full materialization"
$BC worker signal csv-export "endpoint + button implemented; streaming 500k-row fixture in 3.8s; writing tests"

card_create rate-limit-search "Rate-limit the public search endpoint" \
  kira implementation nimbus-api <<'EOF'
/v1/search is getting hammered by a few anonymous clients (40% of API CPU).
Add per-key rate limiting with sane anonymous defaults.
EOF
$BC card start rate-limit-search --brief-file - <<'EOF'
Add token-bucket rate limiting to /v1/search: 60 req/min per API key, 10 req/min anonymous, 429 + Retry-After.
EOF
sleep 2
$BC worker signal rate-limit-search "token-bucket middleware in place: 60/min keyed, 10/min anonymous; adding Retry-After headers and tests"

card_create webhook-secret "Rotate the payments webhook secret" \
  kira implementation nimbus-api security <<'EOF'
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
