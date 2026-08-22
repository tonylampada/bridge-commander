'use strict';
// BUSY vs IDLE, pinned against what a real claude 2.1.239 pane actually printed.
//
// This exists for the same reason settle-screens.test.js does. /output-style
// applies a style by cycling the session — kill, then `claude --resume` — and a
// resume comes back with an IDLE composer: a turn interrupted by the cycle is
// not continued, it is lost. A worker stopped that way reports no turn-end and
// wakes nobody, and its card sits until the 30-minute stale watchdog notices.
// So the command refuses on a busy session, which makes "is it busy?" a
// question the harness has to get right, and getting it right is not something
// to establish by reading a regex.
//
// The captures below are verbatim tmux `capture-pane` output from live panes,
// sampled across several turns. Every one of them broke a matcher that had been
// reasoned out rather than measured.
const test = require('node:test');
const assert = require('node:assert');
const path = require('node:path');

const { BUSY, SETTLE } = require(path.join(__dirname, '..', 'claude-tmux.js'));
const { paneTail } = require(path.join(__dirname, '..', 'tmux-session.js'));

// The harness never asks these questions of a whole capture — the current
// interaction lives at the bottom, and a spinner from a turn that ended long
// ago is still up there in the scrollback. Same tail the settle signatures use.
const busy = (screen) => BUSY.spinnerRe.test(paneTail(screen)) || BUSY.queuedRe.test(paneTail(screen));

// ---------- BUSY ----------

// Mid-turn, with the parenthetical the spinner grows once it has something to
// report. Note line 39: the PREVIOUS turn's spinner, already rewritten to
// "Sautéed for 1s" — past turns say "for <N>s", only the live one says "…".
const BUSY_WORKING = `  24
  25
  26
  27
  28
  29
  30
  31
  32
  33
  34
  35
  36
  37
  38
  39
  40
  41
  42
  43
  44
  45
  46
  47
  48
  49
  50
  51
  52
  53
  54
  55
  56
  57
  58
  59
  60

✻ Sautéed for 1s

❯ Write a 400-word essay about the history of the semicolon.

✻ Working… (12s · still thinking with high effort)
  ⎿  Tip: Hit shift+tab to cycle between manual mode, auto-accept edit mode, and plan mode

────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────
❯ Write a 600-word essay on the history of the ampersand, slowly and carefully.
────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────
  Opus 5 | █░░░░░░░░░░░░░░░░░░░ 5% | 53k/1000k | 5h 8% (2h36m) | 7d 22% (2d4h)
  ⏵⏵ bypass permissions on (shift+tab to cycle)
`;

