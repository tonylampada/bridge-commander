'use strict';
// The test that decides whether a stranger's first command is allowed to write
// anything at all: is this directory a workspace, an empty folder, or somebody's
// code? The ORDER is the contract — a workspace is itself a git repo, so it has
// to be recognised before any project signal is looked at.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { runCli } = require('./helper');
const fr = require('../server/firstrun.js');

function tmp(seed) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bc-firstrun-'));
  if (seed) seed(dir);
  return dir;
}
const touch = (dir, rel) => {
  fs.mkdirSync(path.dirname(path.join(dir, rel)), { recursive: true });
  fs.writeFileSync(path.join(dir, rel), '');
};

test('an existing workspace is recognised before any project signal', () => {
  // The whole point of the ordering: this folder is ALSO a git repo with a
  // manifest and a src/ in it, and it still has to read as "continue".
  const dir = tmp((d) => {
    fs.mkdirSync(path.join(d, '.bridge-commander'));
    fs.mkdirSync(path.join(d, '.git'));
    touch(d, 'package.json');
    touch(d, 'src/index.js');
  });
  try {
    assert.strictEqual(fr.inspectTarget(dir).verdict, 'workspace');
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('an empty folder goes, and agent dotfiles do not make it non-empty', () => {
  const empty = tmp();
  const dotted = tmp((d) => { touch(d, '.claude/settings.local.json'); touch(d, '.DS_Store'); });
  try {
    assert.strictEqual(fr.inspectTarget(empty).verdict, 'empty');
    assert.strictEqual(fr.inspectTarget(dotted).verdict, 'empty');
  } finally {
    fs.rmSync(empty, { recursive: true, force: true });
    fs.rmSync(dotted, { recursive: true, force: true });
  }
});

test('a repo, a manifest and a source dir each read as a code project, and are named', () => {
  const cases = [
    [(d) => fs.mkdirSync(path.join(d, '.git')), /git repository/],
    [(d) => touch(d, 'pyproject.toml'), /`pyproject\.toml`/],
    [(d) => touch(d, 'src/main.go'), /`src\/`/],
    [(d) => touch(d, 'server.js'), /source files/],
  ];
  for (const [seed, re] of cases) {
    const dir = tmp(seed);
    try {
      const r = fr.inspectTarget(dir);
      assert.strictEqual(r.verdict, 'project', JSON.stringify(r));
      assert.match(fr.listPhrase(r.found), re);
      assert.match(fr.refusalText(dir, r), re); // the refusal quotes what it found back
    } finally { fs.rmSync(dir, { recursive: true, force: true }); }
  }
});

test('a non-empty folder that is neither is a judgement call, and lists what is there', () => {
  const dir = tmp((d) => { touch(d, 'holiday-photos'); touch(d, 'notes.txt'); });
  try {
    const r = fr.inspectTarget(dir);
    assert.strictEqual(r.verdict, 'unclear');
    assert.deepStrictEqual(r.found, []);
    const text = fr.refusalText(dir, r);
    assert.match(text, /notes\.txt/);
    assert.match(text, /--here/); // the way out, once the person has been asked
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('a missing directory is missing, not empty', () => {
  assert.strictEqual(fr.inspectTarget(path.join(os.tmpdir(), 'bc-nope-' + process.pid)).verdict, 'missing');
});

test('no failure message ever asks anyone to type a tmux command', () => {
  // The one rule the whole first run is judged on. `tmux new -s ...` in front of
  // a person who has never heard of tmux is the failure this flow exists to end.
  const texts = [fr.tmuxMissingText(), fr.gitIdentityText({ ok: false, missing: false })];
  for (const t of texts) assert.doesNotMatch(t, /tmux (new|attach|new-session)/);
  assert.match(fr.tmuxMissingText(), /ASK/); // it asks for permission instead
});

test('the teleport init, run outside tmux, points at the onboarding path instead of a tmux command', async () => {
  const dir = tmp();
  try {
    const r = await runCli(['init', '--name', 'Ada', '--workspace', dir], { TMUX: '' });
    assert.strictEqual(r.code, 1);
    assert.match(r.stderr, /bc-axi init --onboard/);
    assert.doesNotMatch(r.stderr, /tmux new/);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('init --onboard refuses a code project, names what it found, and writes nothing', async () => {
  const dir = tmp((d) => {
    fs.mkdirSync(path.join(d, '.git'));
    fs.writeFileSync(path.join(d, 'package.json'), '{}');
    touch(d, 'src/index.js');
  });
  try {
    const r = await runCli(['init', '--onboard', '--workspace', dir]);
    assert.strictEqual(r.code, 1);
    assert.match(r.stderr, /first run refused \(project\)/);
    assert.match(r.stderr, /`package\.json`/);
    assert.match(r.stderr, /`src\/`/);
    assert.match(r.stderr, /git repository/);
    assert.ok(!fs.existsSync(path.join(dir, '.bridge-commander')), 'refused before writing state');
    assert.ok(!fs.existsSync(path.join(dir, 'AGENTS.md')), 'refused before scaffolding');
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});
