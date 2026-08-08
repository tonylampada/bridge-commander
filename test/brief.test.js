'use strict';
// brief.js — the brief is a markdown template the USER owns, rendered against
// the card at card.start. These tests pin the renderer: which template wins,
// what a placeholder resolves to, and what happens to one that resolves to
// nothing.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const {
  workerBrief, render, listBriefs, resolveBrief, briefsDir, seedBriefsAndDuties,
  PACKAGED_BRIEFS_DIR, PACKAGED_SKILL_DIR,
} = require('../server/brief.js');

function tmpState(files) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bc-briefs-'));
  const bd = path.join(dir, 'briefs');
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

// ---------- the template list ----------

test('templates come from the workspace first, packaged second; README is not one', () => {
  const dir = tmpState({ 'house-style.md': '# ours\n', 'README.md': 'docs, not a template\n' });
  const ids = listBriefs(dir);
  assert.ok(ids.includes('house-style'), 'the workspace template lists');
  assert.ok(ids.includes('default'), 'a packaged template the workspace never seeded still lists');
  assert.ok(ids.includes('no-mistakes'));
  assert.ok(!ids.includes('README'), 'README documents the folder — it is not a flavour of SDLC');
  assert.deepStrictEqual(ids, [...ids].sort(), 'sorted, so the dropdown is stable');
  assert.strictEqual(resolveBrief(dir, 'README'), '', 'and it never resolves as an id either');
  fs.rmSync(dir, { recursive: true, force: true });
});

test('a workspace file wins over the packaged one of the same name — an upgrade never overwrites an edit', () => {
  const dir = tmpState({ 'default.md': 'MY default\n' });
  assert.strictEqual(resolveBrief(dir, 'default'), path.join(briefsDir(dir), 'default.md'));
  assert.strictEqual(fs.readFileSync(resolveBrief(dir, 'default'), 'utf8'), 'MY default\n');
  // one it has NOT overridden still resolves, to the packaged copy
  assert.strictEqual(resolveBrief(dir, 'investigation'),
    path.join(PACKAGED_BRIEFS_DIR, 'investigation.md'));
  fs.rmSync(dir, { recursive: true, force: true });
});

test('an unknown id resolves to nothing, and so does a path dressed up as one', () => {
  const dir = tmpState({});
  assert.strictEqual(resolveBrief(dir, 'nope'), '');
  assert.strictEqual(resolveBrief(dir, ''), '');
  assert.strictEqual(resolveBrief(dir, '../../etc/passwd'), '');
  assert.strictEqual(resolveBrief(dir, 'sub/dir'), '');
  fs.rmSync(dir, { recursive: true, force: true });
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

test('the packaged templates render with no {{ left in them', () => {
  for (const f of fs.readdirSync(PACKAGED_BRIEFS_DIR)) {
    if (!f.endsWith('.md') || f === 'README.md') continue;
    const out = brief(fs.readFileSync(path.join(PACKAGED_BRIEFS_DIR, f), 'utf8'), {
      // codereview.md reads the PR attributes off the card
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

test('{{CLI}} carries --workspace, so a template can paste it in front of any verb', () => {
  const out = brief('{{CLI}} worker done {{CARD_ID}} --outcome "x"');
  assert.strictEqual(out, 'bc-axi --workspace /ws worker done MON-9 --outcome "x"');
});

test('render() substitutes only what it was given, and leaves the rest alone', () => {
  assert.strictEqual(render('a {{X}} b {{Y}}', { X: '1' }), 'a 1 b {{Y}}');
  assert.strictEqual(render('{{x}} {{X_1}}', { X_1: 'ok' }), '{{x}} ok'); // lowercase is not a placeholder name we set
});

// ---------- seeding a workspace (workspace.init) ----------

test('init seeds COPIES of the templates and never overwrites one the user edited', () => {
  const dir = tmpState({ 'default.md': 'MY default, do not touch\n' });
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'bc-home-'));
  const first = seedBriefsAndDuties(dir, home);
  // the edited one is left alone; the rest arrive
  assert.ok(!first.briefs.includes('default.md'), 'an existing file is not re-seeded');
  assert.ok(first.briefs.includes('no-mistakes.md'));
  assert.strictEqual(fs.readFileSync(path.join(briefsDir(dir), 'default.md'), 'utf8'), 'MY default, do not touch\n');
  // copies, not symlinks: editing one must not write into the install
  assert.ok(!fs.lstatSync(path.join(briefsDir(dir), 'no-mistakes.md')).isSymbolicLink());

  // idempotent — a re-run (an upgrade, a second init) copies nothing
  assert.deepStrictEqual(seedBriefsAndDuties(dir, home).briefs, []);
  fs.rmSync(dir, { recursive: true, force: true });
  fs.rmSync(home, { recursive: true, force: true });
});

test('init SYMLINKS the worker-duties skill, repoints a stale link, and leaves a real dir alone', () => {
  const dir = tmpState({});
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'bc-home-'));
  const skillDst = path.join(home, '.claude', 'skills', 'bridge-commander-worker');

  const r = seedBriefsAndDuties(dir, home);
  assert.strictEqual(r.skill, skillDst);
  assert.ok(fs.lstatSync(skillDst).isSymbolicLink(), 'a symlink, so an upgrade upgrades the duties');
  assert.strictEqual(fs.readlinkSync(skillDst), PACKAGED_SKILL_DIR);
  assert.match(fs.readFileSync(path.join(skillDst, 'SKILL.md'), 'utf8'), /name: bridge-commander-worker/);

  // already ours and pointing right: nothing to do
  assert.strictEqual(seedBriefsAndDuties(dir, home).skill, '');

  // a link left by an older checkout is repointed at the current one
  fs.unlinkSync(skillDst);
  fs.symlinkSync(path.join(home, 'somewhere-else'), skillDst, 'dir');
  assert.strictEqual(seedBriefsAndDuties(dir, home).skill, skillDst);
  assert.strictEqual(fs.readlinkSync(skillDst), PACKAGED_SKILL_DIR);

  // a REAL directory is someone's own install — never clobbered
  fs.unlinkSync(skillDst);
  fs.mkdirSync(skillDst);
  fs.writeFileSync(path.join(skillDst, 'SKILL.md'), 'hand-rolled\n');
  assert.strictEqual(seedBriefsAndDuties(dir, home).skill, '');
  assert.strictEqual(fs.readFileSync(path.join(skillDst, 'SKILL.md'), 'utf8'), 'hand-rolled\n');

  fs.rmSync(dir, { recursive: true, force: true });
  fs.rmSync(home, { recursive: true, force: true });
});
