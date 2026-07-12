'use strict';
// agent-status — session status (model, context usage, rate limits) read from
// the files the harnesses ALREADY write; no statusline dependency, nothing new
// is persisted. Backs the OPTIONAL `status`/`runCommand` capability verbs
// (port.js): claude-tmux reads the session transcript under ~/.claude/projects,
// codex-tmux reads the rollout log under ~/.codex/sessions. Everything here is
// best-effort by contract: a missing/unreadable/foreign-shaped file returns
// null, never a throw.
//
// Status shape (the port's `status(ref)` return value):
//   { model, contextUsed, contextWindow, rateLimits? }
//   rateLimits (codex only — claude does not persist them): { primary?,
//   secondary? } each { usedPercent, windowMinutes, resetsAt (epoch secs) }.
//
// Files can grow to tens of MB, so reads are TAIL reads (last N bytes, from
// the end); the interesting lines — claude's last assistant message, codex's
// last token_count event — always sit near the bottom. claude alone gets one
// escalation step: a huge tool-result line can push the last assistant line
// past a small tail window.

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const TAIL_BYTES = 256 * 1024;

// tailRead — the last maxBytes of a file, decoded; null when missing/unreadable.
// When the file is smaller than maxBytes the whole file comes back.
function tailRead(file, maxBytes) {
  let fd;
  try {
    fd = fs.openSync(file, 'r');
  } catch {
    return null;
  }
  try {
    const size = fs.fstatSync(fd).size;
    const want = Math.min(size, maxBytes);
    const buf = Buffer.alloc(want);
    fs.readSync(fd, buf, 0, want, size - want);
    return buf.toString('utf8');
  } catch {
    return null;
  } finally {
    fs.closeSync(fd);
  }
}

// ---------- claude ----------
// Transcript path: ~/.claude/projects/<slug(cwd)>/<sessionId>.jsonl — the slug
// replaces every non-alphanumeric cwd character with '-' (verified against
// real transcript dirs: /home/ai/.treehouse/x → -home-ai--treehouse-x).
function claudeProjectSlug(cwd) {
  return String(cwd).replace(/[^A-Za-z0-9]/g, '-');
}

// Context window per model — matched by substring so versioned ids
// (claude-fable-5, claude-opus-4-8, …) hit without an exhaustive list.
// Extend by adding a pair; unknown models get the conservative default.
const CLAUDE_CONTEXT_WINDOWS = [
  ['fable', 1000000],
  ['opus', 200000],
  ['sonnet', 200000],
  ['haiku', 200000],
];
const CLAUDE_DEFAULT_WINDOW = 200000;
function claudeContextWindow(model) {
  const m = String(model || '').toLowerCase();
  for (const [needle, window] of CLAUDE_CONTEXT_WINDOWS) {
    if (m.includes(needle)) return window;
  }
  return CLAUDE_DEFAULT_WINDOW;
}

// claudeStatus(ref, opts?) -> status | null
// The last assistant line's message.usage is the current context truth:
// contextUsed = input + cache_read + cache_creation + output (what the next
// turn starts from). No rate limits — claude does not persist them, so the
// field is omitted rather than faked.
function claudeStatus(ref, opts = {}) {
  if (!ref || !ref.cwd || !ref.resumeId) return null;
  const projectsDir = opts.projectsDir || process.env.BC_CLAUDE_PROJECTS_DIR
    || path.join(os.homedir(), '.claude', 'projects');
  const file = path.join(projectsDir, claudeProjectSlug(ref.cwd), ref.resumeId + '.jsonl');
  let size = 0;
  try {
    size = fs.statSync(file).size;
  } catch {
    return null;
  }
  // One escalation: 256KB tail first, 4MB if no assistant line surfaced.
  for (const maxBytes of [TAIL_BYTES, 16 * TAIL_BYTES]) {
    const text = tailRead(file, maxBytes);
    if (text === null) return null;
    const lines = text.split('\n');
    for (let i = lines.length - 1; i >= 0; i--) {
      if (!lines[i].includes('"type":"assistant"')) continue;
      let doc;
      try {
        doc = JSON.parse(lines[i]);
      } catch {
        continue; // the tail window's first line may be cut mid-JSON
      }
      const msg = doc && doc.type === 'assistant' && doc.message;
      const u = msg && msg.usage;
      if (!u || typeof u !== 'object') continue;
      const used = (u.input_tokens || 0) + (u.cache_read_input_tokens || 0)
        + (u.cache_creation_input_tokens || 0) + (u.output_tokens || 0);
      return {
        model: msg.model || null,
        contextUsed: used,
        contextWindow: claudeContextWindow(msg.model),
      };
    }
    if (size <= maxBytes) break; // whole file scanned — a bigger tail finds nothing new
  }
  return null;
}

// ---------- codex ----------
// Rollout path: ~/.codex/sessions/YYYY/MM/DD/rollout-<ts>-<threadId>.jsonl
// (threadId = ref.resumeId). The date dirs are walked newest-first and the
// first match wins, so a thread resumed on a later day resolves to its newest
// rollout file.
function codexRolloutFile(threadId, sessionsDir) {
  const suffix = '-' + threadId + '.jsonl';
  const listDesc = (dir) => {
    try {
      return fs.readdirSync(dir).sort().reverse();
    } catch {
      return [];
    }
  };
  for (const year of listDesc(sessionsDir)) {
    for (const month of listDesc(path.join(sessionsDir, year))) {
      for (const day of listDesc(path.join(sessionsDir, year, month))) {
        const dir = path.join(sessionsDir, year, month, day);
        const hit = listDesc(dir).find((f) => f.startsWith('rollout-') && f.endsWith(suffix));
        if (hit) return path.join(dir, hit);
      }
    }
  }
  return null;
}

