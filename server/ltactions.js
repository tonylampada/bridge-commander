'use strict';
// Lieutenant page actions: the captain clicks on a lieutenant's page, the page
// POSTs /lt/<id>/action/<name>, and the board runs the lieutenant's own
// executable `lieutenants/<id>/actions/<name>`. The board owns the plumbing
// (name check, spawn, timeout, log, notify, refresh event); the lieutenant owns
// what an action does. Node built-ins only.
//
// The executable contract:
//   cwd     lieutenants/<id>/
//   stdin   {"action", "args", "lieutenant", "ts"}  (one JSON document, then EOF)
//   stdout  {"ok": true, "result"?, "message"?} — or {"ok": false, "message"}
//           for a refusal the captain should read (a 422, shown as a toast)
//   exit    0. Anything else, a timeout, or stdout that is not that JSON is the
//           action being broken: a 5xx carrying the stderr tail.
// Spawned directly, never through a shell, so nothing in args is ever
// interpolated into a command line. A timeout kills the whole process group.
//
// Every run, ok or not, is one line in lieutenants/<id>/state/actions.jsonl:
// that file is how a `notify: false` action reaches the lieutenant (it reads
// the tail on its next turn), and the record of every one that did notify.

const fs = require('node:fs');
const path = require('node:path');
const { spawn } = require('node:child_process');

const ACTION_NAME_RE = /^[a-z0-9][a-z0-9._-]{0,63}$/;
const DEFAULT_TIMEOUT_MS = 20000;
const STDOUT_CAP = 1 << 20; // a result is data for a page, not a download
const STDERR_TAIL = 4096;

function actionsDir(ltDir) { return path.join(ltDir, 'actions'); }
function logFile(ltDir) { return path.join(ltDir, 'state', 'actions.jsonl'); }

// The executable a name refers to, or null — the same null for a bad name, a
// missing file, a non-executable one and anything that resolves out of
// actions/ through a symlink. The caller answers all of them with one 404.
function actionFile(ltDir, name) {
  if (typeof name !== 'string' || !ACTION_NAME_RE.test(name)) return null;
  let root;
  try { root = fs.realpathSync(actionsDir(ltDir)); } catch (e) { return null; }
  try {
    const file = fs.realpathSync(path.join(root, name));
    if (path.dirname(file) !== root) return null;
    if (!fs.statSync(file).isFile()) return null;
    fs.accessSync(file, fs.constants.X_OK);
    return file;
  } catch (e) { return null; }
}

// Spawn `file` with `input` on stdin. Never rejects:
//   {code, signal, timedOut, error?, stdout, stderr, ms}
function runAction(file, input, opts) {
  const timeoutMs = (opts && opts.timeoutMs) || DEFAULT_TIMEOUT_MS;
  const started = Date.now();
  return new Promise((resolve) => {
    let stdout = '', stderr = '', timedOut = false, settled = false, child;
    const done = (r) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(Object.assign({ stdout, stderr: stderr.slice(-STDERR_TAIL), timedOut, ms: Date.now() - started }, r));
    };
    try {
      // detached: its own process group, so the kill reaches a shebang shell's children too
      child = spawn(file, [], { cwd: opts.cwd, env: opts.env || process.env, stdio: ['pipe', 'pipe', 'pipe'], detached: true });
    } catch (e) {
      return resolve({ code: null, signal: null, timedOut: false, error: String(e.message || e), stdout: '', stderr: '', ms: 0 });
    }
    const timer = setTimeout(() => {
      timedOut = true;
      try { process.kill(-child.pid, 'SIGKILL'); } catch (e) { try { child.kill('SIGKILL'); } catch (e2) {} }
    }, timeoutMs);
    child.stdout.on('data', (c) => { if (stdout.length < STDOUT_CAP) stdout += c.toString('utf8'); });
    child.stderr.on('data', (c) => { stderr = (stderr + c.toString('utf8')).slice(-STDERR_TAIL * 2); });
    child.stdin.on('error', () => {}); // an action that never reads stdin closes it early: not our failure
    child.on('error', (e) => done({ code: null, signal: null, error: String(e.message || e) }));
    child.on('close', (code, signal) => done({ code, signal }));
    child.stdin.end(JSON.stringify(input));
  });
}

// A run -> the HTTP answer: {status, body}. The body always says `ok`.
function interpret(name, run, timeoutMs) {
  const tail = run.stderr ? run.stderr.trim() : '';
  const fail = (status, error) => ({ status, body: Object.assign({ ok: false, error }, tail ? { stderr: tail } : null) });
  if (run.timedOut) return fail(504, 'action ' + name + ' timed out after ' + Math.round((timeoutMs || DEFAULT_TIMEOUT_MS) / 1000) + 's (killed)');
  if (run.error) return fail(500, 'action ' + name + ' could not run: ' + run.error);
  if (run.code !== 0) return fail(500, 'action ' + name + ' exited ' + (run.code === null ? 'on ' + run.signal : run.code));
  let out;
  try { out = JSON.parse(run.stdout); } catch (e) { out = null; }
  if (!out || typeof out !== 'object' || Array.isArray(out) || typeof out.ok !== 'boolean') {
    return fail(502, 'action ' + name + ' did not print {"ok": true|false, ...} on stdout');
  }
  const msg = typeof out.message === 'string' ? out.message : undefined;
  if (!out.ok) return { status: 422, body: { ok: false, error: msg || 'action ' + name + ' refused', message: msg } };
  return { status: 200, body: { ok: true, result: out.result === undefined ? null : out.result, message: msg } };
}

// Append one record to the lieutenant's action log. Best effort: a log that
// cannot be written never fails the action that already happened.
function logAction(ltDir, rec) {
  try {
    fs.mkdirSync(path.dirname(logFile(ltDir)), { recursive: true });
    fs.appendFileSync(logFile(ltDir), JSON.stringify(rec) + '\n');
  } catch (e) {}
}

// One action at a time per lieutenant: two clicks that both read-modify-write
// the same JSON file must not interleave.
const chains = new Map();
function serialized(key, fn) {
  const prev = chains.get(key) || Promise.resolve();
  const next = prev.then(fn, fn);
  const tail = next.catch(() => {});
  chains.set(key, tail);
  tail.then(() => { if (chains.get(key) === tail) chains.delete(key); });
  return next;
}

// Where the comment overlay goes in a served HTML page: before the last
// </body>, else before </html>, else at the end. The file on disk is untouched.
const OVERLAY_TAG = '<script type="module" src="/lt/_sdk/comment.js"></script>';
function injectOverlay(html) {
  const s = String(html);
  for (const re of [/<\/body\s*>/gi, /<\/html\s*>/gi]) {
    let m, last = -1;
    while ((m = re.exec(s))) last = m.index;
    if (last >= 0) return s.slice(0, last) + OVERLAY_TAG + s.slice(last);
  }
  return s + OVERLAY_TAG;
}

// The text a page comment reaches the lieutenant as: where, what, and his words.
function commentText(pagePath, quote, comment) {
  const q = String(quote || '').trim().split('\n').map((l) => '> ' + l).join('\n');
  return '💬 comment on your page ' + pagePath + '\n' + (q ? q + '\n\n' : '\n') + String(comment).trim();
}

module.exports = {
  ACTION_NAME_RE, DEFAULT_TIMEOUT_MS, OVERLAY_TAG,
  actionsDir, logFile, actionFile, runAction, interpret, logAction, serialized, injectOverlay, commentText,
};
