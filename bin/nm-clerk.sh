#!/usr/bin/env bash
# nm-clerk.sh — drive `no-mistakes axi` through its gates with no model in the loop.
#
#   nm-clerk.sh --intent-file <file> [extra axi run flags...]   start a run
#   nm-clerk.sh --respond <fix|approve|skip> [--findings id,id]
#               [--instructions "<guidance>"]                   answer a parked gate
#
# The gate is a mapping, not a judgement: `auto-fix` findings get fixed, a gate
# with nothing actionable left gets approved, and an `ask-user` finding stops the
# clerk — that call belongs to a human.
#
# `--respond` is that human coming back. It answers the gate the LAST invocation
# refused — the run is still alive and still parked on it — and then drives the
# rest exactly as the first entry point does, to the same files. So one card can
# go run → park → human → outcome without anyone finishing it by hand.
#
# `--instructions` is how that human ARGUES rather than obeys. A `fix` with no
# guidance tells the fixer "you were right, go ahead"; a `fix` carrying
# instructions tells it what the finding got wrong and what to do instead. It is
# the difference between a lieutenant who rubber-stamps and one who rules, and
# it is the only way a wrong finding gets fixed the right way. no-mistakes takes
# it on `--action fix` only, which is why nothing else here accepts it.
#
# ALWAYS EXITS 0. A non-zero exit kills whatever is driving the clerk, and to
# that driver a crashed run looks exactly like a broken one. So the outcome
# travels in files:
#
#
#   $ARTIFACTS_DIR/nm-outcome     passed | escalated | refused | failed
#   $ARTIFACTS_DIR/escalation.md  the whole payload, when a finding is ask-user
#                                 OR when the gate refused to start at all
#
# and the reason it stopped goes to stdout, which is the node's output and the
# next round's only account of what happened.
#
# `refused` and `failed` are the same word to no-mistakes and must not be to us.
# `failed` is a VERDICT ON THE CHANGE: the gate read the diff and said no, so
# the next round belongs to the implementer. `refused` is the gate declining to
# look — repo not initialised, detached HEAD, a missing dependency, no remote —
# and no amount of rewriting the code fixes it. MNC-17 burned three implement
# rounds at full model price against a `bridge-commander` that had never been
# `no-mistakes init`ed: three one-second refusals, three rewrites of code that
# was never the problem. A refusal is about the ENVIRONMENT, so it escalates to
# a human like an ask-user finding does, and never bounces to the implementer.
#
# Env:
#   NM_BIN              the no-mistakes binary (default: no-mistakes)
#   NM_MAX_FIX_ROUNDS   fix rounds before giving up (default: 3). The fixer can
#                       introduce findings of its own — it has committed
#                       __pycache__ — so an unbounded fix loop is a real shape.
#   NM_MAX_GATES        total gates answered before giving up (default: 20)
#   ARTIFACTS_DIR       where the outcome files go (default: .)
#   NM_CLERK_LOG        where no-mistakes' stderr goes (default: /dev/stderr)
set -uo pipefail

NM=${NM_BIN:-no-mistakes}
MAX_FIX_ROUNDS=${NM_MAX_FIX_ROUNDS:-3}
MAX_GATES=${NM_MAX_GATES:-20}
ART=${ARTIFACTS_DIR:-.}
LOG=${NM_CLERK_LOG:-/dev/stderr}

INTENT_FILE=
RESPOND=
FINDINGS=
INSTRUCTIONS=
while [ $# -gt 0 ]; do
  case "$1" in
    --intent-file) INTENT_FILE=${2:-}; shift 2 ;;
    --intent-file=*) INTENT_FILE=${1#*=}; shift ;;
    --respond) RESPOND=${2:-}; shift 2 ;;
    --respond=*) RESPOND=${1#*=}; shift ;;
    --findings) FINDINGS=${2:-}; shift 2 ;;
    --findings=*) FINDINGS=${1#*=}; shift ;;
    --instructions) INSTRUCTIONS=${2:-}; shift 2 ;;
    --instructions=*) INSTRUCTIONS=${1#*=}; shift ;;
    *) break ;;
  esac
done

mkdir -p "$ART"

# finish <outcome> <reason>
finish() {
  printf '%s\n' "$1" > "$ART/nm-outcome"
  printf 'clerk: %s\n' "$2"
  exit 0
}

