'use strict';
// playbooks — the repeatable procedures a card is run by, and the briefs they
// render into. A playbook is a markdown template the USER owns; this file only
// finds it and renders it against the card. What comes out is the BRIEF: the
// task handed to the worker at card.start (docs/api/overview.md).
//
// Playbooks live in `<workspace>/.bridge-commander/playbooks/`, one markdown
// file per playbook, and the file name is the id. A card carries `playbook` =
// that id — a pointer, never text — so the playbook is resolved and rendered at
// card.start and only there: title, body, thread and attributes all keep
// changing until then, and the worker must read the latest.
//
// The packaged set (this repo's `playbooks/`) seeds a fresh workspace and is
// the fallback: a workspace file of the same name always wins, so an upgrade
// never overwrites an edit and a workspace that predates a new packaged
// playbook still gets it.
const fs = require('fs');
const path = require('path');

const PACKAGED_PLAYBOOKS_DIR = path.join(__dirname, '..', 'playbooks');
// README.md documents the folder for whoever is editing it — it is not a
// playbook, so it never lists and never resolves as an id.
const NOT_A_PLAYBOOK = /^readme$/i;
const ID_RE = /^[\w][\w.-]*$/;

// playbooksDir(stateDir) — the workspace's own playbooks, the ones the user edits.
function playbooksDir(stateDir) { return path.join(stateDir, 'playbooks'); }

function idsIn(dir) {
  let names;
  try { names = fs.readdirSync(dir); } catch (e) { return []; } // absent dir = no playbooks, not an error
  return names.filter((n) => n.endsWith('.md'))
    .map((n) => n.slice(0, -3))
    .filter((id) => ID_RE.test(id) && !NOT_A_PLAYBOOK.test(id));
}

// listPlaybooks(stateDir) -> sorted ids: the workspace's playbooks ∪ the packaged
// ones. What the dropdown shows and what an error names.
function listPlaybooks(stateDir) {
  const ids = new Set(idsIn(playbooksDir(stateDir)));
  for (const id of idsIn(PACKAGED_PLAYBOOKS_DIR)) ids.add(id);
  return [...ids].sort();
}

// resolvePlaybook(stateDir, id) -> the file that wins for that id, or '' when the
// id names no playbook. Workspace first — an edit always beats the package.
function resolvePlaybook(stateDir, id) {
  const s = String(id || '').trim();
  if (!ID_RE.test(s) || NOT_A_PLAYBOOK.test(s)) return '';
  for (const dir of [playbooksDir(stateDir), PACKAGED_PLAYBOOKS_DIR]) {
    const f = path.join(dir, s + '.md');
    if (fs.existsSync(f)) return f;
  }
  return '';
}

// ---------- frontmatter ----------
//
// A playbook MAY open with a fenced header block naming how the card runs:
//
//   ---
//   harness: codex
//   model: gpt-5.6-sol
//   requires: [pr_url, pr_number]
//   branch: false
//   keep_worktree: true
//   teardown: .claude/skills/devcontainer/cli.sh down
//   ---
//
// A playbook includes what runs it, and prose in the brief cannot act — the
// worker reads "start this on codex" only once it is already on claude.
// Six keys, all optional, no playbook without the block behaving any
// differently. The parser is hand-written and covers only what those
// six keys need — a general markup language is exactly what this must not
// grow into — and anything else in the block is an error naming its line,
// because a guess here silently starts the wrong worker.
const FM_KEYS = ['harness', 'model', 'requires', 'branch', 'keep_worktree', 'teardown'];
const FM_NAME_RE = /^[\w][\w.-]*$/;

