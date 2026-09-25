'use strict';
// Board permission approvals — the server half. A PermissionRequest hook
// (harness/permission-hook.js) POSTs what Claude Code is about to ask, and
// its HTTP request IS the question: we hold the response open until the
// captain decides, the cap runs out, or the hook goes away. Nothing here is
// persisted — a held request cannot outlive the process that holds it.

// The launch modes config.json may name. Anything else reads as the default:
// a typo must not turn into a flag claude refuses to start on.
const PERMISSION_MODES = ['auto', 'default', 'acceptEdits', 'bypass'];
function permissionMode(v) { return PERMISSION_MODES.includes(v) ? v : 'auto'; }

// One line the captain can judge from: the field that carries the risk for
// the tools that have one, else the input itself, trimmed.
function summarize(tool, input) {
  const i = input && typeof input === 'object' ? input : {};
  const pick = (k) => (typeof i[k] === 'string' && i[k].trim() ? i[k].trim() : '');
  let s = '';
  if (tool === 'Bash') s = pick('command');
  else if (tool === 'Edit' || tool === 'Write' || tool === 'Read' || tool === 'MultiEdit' || tool === 'NotebookEdit') {
    s = pick('file_path') || pick('notebook_path');
  } else if (tool === 'WebFetch') s = pick('url');
  if (!s) { try { s = JSON.stringify(i); } catch (e) { s = ''; } }
  s = s.replace(/\s+/g, ' ');
  return s.length > 200 ? s.slice(0, 199) + '…' : s;
}

// createPermissions({ capMs, onChange }) -> { hold, decide, list, has }
//   hold(res, item)  keep `res` open under a fresh id; replies {decision:null}
//                    at capMs; drops the item if the client hangs up first.
//   decide(id, decision, message) -> the item, or null for an unknown id.
//   onChange(item, outcome) fires on every add and removal —
//   outcome: 'asked' | 'allow' | 'deny' | 'timeout' | 'gone'.
function createPermissions({ capMs, onChange }) {
  const pending = new Map(); // id -> { item, res, timer }
  let n = 0;

  function reply(res, obj) {
    if (res.writableEnded || res.destroyed) return;
    const body = JSON.stringify(obj);
    res.writeHead(200, { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) });
    res.end(body);
  }
  function settle(id, answer, outcome) {
    const p = pending.get(id);
    if (!p) return null;
    pending.delete(id);
    clearTimeout(p.timer);
    if (answer) reply(p.res, answer);
    onChange(p.item, outcome);
    return p.item;
  }

  function hold(res, fields) {
    const id = 'perm-' + Date.now().toString(36) + '-' + (++n);
    const item = Object.assign({ id }, fields);
    const timer = setTimeout(() => settle(id, { decision: null }, 'timeout'), capMs);
    pending.set(id, { item, res, timer });
    // 'close' before our reply = the hook was killed, Claude timed it out, or
    // the agent was interrupted: nobody is left to answer.
    res.on('close', () => settle(id, null, 'gone'));
    onChange(item, 'asked');
    return item;
  }
  function decide(id, decision, message) {
    const answer = { decision };
    if (message) answer.message = message;
    return settle(id, answer, decision);
  }
  function list() {
    return [...pending.values()].map((p) => p.item).sort((a, b) => (a.ts < b.ts ? -1 : a.ts > b.ts ? 1 : 0));
  }
  function has(pred) {
    for (const p of pending.values()) if (pred(p.item)) return true;
    return false;
  }
  return { hold, decide, list, has };
}

module.exports = { PERMISSION_MODES, permissionMode, summarize, createPermissions };