# refuse <reason> [payload] — the gate never looked at the diff. Same exit as
# an ask-user finding, and the same file, because it needs the same person: it
# is the environment that is wrong, and the implementer cannot fix it by
# writing different code.
refuse() {
  {
    echo "# no-mistakes never got as far as reading the change"
    echo
    echo "$1"
    echo
    echo "This is the ENVIRONMENT, not the diff — repo not initialised, detached"
    echo "HEAD, a missing dependency, no remote, or the clerk meeting a shape it"
    echo "does not know. Another implement round cannot fix it, so the run stops"
    echo "here and asks instead of asking the implementer to rewrite working code."
    if [ -n "${2:-}" ]; then
      echo
      echo '```'
      printf '%s\n' "$2"
      echo '```'
    fi
  } > "$ART/escalation.md"
  finish refused "$1"
}

if [ -n "$RESPOND" ]; then
  case "$RESPOND" in
    fix|approve|skip) ;;
    *) refuse "The clerk was called with --respond '$RESPOND', which is not fix, approve or skip." ;;
  esac
  [ -z "$INTENT_FILE" ] \
    || refuse "The clerk was given both --respond and --intent-file; those are two different entry points."
  # Guidance only means something to the fixer. Silently dropping it on an
  # approve is how a human's argument disappears without anyone noticing.
  [ -z "$INSTRUCTIONS" ] || [ "$RESPOND" = fix ] \
    || refuse "The clerk was given --instructions with --respond $RESPOND; no-mistakes takes guidance only on a fix."
else
  [ -z "$INSTRUCTIONS" ] \
    || refuse "The clerk was given --instructions on the --intent-file door; guidance answers a parked gate, it does not start a run."
  [ -n "$INTENT_FILE" ] && [ -r "$INTENT_FILE" ] \
    || refuse "The clerk got no readable --intent-file, so the reviewer would have had no acceptance criteria to read the diff against."
fi