function unquote(s) {
  const m = /^(['"])([\s\S]*)\1$/.exec(s);
  return m ? m[2] : s;
}

// One `key: value` right-hand side -> boolean | string | string[].
function fmValue(raw, at) {
  if (raw === 'true') return true;
  if (raw === 'false') return false;
  const list = /^\[(.*)\]$/.exec(raw);
  if (list) {
    const items = list[1].trim() ? list[1].split(',').map((s) => unquote(s.trim())) : [];
    if (items.some((s) => !s)) throw new Error(at + 'empty item in the list: ' + raw);
    return items;
  }
  if (/^\[/.test(raw)) throw new Error(at + 'unclosed list — write it as [a, b, c]: ' + raw);
  if (/^\{/.test(raw)) {
    throw new Error(at + 'a map is not supported here — this block takes a name, true/false, '
      + 'or a [a, b, c] list: ' + raw);
  }
  return unquote(raw);
}

const FM_FLAGS = ['branch', 'keep_worktree'];

function fmCheck(key, val, at) {
  if (FM_FLAGS.includes(key)) {
    if (typeof val !== 'boolean') throw new Error(at + key + ' takes true or false, got: ' + JSON.stringify(val));
    return val;
  }
  if (key === 'requires') {
    const names = Array.isArray(val) ? val : [val]; // a lone name is a one-item list
    for (const n of names) {
      if (typeof n !== 'string' || !FM_NAME_RE.test(n)) {
        throw new Error(at + 'requires takes attribute names, e.g. [pr_url, repo_slug] — got: ' + JSON.stringify(n));
      }
    }
    return names;
  }
  // teardown: a command line, not a name — spaces, slashes and flags are the
  // point of it, so the only thing to check is that there is a command there.
  if (key === 'teardown') {
    if (typeof val !== 'string' || !val.trim()) {
      throw new Error(at + 'teardown takes a shell command, e.g. '
        + '.claude/skills/devcontainer/cli.sh down — got: ' + JSON.stringify(val));
    }
    return val.trim();
  }
  // harness, model: a bare name
  if (typeof val !== 'string' || !val.trim()) {
    throw new Error(at + key + ' takes a name, got: ' + JSON.stringify(val));
  }
  return val.trim();
}

// parsePlaybook(text) -> { meta, body }. No opening `---` line = no frontmatter:
// meta is empty and the body is the text untouched, which is every playbook
// that predates this. A block that opens and never closes, or holds anything
// but the six keys, THROWS with the offending line named.
//
// A first line of `---` is genuinely ambiguous — an opening delimiter to us, a
// horizontal rule to a playbook written before this existed — so when the
// block fails, the error names the way out of the ambiguity too, not just the
// line that broke.
const RULE_HINT = ' If that first `---` was meant as a horizontal rule, put a heading or a '
  + 'blank line above it and the file reads as a plain playbook again.';

function parsePlaybook(text) {
  const src = String(text == null ? '' : text);
  const lines = src.split('\n');
  if (lines[0].trim() !== '---') return { meta: {}, body: src };
  const meta = {};
  for (let i = 1; i < lines.length; i++) {
    const line = lines[i];
    if (line.trim() === '---') return { meta, body: lines.slice(i + 1).join('\n').replace(/^\n+/, '') };
    if (!line.trim()) continue;
    const at = 'frontmatter line ' + (i + 1) + ': ';
    const m = /^([A-Za-z][\w-]*):[ \t]*(.*)$/.exec(line);
    if (!m) {
      throw new Error(at + 'expected `key: value`, got: ' + line.trim()
        + ' (the block runs to the next `---` line — is that one missing?)' + RULE_HINT);
    }
    const key = m[1];
    if (!FM_KEYS.includes(key)) {
      throw new Error(at + 'unknown key "' + key + '" — the block takes ' + FM_KEYS.join(', ')
        + ' and nothing else (prose belongs in the playbook body, below the ---)');
    }
    if (key in meta) throw new Error(at + '"' + key + '" is set twice');
    const raw = m[2].trim();
    if (!raw) throw new Error(at + '"' + key + '" has no value');
    meta[key] = fmCheck(key, fmValue(raw, at), at);
  }
  throw new Error('frontmatter opened on line 1 and is never closed — end the block with a `---` line.'
    + RULE_HINT);
}

// The captain ↔ lieutenant card thread as one block, or '' — playbooks drop
// {{THREAD}} on its own line, so it carries its own heading or nothing at all.
function threadBlock(thread) {
  const msgs = (thread || []).filter((m) => m && String(m.text || '').trim());
  if (!msgs.length) return '';
  return '## Card thread (captain ↔ lieutenant context)\n\n'
    + msgs.map((m) => '- ' + (m.author || 'user') + ': '
      + String(m.text).trim().replace(/\n/g, '\n  ')).join('\n');
}

// attrVar(name) -> the placeholder a card attribute is reachable by. ONE
// definition with two callers — the table below and the `requires` check at
// card.start — so the name a playbook asks for and the name it can actually
// read can never drift: pr_url, PR_URL and pr-url are the same attribute.
function attrVar(name) {
  return 'ATTR_' + String(name).toUpperCase().replace(/[^A-Z0-9_]/g, '_');
}

// attrCardKey(name) -> the same name in the form a CARD carries it. What an
// error must print: telling someone to set PR_URL earns them a second
// attribute that resolves to the very placeholder the first one already owns.
function attrCardKey(name) {
  return attrVar(name).slice('ATTR_'.length).toLowerCase();
}

// briefVars(b) -> the placeholder table. b: { card, task?, thread, project,
// worktree, branch, workspace, stateDir, cli }
function briefVars(b) {
  const card = b.card || {};
  const project = b.project || {};
  const vars = {
    CARD_ID: card.id || '',
    CARD_TITLE: card.title || '',
    TASK: String(b.task || card.body || '').trim() || String(card.title || ''),
    THREAD: threadBlock(b.thread),
    PROJECT: project.name || '',
    PROJECT_PATH: project.path || '',
    WORKTREE: b.worktree || '',
    BRANCH: b.branch || '',
    WORKSPACE: b.workspace || '',
    // The invocation carries --workspace, so a template can paste it in front
    // of any verb: bc-axi parses global flags in any position.
    CLI: b.cli + ' --workspace ' + b.workspace,
    REPORT_FILE: path.join(b.stateDir || path.join(b.workspace || '', '.bridge-commander'),
      'reports', (card.id || '') + '.md'),
  };
  // {{ATTR_<NAME>}} — card attributes, uppercased. Structured ones (artifacts,
  // prs) have no text form and are left out, so they stay literal like any
  // other name that is not an attribute.
  for (const [k, v] of Object.entries(card.attributes || {})) {
    if (v === null || typeof v === 'object') continue;
    const key = attrVar(k);
    if (!(key in vars)) vars[key] = String(v);
  }
  return vars;
}

// ---------- the reference the config screen shows ----------
//
// Editing a playbook takes two vocabularies — the placeholders briefVars()
// fills and the keys FM_KEYS accepts — and neither is readable from the UI.
// They live HERE, beside the code that implements them, and go out on
// GET /api/playbooks. A test pins PLACEHOLDERS to briefVars()'s own keys and
// FRONTMATTER to FM_KEYS, so adding either without a line here goes red.
const PLACEHOLDERS = [
  { name: 'CARD_ID', desc: "the card's id, e.g. MNC-42" },
  { name: 'CARD_TITLE', desc: "the card's title" },
  { name: 'TASK', desc: 'the card body; the title when the body is empty' },
  { name: 'THREAD', desc: "the card's conversation so far, quoted; empty when there is none" },
  { name: 'PROJECT', desc: "the registered project named by the card's repo attribute" },
  { name: 'PROJECT_PATH', desc: "the project clone. Not the worker's to touch" },
  { name: 'WORKTREE', desc: "the worker's own checkout, made at start" },
  { name: 'BRANCH', desc: "the branch this card's work belongs on" },
  { name: 'WORKSPACE', desc: "this workspace's root" },
  { name: 'CLI', desc: 'the full bc-axi --workspace <dir> invocation, to paste in front of any verb' },
  { name: 'REPORT_FILE', desc: 'where a durable report goes: <state dir>/reports/<CARD_ID>.md' },
  { name: 'ATTR_<NAME>', desc: 'any card attribute, uppercased: --attr repo=x fills {{ATTR_REPO}}. '
    + 'Structured attributes (artifacts, prs) have no text form and stay literal' },
];

const FRONTMATTER = [
  { key: 'harness', desc: "which agent runs the card (claude, codex); the workspace's own by default" },
  { key: 'model', desc: 'the model that harness starts on' },
  { key: 'requires', desc: 'attributes a card must carry, [a, b]. A card missing one is refused '
    + 'before any worktree exists' },
  { key: 'branch', desc: 'false for a playbook that ships no code: no branch, no PR' },
  { key: 'keep_worktree', desc: "true keeps the worker's checkout after the card leaves Working" },
  { key: 'teardown', desc: 'a shell command run in the worktree just before it is released, to stop '
    + 'what the run started (a devcontainer, a compose stack). Best effort: a failure is an event '
    + 'on the card and the release goes ahead' },
];

// render(template, vars) — {{NAME}} → its value. An unknown name is left
// EXACTLY as written: a typo has to be visible in the brief, never silently
// empty.
function render(template, vars) {
  return String(template).replace(/\{\{([A-Za-z][A-Za-z0-9_]*)\}\}/g,
    (m, k) => (Object.prototype.hasOwnProperty.call(vars, k) ? vars[k] : m));
}

// workerBrief(b) -> the rendered brief. `b.template` is the playbook body;
// callers that have a card id use resolvePlaybook() to find it first.
function workerBrief(b) {
  return render(b.template, briefVars(b));
}

// seedPlaybooksAndDuties(stateDir, home) — the two halves of "how we ask for work",
// installed together at workspace.init because they are one thing split by
// ownership:
//
//   playbooks/  COPIES of the packaged playbooks, and only the ones missing.
//               They are the USER's to edit, so an upgrade must never
//               overwrite one.
//   skill       a SYMLINK to the packaged bridge-commander-worker skill. The
//               duties are OURS, so upgrading bridge-commander upgrades them
//               with no copy going stale in someone's skills dir.
//
// Returns what it did, for init to print. Never throws: a workspace whose
// playbooks/ is unwritable still runs off the packaged playbooks, and a skills dir
// we may not write is the user's business, not a reason to fail init.
const PACKAGED_SKILL_DIR = path.join(__dirname, '..', 'skills', 'bridge-commander-worker');

function seedPlaybooksAndDuties(stateDir, home) {
  const out = { playbooks: [], skill: '' };
  const dst = playbooksDir(stateDir);
  try {
    fs.mkdirSync(dst, { recursive: true });
    for (const f of fs.readdirSync(PACKAGED_PLAYBOOKS_DIR)) {
      if (!f.endsWith('.md') || fs.existsSync(path.join(dst, f))) continue;
      fs.copyFileSync(path.join(PACKAGED_PLAYBOOKS_DIR, f), path.join(dst, f));
      out.playbooks.push(f);
    }
  } catch (e) { /* unwritable playbooks dir — the packaged playbooks still resolve */ }

  const skillDst = path.join(home || require('os').homedir(), '.claude', 'skills', 'bridge-commander-worker');
  try {
    fs.mkdirSync(path.dirname(skillDst), { recursive: true });
    let cur = null;
    try { cur = fs.lstatSync(skillDst); } catch (e) { cur = null; }
    if (cur && cur.isSymbolicLink()) {
      if (fs.readlinkSync(skillDst) === PACKAGED_SKILL_DIR) return out; // already ours, pointing right
      fs.unlinkSync(skillDst); // a link left by an older checkout is ours to repoint
    } else if (cur) {
      return out; // a real directory someone installed by hand — leave it alone
    }
    fs.symlinkSync(PACKAGED_SKILL_DIR, skillDst, 'dir');
    out.skill = skillDst;
  } catch (e) { /* no skills dir we may write — the playbook says to load it, the user installs it */ }
  return out;
}

module.exports = {
  PACKAGED_PLAYBOOKS_DIR, PACKAGED_SKILL_DIR, playbooksDir, listPlaybooks, resolvePlaybook,
  parsePlaybook, attrVar, attrCardKey, briefVars, render, workerBrief, seedPlaybooksAndDuties,
  FM_KEYS, PLACEHOLDERS, FRONTMATTER,
};
