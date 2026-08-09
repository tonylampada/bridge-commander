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
  const texts = [fr.tmuxMissingText(), fr.gitIdentityText({ ok: false, missing: false }),
    fr.rootBlockText(), fr.agentMissingText('claude')];
  for (const t of texts) assert.doesNotMatch(t, /tmux (new|attach|new-session)/);
  assert.match(fr.tmuxMissingText(), /ASK/); // it asks for permission instead
});

test('the root block names both ways forward and lets nobody pick --allow-root for the person', () => {
  const t = fr.rootBlockText();
  assert.match(t, /useradd/, 'the recommended route is a normal user');
  assert.match(t, /--allow-root/);
  assert.match(t, /IS_SANDBOX=1/, 'it says what the escape hatch actually does');
  assert.match(t, /ASK the person|Do not pick --allow-root for them/);
});

test('an install command earns its sudo — never as root, never when sudo is not installed', () => {
  // `sudo apt-get …` printed at a container's root user dies with
  // "sudo: command not found", which reads as "the instructions are broken".
  const apt = (n) => n === 'apt-get';
  const aptAndSudo = (n) => n === 'apt-get' || n === 'sudo';
  assert.doesNotMatch(fr.installCommand('tmux', { root: true, hasBin: aptAndSudo }), /sudo/);
  assert.doesNotMatch(fr.installCommand('tmux', { root: false, hasBin: apt }), /sudo/);
  assert.match(fr.installCommand('tmux', { root: false, hasBin: aptAndSudo }), /^sudo apt-get/);
});

test('a spawn failure is diagnosed from the pane, and the pane comes back with it', () => {
  const withTail = (tail) => 'spawn failed: claude could not start at =s:=w; pane tail:\n' + tail;

  let d = fr.diagnoseSpawn(withTail(
    '$ claude --dangerously-skip-permissions --session-id x\n'
    + '--dangerously-skip-permissions cannot be used with root/sudo privileges for security reasons'));
  assert.strictEqual(d.cause, 'root');
  assert.match(d.fix, /--allow-root|normal user/);
  assert.match(d.tail, /cannot be used with root/, 'the pane is handed back verbatim');
  assert.doesNotMatch(d.headline, /not installed, or not logged in/);

  d = fr.diagnoseSpawn(withTail(
    'Welcome to Claude Code v2.1.226\n\n Choose the text style that looks best with your terminal\n'
    + ' To change this later, run /theme'));
  assert.strictEqual(d.cause, 'setup');
  assert.match(d.fix, /claude/);
  assert.doesNotMatch(d.headline, /not installed, or not logged in/);

  assert.strictEqual(fr.diagnoseSpawn(withTail('bash: claude: command not found')).cause, 'missing');

  // Round 2: the folder-trust question, which is a THIRD setup screen and comes
  // before login. A user who ran `claude` once at home has not cleared it —
  // Bridget is spawned in the workspace, and the question is about that folder.
  d = fr.diagnoseSpawn(withTail(
    ' Accessing workspace:\n /root/myfleet\n'
    + ' Quick safety check: Is this a project you created or one you trust?\n'
    + ' ❯ 1. Yes, I trust this folder\n   2. No, exit'), '/root/myfleet');
  assert.strictEqual(d.cause, 'trust');
  assert.match(d.fix, /cd \/root\/myfleet && claude/, 'the fix names the workspace, not $HOME');

  // The guessing branches, both of them — and the guess says it is one. Which
  // branch you get depends on whether there was a pane to read at all: "read it
  // above" over an empty space is what round 2 caught.
  d = fr.diagnoseSpawn(withTail('a screen from the future'));
  assert.strictEqual(d.cause, 'unknown');
  assert.strictEqual(d.tail, 'a screen from the future');
  assert.match(d.headline, /printed above/);

  d = fr.diagnoseSpawn('spawn failed: something nobody has seen before');
  assert.strictEqual(d.cause, 'unknown');
  assert.strictEqual(d.tail, '');
  assert.match(d.headline, /pane was empty/);
  assert.doesNotMatch(d.headline, /above/, 'nothing is above it, so it may not say so');
  assert.match(d.fix, /That is a guess/);
});

test('the agent-missing block installs as the user who will run it, and points at the workspace', () => {
  // Round 2: the root block says "become a normal user", and this block used to
  // answer with `npm i -g`, which for that user is EACCES. Two instructions that
  // contradict each other leave the person stuck between them.
  const t = fr.agentMissingText('claude', '/home/dev/myfleet');
  assert.match(t, /claude\.ai\/install\.sh/, 'a route that needs no root comes first');
  assert.match(t, /cd \/home\/dev\/myfleet && claude/, 'and the by-hand run happens in the workspace');
});

test('with neither root nor sudo, the tmux block says the command will be refused', () => {
  const t = fr.tmuxMissingText({ root: false, hasBin: (n) => n === 'apt-get' });
  assert.match(t, /apt-get install -y tmux/);
  assert.match(t, /not root and there is no `sudo`/, 'the one cell where the command cannot work');
  assert.match(t, /administrator/);
  // …and the cells where it does work do not carry the caveat.
  assert.doesNotMatch(fr.tmuxMissingText({ root: true, hasBin: (n) => n === 'apt-get' }), /administrator/);
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
