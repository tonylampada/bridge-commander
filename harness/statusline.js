#!/usr/bin/env node
'use strict';
// statusline.js — the BC-owned Claude Code `statusLine` command. Two jobs on
// every invocation, both best-effort (a statusLine command must never fail):
//
//  1. Sidecar. Tee the stdin payload to a per-session file keyed by session_id:
//     <workspace>/.bridge-commander/statusline/<session_id>.json (atomic
//     tmp+rename, received-at stamped). This is the ONLY place the Claude Code
//     binary exports the REAL context window (context_window.context_window_size,
//     total_input_tokens, used_percentage) and the account rate_limits — the
//     transcript jsonl carries none of it. The board's status reader
//     (agent-status.js) prefers this sidecar over its hardcoded model→window map.
//     Workspace = nearest ancestor of payload.cwd holding a .bridge-commander/;
//     none found → write nothing, still render.
//
//  2. Render. Reproduce the captain's reference statusline: model (cyan), a
//     20-char block bar colored green / yellow≥60 / red≥80, used%, `118k/1000k`
//     tokens, then `5h X% (ETA)` and `7d X% (ETA)` from rate_limits with a
//     compact ETA (2d4h / 3h12m / 45m). Zero deps — no jq, no awk.
//
// Usage (as a statusLine command): node statusline.js   (payload JSON on stdin)

const fs = require('node:fs');
const path = require('node:path');

const STATE_DIR_NAME = '.bridge-commander';

const C = {
  reset: '\x1b[0m',
  green: '\x1b[32m',
  yellow: '\x1b[33m',
  red: '\x1b[31m',
  cyan: '\x1b[36m',
  dim: '\x1b[2m',
};

// findWorkspace — nearest ancestor of startDir that contains a .bridge-commander/
// directory; null when none is found (or startDir is empty).
function findWorkspace(startDir) {
  if (!startDir) return null;
  let dir = path.resolve(startDir);
  for (;;) {
    try {
      if (fs.statSync(path.join(dir, STATE_DIR_NAME)).isDirectory()) return dir;
    } catch { /* not here — keep walking up */ }
    const parent = path.dirname(dir);
    if (parent === dir) return null;
    dir = parent;
  }
}

// writeSidecar — atomically tee the payload to its per-session sidecar. Returns
// the file path written, or null when there is no session_id, no workspace, or
// any write error (best-effort: never throws). opts.workspace / opts.sidecarDir
// / opts.now / opts.pid are test seams.
function writeSidecar(payload, opts = {}) {
  const sid = payload && payload.session_id;
  if (!sid || typeof sid !== 'string') return null;
  const ws = opts.workspace || findWorkspace(payload && payload.cwd);
  if (!ws) return null;
  const dir = opts.sidecarDir || path.join(ws, STATE_DIR_NAME, 'statusline');
  const file = path.join(dir, sid + '.json');
  const doc = { receivedAt: opts.now || new Date().toISOString(), payload };
  try {
    fs.mkdirSync(dir, { recursive: true });
    const tmp = file + '.' + (opts.pid || process.pid) + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify(doc));
    fs.renameSync(tmp, file);
    return file;
  } catch {
    return null;
  }
}

// ---------- render helpers ----------

// bar — a 20-char block progress bar for a used-percentage (0..100).
function bar(pct) {
  let filled = Math.floor((Number(pct) || 0) / 5);
  if (filled > 20) filled = 20;
  if (filled < 0) filled = 0;
  return '█'.repeat(filled) + '░'.repeat(20 - filled);
}

// pctColor — green <60, yellow 60..79, red ≥80 (matches the reference thresholds).
function pctColor(pct) {
  const p = Number(pct) || 0;
  if (p >= 80) return C.red;
  if (p >= 60) return C.yellow;
  return C.green;
}

// fmtK — token count as a rounded `k` string (118213 → "118k", 1000000 → "1000k").
function fmtK(n) {
  return Math.round((Number(n) || 0) / 1000) + 'k';
}