# Pull `<id>\t<action>` out of the TOON tabular block `findings[N]{cols}:`.
# The COLUMNS ARE READ FROM THE HEADER, never assumed by position: a reordered
# or extended header must not silently shift `action` onto another field.
# Fields are comma-separated with optional double quotes and backslash escapes;
# descriptions carry both, so the split has to respect them.
parse_findings() {
  awk '
    function splitrow(line, out,   i, c, f, inq, nf) {
      delete out; nf = 0; f = ""; inq = 0
      for (i = 1; i <= length(line); i++) {
        c = substr(line, i, 1)
        if (c == "\\" && inq) { i++; f = f substr(line, i, 1); continue }
        if (c == "\"") { inq = !inq; continue }
        if (c == "," && !inq) { out[++nf] = f; f = ""; continue }
        f = f c
      }
      out[++nf] = f
      return nf
    }
    /^ *findings\[[0-9]+\]\{/ {
      hdr = $0; sub(/^[^{]*\{/, "", hdr); sub(/\}.*$/, "", hdr)
      n = split(hdr, col, ",")
      idc = 0; ac = 0
      for (i = 1; i <= n; i++) { if (col[i] == "id") idc = i; if (col[i] == "action") ac = i }
      if (!idc || !ac) { print "PARSE_ERROR no id/action column in header: " hdr; exit }
      match($0, /^ */); hdrind = RLENGTH; inblk = 1; next
    }
    inblk {
      match($0, /^ */); ind = RLENGTH
      line = $0; sub(/^ +/, "", line)
      if (ind <= hdrind || line == "") { inblk = 0; next }
      if (splitrow(line, F) < n) { print "PARSE_ERROR short row: " line; exit }
      print F[idc] "\t" F[ac]
    }
  '
}

# The first `status:` inside the `gate:` block — not the `run:` one above it.
gate_status() {
  awk '/^gate:/ { g = 1; next }
       g && /^[^[:space:]]/ { g = 0 }
       g && $1 == "status:" { print $2; exit }'
}

fix_rounds=0
gates=0

# The two doors into the same loop. `--respond` skips `axi run` because the run
# is already open and parked; the human's decision IS the first gate answer, and
# everything after it is the clerk's ordinary job again.
if [ -n "$RESPOND" ]; then
  # A bare `fix` means "fix everything you offered me" — which is what the
  # escalation message tells the human it means. no-mistakes will not take
  # `--action fix` without ids, so the ids are read back off the parked gate
  # here rather than asked of a human who is holding a phone.
  if [ "$RESPOND" = fix ] && [ -z "$FINDINGS" ]; then
    FINDINGS=$(parse_findings <<<"$("$NM" axi status 2>>"$LOG")" \
      | awk -F'\t' '$2 == "auto-fix" || $2 == "ask-user" { print $1 }' | paste -sd,)
    [ -n "$FINDINGS" ] || refuse \
      "A human answered \`fix\`, but the parked gate offers nothing actionable to fix."
  fi
  printf 'clerk: answering the parked gate — %s%s%s\n' \
    "$RESPOND" "${FINDINGS:+ ($FINDINGS)}" "${INSTRUCTIONS:+ with guidance}"
  if [ "$RESPOND" = fix ] && [ -n "$FINDINGS" ]; then
    if [ -n "$INSTRUCTIONS" ]; then
      out=$("$NM" axi respond --action fix --findings "$FINDINGS" --instructions "$INSTRUCTIONS" 2>>"$LOG")
    else
      out=$("$NM" axi respond --action fix --findings "$FINDINGS" 2>>"$LOG")
    fi
  else
    out=$("$NM" axi respond --action "$RESPOND" 2>>"$LOG")
  fi
else
  out=$("$NM" axi run --intent "$(cat "$INTENT_FILE")" "$@" 2>>"$LOG")
fi

while :; do
  printf '\n===== gate %d =====\n%s\n' "$((gates + 1))" "$out"

  if grep -q '^outcome:' <<<"$out"; then
    o=$(sed -n 's/^outcome:[[:space:]]*//p' <<<"$out" | head -1)
    case "$o" in
      passed|checks-passed) finish passed "no-mistakes finished: $o" ;;
      *)                    finish failed "no-mistakes finished: $o" ;;
    esac
  fi

  if grep -q '^error:' <<<"$out"; then
    refuse "no-mistakes refused to run: $(sed -n 's/^error:[[:space:]]*//p' <<<"$out" | head -1)" "$out"
  fi

  grep -q '^gate:' <<<"$out" \
    || refuse "Unrecognised no-mistakes output: no gate:, outcome: or error: line." "$out"

  gates=$((gates + 1))
  [ "$gates" -gt "$MAX_GATES" ] \
    && finish failed "gate cap ($MAX_GATES) reached — no-mistakes is not converging"

  # `awaiting_approval` and `fix_review` carry an identically shaped findings
  # table and mean different things: the first is "rule on these", the second is
  # "here is what my fixer did, and what it introduced". Both are answered by the
  # same mapping, but only fix_review can loop, so both are named rather than
  # defaulted — an unrecognised status is a shape we have not seen, and guessing
  # at it is how a clerk ships something nobody agreed to.
  status=$(gate_status <<<"$out")
  case "$status" in
    awaiting_approval|fix_review) ;;
    *) refuse "Unknown gate status: ${status:-<none>} — the clerk refuses to guess at a shape it has not seen." "$out" ;;
  esac

  rows=$(parse_findings <<<"$out")
  case "$rows" in PARSE_ERROR*) refuse "The clerk could not parse the gate's findings table: $rows" "$out" ;; esac

  ask=$(awk -F'\t' '$2 == "ask-user" { print $1 }' <<<"$rows" | paste -sd,)
  if [ -n "$ask" ]; then
    {
      echo "# no-mistakes parked on an ask-user finding"
      echo
      echo "Gate \`$status\` on step \`$(sed -n 's/^ *step:[[:space:]]*//p' <<<"$out" | head -1)\`."
      echo "Findings the clerk refused to resolve: \`$ask\`."
      echo
      echo "An \`ask-user\` finding challenges deliberate intent or touches product"
      echo "behaviour. Nothing was resolved and nothing was approved."
      echo
      echo '```'
      printf '%s\n' "$out"
      echo '```'
    } > "$ART/escalation.md"
    finish escalated "ask-user finding(s) at gate $status: $ask — parked, nothing resolved"
  fi

  fix=$(awk -F'\t' '$2 == "auto-fix" { print $1 }' <<<"$rows" | paste -sd,)
  if [ -n "$fix" ]; then
    fix_rounds=$((fix_rounds + 1))
    [ "$fix_rounds" -gt "$MAX_FIX_ROUNDS" ] && finish failed \
      "fix-round cap ($MAX_FIX_ROUNDS) reached at gate $status; the fixer is still producing findings: $fix"
    printf 'clerk: fix round %d — %s\n' "$fix_rounds" "$fix"
    out=$("$NM" axi respond --action fix --findings "$fix" 2>>"$LOG")
  else
    printf 'clerk: approve — nothing actionable at gate %s\n' "$status"
    out=$("$NM" axi respond --action approve 2>>"$LOG")
  fi
done
