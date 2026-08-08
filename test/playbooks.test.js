'use strict';
// playbooks.js — a playbook is a markdown file the USER owns, rendered against
// the card at card.start into the worker's brief. These tests pin the
// renderer: which playbook wins, what a placeholder resolves to, and what
// happens to one that resolves to nothing.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const {
  workerBrief, render, listPlaybooks, resolvePlaybook, playbooksDir, seedPlaybooksAndDuties, parsePlaybook,
  PACKAGED_PLAYBOOKS_DIR, PACKAGED_SKILL_DIR,
} = require('../server/playbooks.js');

function tmpState(files) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bc-playbooks-'));
  const bd = path.join(dir, 'playbooks');
  fs.mkdirSync(bd, { recursive: true });
  for (const [name, body] of Object.entries(files || {})) fs.writeFileSync(path.join(bd, name), body);
  return dir;
}

function brief(template, overrides = {}) {
  return workerBrief(Object.assign({
    template,
    card: { id: 'MON-9', title: 'Demo card', type: 'implementation', body: 'do the thing', attributes: {} },
    thread: [],
    project: { name: 'proj', path: '/repos/proj' },
    worktree: '/wt/MON-9',
    branch: 'bc/MON-9',
    workspace: '/ws',
    stateDir: '/ws/.bridge-commander',
    cli: 'bc-axi',
  }, overrides));
}

// ---------- the playbook list ----------

test('playbooks come from the workspace first, packaged second; README is not one', () => {
  const dir = tmpState({ 'house-style.md': '# ours\n', 'README.md': 'docs, not a playbook\n' });
  const ids = listPlaybooks(dir);
  assert.ok(ids.includes('house-style'), 'the workspace playbook lists');
  assert.ok(ids.includes('default'), 'a packaged playbook the workspace never seeded still lists');
  assert.ok(ids.includes('no-mistakes'));
  assert.ok(!ids.includes('README'), 'README documents the folder — it is not a playbook');
  assert.deepStrictEqual(ids, [...ids].sort(), 'sorted, so the dropdown is stable');
  assert.strictEqual(resolvePlaybook(dir, 'README'), '', 'and it never resolves as an id either');
  fs.rmSync(dir, { recursive: true, force: true });
});

test('a workspace file wins over the packaged one of the same name — an upgrade never overwrites an edit', () => {
  const dir = tmpState({ 'default.md': 'MY default\n' });
  assert.strictEqual(resolvePlaybook(dir, 'default'), path.join(playbooksDir(dir), 'default.md'));
  assert.strictEqual(fs.readFileSync(resolvePlaybook(dir, 'default'), 'utf8'), 'MY default\n');
  // one it has NOT overridden still resolves, to the packaged copy
  assert.strictEqual(resolvePlaybook(dir, 'investigation'),
    path.join(PACKAGED_PLAYBOOKS_DIR, 'investigation.md'));
  fs.rmSync(dir, { recursive: true, force: true });
});

test('an unknown id resolves to nothing, and so does a path dressed up as one', () => {
  const dir = tmpState({});
  assert.strictEqual(resolvePlaybook(dir, 'nope'), '');
  assert.strictEqual(resolvePlaybook(dir, ''), '');
  assert.strictEqual(resolvePlaybook(dir, '../../etc/passwd'), '');
  assert.strictEqual(resolvePlaybook(dir, 'sub/dir'), '');
  fs.rmSync(dir, { recursive: true, force: true });
});

// ---------- frontmatter ----------
//
// A playbook is a repeatable procedure, and part of the procedure is what RUNS
// it. The block is four optional keys and deliberately not yaml — what is
// pinned here is that a playbook without one is untouched, and that everything
// the parser does not understand becomes an error naming the line rather than
// a guess.

test('no frontmatter = the body is the file, untouched', () => {
  const md = '# Title\n\nnot frontmatter: this is prose\n';
  assert.deepStrictEqual(parsePlaybook(md), { meta: {}, body: md });
  assert.deepStrictEqual(parsePlaybook(''), { meta: {}, body: '' });
  // a --- that is not on line 1 is a horizontal rule, not an opening delimiter
  const rule = 'intro\n\n---\nharness: codex\n---\n';
  assert.deepStrictEqual(parsePlaybook(rule), { meta: {}, body: rule });
});

