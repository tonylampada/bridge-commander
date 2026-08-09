'use strict';
// The screens a launch has to walk through, pinned against what a real terminal
// actually printed.
//
// This exists because of a morning that was lost: the tmux server restarted,
// supervision found eight lieutenants dead, revived five, and gave up on three.
// The three it gave up on were the ones with the most context — because
// `claude --resume` only shows its "resume from summary or in full?" picker
// when there is enough transcript to be worth warning about. The harness had no
// idea what that screen was, waited 45s for a UI that was never coming, and
// flagged needs-captain three times over.
//
// The captures below are verbatim from that morning.
const test = require('node:test');
const assert = require('node:assert');
const path = require('node:path');

const { SETTLE } = require(path.join(__dirname, '..', 'claude-tmux.js'));

// What `claude --dangerously-skip-permissions --resume <id>` printed for Waldir
// and Holmes, and sat on for 45 seconds.
const RESUME_PICKER = `
  Resuming the full session will consume a substantial portion of
  your usage limits. We recommend resuming from a summary.

  ❯ 1. Resume from summary (recommended)
    2. Resume full session as-is
    3. Don't ask me again

  Enter to confirm · Esc to cancel
`;

// The main UI, once it is actually up — Selma, resumed, mid-compact.
const READY = `
✻ Cooked for 22s

❯ /compact

* Compacting conversation…
───────────────────────────────────────────────────────────────────────
❯
───────────────────────────────────────────────────────────────────────
  Opus 5 | █████░░░░░░░░░░░░░░░ 27% | 270k/1000k | 5h 5% (3h17m) | 7d…
  ⏵⏵ bypass permissions on (shift+tab to cycle) · ← for agents
`;

test('the resume picker is recognised as a menu to answer', () => {
  assert.ok(SETTLE.resumeRe.test(RESUME_PICKER),
    'unanswered, this screen costs a lieutenant its whole context');
});

test('the resume picker must NOT read as a ready UI', () => {
  // The near miss that made the bug quiet rather than loud: the picker draws
  // its own ❯, and only the column-zero anchor in readyRe keeps it from
  // matching. Relax that anchor and every unattended revival silently parks a
  // lieutenant on a menu nobody will ever press Enter on.
  assert.ok(!SETTLE.readyRe.test(RESUME_PICKER),
    'a menu mistaken for a ready UI is a lieutenant that never comes back');
});

test('the real UI still reads as ready', () => {
  assert.ok(SETTLE.readyRe.test(READY));
});

test('the ready UI is not mistaken for a menu — Enter there is a stray keystroke', () => {
  assert.ok(!SETTLE.resumeRe.test(READY));
  assert.ok(!SETTLE.trustRe.test(READY));
});

test('the trust screen is still recognised, and is not the resume picker', () => {
  const TRUST = '\n  Do you trust the files in this folder?\n\n  ❯ 1. Yes, I trust this folder\n';
  assert.ok(SETTLE.trustRe.test(TRUST));
  assert.ok(!SETTLE.resumeRe.test(TRUST));
});

