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
//
// All subprocess work is async (the server's event loop must never block on
// a multi-GB worktree add), and provision/release are serialized per project
// clone: concurrent `git worktree add/remove` on one repo race its worktree
// locks, so operations on the same clone queue behind each other.

const fs = require('node:fs');
const path = require('node:path');
const { execFile } = require('node:child_process');

function run(cmd, args, opts = {}) {
  return new Promise((resolve, reject) => {
    const child = execFile(cmd, args, Object.assign({ encoding: 'utf8', timeout: 120000 }, opts),
      (err, stdout, stderr) => {
        if (err) {
          const detail = String(stderr || '').trim();
          if (detail && !String(err.message || '').includes(detail)) {
            err.message = err.message + ': ' + detail;
          }
          reject(err);
        } else {
          resolve(String(stdout).trim());
        }
      });
    child.stdin.on('error', () => {});
    child.stdin.end(); // never interactive (execFileSync ran with stdin ignored)
  });
}
function git(dir, ...args) { return run('git', ['-C', dir, ...args]); }

// Per-clone operation queue: worktree add/remove mutate the clone's shared
// git dir, so two in-flight operations on the same clone are never allowed.
const projectQueues = new Map(); // realpath(project) -> tail promise
function withProjectLock(key, fn) {
  const tail = projectQueues.get(key) || Promise.resolve();
  const next = tail.catch(() => {}).then(fn);
  projectQueues.set(key, next);
  next.catch(() => {}).then(() => {
    if (projectQueues.get(key) === next) projectQueues.delete(key);
  });
  return next;
}

async function treehouseAvailable() {
  if (process.env.BC_WORKTREE_TOOL === 'git') return false;
  if (process.env.BC_WORKTREE_TOOL === 'treehouse') return true;
  try { await run('treehouse', ['--version']); return true; } catch (e) { return false; }
}

// assertIsolated — the worktree is a genuine, distinct linked worktree:
// not the clone itself, a real worktree root, and not sharing the clone's
// primary git dir. Throws with a precise reason otherwise.
async function assertIsolated(wt, projectPath) {
  const w = fs.realpathSync(wt);
  const p = fs.realpathSync(projectPath);
  if (w === p) throw new Error('worktree resolves to the project clone itself: ' + w);
  const top = fs.realpathSync(await git(w, 'rev-parse', '--show-toplevel'));
  if (top !== w) throw new Error('not a worktree root: ' + wt + ' (toplevel is ' + top + ')');
  const wGit = await git(w, 'rev-parse', '--absolute-git-dir');
  const pGit = await git(p, 'rev-parse', '--absolute-git-dir');
  if (wGit === pGit) throw new Error('worktree shares the clone\'s git dir (not isolated): ' + wt);
}

// createWorktree(projectPath, cardId, workspace) -> { path, tool }
// Always returns an asserted-isolated worktree or throws.
function createWorktree(projectPath, cardId, workspace) {
  const proj = fs.realpathSync(projectPath);
  return withProjectLock(proj, async () => {
    let wt = null;
    let tool = 'git';
    if (await treehouseAvailable()) {
      try {
        const out = await run('treehouse', ['get', '--lease', '--lease-holder', 'bc-w-' + cardId], { cwd: proj });
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
      await git(proj, 'worktree', 'add', '-d', wt);
    }
    await assertIsolated(wt, proj);
    return { path: fs.realpathSync(wt), tool };
  });
}

// releaseWorktree({ path, tool }, projectPath) -> { released, reason? }
// Releases ONLY a clean worktree (uncommitted changes are never discarded);
// a dirty or unreadable worktree is left in place with the reason reported.
function releaseWorktree(rec, projectPath) {
  const wt = rec && rec.path;
  if (!wt || !fs.existsSync(wt)) return Promise.resolve({ released: true, reason: 'already gone' });
  let proj;
  try { proj = fs.realpathSync(projectPath); }
  catch (e) { return Promise.resolve({ released: false, reason: 'unreadable: ' + String(e.message || e) }); }
  return withProjectLock(proj, async () => {
    let dirty;
    try { dirty = await git(wt, 'status', '--porcelain'); }
    catch (e) { return { released: false, reason: 'unreadable: ' + String(e.message || e) }; }
    if (dirty) return { released: false, reason: 'worktree has uncommitted changes' };
    try {
      if (rec.tool === 'treehouse') await run('treehouse', ['return', wt], { cwd: projectPath });
      else await git(projectPath, 'worktree', 'remove', wt);
      return { released: true };
    } catch (e) {
      return { released: false, reason: String(e.message || e) };
    }
  });
}

module.exports = { createWorktree, releaseWorktree, assertIsolated };
