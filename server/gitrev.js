'use strict';
// gitrev — which commit is this process actually running? Node built-ins only.
//
// A merge changes the files on disk and nothing else: the server keeps serving
// the code it was started with, every call succeeds against it, and the only
// symptom is a feature that provably landed refusing to work. So the server
// records its commit ONCE, at boot, and the CLI compares that record to what
// the repo says NOW. Drift becomes visible instead of remembered.
//
// Git is read here, never required. `headCommit` is plain file reads under
// .git — no binary, no subprocess, no error when git is missing — which is
// what lets the comparison sit on a surface an agent hits constantly. The one
// real git call decides `dirty`, runs once at boot, off any request path, with
// a short timeout, and answers "unknown" (null) rather than throwing when git
// is slow, missing, or pointed at something that is not a repo.

const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

const SHA_RE = /^[0-9a-f]{40}$/;
const DIRTY_TIMEOUT_MS = 2000;

// <dir>/.git is a directory in a clone and a "gitdir: <path>" pointer file in a
// linked worktree — the board's own workers live in worktrees, so both shapes
// are the normal case. null when there is no git here at all.
function gitDir(dir) {
  if (!dir) return null;
  const dot = path.join(dir, '.git');
  let st;
  try { st = fs.statSync(dot); } catch (e) { return null; }
  if (st.isDirectory()) return dot;
  let txt;
  try { txt = fs.readFileSync(dot, 'utf8'); } catch (e) { return null; }
  const m = /^gitdir:\s*(.+)$/m.exec(txt);
  if (!m) return null;
  const g = m[1].trim();
  return path.isAbsolute(g) ? g : path.resolve(dir, g);
}

// A linked worktree keeps its own HEAD but shares the clone's refs, named by a
// `commondir` pointer beside it.
function commonDir(g) {
  let txt;
  try { txt = fs.readFileSync(path.join(g, 'commondir'), 'utf8').trim(); } catch (e) { return g; }
  if (!txt) return g;
  return path.isAbsolute(txt) ? txt : path.resolve(g, txt);
}

function packedRef(common, ref) {
  let txt;
  try { txt = fs.readFileSync(path.join(common, 'packed-refs'), 'utf8'); } catch (e) { return null; }
  for (const line of txt.split('\n')) {
    if (!line || line[0] === '#' || line[0] === '^') continue;
    const sp = line.indexOf(' ');
    if (sp < 0) continue;
    if (line.slice(sp + 1).trim() === ref) {
      const sha = line.slice(0, sp).trim();
      if (SHA_RE.test(sha)) return sha;
    }
  }
  return null;
}

// The commit HEAD points at, by file reads alone. null whenever it cannot be
// answered cheaply and certainly — no repo, unreadable HEAD, unborn branch.
// A null is "unknown", and every caller here treats unknown as silence.
function headCommit(dir) {
  const g = gitDir(dir);
  if (!g) return null;
  let head;
  try { head = fs.readFileSync(path.join(g, 'HEAD'), 'utf8').trim(); } catch (e) { return null; }
  if (SHA_RE.test(head)) return head; // detached HEAD — the shape a worktree starts in
  const m = /^ref:\s*(.+)$/.exec(head);
  if (!m) return null;
  const ref = m[1].trim();
  const common = commonDir(g);
  try {
    const v = fs.readFileSync(path.join(common, ref), 'utf8').trim();
    if (SHA_RE.test(v)) return v;
  } catch (e) {}
  return packedRef(common, ref);
}

// The one git subprocess in this file. true/false, or null for "unknown" —
// git missing, git slow, or not a repo are all answers, never failures.
function isDirty(dir, timeoutMs) {
  try {
    const out = execFileSync('git', ['-C', dir, 'status', '--porcelain'], {
      encoding: 'utf8',
      timeout: timeoutMs || DIRTY_TIMEOUT_MS,
      stdio: ['ignore', 'pipe', 'ignore'],
    });
    return String(out).trim().length > 0;
  } catch (e) { return null; }
}

// Called once, at server boot. `commit: null` means the server cannot say what
// it is running — which is reported as "unknown" and never as an error.
function bootRecord(dir, timeoutMs) {
  const commit = headCommit(dir);
  return {
    root: dir,
    commit,
    short: short(commit),
    dirty: commit ? isDirty(dir, timeoutMs) : null,
  };
}

function short(sha) { return SHA_RE.test(String(sha || '')) ? String(sha).slice(0, 7) : null; }

// The line, or silence. Silence when the commits match, and silence when either
// side is unknown — a line that shows up on every call is read as decoration and
// stops working the day it means something.
function driftLine(boot, headNow, restart) {
  if (!boot || !boot.commit || !headNow) return null;
  if (boot.commit === headNow) return null;
  return 'server is running OLD code — started from ' + short(boot.commit) +
    (boot.dirty ? ' (dirty tree)' : '') + ', repo is now ' + short(headNow) +
    '. Restart it: ' + (restart || 'bc-axi stop && bc-axi open');
}

module.exports = { gitDir, headCommit, isDirty, bootRecord, driftLine, short };
