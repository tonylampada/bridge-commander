'use strict';
// brief — the worker launch prompt. NOT assembled here: a brief is a markdown
// template the USER owns, and this file only finds it and renders it against
// the card (docs/api/overview.md: Brief = the task handed to the worker at
// card.start).
//
// Templates live in `<workspace>/.bridge-commander/briefs/`, one markdown file
// per template, and the file name is the id. A card carries `brief` = that id
// — a pointer, never text — so the template is resolved and rendered at
// card.start and only there: title, body, thread and attributes all keep
// changing until then, and the worker must read the latest.
//
// The packaged set (this repo's `briefs/`) seeds a fresh workspace and is the
// fallback: a workspace file of the same name always wins, so an upgrade never
// overwrites an edit and a workspace that predates a new packaged template
// still gets it.
const fs = require('fs');
const path = require('path');

const PACKAGED_BRIEFS_DIR = path.join(__dirname, '..', 'briefs');
// README.md documents the folder for whoever is editing it — it is not a
// flavour of SDLC, so it never lists and never resolves as an id.
const NOT_A_TEMPLATE = /^readme$/i;
const ID_RE = /^[\w][\w.-]*$/;

// briefsDir(stateDir) — the workspace's own templates, the ones the user edits.
function briefsDir(stateDir) { return path.join(stateDir, 'briefs'); }

function idsIn(dir) {
  let names;
  try { names = fs.readdirSync(dir); } catch (e) { return []; } // absent dir = no templates, not an error
  return names.filter((n) => n.endsWith('.md'))
    .map((n) => n.slice(0, -3))
    .filter((id) => ID_RE.test(id) && !NOT_A_TEMPLATE.test(id));
}

// listBriefs(stateDir) -> sorted ids: the workspace's templates ∪ the packaged
// ones. What the dropdown shows and what an error names.
function listBriefs(stateDir) {
  const ids = new Set(idsIn(briefsDir(stateDir)));
  for (const id of idsIn(PACKAGED_BRIEFS_DIR)) ids.add(id);
  return [...ids].sort();
}

// resolveBrief(stateDir, id) -> the file that wins for that id, or '' when the
// id names no template. Workspace first — an edit always beats the package.
function resolveBrief(stateDir, id) {
  const s = String(id || '').trim();
  if (!ID_RE.test(s) || NOT_A_TEMPLATE.test(s)) return '';
  for (const dir of [briefsDir(stateDir), PACKAGED_BRIEFS_DIR]) {
    const f = path.join(dir, s + '.md');
    if (fs.existsSync(f)) return f;
  }
  return '';
}

// ---------- frontmatter ----------
//
// A template MAY open with a fenced header block naming how the card runs:
//
//   ---
//   harness: codex
//   model: gpt-5.6-sol
//   requires: [pr_url, pr_number]
//   branch: false
//   ---
//
// A flavour of SDLC includes what runs it, and prose in the brief cannot act —
// the worker reads "start this on codex" only once it is already on claude.
// Four keys, all optional, no template without the block behaving any
// differently. The parser is hand-written and covers only what those
// four keys need — a general markup language is exactly what this must not
// grow into — and anything else in the block is an error naming its line,
// because a guess here silently starts the wrong worker.
const FM_KEYS = ['harness', 'model', 'requires', 'branch'];
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
  if (/^[[{]/.test(raw)) throw new Error(at + 'unclosed list — write it as [a, b, c]: ' + raw);
  return unquote(raw);
}

function fmCheck(key, val, at) {
  if (key === 'branch') {
    if (typeof val !== 'boolean') throw new Error(at + 'branch takes true or false, got: ' + JSON.stringify(val));
    return val;
  }
  if (key === 'requires') {
    const names = Array.isArray(val) ? val : [String(val)]; // a lone name is a one-item list
    for (const n of names) {
      if (typeof n !== 'string' || !FM_NAME_RE.test(n)) {
        throw new Error(at + 'requires takes attribute names, e.g. [pr_url, repo_slug] — got: ' + JSON.stringify(n));
      }
    }
    return names;
  }
  // harness, model: a bare name
  if (typeof val !== 'string' || !val.trim()) {
    throw new Error(at + key + ' takes a name, got: ' + JSON.stringify(val));
  }
  return val.trim();
}

// parseBrief(text) -> { meta, body }. No opening `---` line = no frontmatter:
// meta is empty and the body is the text untouched, which is every template
// that predates this. A block that opens and never closes, or holds anything
// but the four keys, THROWS with the offending line named.
function parseBrief(text) {
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
        + ' (the block runs to the next `---` line — is that one missing?)');
    }
    const key = m[1];
    if (!FM_KEYS.includes(key)) {
      throw new Error(at + 'unknown key "' + key + '" — the block takes ' + FM_KEYS.join(', ')
        + ' and nothing else (prose belongs in the brief, below the ---)');
    }
    if (key in meta) throw new Error(at + '"' + key + '" is set twice');
    const raw = m[2].trim();
    if (!raw) throw new Error(at + '"' + key + '" has no value');
    meta[key] = fmCheck(key, fmValue(raw, at), at);
  }
  throw new Error('frontmatter opened on line 1 and is never closed — end the block with a `---` line');
}