// The same session a moment later, on a different glyph and a different verb.
// Saved during the investigation under the name IDLE_SCREEN.txt, which it is
// not — the capture loop that was meant to overwrite it with an idle frame
// never did, so a busy one kept the idle name. It is kept HERE, as a busy
// fixture, because a frame that was filed as idle by mistake is exactly the
// frame the matcher has to read correctly: the empty composer below the spinner
// means nothing, and the direction of any doubt is "busy" — refusing a cycle
// costs five seconds and taking one costs a turn.
const BUSY_ACCOMPLISHING = `
  53
  54
  55
  56
  57
  58
  59
  60

✻ Sautéed for 1s

❯ Write a 400-word essay about the history of the semicolon.

● The Semicolon: A Short History of a Small Mark

  The semicolon is a printer's invention, not a scribe's inheritance. It first appears in a recognizable modern form in 1496, in Pietro Bembo's De Aetna, printed in Venice by Aldus Manutius from type
  cut by Francesco Griffo. Medieval manuscripts had used various dots and slashes to tell a reader aloud where to breathe, and one of them — the punctus versus — looked something like a semicolon. But
  Aldus gave the mark a job that was recognizably ours: a pause weightier than a comma, lighter than a colon, joining two thoughts that could stand alone but would rather not.

  It spread with the presses. Aldus's grandson, Aldus Manutius the Younger, codified punctuation in his 1561 Interpungendi ratio, and the mark reached England late in the sixteenth century, where
  compositors used it more or less as they pleased. Ben Jonson was among the first English writers to describe its use as a matter of rule rather than taste; his English Grammar, published after his
  death in 1640, treated punctuation as a system.

  The eighteenth century changed what the mark was for. Grammarians moved punctuation off the breath and onto the sentence: marks stopped scoring speech and started diagramming syntax. The semicolon,
  ambiguous by nature, survived the transition by becoming the joint where independent clauses meet. The nineteenth century was its golden age. Dickens, Melville, and the long-winded generally built
  cathedral sentences that would collapse without it.

  Then came the backlash. Modernist prose prized the short declarative, and the semicolon began to read as fussy, academic, a little vain. Orwell reportedly tried to write a novel without one. Kurt
  Vonnegut, most quotably, dismissed semicolons as marks that do nothing but show you went to college. The complaint was never really about grammar; it was about voice, and about who gets to sound
  careful.

  The mark's strangest afterlife is technical. When C was designed, the semicolon became the statement terminator, and it was inherited by C++, Java, JavaScript, and their descendants — so the most
  common semicolons written today are typed by programmers who may never use one in a sentence. It found a second unpunctuated life in the winking emoticon.

  Five centuries on, the semicolon remains what Aldus made it: optional. No sentence strictly requires one. That is precisely why it still signals something — not correctness, but a writer choosing
  connection over the full stop.

✻ Crunched for 28s
  ⎿  Tip: Hit shift+tab to cycle between manual mode, auto-accept edit mode, and plan mode
❯ Write a 600-word essay on the history of the ampersand, slowly and carefully.

✽ Accomplishing… (0s · ↓ 1.7k tokens)
  ⎿  Tip: Hit shift+tab to cycle between manual mode, auto-accept edit mode, and plan mode

────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────
❯ 
────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────
  Opus 5 | █░░░░░░░░░░░░░░░░░░░ 5% | 53k/1000k | 5h 8% (2h36m) | 7d 22% (2d4h)
  ⏵⏵ bypass permissions on (shift+tab to cycle) · ← for agents
`;

// A launch that went straight to work: the startup welcome box is still on
// screen and the spinner is the bare form, on the glyph that is not a star.
const BUSY_CHURNING = `
╭─── Claude Code v2.1.239 ─────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────╮
│                                                    │ Tips for getting started                                                                                                                        │
│                 Welcome back Tony!                 │ Ask Claude to create a new app or clone a repository                                                                                            │
│                                                    │ ─────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────── │
│                       ▐▛███▛█                      │ What's new                                                                                                                                      │
│                      ▝▜██████▀                     │ Cost estimates (\`/cost\`, status line, \`--max-budget-usd\`) now include the 1.1× US-only-inference premium for data-residency workspaces          │
│                        ▝▝ ▝▝                       │ Added the one-time fullscreen renderer offer on Bedrock, Vertex, Foundry and other previously excluded setups; new installs there now start in… │
│       Opus 5 with high effort · Claude Max ·       │ Added \`/claude-api upgrade\` to migrate Python projects from \`anthropic\` 0.x to 1.x, and updated the skill's Python reference for 1.x (timeouts… │
│       tonylampada@gmail.com's Organization         │ /release-notes for more                                                                                                                         │
│                 /…/scratchpad/busy                 │                                                                                                                                                 │
╰──────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────╯

 ⚠ 2 MCP servers need authentication · run /mcp

❯ Count slowly from 1 to 40, one number per line, thinking carefully about each.



























· Churning…

────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────
❯ 
────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────
  Opus 5
  ⏵⏵ bypass permissions on (shift+tab to cycle) · ← for agents
`;

