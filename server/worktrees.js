'use strict';
// worktrees — isolated worker worktree provisioning and release. Node built-ins only.
//
// A worker never touches the project clone: `card.start` provisions it a real,
// isolated git worktree and asserts the isolation before any agent is spawned
// (the same guard firstmate's fm-spawn applies — a worker accidentally handed
// the clone itself would strand the clone on a feature branch).
//
// Tool selection: `treehouse get --lease` when the treehouse CLI is available
// (non-interactive durable acquire: prints only the worktree path to stdout;
// `treehouse return <path>` releases — the pattern mined from firstmate's
// fm-spawn.sh, with --lease replacing the interactive-subshell dance), else
// plain `git worktree add -d` under <workspace>/.bridge-command/worktrees/.
// BC_WORKTREE_TOOL=git|treehouse forces the choice (tests pin `git` for
// hermetic cleanup).

const fs = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');

function run(cmd, args, opts = {}) {
  return execFileSync(cmd, args, Object.assign(
    { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], timeout: 120000 }, opts)).trim();
}
function git(dir, ...args) { return run('git', ['-C', dir, ...args]); }

function treehouseAvailable() {
  if (process.env.BC_WORKTREE_TOOL === 'git') return false;
  if (process.env.BC_WORKTREE_TOOL === 'treehouse') return true;
  try { run('treehouse', ['--version']); return true; } catch (e) { return false; }
}

// assertIsolated — the worktree is a genuine, distinct linked worktree:
// not the clone itself, a real worktree root, and not sharing the clone's
// primary git dir. Throws with a precise reason otherwise.
function assertIsolated(wt, projectPath) {
  const w = fs.realpathSync(wt);
  const p = fs.realpathSync(projectPath);
  if (w === p) throw new Error('worktree resolves to the project clone itself: ' + w);
  const top = fs.realpathSync(git(w, 'rev-parse', '--show-toplevel'));
  if (top !== w) throw new Error('not a worktree root: ' + wt + ' (toplevel is ' + top + ')');
  const wGit = git(w, 'rev-parse', '--absolute-git-dir');
  const pGit = git(p, 'rev-parse', '--absolute-git-dir');
  if (wGit === pGit) throw new Error('worktree shares the clone\'s git dir (not isolated): ' + wt);
}

// createWorktree(projectPath, cardId, workspace) -> { path, tool }
// Always returns an asserted-isolated worktree or throws.
function createWorktree(projectPath, cardId, workspace) {
  const proj = fs.realpathSync(projectPath);
  let wt = null;
  let tool = 'git';
  if (treehouseAvailable()) {
    try {
      const out = run('treehouse', ['get', '--lease', '--lease-holder', 'bc-w-' + cardId], { cwd: proj });
      const lines = out.split('\n').map((l) => l.trim()).filter(Boolean);
      const cand = lines[lines.length - 1];
      if (cand && fs.existsSync(cand)) { wt = cand; tool = 'treehouse'; }
    } catch (e) { wt = null; /* fall back to git worktree */ }
  }
  if (!wt) {
    tool = 'git';
    const dir = path.join(workspace, '.bridge-command', 'worktrees');
    fs.mkdirSync(dir, { recursive: true });
    wt = path.join(dir, String(cardId).replace(/[^A-Za-z0-9_.-]/g, '-'));
    if (fs.existsSync(wt)) throw new Error('worktree path already exists: ' + wt);
    git(proj, 'worktree', 'add', '-d', wt);
  }
  assertIsolated(wt, proj);
  return { path: fs.realpathSync(wt), tool };
}

// releaseWorktree({ path, tool }, projectPath) -> { released, reason? }
// Releases ONLY a clean worktree (uncommitted changes are never discarded);
// a dirty or unreadable worktree is left in place with the reason reported.
function releaseWorktree(rec, projectPath) {
  const wt = rec && rec.path;
  if (!wt || !fs.existsSync(wt)) return { released: true, reason: 'already gone' };
  let dirty;
  try { dirty = git(wt, 'status', '--porcelain'); }
  catch (e) { return { released: false, reason: 'unreadable: ' + String(e.message || e) }; }
  if (dirty) return { released: false, reason: 'worktree has uncommitted changes' };
  try {
    if (rec.tool === 'treehouse') run('treehouse', ['return', wt], { cwd: projectPath });
    else git(projectPath, 'worktree', 'remove', wt);
    return { released: true };
  } catch (e) {
    return { released: false, reason: String(e.message || e) };
  }
}

module.exports = { createWorktree, releaseWorktree, assertIsolated };
