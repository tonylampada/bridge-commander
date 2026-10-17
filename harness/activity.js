'use strict';
// activity — what an agent is doing RIGHT NOW, read from the transcript its
// harness already writes (claude: ~/.claude/projects/<slug>/<session>.jsonl).
// Zero tokens: nothing is asked of the agent, the file is only tail-read.
//
//   { running, since, tool: { kind, name, label } | null, ts }
//
// A turn starts at the last real prompt (a user line that is not a tool
// result) and ends at the `system/turn_duration` line claude writes when it
// stops. A tool_use with no tool_result after it is the tool in flight; none
// pending in a running turn means the model is thinking.
//
// The label is shown to the captain and may be on a shared screen: a command's
// obvious secrets are redacted (redact) before it leaves this module.

const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { tailRead, claudeProjectSlug } = require('./agent-status');

// ── secrets out ─────────────────────────────────────────────────────────────
const MASK = '•••';
const SECRET_NAME = '(?:[A-Za-z0-9_]*(?:TOKEN|SECRET|PASSWORD|PASSWD|PASS|PWD|API_?KEY|ACCESS_?KEY|PRIVATE_?KEY|AUTH|CREDENTIALS?|COOKIE|SESSION)[A-Za-z0-9_]*)';
const REDACTIONS = [
  // Authorization: Bearer xyz / -H "Authorization: token xyz"
  [/\b(authorization\s*:\s*(?:bearer|token|basic)?\s*)[^\s'"]+/gi, '$1' + MASK],
  [/\b(bearer\s+)[A-Za-z0-9._~+/=-]{8,}/gi, '$1' + MASK],
  // https://user:pass@host
  [/(\b[a-z][a-z0-9+.-]*:\/\/)[^\s/@:]+:[^\s/@]+@/gi, '$1' + MASK + '@'],
  // FOO_TOKEN=xyz, password: xyz, "apiKey": "xyz"
  [new RegExp('(\\b' + SECRET_NAME + '["\']?\\s*[=:]\\s*["\']?)[^\\s"\'&;]+', 'gi'), '$1' + MASK],
  // --token xyz / --password=xyz / --api-key xyz
  [/(--?(?:[a-z-]*(?:token|secret|password|passwd|api-?key|auth|key))(?:=|\s+))(?!-)[^\s"']+/gi, '$1' + MASK],
  // well-known token shapes, wherever they appear
  [/\b(?:sk|pk|rk)-(?:[A-Za-z0-9_-]+-)?[A-Za-z0-9_-]{16,}/g, MASK],
  [/\b(?:ghp|gho|ghs|ghu|ghr)_[A-Za-z0-9]{20,}|\bgithub_pat_[A-Za-z0-9_]{20,}/g, MASK],
  [/\bxox[abposr]-[A-Za-z0-9-]{10,}/g, MASK],
  [/\bglpat-[A-Za-z0-9_-]{16,}|\bhf_[A-Za-z0-9]{20,}|\bAIza[A-Za-z0-9_-]{30,}|\b(?:AKIA|ASIA)[A-Z0-9]{16}\b/g, MASK],
  [/\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}/g, MASK],                     // JWT
  // a long opaque run (40+ of base64/hex-ish, with digits AND letters): a key
  [/\b(?=[A-Za-z0-9+/_=-]{40,})(?=[^\s]*\d)(?=[^\s]*[A-Za-z])[A-Za-z0-9+/_=-]{40,}/g, MASK],
];
function redact(s) {
  let t = String(s == null ? '' : s);
  for (const [re, to] of REDACTIONS) t = t.replace(re, to);
  return t;
}

// ── a command, shortened to what it does ────────────────────────────────────
// "export PATH=…:/x/cli && cd /repo && /home/ai/bc/cli/bc-axi drain --workspace /w"
// is "bc-axi drain --workspace /w": the plumbing in front goes, a binary's path
// goes, a heredoc's body goes.
function shortCommand(cmd, max = 60) {
  let t = String(cmd || '').split('\n')[0].trim();
  for (let i = 0; i < 8; i++) {
    const before = t;
    t = t
      .replace(/^(?:export\s+)?[A-Za-z_][A-Za-z0-9_]*=(?:"[^"]*"|'[^']*'|\S*)\s*(?:&&|;)?\s*/, '')
      .replace(/^(?:cd|source|\.|set|ulimit)\s+(?:"[^"]*"|'[^']*'|[^\s;&]+)(?:\s+[^\s;&]+)*\s*(?:&&|;)\s*/, '')
      .trim();
    if (t === before) break;
  }
  t = t.replace(/^(?:sudo\s+)?(?:\S*\/)([^\s/]+)/, '$1');
  t = redact(t).replace(/\s+/g, ' ');
  return t.length > max ? t.slice(0, max - 1).trimEnd() + '…' : t;
}

function clip(s, max) {
  const t = redact(String(s || '').replace(/\s+/g, ' ').trim());
  return t.length > max ? t.slice(0, max - 1).trimEnd() + '…' : t;
}
function base(p) { return p ? path.basename(String(p)) : ''; }
function host(u) { try { return new URL(String(u)).host; } catch (e) { return ''; } }

// ── a tool call, named for a person ─────────────────────────────────────────
// kind drives the spoken status (callcore.spokenStatus); label is the line.
function toolLabel(name, input) {
  const i = input && typeof input === 'object' ? input : {};
  const n = String(name || '');
  if (n === 'Bash' || n === 'BashOutput' || n === 'PowerShell') {
    const c = shortCommand(i.command || i.description || '');
    // the board's own verbs read better as what they are
    if (/(?:^|[\s|;&])bc-axi\s+(?:say|line)\b/.test(String(i.command || ''))) return { kind: 'reply', label: '💬 writing the reply' };
    if (/^bc-axi\s+drain\b/.test(c)) return { kind: 'think', label: '📥 reading the queue' };
    return { kind: 'bash', label: '🔧 running' + (c ? ': ' + c : ' a command') };
  }
  if (n === 'Read' || n === 'NotebookRead') return { kind: 'read', label: '📖 reading ' + (base(i.file_path || i.notebook_path) || 'a file') };
  if (n === 'Edit' || n === 'MultiEdit' || n === 'NotebookEdit') return { kind: 'edit', label: '✏️ editing ' + (base(i.file_path || i.notebook_path) || 'a file') };
  if (n === 'Write') return { kind: 'edit', label: '📝 writing ' + (base(i.file_path) || 'a file') };
  if (n === 'Grep' || n === 'Glob' || n === 'LS') return { kind: 'search', label: '🔎 searching' + (i.pattern ? ' for ' + clip(i.pattern, 40) : ' the code') };
  if (n === 'Agent' || n === 'Task') return { kind: 'agent', label: '🤖 subagent working' + (i.description ? ': ' + clip(i.description, 50) : '') };
  if (n === 'WebSearch') return { kind: 'web', label: '🌐 searching the web' + (i.query ? ': ' + clip(i.query, 50) : '') };
  if (n === 'WebFetch') return { kind: 'web', label: '🌐 reading ' + (host(i.url) || 'a web page') };
  if (n === 'TodoWrite') return { kind: 'think', label: '📋 updating the plan' };
  if (n === 'Skill') return { kind: 'think', label: '📚 loading skill ' + clip(i.skill || i.name || '', 30) };
  if (n === 'ToolSearch') return { kind: 'think', label: '🔎 looking up tools' };
  const mcp = /^mcp__(.+?)__(.+)$/.exec(n);
  if (mcp) {
    const server = mcp[1].replace(/^claude_ai_/, '').replace(/_/g, ' ');
    return { kind: 'other', label: '🔌 ' + server + ': ' + mcp[2].replace(/_/g, ' ') };
  }
  return { kind: 'other', label: '⚙️ ' + (n || 'working') };
}

// ── the transcript, read backwards ──────────────────────────────────────────
function isPrompt(d) {
  if (!d || d.type !== 'user' || d.isMeta || d.isSidechain) return false;
  const c = d.message && d.message.content;
  if (typeof c === 'string') return c.trim() !== '';
  if (!Array.isArray(c)) return false;
  return !c.some((b) => b && b.type === 'tool_result') && c.some((b) => b && b.type === 'text');
}

// claudeActivityFromLines(lines) -> { running, since, tool } — `lines` is the
// tail, oldest first; the first may be cut mid-JSON and is skipped.
function claudeActivityFromLines(lines) {
  const done = new Set();          // tool_use ids with a result, seen from the end
  let pending = null;               // the newest tool_use without one
  let last = null;                  // timestamp of the newest line with one
  for (let i = lines.length - 1; i >= 0; i--) {
    const l = lines[i];
    if (!l || l[0] !== '{') continue;
    let d;
    try { d = JSON.parse(l); } catch (e) { continue; }
    if (!last && d.timestamp) last = d.timestamp;
    if (d.isSidechain) continue;
    if (d.type === 'system' && d.subtype === 'turn_duration') return { running: false, since: null, tool: null, last };
    const c = d.message && d.message.content;
    if (d.type === 'user' && Array.isArray(c)) for (const b of c) if (b && b.type === 'tool_result') done.add(b.tool_use_id);
    if (d.type === 'assistant' && Array.isArray(c) && !pending) {
      for (let k = c.length - 1; k >= 0; k--) {
        const b = c[k];
        if (b && b.type === 'tool_use' && !done.has(b.id)) { pending = Object.assign({ name: b.name }, toolLabel(b.name, b.input)); break; }
      }
    }
    if (isPrompt(d)) return { running: true, since: d.timestamp || null, tool: pending || { kind: 'think', name: '', label: '💭 thinking' }, last };
  }
  return null;   // neither end nor start in the window: unknown
}

// claudeActivity(ref, opts?) -> activity | null. Stat-gated: an unchanged
// file returns the cached reading without a read.
const cache = new Map();
function claudeActivity(ref, opts = {}) {
  if (!ref || !ref.cwd || !ref.resumeId) return null;
  const projectsDir = opts.projectsDir || process.env.BC_CLAUDE_PROJECTS_DIR || path.join(os.homedir(), '.claude', 'projects');
  const file = path.join(projectsDir, claudeProjectSlug(ref.cwd), ref.resumeId + '.jsonl');
  let st;
  try { st = fs.statSync(file); } catch (e) { return null; }
  const key = st.size + ':' + st.mtimeMs;
  const hit = cache.get(file);
  if (hit && hit.key === key) return hit.value;
  let value = null;
  for (const maxBytes of [128 * 1024, 2 * 1024 * 1024]) {
    const text = tailRead(file, maxBytes);
    if (text === null) return null;
    value = claudeActivityFromLines(text.split('\n'));
    if (value || st.size <= maxBytes) break;
  }
  if (value) value.mtime = st.mtimeMs;
  cache.set(file, { key, value });
  return value;
}

module.exports = { redact, shortCommand, toolLabel, claudeActivityFromLines, claudeActivity };