// The third state, and the quietest. Messages typed at a busy session queue up
// INSIDE the process — the composer says so where the prompt would be, the
// queued lines are echoed into the transcript, and every one of them dies with
// the pane. There is no spinner in this tail at all, which is why the queue
// needs a signature of its own.
const BUSY_QUEUED = `
  29
  30
  31
  32
  33
  34
  35
  36
  37
  38
  39
  40
  41
  42
  43
  44
  45
  46
  47
  48
  49
  50
  51
  52
  53
  54
  55
  56
  57
  58
  59
  60

✻ Sautéed for 1s

❯ Write a 400-word essay about the history of the semicolon.

● The Semicolon: A Short History of a Small Mark

  The semicolon is a printer's invention, not a scribe's inheritance. It first appears in a recognizable modern form in 1496, in Pietro Bembo's De Aetna, printed in Venice by Aldus Manutius from type
  cut by Francesco Griffo. Medieval manuscripts had used various dots and slashes to tell a reader aloud where to breathe, and one of them — the punctus versus — looked something like a semicolon. But
  ❯ Write a 600-word essay on the history of the ampersand, slowly and carefully.
  ❯ Write a 600-word essay on the history of the ampersand, slowly and carefully.

────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────
❯ Press up to edit queued messages
────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────
  Opus 5 | █░░░░░░░░░░░░░░░░░░░ 5% | 53k/1000k | 5h 8% (2h36m) | 7d 22% (2d4h)
  ⏵⏵ bypass permissions on (shift+tab to cycle) · ← for agents
`;

// THE COUNTER-EXAMPLE. Not one more sample — the frame that proved the shape
// wrong, lifted verbatim from settle-screens.test.js's READY fixture, where it
// had been sitting in this repo the whole time.
//
// The label was pinned to a SINGLE word because every frame anybody had sampled
// happened to carry one, and an accident of sampling was written down as if it
// were the contract. `Compacting conversation…` is two words, so this screen —
// a real session mid-compaction — read as IDLE, and /output-style would have
// killed the compaction it exists to protect. /compact is a pass-through the
// same command list offers, so "compact, then restyle" is not a contrived
// sequence; it is a Tuesday.
//
// It also carries the other lesson, and the tests below keep it: READY and BUSY
// are ORTHOGONAL axes over one screen, not opposites. This pane's main UI is up
// — all readyRe asks — AND it is mid-turn. A busy screen is not "not ready".
const BUSY_COMPACTING = `
✻ Cooked for 22s

❯ /compact

* Compacting conversation…
───────────────────────────────────────────────────────────────────────
❯
───────────────────────────────────────────────────────────────────────
  Opus 5 | █████░░░░░░░░░░░░░░░ 27% | 270k/1000k | 5h 5% (3h17m) | 7d…
  ⏵⏵ bypass permissions on (shift+tab to cycle) · ← for agents
`;

// ---------- IDLE ----------

// A freshly launched session, doing nothing whatsoever — and the trap that this
// whole anchoring exists for. The welcome box truncates its "What's new"
// entries with the SAME U+2026 the spinner uses, inside rows beginning with
// "│ ". A bare /…/ calls this screen busy, and /output-style would then refuse
// on exactly the session most likely to be given one.
const IDLE_FRESH = `
╭─── Claude Code v2.1.239 ─────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────╮
│                                                    │ Tips for getting started                                                                                                                        │
│                 Welcome back Tony!                 │ Ask Claude to create a new app or clone a repository                                                                                            │
│                                                    │ ─────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────── │
│                       ▐▛███▛█                      │ What's new                                                                                                                                      │
│                      ▝▜██████▀                     │ Cost estimates (\`/cost\`, status line, \`--max-budget-usd\`) now include the 1.1× US-only-inference premium for data-residency workspaces          │
│                        ▝▝ ▝▝                       │ Added the one-time fullscreen renderer offer on Bedrock, Vertex, Foundry and other previously excluded setups; new installs there now start in… │
│       Opus 5 with high effort · Claude Max ·       │ Added \`/claude-api upgrade\` to migrate Python projects from \`anthropic\` 0.x to 1.x, and updated the skill's Python reference for 1.x (timeouts… │
│       tonylampada@gmail.com's Organization         │ /release-notes for more                                                                                                                         │
│                 /…/scratchpad/busy                 │                                                                                                                                                 │
╰──────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────╯

 ⚠ 2 MCP servers need authentication · run /mcp































────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────
❯ 
────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────
  Opus 5
  ⏵⏵ bypass permissions on (shift+tab to cycle) · ← for agents
`;