// toEpochSecs — coerce a rate-limit resets_at (epoch seconds, epoch millis, a
// numeric string, or an ISO timestamp) to epoch SECONDS; null when unparseable.
function toEpochSecs(v) {
  if (v == null) return null;
  if (typeof v === 'number' && Number.isFinite(v)) {
    return v > 1e11 ? Math.floor(v / 1000) : Math.floor(v);
  }
  if (typeof v === 'string' && v.trim() !== '') {
    const n = Number(v);
    if (Number.isFinite(n)) return n > 1e11 ? Math.floor(n / 1000) : Math.floor(n);
    const p = Date.parse(v);
    if (!Number.isNaN(p)) return Math.floor(p / 1000);
  }
  return null;
}

// fmtEta — seconds until resetsAt in compact form: 2d4h / 3h12m / 45m. Empty
// string when resetsAt is unparseable. `now` is epoch millis.
function fmtEta(resetsAt, now) {
  const target = toEpochSecs(resetsAt);
  if (target === null) return '';
  let s = target - Math.floor(now / 1000);
  if (s < 0) s = 0;
  const d = Math.floor(s / 86400);
  const h = Math.floor((s % 86400) / 3600);
  const m = Math.floor((s % 3600) / 60);
  if (d > 0) return d + 'd' + h + 'h';
  if (h > 0) return h + 'h' + m + 'm';
  return m + 'm';
}

// rlSegment — one ` | 5h X% (ETA)` rate-limit chunk; empty when the window has
// no used_percentage.
function rlSegment(label, w, now) {
  if (!w || w.used_percentage == null || w.used_percentage === '') return '';
  const pct = Number(w.used_percentage);
  const c = pctColor(pct);
  const e = fmtEta(w.resets_at, now);
  const eta = e ? ` ${C.dim}(${e})${C.reset}` : '';
  return ` ${C.dim}|${C.reset} ${C.dim}${label}${C.reset} ${c}${pct.toFixed(0)}%${C.reset}${eta}`;
}

// render — the full statusline string for a payload. `now` (epoch millis)
// defaults to the wall clock; passed explicitly by tests for a stable ETA.
function render(payload, now) {
  const nowMs = now || Date.now();
  const p = payload || {};
  const model = (p.model && (p.model.display_name || p.model.id)) || 'Unknown';
  const cw = p.context_window || {};
  const usedPct = cw.used_percentage;
  let out;
  if (usedPct != null && usedPct !== '') {
    const pct = Number(usedPct);
    const color = pctColor(pct);
    out = `${C.cyan}${model}${C.reset} ${C.dim}|${C.reset} ${color}${bar(pct)} ${pct.toFixed(0)}%${C.reset}`
      + ` ${C.dim}|${C.reset} ${fmtK(cw.total_input_tokens)}/${fmtK(cw.context_window_size)}`;
  } else {
    out = `${C.cyan}${model}${C.reset}`;
  }
  const rl = p.rate_limits || {};
  out += rlSegment('5h', rl.five_hour, nowMs);
  out += rlSegment('7d', rl.seven_day, nowMs);
  return out;
}

// readStdinSync — the piped payload; '' on any error (statusLine stdin is always
// a pipe, never a TTY, so a synchronous fd-0 read is safe and prompt).
function readStdinSync() {
  try {
    return fs.readFileSync(0, 'utf8');
  } catch {
    return '';
  }
}

function main() {
  let payload = null;
  try {
    payload = JSON.parse(readStdinSync());
  } catch {
    payload = null;
  }
  if (payload) writeSidecar(payload);
  process.stdout.write(render(payload || {}));
}

if (require.main === module) main();

module.exports = {
  findWorkspace,
  writeSidecar,
  bar,
  pctColor,
  fmtK,
  toEpochSecs,
  fmtEta,
  render,
  STATE_DIR_NAME,
};