function codexRateLimits(rl) {
  if (!rl || typeof rl !== 'object') return null;
  const pick = (w) => (w && typeof w === 'object' ? {
    usedPercent: w.used_percent,
    windowMinutes: w.window_minutes,
    resetsAt: w.resets_at,
  } : undefined);
  const out = {};
  if (pick(rl.primary)) out.primary = pick(rl.primary);
  if (pick(rl.secondary)) out.secondary = pick(rl.secondary);
  return Object.keys(out).length ? out : null;
}

// codexStatus(ref, opts?) -> status | null
// The last token_count event carries current context occupancy
// (info.last_token_usage.total_tokens = input+cached+output of the last turn)
// and the model context window; the model rides every turn_context line, so the
// tail always has a fresh one. rate_limits come from the same token_count.
// NOTE: info.total_token_usage is the CUMULATIVE session total (grows forever,
// exceeds the window) — it is NOT occupancy. Selecting on last_token_usage is
// deliberate: rollouts where info is populated always carry it (verified on
// real rollouts), and the only ones missing it have info === null, which the
// null-guards below already reject — so no total_token_usage fallback is needed.
function codexStatus(ref, opts = {}) {
  if (!ref || !ref.resumeId) return null;
  const sessionsDir = opts.sessionsDir || process.env.BC_CODEX_SESSIONS_DIR
    || path.join(os.homedir(), '.codex', 'sessions');
  const file = codexRolloutFile(ref.resumeId, sessionsDir);
  if (!file) return null;
  const text = tailRead(file, TAIL_BYTES);
  if (text === null) return null;
  const lines = text.split('\n');
  let usage = null;
  let model = null;
  for (let i = lines.length - 1; i >= 0 && !(usage && model); i--) {
    const line = lines[i];
    let doc = null;
    if (!usage && line.includes('"token_count"')) {
      try { doc = JSON.parse(line); } catch { continue; }
      const p = doc && doc.payload;
      if (p && p.type === 'token_count' && p.info && p.info.last_token_usage) usage = p;
    } else if (!model && line.includes('"turn_context"')) {
      try { doc = JSON.parse(line); } catch { continue; }
      const p = doc && doc.payload;
      if (doc.type === 'turn_context' && p && p.model) model = String(p.model);
    }
  }
  if (!usage) return null;
  const out = {
    model,
    contextUsed: usage.info.last_token_usage.total_tokens || 0,
    contextWindow: usage.info.model_context_window || null,
  };
  const rl = codexRateLimits(usage.rate_limits);
  if (rl) out.rateLimits = rl;
  return out;
}

// ---------- shared slash-command surface ----------
// The commands every status-capable harness answers; runCommand semantics:
// /status formats status(), /compact rides the verified-submit send path
// (the harness's OWN /compact runs in-session), /help renders this list.
const SLASH_COMMANDS = [
  { name: '/status', description: 'model, context usage and rate limits' },
  { name: '/compact', description: 'compact the conversation to free context' },
  { name: '/help', description: 'list the available commands' },
];

// Replies render as markdown in the chat thread, where a single newline
// collapses — blank-line separators keep each line its own paragraph.
function helpText(cmds) {
  return cmds.map((c) => c.name + ' — ' + c.description).join('\n\n');
}

function fmtInt(n) {
  return Number.isFinite(n) ? Math.round(n).toLocaleString('en-US') : '?';
}

function fmtWindowLabel(minutes) {
  if (!Number.isFinite(minutes)) return 'rate';
  if (minutes % 10080 === 0) return (minutes / 10080) + 'w';
  if (minutes % 1440 === 0) return (minutes / 1440) + 'd';
  if (minutes % 60 === 0) return (minutes / 60) + 'h';
  return minutes + 'min';
}

// formatStatus(status) -> the human /status reply.
function formatStatus(st) {
  const lines = ['model: ' + (st.model || 'unknown')];
  if (Number.isFinite(st.contextUsed) && st.contextWindow > 0) {
    const pct = Math.round((st.contextUsed / st.contextWindow) * 100);
    lines.push('context: ' + fmtInt(st.contextUsed) + ' / ' + fmtInt(st.contextWindow)
      + ' tokens (' + pct + '%)');
  } else if (Number.isFinite(st.contextUsed)) {
    lines.push('context: ' + fmtInt(st.contextUsed) + ' tokens');
  }
  const rl = st.rateLimits || {};
  for (const key of ['primary', 'secondary']) {
    const w = rl[key];
    if (!w) continue;
    let line = fmtWindowLabel(w.windowMinutes) + ' limit: ' + (Number.isFinite(w.usedPercent) ? Math.round(w.usedPercent) : '?') + '% used';
    if (Number.isFinite(w.resetsAt)) {
      line += ' (resets ' + new Date(w.resetsAt * 1000).toISOString().replace('T', ' ').slice(0, 16) + ' UTC)';
    }
    lines.push(line);
  }
  return lines.join('\n\n');
}

module.exports = {
  tailRead,
  claudeProjectSlug,
  claudeContextWindow,
  claudeStatus,
  codexRolloutFile,
  codexStatus,
  SLASH_COMMANDS,
  helpText,
  formatStatus,
};