// Idle the other way: a turn that finished. "Baked for 1s" — past tense, "for
// <N>s", no ellipsis anywhere.
const IDLE_AFTER_TURN = `
✻ Baked for 1s

────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────
❯ 
────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────
  Opus 5 | █░░░░░░░░░░░░░░░░░░░ 5% | 53k/1000k | 5h 8% (2h36m) | 7d 22% (2d4h)
  ⏵⏵ bypass permissions on (shift+tab to cycle) · ← for agents
`;

// The clean idle capture, taken after a turn that ENDED: an assistant line, a
// past-tense spinner ("Churned for 1s"), an empty composer. No column-zero
// ellipsis anywhere on the screen.
const IDLE_CLEAN = `
╭─── Claude Code v2.1.239 ─────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────╮
│                                                    │ Tips for getting started                                                                                                    │
│                 Welcome back Tony!                 │ Ask Claude to create a new app or clone a repository                                                                        │
│                                                    │ ─────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────── │
│                       ▐▛███▛█                      │ What's new                                                                                                                  │
│                      ▝▜██████▀                     │ Cost estimates (\`/cost\`, status line, \`--max-budget-usd\`) now include the 1.1× US-only-inference premium for data-residenc… │
│                        ▝▝ ▝▝                       │ Added the one-time fullscreen renderer offer on Bedrock, Vertex, Foundry and other previously excluded setups; new install… │
│       Opus 5 with high effort · Claude Max ·       │ Added \`/claude-api upgrade\` to migrate Python projects from \`anthropic\` 0.x to 1.x, and updated the skill's Python referen… │
│       tonylampada@gmail.com's Organization         │ /release-notes for more                                                                                                     │
│                 /…/scratchpad/idle2                │                                                                                                                             │
╰──────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────╯

 ⚠ 2 MCP servers need authentication · run /mcp

❯ Say only: ok

● ok

✻ Churned for 1s




















────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────
❯ 
────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────
  Opus 5
  ⏵⏵ bypass permissions on (shift+tab to cycle) · ← for agents
`;

// And the one that matters most, because it is ordinary rather than exotic: a
// FULLY IDLE session whose last reply happens to contain an ellipsis.
//
//   ● Loading… done
//   ✻ Crunched for 1s
//
// Column zero, plain space, U+2026 inside the first word — every anchor the
// first matcher had, and the session is doing nothing at all. A matcher that
// reads this as busy refuses /output-style for as long as that line stays in
// the tail, which on an idle pane is forever: nothing scrolls it away, so the
// captain re-runs the command and gets the same refusal every time. Ellipses in
// prose are common, so this is the failure that would actually have been met.
const IDLE_ELLIPSIS = `
╭─── Claude Code v2.1.239 ─────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────╮
│                                                    │ Tips for getting started                                                                                                    │
│                 Welcome back Tony!                 │ Ask Claude to create a new app or clone a repository                                                                        │
│                                                    │ ─────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────── │
│                       ▐▛███▛█                      │ What's new                                                                                                                  │
│                      ▝▜██████▀                     │ Cost estimates (\`/cost\`, status line, \`--max-budget-usd\`) now include the 1.1× US-only-inference premium for data-residenc… │
│                        ▝▝ ▝▝                       │ Added the one-time fullscreen renderer offer on Bedrock, Vertex, Foundry and other previously excluded setups; new install… │
│       Opus 5 with high effort · Claude Max ·       │ Added \`/claude-api upgrade\` to migrate Python projects from \`anthropic\` 0.x to 1.x, and updated the skill's Python referen… │
│       tonylampada@gmail.com's Organization         │ /release-notes for more                                                                                                     │
│                 /…/scratchpad/idle2                │                                                                                                                             │
╰──────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────╯

 ⚠ 2 MCP servers need authentication · run /mcp

❯ Say only: ok

● ok

✻ Churned for 1s

❯ Read the file /home/ai/repos/roboflow-commander/.bridge-commander/worktrees/MNC-108/harness/claude-tmux.js and tell me its first line only.

  Read 1 file

● 'use strict';

✻ Sautéed for 3s

❯ Reply with exactly this and nothing else: Loading… done

● Loading… done

✻ Crunched for 1s






────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────
❯ 
────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────
  Opus 5 | █░░░░░░░░░░░░░░░░░░░ 5% | 53k/1000k | 5h 12% (2h12m) | 7d 22% (2d4h)
  ⏵⏵ bypass permissions on (shift+tab to cycle) · ← for agents
`;