// Recognising the screen is half of it. The half that actually failed that
// morning is the WIRING — whether launchAndSettle does anything about it.
test('a resume that meets the picker answers it and comes up', async () => {
  const claude = require(path.join(__dirname, '..', 'claude-tmux.js'));
  const { mockTmux } = require('./tmux-mock.js');
  const fs = require('node:fs');
  const os = require('node:os');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bc-settle-'));
  const m = mockTmux({ readyTail: [RESUME_PICKER, READY] });
  try {
    const ref = { harness: 'claude', session: 'bc-selma', window: 'lt', cwd: dir, resumeId: 'uuid-1' };
    const out = await claude.resume(ref, { stateDir: dir, installHooks: false });
    assert.strictEqual(out.resumeId, 'uuid-1', 'it came back with its memory, not a fresh session');

    const launch = m.calls.find((c) => c.fn === 'sendLiteral');
    assert.match(launch.args[1], /--resume uuid-1/);
    // One Enter submits the launch line; the second is the answer to the
    // picker. Without it the loop spins for 45s and the lieutenant stays dead.
    const enters = m.calls.filter((c) => c.fn === 'sendKey' && c.args[1] === 'Enter');
    assert.ok(enters.length >= 2, `the picker was never answered (${enters.length} Enter sent)`);
  } finally {
    m.restore();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

// Two more screens that are never going to become a running agent, captured in
// a container by the onboarding install test (MNC-71, round 1). Both used to
// burn the full 45s and then be explained by a guess that the screen itself
// contradicted.

// `claude --dangerously-skip-permissions` as uid 0. It prints one line and exits,
// which puts the pane straight back on a shell prompt.
const ROOT_REFUSAL = `
$ CLAUDE_CODE_ENABLE_PROMPT_SUGGESTION=false claude --dangerously-skip-permissions --session-id f44e2a6d
--dangerously-skip-permissions cannot be used with root/sudo privileges for security reasons
$
`;

// A claude nobody has ever run. This is BEFORE any credential question — a
// brand-new machine sees it whether or not it is logged in.
const FIRST_RUN_WIZARD = `
Welcome to Claude Code v2.1.226

 Let's get started.

 Choose the text style that looks best with your terminal
 To change this later, run /theme

   1. Auto (match terminal)
 ❯ 2. Dark mode ✔
`;

test('the screens that can never come up are fatal, not something to wait out', () => {
  assert.ok(SETTLE.fatalRe.test(ROOT_REFUSAL), 'as root there is no session coming — say so at once');
  assert.ok(SETTLE.fatalRe.test(FIRST_RUN_WIZARD), 'a setup wizard needs a human, not 45 seconds');
  assert.ok(SETTLE.fatalRe.test('bash: claude: command not found'));
});

test('the setup wizard is NOT answered with Enter, and does not read as ready', () => {
  // It draws its own ❯ and a preselected option, so it is one relaxed anchor
  // away from both mistakes. Answering it blind would pick a stranger's theme,
  // and then their login method, on their behalf.
  assert.ok(!(SETTLE.trustRe.test(FIRST_RUN_WIZARD) || SETTLE.resumeRe.test(FIRST_RUN_WIZARD)),
    'a setup wizard is not a menu we may answer');
  assert.ok(!SETTLE.readyRe.test(FIRST_RUN_WIZARD.trim().split('\n').slice(-8).join('\n')),
    'parked on the wizard is not "the UI is up"');
});

test('the screens that DO come up are not swept in with the fatal ones', () => {
  assert.ok(!SETTLE.fatalRe.test(READY));
  assert.ok(!SETTLE.fatalRe.test(RESUME_PICKER));
});

// Round 3, and the worst one: `Bridget's session started` printed over THIS.
//
// It is raised by --dangerously-skip-permissions itself, so it appears only for
// the launch line the spawn uses — and it matched the READY signature, because
// the modal's own title contains the words "Bypass Permissions mode" and the
// ready footer contains "bypass permissions on". A settle that returns here
// types the brief into a menu whose preselected option is "No, exit", and every
// caller downstream is told there is a session.
const BYPASS_CONSENT = `
  WARNING: Claude Code running in Bypass Permissions mode

  In Bypass Permissions mode, Claude Code will not ask for your approval
  before running commands. Only use this in a container without internet.

  ❯ 1. No, exit
    2. Yes, I accept
`;

test('the bypass-permissions consent screen is not a ready UI', () => {
  assert.ok(SETTLE.fatalRe.test(BYPASS_CONSENT),
    'a consent screen with "No, exit" preselected is nobody to answer but the person');
  // The ready signature still matches it — the words are the same — which is
  // exactly why fatalRe is checked FIRST and why spawn verifies afterwards.
  // If this ever stops being true, the ordering below matters less, not more.
  assert.ok(!SETTLE.trustRe.test(BYPASS_CONSENT) && !SETTLE.resumeRe.test(BYPASS_CONSENT),
    'and it is not a menu Enter may answer — Enter here EXITS claude');
});

test('the real ready footer is not mistaken for the consent screen', () => {
  // The distinguisher is "mode" / "Yes, I accept" — the running UI says
  // "bypass permissions on (shift+tab to cycle)" and neither of those.
  assert.ok(!SETTLE.fatalRe.test(READY), 'a working session must never read as fatal');
  assert.ok(SETTLE.readyRe.test(READY));
});