test('the five keys parse to their types, and the body starts after the closing ---', () => {
  const { meta, body } = parsePlaybook([
    '---',
    'harness: codex',
    'model: gpt-5.6-sol',
    'requires: [pr_url, pr_number, repo_slug]',
    'branch: false',
    'keep_worktree: true',
    '---',
    '',
    '# The brief',
  ].join('\n'));
  assert.deepStrictEqual(meta, {
    harness: 'codex',
    model: 'gpt-5.6-sol',
    requires: ['pr_url', 'pr_number', 'repo_slug'],
    branch: false,
    keep_worktree: true,
  });
  assert.strictEqual(body, '# The brief'); // the blank line under the block is not the brief
});

test('the small mercies: blank lines, quotes, an empty list, a lone required name', () => {
  const { meta } = parsePlaybook([
    '---',
    'harness: claude',
    '',
    "model: 'claude-opus-5'",
    'requires: [] ',
    'branch: true',
    '---',
    'body',
  ].join('\n'));
  assert.deepStrictEqual(meta, { harness: 'claude', model: 'claude-opus-5', requires: [], branch: true });
  assert.deepStrictEqual(parsePlaybook('---\nrequires: pr_url\n---\nb').meta.requires, ['pr_url']);
});

test('a malformed block fails with the offending line named', () => {
  const bad = (lines, re) => assert.throws(() => parsePlaybook(lines.join('\n')), re);
  bad(['---', 'harness: codex', 'this is prose', '---', 'b'], /line 3: expected `key: value`.*this is prose/);
  bad(['---', 'hraness: codex', '---', 'b'], /line 2: unknown key "hraness"/);
  bad(['---', 'branch: nope', '---', 'b'], /line 2: branch takes true or false/);
  bad(['---', 'keep_worktree: yes', '---', 'b'], /line 2: keep_worktree takes true or false/);
  bad(['---', 'harness: [a, b]', '---', 'b'], /line 2: harness takes a name/);
  bad(['---', 'harness: true', '---', 'b'], /line 2: harness takes a name/);
  bad(['---', 'model:', '---', 'b'], /line 2: "model" has no value/);
  bad(['---', 'requires: [pr_url, ]', '---', 'b'], /line 2: empty item in the list/);
  bad(['---', 'requires: [pr url]', '---', 'b'], /line 2: requires takes attribute names/);
  // not coerced into the attribute literally named "true": a scalar that is
  // not a name is an error, the same as everything else the block cannot read
  bad(['---', 'requires: true', '---', 'b'], /line 2: requires takes attribute names.*true/);
  bad(['---', 'requires: false', '---', 'b'], /line 2: requires takes attribute names.*false/);
  bad(['---', 'harness: codex', 'harness: claude', '---', 'b'], /line 3: "harness" is set twice/);
  bad(['---', 'harness: codex'], /never closed/);
  // the everyday version of "never closed": the brief itself runs into the block
  bad(['---', 'harness: codex', '# the brief'], /line 3: expected `key: value`.*is that one missing/);
  // a map is well-formed and simply unsupported — saying "unclosed list" would
  // point the author at a fix for a problem they do not have
  bad(['---', 'requires: {a: 1}', '---', 'b'], /line 2: a map is not supported here/);
  bad(['---', 'requires: [pr_url', '---', 'b'], /line 2: unclosed list/);
});

// A first line of `---` is an opening delimiter here and a horizontal rule in
// every playbook written before this existed, so both ways the block can fail
// have to name the way out — the line alone leaves the author guessing.
test('a block opened by a first-line --- says how to make it a rule again', () => {
  const hint = /horizontal rule.*heading or a blank line above it/;
  assert.throws(() => parsePlaybook(['---', 'harness: codex'].join('\n')), hint);
  assert.throws(() => parsePlaybook(['---', '***', '---', 'b'].join('\n')), hint);
});