test('a session mid-turn reads as busy — whatever glyph and whatever verb', () => {
  assert.ok(busy(BUSY_WORKING), '✻ Working… (12s · …)');
  assert.ok(busy(BUSY_ACCOMPLISHING), '✽ Accomplishing… (0s · ↓ 1.7k tokens)');
  assert.ok(busy(BUSY_CHURNING), '· Churning… — the glyph is not always a star');
});

test('queued messages count as busy: a cycle would drop them and nobody would know', () => {
  // The composer puts a NO-BREAK space (U+00A0) after its ❯, not a plain one —
  // read out of the capture byte by byte, after a literal-space matcher missed.
  assert.ok(BUSY_QUEUED.includes('❯\u00a0Press up'), 'the separator really is U+00A0');
  assert.ok(BUSY.queuedRe.test(paneTail(BUSY_QUEUED)), 'the footer names the queue');
  assert.ok(busy(BUSY_QUEUED));
  // and it is genuinely a state the spinner does not cover
  assert.ok(!BUSY.spinnerRe.test(paneTail(BUSY_QUEUED)),
    'no spinner in this tail — without its own signature this state reads idle');
});

test('an idle session reads as idle, welcome box and all', () => {
  // The ellipsis in "…now start in…" / "…(timeouts…" is a truncated release
  // note, not a turn. Relax the column-zero, non-box-glyph anchor and this
  // assertion is the one that goes.
  assert.ok(!busy(IDLE_FRESH), 'a freshly launched session is not mid-turn');
  assert.ok(!BUSY.spinnerRe.test(IDLE_FRESH),
    'and not even against the WHOLE screen — the welcome box is the trap');
  assert.ok(!busy(IDLE_AFTER_TURN), '"Baked for 1s" is a turn that ENDED');
  assert.ok(!busy(IDLE_CLEAN), '"Churned for 1s" over an empty composer is idle');
  assert.ok(!BUSY.spinnerRe.test(IDLE_CLEAN));
});

test('an idle session whose REPLY contains an ellipsis is not busy', () => {
  assert.ok(IDLE_ELLIPSIS.includes('\n● Loading… done'),
    'the fixture really does carry the line, at column zero');
  assert.ok(!busy(IDLE_ELLIPSIS),
    'a reply is not a spinner — this refusal would never have lifted');
  assert.ok(!BUSY.spinnerRe.test(IDLE_ELLIPSIS), 'nor anywhere else on the screen');
});

test('the markers that have a job are never read as the spinner glyph', () => {
  // The spinner glyph rotates and cannot be enumerated — an unlisted ✽ already
  // slipped through once. So the class turns away the glyphs that DO mean
  // something fixed, and lets every other one be a spinner.
  for (const line of [
    '● Loading… done',                  // assistant output
    '● Thinking…',                      // assistant output that reads exactly like one
    '❯ Write a 400-word essay…',        // echoed user message
    '⎿  Tip: something…',               // tool detail / tip
    '⚠ 2 MCP servers need authentication…',
    '│ Added the one-time renderer offer; new installs there now start in…',
    '…/scratchpad/busy',                // an abbreviated path, alone on the line
  ]) {
    assert.ok(!BUSY.spinnerRe.test(line), line + ' is not a turn in flight');
  }
  // …while an unseen glyph still reads as one, which is the whole point of
  // excluding rather than enumerating.
  assert.ok(BUSY.spinnerRe.test('◈ Confabulating…'), 'a glyph nobody has captured yet');
});

