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
// plain `git worktree add -d` under <workspace>/.bridge-commander/worktrees/.
// BC_WORKTREE_TOOL=git|treehouse forces the choice (tests pin `git` for
// hermetic cleanup). A pooled worktree is backed by whatever clone treehouse
// built its pool from — NOT the project clone this board registered — so the
// base is carried into it by sha and checked afterwards (freshBase/applyBase/
// assertOnBase below).
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

// freshBase(proj) -> { ref, fullRef, sha, warnings }
//
// `git worktree add` with no commit-ish uses the clone's HEAD, and nothing
// keeps a long-lived clone's HEAD current — so every worker was starting from
// wherever the clone last happened to stand. On the monorepo that was hundreds
// of commits back, against files that no longer existed; the work was doomed
// before the agent read the brief. Fetch, then cut from origin's default
// branch.
//
// The SHA is the load-bearing half. A ref name means whatever the ref store
// reading it happens to hold, and a pooled worktree reads a different clone
// than the one fetched here (see createWorktree) — so the tip is carried by
// value, and every path that applies the base is checked against it.
//
// A fetch that fails must not block the board: fall back to the local
// origin/HEAD ref (stale, but still a real base), then to the clone's HEAD
// (the old behaviour). Both fallbacks return a warning — a silent fallback is
// how this bug hid in the first place, and stderr is where nobody read it.
async function freshBase(proj) {
  const warnings = [];
  const none = { ref: null, fullRef: null, sha: null, warnings };
  try {
    await git(proj, 'fetch', '--quiet', 'origin');
  } catch (e) {
    warnings.push('fetch failed in ' + proj + ' — the base may be stale: ' + String(e.message || e));
  }
  let fullRef;
  try {
    fullRef = await git(proj, 'rev-parse', '--symbolic-full-name', 'origin/HEAD');
  } catch (e) {
    warnings.push('no origin/HEAD in ' + proj + ' — cutting from the clone HEAD: ' + String(e.message || e));
    return none;
  }
  const ref = fullRef.replace(/^refs\/remotes\//, '');
  let sha;
  try {
    sha = await git(proj, 'rev-parse', fullRef);
  } catch (e) {
    warnings.push('cannot resolve ' + ref + ' in ' + proj + ' — cutting from the clone HEAD: ' + String(e.message || e));
    return none;
  }
  return { ref, fullRef, sha, warnings };
}

// applyBase(wt, proj, base) -> warnings
//
// The pooled worktree's ref store is NOT the clone freshBase() fetched.
// treehouse keeps one pool per repository per machine, and which clone backs
// it is decided by whoever asked for it first — here, a checkout in another
// workspace entirely. So `checkout --detach origin/master` inside the lease
// reads that other clone's `origin/master`, whatever it last happened to know,
// and the fetch we just paid for lands somewhere nobody reads. When the two
// clones agree the start looks fine, which is why the stale base was
// intermittent rather than obvious.
//
// Fetching the fetched clone's own ref, BY PATH, into the lease puts the exact
// tip in the ref store the checkout will read. No treehouse internals: it is
// git, run inside the leased path.
async function applyBase(wt, proj, base) {
  const warnings = [];
  try {
    await git(wt, 'fetch', '--quiet', '--no-tags', proj, base.fullRef);
    await git(wt, 'checkout', '--detach', 'FETCH_HEAD');
    return warnings;
  } catch (e) {
    warnings.push('could not carry ' + base.ref + ' from ' + proj + ' into the leased worktree ('
      + String(e.message || e) + ') — falling back to that worktree\'s own ' + base.ref);
  }
  await git(wt, 'checkout', '--detach', base.ref);
  return warnings;
}

// assertOnBase — the checkout landed on the tip that was actually fetched.
// Without this the base is a hope: two ref stores, two `origin/master`s, and
// nothing downstream can tell which one the worker got.
async function assertOnBase(wt, base) {
  if (!base.sha) return;
  const head = await git(wt, 'rev-parse', 'HEAD');
  if (head !== base.sha) {
    throw new Error('worktree is on ' + head + ' but the fetched ' + base.ref + ' is ' + base.sha
      + ' — refusing to start a worker on a stale base');
  }
}

// createWorktree(projectPath, cardId, workspace)
//   -> { path, tool, base, baseSha, warnings }
// Always returns an asserted-isolated worktree standing on the tip that was
// just fetched, or throws. `warnings` is what the caller must make audible on
// the card: a start that fell back to a stale base is still a start, and
// nobody reads the server's stderr.
function createWorktree(projectPath, cardId, workspace) {
  const proj = fs.realpathSync(projectPath);
  return withProjectLock(proj, async () => {
    let wt = null;
    let tool = 'git';
    const base = await freshBase(proj);
    const warnings = base.warnings;
    if (await treehouseAvailable()) {
      try {
        const out = await run('treehouse', ['get', '--lease', '--lease-holder', 'bc-w-' + cardId], { cwd: proj });
        const lines = out.split('\n').map((l) => l.trim()).filter(Boolean);
        const cand = lines[lines.length - 1];
        if (cand && fs.existsSync(cand)) { wt = cand; tool = 'treehouse'; }
      } catch (e) { wt = null; /* fall back to git worktree */ }
      // A pooled worktree comes back on whatever the pool left it on, so the
      // base has to be applied after the fact rather than at creation — into
      // ITS ref store, which is not the clone we fetched.
      if (wt && base.ref) {
        try {
          warnings.push(...await applyBase(wt, proj, base));
        } catch (e) {
          await run('treehouse', ['return', wt], { cwd: proj }).catch(() => {}); // no lease left behind
          throw e;
        }
      }
    }
    if (!wt) {
      tool = 'git';
      const dir = path.join(workspace, '.bridge-commander', 'worktrees');
      fs.mkdirSync(dir, { recursive: true });
      wt = path.join(dir, String(cardId).replace(/[^A-Za-z0-9_.-]/g, '-'));
      if (fs.existsSync(wt)) throw new Error('worktree path already exists: ' + wt);
      await git(proj, 'worktree', 'add', '-d', wt, ...(base.ref ? [base.ref] : []));
    }
    await assertIsolated(wt, proj);
    try {
      await assertOnBase(wt, base);
    } catch (e) {
      // Nothing half-provisioned survives a refusal: a leaked lease starves the
      // pool, and a leaked git worktree owns the deterministic path this card
      // would be handed on its next start.
      if (tool === 'treehouse') await run('treehouse', ['return', wt], { cwd: proj }).catch(() => {});
      else await git(proj, 'worktree', 'remove', '--force', wt).catch(() => {});
      throw e;
    }
    return { path: fs.realpathSync(wt), tool, base: base.ref || null, baseSha: base.sha || null, warnings };
  });
}

// releaseWorktree({ path, tool }, projectPath) -> { released, reason? }
// Releases ONLY a worktree whose work is safely elsewhere; a worktree that is
// not, or that cannot be read, is left in place with the reason reported.
//
// TWO ways work can still live only here, and neither is ever discarded:
//   - uncommitted changes (`git status --porcelain`);
//   - commits on a HEAD no branch, tag or remote ref holds. A worktree is
//     created DETACHED and the branch is cut inside it, so a run that commits
//     before cutting one — or a `branch: false` playbook that commits at all —
//     is referenced by this worktree's HEAD and nothing else. `git worktree
//     remove` on it drops the last reference to those commits.
function releaseWorktree(rec, projectPath) {
  const wt = rec && rec.path;
  if (!wt || !fs.existsSync(wt)) return Promise.resolve({ released: true, reason: 'already gone' });
  let proj;
  try { proj = fs.realpathSync(projectPath); }
  catch (e) { return Promise.resolve({ released: false, reason: 'unreadable: ' + String(e.message || e) }); }
  return withProjectLock(proj, async () => {
    let dirty;
    let dangling;
    try {
      dirty = await git(wt, 'status', '--porcelain');
      // the newest commit on HEAD that no branch, tag or remote ref reaches —
      // empty for the ordinary worktree, which stands on its branch or on the
      // origin tip it was cut from
      dangling = await git(wt, 'rev-list', '--max-count=1', 'HEAD', '--not', '--branches', '--tags', '--remotes');
    } catch (e) { return { released: false, reason: 'unreadable: ' + String(e.message || e) }; }
    if (dirty) return { released: false, reason: 'worktree has uncommitted changes' };
    if (dangling) {
      return { released: false,
        reason: 'HEAD carries commits no branch or tag holds (' + dangling.slice(0, 8) + ')' };
    }
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