test('every packaged playbook has a parseable block, and investigation is the one that cuts no branch', () => {
  for (const f of fs.readdirSync(PACKAGED_PLAYBOOKS_DIR)) {
    if (!f.endsWith('.md') || f === 'README.md') continue;
    const { meta } = parsePlaybook(fs.readFileSync(path.join(PACKAGED_PLAYBOOKS_DIR, f), 'utf8'));
    const want = f === 'investigation.md' ? { branch: false } : {};
    assert.deepStrictEqual(meta, want, f + ' frontmatter');
  }
});

// ---------- rendering ----------

test('every documented placeholder resolves, and nothing is left unrendered', () => {
  const out = brief([
    '{{CARD_ID}} | {{CARD_TITLE}} | {{PROJECT}} | {{PROJECT_PATH}}',
    '{{WORKTREE}} | {{BRANCH}} | {{WORKSPACE}} | {{CLI}} | {{REPORT_FILE}}',
    '{{TASK}}',
  ].join('\n'));
  assert.strictEqual(out, [
    'MON-9 | Demo card | proj | /repos/proj',
    '/wt/MON-9 | bc/MON-9 | /ws | bc-axi --workspace /ws | /ws/.bridge-commander/reports/MON-9.md',
    'do the thing',
  ].join('\n'));
  assert.doesNotMatch(out, /\{\{/);
});

test('the packaged playbooks render with no {{ left in them', () => {
  for (const f of fs.readdirSync(PACKAGED_PLAYBOOKS_DIR)) {
    if (!f.endsWith('.md') || f === 'README.md') continue;
    const out = brief(fs.readFileSync(path.join(PACKAGED_PLAYBOOKS_DIR, f), 'utf8'), {
      card: {
        id: 'MON-9', title: 'Demo card', type: 'implementation', body: 'do the thing',
        attributes: { pr_url: 'https://x/1', pr_number: '1', repo_slug: 'o/r' },
      },
    });
    assert.doesNotMatch(out, /\{\{/, f + ' left a placeholder unrendered');
  }
});

test('an unknown placeholder is left EXACTLY as written — a typo has to be visible', () => {
  const out = brief('{{CARD_ID}} {{CRAD_ID}} {{NOT_A_THING}}');
  assert.strictEqual(out, 'MON-9 {{CRAD_ID}} {{NOT_A_THING}}');
});

test('{{ATTR_<NAME>}} reads card attributes; one that does not exist stays literal', () => {
  const out = brief('{{ATTR_PR_URL}} | {{ATTR_REPO}} | {{ATTR_NOPE}}', {
    card: { id: 'MON-9', title: 't', type: 'implementation', body: 'b',
      attributes: { pr_url: 'https://github.com/o/r/pull/7', repo: 'proj' } },
  });
  assert.strictEqual(out, 'https://github.com/o/r/pull/7 | proj | {{ATTR_NOPE}}');
});

test('a structured attribute has no text form, so it stays literal rather than printing [object Object]', () => {
  const out = brief('{{ATTR_ARTIFACTS}}', {
    card: { id: 'MON-9', title: 't', type: 'implementation', body: 'b',
      attributes: { artifacts: [{ uri: 'file:///x', label: 'brief' }] } },
  });
  assert.strictEqual(out, '{{ATTR_ARTIFACTS}}');
});

test('{{TASK}} is the card body, overridden by the lieutenant\'s brief-file text, and never empty', () => {
  assert.strictEqual(brief('{{TASK}}'), 'do the thing');
  assert.strictEqual(brief('{{TASK}}', { task: 'do THIS instead' }), 'do THIS instead');
  // an empty body falls back to the title: a brief with no task in it is useless
  assert.strictEqual(brief('{{TASK}}', { card: { id: 'MON-9', title: 'Demo card', body: '' } }), 'Demo card');
});

test('{{THREAD}} carries its own heading, and renders to nothing when the thread is empty', () => {
  assert.strictEqual(brief('{{THREAD}}'), '');
  const out = brief('{{THREAD}}', {
    thread: [
      { author: 'user', text: 'ship it behind a flag' },
      { author: 'monica', text: 'two lines\nsecond one' },
      { author: 'user', text: '   ' }, // blank messages are not context
    ],
  });
  assert.match(out, /^## Card thread/m);
  assert.match(out, /- user: ship it behind a flag/);
  assert.match(out, /- monica: two lines\n {2}second one/);
  assert.doesNotMatch(out, /- user: {3}/);
});

test('{{BRANCH}} is empty for a card with no branch (an investigation), not the string "null"', () => {
  assert.strictEqual(brief('[{{BRANCH}}]', { branch: '' }), '[]');
});

test('{{CLI}} carries --workspace, so a playbook can paste it in front of any verb', () => {
  const out = brief('{{CLI}} worker done {{CARD_ID}} --outcome "x"');
  assert.strictEqual(out, 'bc-axi --workspace /ws worker done MON-9 --outcome "x"');
});

test('render() substitutes only what it was given, and leaves the rest alone', () => {
  assert.strictEqual(render('a {{X}} b {{Y}}', { X: '1' }), 'a 1 b {{Y}}');
  assert.strictEqual(render('{{x}} {{X_1}}', { X_1: 'ok' }), '{{x}} ok'); // lowercase is not a placeholder name we set
});

// ---------- seeding a workspace (workspace.init) ----------

test('init seeds COPIES of the playbooks and never overwrites one the user edited', () => {
  const dir = tmpState({ 'default.md': 'MY default, do not touch\n' });
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'bc-home-'));
  const first = seedPlaybooksAndDuties(dir, home);
  // the edited one is left alone; the rest arrive
  assert.ok(!first.playbooks.includes('default.md'), 'an existing file is not re-seeded');
  assert.ok(first.playbooks.includes('no-mistakes.md'));
  assert.strictEqual(fs.readFileSync(path.join(playbooksDir(dir), 'default.md'), 'utf8'), 'MY default, do not touch\n');
  // copies, not symlinks: editing one must not write into the install
  assert.ok(!fs.lstatSync(path.join(playbooksDir(dir), 'no-mistakes.md')).isSymbolicLink());

  // idempotent — a re-run (an upgrade, a second init) copies nothing
  assert.deepStrictEqual(seedPlaybooksAndDuties(dir, home).playbooks, []);
  fs.rmSync(dir, { recursive: true, force: true });
  fs.rmSync(home, { recursive: true, force: true });
});

test('init SYMLINKS the worker-duties skill, repoints a stale link, and leaves a real dir alone', () => {
  const dir = tmpState({});
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'bc-home-'));
  const skillDst = path.join(home, '.claude', 'skills', 'bridge-commander-worker');

  const r = seedPlaybooksAndDuties(dir, home);
  assert.strictEqual(r.skill, skillDst);
  assert.ok(fs.lstatSync(skillDst).isSymbolicLink(), 'a symlink, so an upgrade upgrades the duties');
  assert.strictEqual(fs.readlinkSync(skillDst), PACKAGED_SKILL_DIR);
  assert.match(fs.readFileSync(path.join(skillDst, 'SKILL.md'), 'utf8'), /name: bridge-commander-worker/);

  // already ours and pointing right: nothing to do
  assert.strictEqual(seedPlaybooksAndDuties(dir, home).skill, '');

  // a link left by an older checkout is repointed at the current one
  fs.unlinkSync(skillDst);
  fs.symlinkSync(path.join(home, 'somewhere-else'), skillDst, 'dir');
  assert.strictEqual(seedPlaybooksAndDuties(dir, home).skill, skillDst);
  assert.strictEqual(fs.readlinkSync(skillDst), PACKAGED_SKILL_DIR);

  // a REAL directory is someone's own install — never clobbered
  fs.unlinkSync(skillDst);
  fs.mkdirSync(skillDst);
  fs.writeFileSync(path.join(skillDst, 'SKILL.md'), 'hand-rolled\n');
  assert.strictEqual(seedPlaybooksAndDuties(dir, home).skill, '');
  assert.strictEqual(fs.readFileSync(path.join(skillDst, 'SKILL.md'), 'utf8'), 'hand-rolled\n');

  fs.rmSync(dir, { recursive: true, force: true });
  fs.rmSync(home, { recursive: true, force: true });
});