test('the shape after the ellipsis is pinned too: a progress note, or nothing', () => {
  assert.ok(BUSY.spinnerRe.test('✻ Working… (12s · still thinking with high effort)'));
  assert.ok(BUSY.spinnerRe.test('✻ Working…'), 'bare form, end of line');
  assert.ok(!BUSY.spinnerRe.test('✻ Loading… done'),
    'prose after the ellipsis is a sentence, not a spinner');
  // What separates `Loading… done` from `Compacting conversation…` is not how
  // many words precede the ellipsis — it is what FOLLOWS it. A spinner ends
  // there, or continues into a ` (` progress note. Prose carries on.
  assert.ok(BUSY.spinnerRe.test('✻ Compacting conversation…'),
    'the label may carry spaces — pinning it to one word was an accident of sampling');
});

test('a session mid-COMPACTION is busy — the frame that proved the one-word label wrong', () => {
  assert.ok(busy(BUSY_COMPACTING),
    'this screen sat in the repo reading as idle; a cycle here loses the compaction');
  assert.ok(BUSY.spinnerRe.test('* Compacting conversation…'),
    '* is a spinner glyph like any other — the class excludes the markers that mean something');
});

test('READY and BUSY are orthogonal: a mid-compaction pane is both', () => {
  // Nothing here relaxes settle's own expectations, and nothing may: readyRe
  // asks "is the main UI up", which on this screen is simply yes. The busy axis
  // is added ALONGSIDE it. Reading "ready" as "idle" is how a cycle lands on a
  // session that is working.
  assert.ok(SETTLE.readyRe.test(BUSY_COMPACTING), 'the main UI is up');
  assert.ok(busy(BUSY_COMPACTING), 'and it is mid-turn at the same time');
});

test('the truncated status footer is not a spinner — it is INDENTED', () => {
  // Same fixture, two lines down. The footer abbreviates itself with the very
  // same U+2026, and only the column-zero anchor turns it away. A cheap guard
  // against the anchor being loosened later.
  assert.ok(!BUSY.spinnerRe.test('  Opus 5 | █████░░░░░░░░░░░░░░░ 27% | 270k/1000k | 5h 5% (3h17m) | 7d…'));
});

test('the past-tense spinner is never mistaken for the live one', () => {
  // Both fixtures carry a finished spinner in their scrollback ("Sautéed for
  // 1s", "Crunched for 28s") while a live one runs below it. The discriminator
  // is the ellipsis, not the presence of a spinner line.
  for (const line of ['✻ Baked for 1s', '✻ Brewed for 1s', '✻ Sautéed for 1s', '✻ Cooked for 22s']) {
    assert.ok(!BUSY.spinnerRe.test(line), line + ' is done, not working');
  }
  for (const line of ['✻ Working…', '✶ Working…', '✳ Thinking…', '✽ Accomplishing… (0s)', '· Tinkering…']) {
    assert.ok(BUSY.spinnerRe.test(line), line + ' is a turn in flight');
  }
});

test('"esc to interrupt" is NOT the busy signal — this build never renders it', () => {
  // UI_READY_RE still names it, and that is where the idea came from. ~100
  // frames were sampled across several turns of 2.1.239 and it did not appear
  // once; a busy check resting on it would call every busy session idle.
  const all = [BUSY_WORKING, BUSY_ACCOMPLISHING, BUSY_CHURNING, BUSY_QUEUED, IDLE_FRESH, IDLE_AFTER_TURN];
  for (const screen of all) {
    assert.ok(!/esc (to )?interrupt/i.test(screen), 'no frame of 2.1.239 renders it');
  }
});