// The captain ↔ lieutenant card thread as one block, or '' — templates drop
// {{THREAD}} on its own line, so it carries its own heading or nothing at all.
function threadBlock(thread) {
  const msgs = (thread || []).filter((m) => m && String(m.text || '').trim());
  if (!msgs.length) return '';
  return '## Card thread (captain ↔ lieutenant context)\n\n'
    + msgs.map((m) => '- ' + (m.author || 'user') + ': '
      + String(m.text).trim().replace(/\n/g, '\n  ')).join('\n');
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
    const key = 'ATTR_' + String(k).toUpperCase().replace(/[^A-Z0-9_]/g, '_');
    if (!(key in vars)) vars[key] = String(v);
  }
  return vars;
}

// render(template, vars) — {{NAME}} → its value. An unknown name is left
// EXACTLY as written: a typo has to be visible in the brief, never silently
// empty.
function render(template, vars) {
  return String(template).replace(/\{\{([A-Za-z][A-Za-z0-9_]*)\}\}/g,
    (m, k) => (Object.prototype.hasOwnProperty.call(vars, k) ? vars[k] : m));
}

// workerBrief(b) -> the rendered brief. `b.template` is the template text;
// callers that have a card id use resolveBrief() to find it first.
function workerBrief(b) {
  return render(b.template, briefVars(b));
}

// seedBriefsAndDuties(stateDir, home) — the two halves of "how we ask for work",
// installed together at workspace.init because they are one thing split by
// ownership:
//
//   briefs/  COPIES of the packaged templates, and only the ones missing. They
//            are the USER's to edit, so an upgrade must never overwrite one.
//   skill    a SYMLINK to the packaged bridge-commander-worker skill. The
//            duties are OURS, so upgrading bridge-commander upgrades them with
//            no copy going stale in someone's skills dir.
//
// Returns what it did, for init to print. Never throws: a workspace whose
// briefs/ is unwritable still runs off the packaged templates, and a skills dir
// we may not write is the user's business, not a reason to fail init.
const PACKAGED_SKILL_DIR = path.join(__dirname, '..', 'skills', 'bridge-commander-worker');

function seedBriefsAndDuties(stateDir, home) {
  const out = { briefs: [], skill: '' };
  const dst = briefsDir(stateDir);
  try {
    fs.mkdirSync(dst, { recursive: true });
    for (const f of fs.readdirSync(PACKAGED_BRIEFS_DIR)) {
      if (!f.endsWith('.md') || fs.existsSync(path.join(dst, f))) continue;
      fs.copyFileSync(path.join(PACKAGED_BRIEFS_DIR, f), path.join(dst, f));
      out.briefs.push(f);
    }
  } catch (e) { /* unwritable briefs dir — the packaged templates still resolve */ }

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
  } catch (e) { /* no skills dir we may write — the template says to load it, the user installs it */ }
  return out;
}

module.exports = {
  PACKAGED_BRIEFS_DIR, PACKAGED_SKILL_DIR, briefsDir, listBriefs, resolveBrief,
  parseBrief, briefVars, render, workerBrief, seedBriefsAndDuties,
};
