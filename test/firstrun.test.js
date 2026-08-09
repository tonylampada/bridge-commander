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

  // Round 3: the consent screen only OUR launch line raises. The recipe has to
  // carry the flag — `cd <ws> && claude` can be run all day and never see it.
  d = fr.diagnoseSpawn(withTail(
    '  WARNING: Claude Code running in Bypass Permissions mode\n  ❯ 1. No, exit\n    2. Yes, I accept'),
  '/root/myfleet');
  assert.strictEqual(d.cause, 'bypass');
  assert.match(d.fix, /claude --dangerously-skip-permissions/, 'a recipe that cannot clear it is no recipe');
  assert.match(d.fix, /2 \(Yes, I accept\)/);

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
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'bc-home-')); // …one with no claude in it
  const oldHome = process.env.HOME;
  let t;
  try { process.env.HOME = home; t = fr.agentMissingText('claude', '/home/dev/myfleet'); }
  finally { process.env.HOME = oldHome; fs.rmSync(home, { recursive: true, force: true }); }
  assert.match(t, /claude\.ai\/install\.sh/, 'a route that needs no root comes first');
  assert.match(t, /cd \/home\/dev\/myfleet && claude --dangerously-skip-permissions/,
    'the by-hand run happens in the workspace, with the flag that raises every screen');
  assert.match(t, /PATH="\$HOME\/\.local\/bin/, 'the installer does not edit PATH, so the block does');
});

test('installed-but-invisible is a different problem from not-installed', () => {
  // Round 3: as root, the curl installer lands the binary in ~/.local/bin and
  // root's ~/.profile does not pick it up — so "install it" was printed at
  // someone who already had, forever.
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'bc-home-'));
  const bin = path.join(home, '.local', 'bin');
  fs.mkdirSync(bin, { recursive: true });
  fs.writeFileSync(path.join(bin, 'claude'), '#!/bin/sh\n', { mode: 0o755 });
  const oldHome = process.env.HOME;
  try {
    process.env.HOME = home;
    assert.strictEqual(fr.agentAtHome('claude'), path.join(bin, 'claude'));
    const t = fr.agentMissingText('claude', '/root/myfleet');
    assert.match(t, /is installed at .*\.local\/bin\/claude but is not on PATH/);
    assert.match(t, /bashrc/, 'and it survives into the shell her session is launched from');
    assert.doesNotMatch(t, /install\.sh/, 'it does not tell them to install what they have');
  } finally {
    process.env.HOME = oldHome;
    fs.rmSync(home, { recursive: true, force: true });
  }
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

// Round 5: the last one the tester found. On --allow-root the spawn passes
// IS_SANDBOX=1, but the line we printed for the PERSON did not — so following
// the recipe verbatim as root died with the same root refusal it was meant to
// get them past. Every hand-run line is built in one place now, and this is the
// test that keeps it that way.
test('a hand-run recipe printed at root carries the escape hatch root needs', () => {
  assert.strictEqual(fr.handRunLine('claude', '/root/myfleet', { root: true }),
    '  cd /root/myfleet && IS_SANDBOX=1 claude --dangerously-skip-permissions');
  assert.strictEqual(fr.handRunLine('claude', '/home/dev/ws', { root: false }),
    '  cd /home/dev/ws && claude --dangerously-skip-permissions',
    'a normal user gets no sandbox flag they do not need');

  // …and every block that prints one gets it from there. Stubbing getuid is the
  // only way to see the root shape without being root.
  const realUid = process.getuid;
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'bc-home-'));
  const oldHome = process.env.HOME;
  let texts;
  try {
    process.getuid = () => 0;
    process.env.HOME = home;
    const tail = (t) => 'spawn failed; pane tail:\n' + t;
    texts = [
      fr.agentMissingText('claude', '/root/myfleet'),
      fr.diagnoseSpawn(tail('WARNING: Claude Code running in Bypass Permissions mode'), '/root/myfleet').fix,
      fr.diagnoseSpawn(tail('Quick safety check: Is this a project you created'), '/root/myfleet').fix,
      fr.diagnoseSpawn(tail('Choose the text style that looks best'), '/root/myfleet').fix,
    ];
  } finally {
    process.getuid = realUid;
    process.env.HOME = oldHome;
    fs.rmSync(home, { recursive: true, force: true });
  }
  for (const t of texts) {
    for (const line of t.split('\n')) {
      if (!/claude --dangerously-skip-permissions/.test(line)) continue;
      assert.match(line, /IS_SANDBOX=1 claude --dangerously-skip-permissions/,
        'a launch line printed at root that root cannot run: ' + line.trim());
    }
  }
});
