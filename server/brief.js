'use strict';
// brief — the worker launch prompt. THE one place worker duties and the
// per-mode delivery contracts live (docs/api/overview.md: Brief = task
// description + acceptance criteria handed to the worker at card.start).
//
// A brief is composed from: the card (title/type/body or the lieutenant's
// --brief-file text), the captain's card-thread messages (context), the
// standing worker duties (branch, signal, done), and the delivery-mode
// contract of the card's project. Investigation cards swap the branch/PR
// duties for the report contract.

// Delivery-mode contracts: how finished work leaves the worktree.
const MODE_CONTRACTS = {
  'no-mistakes': (b) =>
    'Delivery mode: no-mistakes.\n'
    + '- Implement and commit on your branch `' + b.branch + '`.\n'
    + '- Then run the no-mistakes pipeline via its user-level skill (invoke /no-mistakes) and drive it\n'
    + '  through review, tests, push, PR, and CI until the PR is green.\n'
    + '- Report the full PR URL in your done outcome.',
  'direct-PR': (b) =>
    'Delivery mode: direct-PR.\n'
    + '- Implement and commit on your branch `' + b.branch + '`.\n'
    + '- Push the branch and open a PR yourself: `git push -u origin ' + b.branch + '` then `gh pr create`.\n'
    + '- Report the full PR URL in your done outcome.',
  'local-only': (b) =>
    'Delivery mode: local-only.\n'
    + '- Implement and commit on your branch `' + b.branch + '`. This project has no remote:\n'
    + '  never push, never open a PR.\n'
    + '- Stop when the work is complete and committed, and report exactly\n'
    + '  "ready in branch ' + b.branch + '" (plus a one-line summary) in your done outcome.',
};
const PROJECT_MODES = Object.keys(MODE_CONTRACTS);

// workerBrief(b) -> string
// b: { card: {id, title, type, body}, task?, thread: [{author,text,ts}],
//      project: {name, path, mode}, worktree, branch, workspace, cli, cardId }
function workerBrief(b) {
  const card = b.card;
  const investigation = card.type === 'investigation';
  const cli = b.cli + ' --workspace ' + b.workspace;
  const reportFile = b.workspace + '/.bridge-commander/reports/' + card.id + '.md';
  const parts = [];

  parts.push(
    '# Worker brief — card "' + card.title + '" (' + card.id + ')\n\n'
    + 'You are a Bridge Commander **worker**: one fresh agent bound 1:1 to this card, working in an\n'
    + 'isolated git worktree. You implement; your owning lieutenant orchestrates and reviews. You\n'
    + 'never talk to the captain and you have no delivery queue — your only board verbs are the two\n'
    + '`worker` commands below.');

  parts.push(
    '## Ground rules\n\n'
    + '- Your worktree is `' + b.worktree + '` (project `' + b.project.name + '`). FIRST, verify your\n'
    + '  cwd is exactly that worktree and NOT the project clone (`' + b.project.path + '`); if it is the\n'
    + '  clone, STOP immediately and report it via the done command with outcome "misplaced: launched\n'
    + '  in the project clone".\n'
    + '- Work only inside your worktree. Never touch the project clone or the workspace directly.\n'
    + '- Signal real milestones (branch created, tests green, PR open) — not chatter:\n'
    + '  `' + cli + ' worker signal ' + card.id + ' "<one line>"`\n'
    + '- When the work is finished per the contract below, report done and stop:\n'
    + '  `' + cli + ' worker done ' + card.id + ' --outcome "<what landed, incl. PR URL if any>"`\n'
    + '- Do NOT move the card; your lieutenant verifies your work and hands it off.');

  const task = String(b.task || card.body || '').trim();
  parts.push('## The task\n\n' + (task || card.title));

  const thread = (b.thread || []).filter((m) => m && String(m.text || '').trim());
  if (thread.length) {
    parts.push('## Card thread (captain ↔ lieutenant context)\n\n'
      + thread.map((m) => '- ' + (m.author || 'user') + ': ' + String(m.text).trim().replace(/\n/g, '\n  ')).join('\n'));
  }

  if (investigation) {
    parts.push(
      '## Deliverable contract (investigation)\n\n'
      + 'This is an investigation: the deliverable is a REPORT, not a change. No branch, no push, no PR.\n'
      + '- Write your findings to `' + reportFile + '` (create parent dirs as needed).\n'
      + '- The report is attached to the card automatically when you report done.\n'
      + '- Your done outcome is a one-paragraph summary of the findings.');
  } else {
    parts.push(
      '## Branch\n\n'
      + 'The worktree starts on a detached HEAD of the project default branch. Create your task branch\n'
      + 'first: `git checkout -b ' + b.branch + '` (or `git checkout ' + b.branch + '` if a previous worker\n'
      + 'already created it). All commits go on that branch.');
    const contract = MODE_CONTRACTS[b.project.mode];
    parts.push('## Delivery contract\n\n' + (contract ? contract(b) : 'Delivery mode: ' + b.project.mode + ' (unknown — ask via signal).'));
  }

  return parts.join('\n\n') + '\n';
}

module.exports = { workerBrief, MODE_CONTRACTS, PROJECT_MODES };
