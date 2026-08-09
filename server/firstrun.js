'use strict';
// firstrun — everything `bc-axi init --onboard` has to decide BEFORE it writes
// anything: is this directory a workspace, an empty folder, or somebody's code?
// and is the machine able to run a board at all?
//
// It lives here rather than in the CLI because the answers are testable facts,
// and a refusal a stranger will read is the last place to improvise: the order
// of the checks IS the contract.
//
//   1. `.bridge-commander/` present  -> an existing workspace. Continue.
//      This check comes FIRST because a workspace is itself a git repo with a
//      package.json's worth of scaffolding in it, and every other signal below
//      would read it as a code project and refuse to re-enter it.
//   2. empty                         -> go.
//   3. a repo / a manifest / source  -> refuse, NAMING what was found.
//   4. anything else non-empty       -> a judgement call: say what is there and ask.

const fs = require('fs');
const path = require('path');
const net = require('net');
const { execFileSync } = require('child_process');
const { STATE_DIR_NAME, LEGACY_STATE_DIR_NAME } = require(path.join(__dirname, 'statedir.js'));

// Entries that say nothing about what a folder is for. A stranger's "empty
// folder" has usually already been opened by an agent, and the agent left its
// own dotfiles in it — those must not read as a code project.
const IGNORABLE = new Set([
  '.DS_Store', 'Thumbs.db', '.localized',
  '.claude', '.claude.json', '.codex', '.agents', '.cursor',
  STATE_DIR_NAME, LEGACY_STATE_DIR_NAME,
]);

// One manifest is enough: nobody drops a pyproject.toml in a scratch folder.
const MANIFESTS = [
  'package.json', 'pyproject.toml', 'go.mod', 'Cargo.toml', 'pom.xml', 'Gemfile',
  'build.gradle', 'build.gradle.kts', 'composer.json', 'mix.exs', 'setup.py',
  'requirements.txt', 'Pipfile', 'CMakeLists.txt', 'Dockerfile',
];
const SOURCE_DIRS = ['src', 'lib', 'app', 'test', 'tests', 'spec', 'cmd', 'pkg', 'internal'];
const SOURCE_EXT = new Set([
  '.js', '.mjs', '.cjs', '.ts', '.tsx', '.jsx', '.py', '.go', '.rs', '.rb', '.java',
  '.kt', '.scala', '.php', '.c', '.h', '.cc', '.cpp', '.hpp', '.cs', '.swift', '.ex',
  '.exs', '.clj', '.erl', '.sh', '.bash', '.pl', '.lua', '.dart', '.vue', '.svelte',
]);

function isWorkspaceDir(dir) {
  return fs.existsSync(path.join(dir, STATE_DIR_NAME)) || fs.existsSync(path.join(dir, LEGACY_STATE_DIR_NAME));
}

// inspectTarget(dir) -> { verdict, found[], entries[] }
//   verdict: 'workspace' | 'empty' | 'project' | 'unclear' | 'missing'
//   found:   human-readable signals, in the order they were found — this is
//            what the refusal quotes back, so it is never a bare boolean.
function inspectTarget(dir) {
  let entries;
  try { entries = fs.readdirSync(dir); }
  catch (e) { return { verdict: 'missing', found: [], entries: [] }; }
  if (isWorkspaceDir(dir)) return { verdict: 'workspace', found: [STATE_DIR_NAME + '/'], entries };

  const visible = entries.filter((e) => !IGNORABLE.has(e));
  if (!visible.length) return { verdict: 'empty', found: [], entries };

  const found = [];
  if (visible.includes('.git')) found.push('a git repository (`.git/`)');
  for (const m of MANIFESTS) if (visible.includes(m)) found.push('`' + m + '`');
  for (const d of SOURCE_DIRS) {
    if (!visible.includes(d)) continue;
    try { if (fs.statSync(path.join(dir, d)).isDirectory()) found.push('`' + d + '/`'); } catch (e) {}
  }
  const srcFiles = visible.filter((e) => SOURCE_EXT.has(path.extname(e).toLowerCase()));
  if (srcFiles.length) {
    found.push('source files (' + srcFiles.slice(0, 3).map((f) => '`' + f + '`').join(', ')
      + (srcFiles.length > 3 ? ', …' : '') + ')');
  }
  return { verdict: found.length ? 'project' : 'unclear', found, entries };
}

// "`package.json`, `src/` and a git repository (`.git/`)" — an Oxford-less list,
// because it is read aloud by an agent relaying it to a person.
function listPhrase(items) {
  if (items.length <= 1) return items[0] || '';
  return items.slice(0, -1).join(', ') + ' and ' + items[items.length - 1];
}

// The refusal a stranger reads (through their agent). It names what was found,
// says what a workspace IS, and hands over the one thing to do next. It never
// tells anyone to run tmux.
function refusalText(dir, r) {
  if (r.verdict === 'project') {
    return 'this looks like a code project: I can see ' + listPhrase(r.found) + ' in\n'
      + '  ' + dir + '\n\n'
      + 'A Bridge Commander workspace is its own folder, BESIDE your code — never inside it.\n'
      + 'It holds the board, its lieutenants and the worktrees they work in; your repos are\n'
      + 'registered with it (`bc-axi project add <path-or-url>`), not replaced by it.\n\n'
      + 'Pick an empty folder, cd into it, and run this again — e.g.\n'
      + '  mkdir ~/myfleet && cd ~/myfleet\n\n'
      + '(If you are certain this folder is meant to BE the workspace, --here says so. Ask first.)';
  }
  return 'this folder is not empty, and I cannot tell what it is:\n'
    + '  ' + dir + '\n'
    + '  contains: ' + r.entries.slice(0, 12).join(', ') + (r.entries.length > 12 ? ', …' : '') + '\n\n'
    + 'A workspace wants a folder of its own. Ask the person whether this one is meant to be it:\n'
    + '  yes -> re-run with --here\n'
    + '  no  -> make an empty folder, cd into it, and run this again';
}

// ---------- machine preflight ----------
// Nothing here installs anything. Each check either passes or hands back a
// message written for the agent that will relay it and ask.

function isRoot() { return typeof process.getuid === 'function' && process.getuid() === 0; }

function hasBin(name) {
  const dirs = String(process.env.PATH || '').split(path.delimiter).filter(Boolean);
  for (const d of dirs) {
    try { fs.accessSync(path.join(d, name), fs.constants.X_OK); return true; } catch (e) {}
  }
  return false;
}

// The install line for THIS machine, so the agent can ask a yes/no question
// with a real command in it instead of guessing a package manager.
//
// `sudo` is earned, not assumed: as root it is unnecessary, and in a container
// it is usually not even installed — a printed `sudo apt-get …` there dies with
// `sudo: command not found`, which reads as "the instructions are broken".
function installCommand(pkg, opts = {}) {
  const root = opts.root === undefined ? isRoot() : opts.root;
  const has = opts.hasBin || hasBin;
  const sudo = root || !has('sudo') ? '' : 'sudo ';
  if (process.platform === 'darwin' && has('brew')) return 'brew install ' + pkg;
  if (has('apt-get')) return sudo + 'apt-get update && ' + sudo + 'apt-get install -y ' + pkg;
  if (has('dnf')) return sudo + 'dnf install -y ' + pkg;
  if (has('yum')) return sudo + 'yum install -y ' + pkg;
  if (has('pacman')) return sudo + 'pacman -S --noconfirm ' + pkg;
  if (has('apk')) return sudo + 'apk add --no-cache ' + pkg;
  if (has('zypper')) return sudo + 'zypper install -y ' + pkg;
  if (has('brew')) return 'brew install ' + pkg;
  return '';
}

function tmuxMissingText() {
  const cmd = installCommand('tmux');
  return 'tmux is not installed on this machine, and Bridge Commander needs it: a lieutenant is a\n'
    + 'real agent session, and it lives in a tmux session so the board can reach it and the\n'
    + 'person can attach to it later. You will never have to type a tmux command yourself.\n\n'
    + (cmd
      ? 'ASK the person for permission, then install it:\n  ' + cmd + '\n'
      : 'I could not identify a package manager here. ASK the person how they want tmux installed.\n')
    + '\nThen run this again — nothing has been written yet.';
}

// git identity is NOT a precondition for a board: it is a precondition for the
// first commit a worker makes. So it is reported, recorded, and carried into
// the conversation — never a wall between a stranger and a running board.
function gitIdentity() {
  const get = (k) => {
    try {
      return execFileSync('git', ['config', '--get', k], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();
    } catch (e) { return ''; }
  };
  if (!hasBin('git')) return { ok: false, missing: true, name: '', email: '' };
  const name = get('user.name');
  const email = get('user.email');
  return { ok: !!(name && email), missing: false, name, email };
}

function gitIdentityText(id) {
  if (id.missing) {
    const cmd = installCommand('git');
    return 'git is not installed. Workers commit with it, so cards will not run without it.\n'
      + (cmd ? 'ASK for permission, then: ' + cmd + '\n' : 'ASK how they want git installed.\n')
      + 'The board itself does not need it — I am carrying on.';
  }
  return 'git has no identity here (user.name / user.email are unset), so the first commit a worker\n'
    + 'makes would fail. The board does not need it, so I am carrying on — but ask for a name and\n'
    + 'an email before starting a card:\n'
    + '  git config --global user.name "<their name>"\n'
    + '  git config --global user.email "<their email>"';
}

// Root. Claude Code refuses `--dangerously-skip-permissions` as uid 0 and exits
// immediately, so as root there is no lieutenant to be had — the board would
// come up with nobody on it. That is checked HERE, before anything is written,
// rather than discovered from a dead pane afterwards.
function rootBlockText() {
  return 'you are running as root, and Claude Code refuses --dangerously-skip-permissions as root.\n'
    + 'Bridget is a real claude session, so as root she cannot start and you would be left with a\n'
    + 'board nobody is on. Two honest ways forward:\n\n'
    + '  1. RECOMMENDED — do the first run as a normal user:\n'
    + '       useradd -m dev && su - dev        # then install the skill and run this again as dev\n\n'
    + '  2. This is a throwaway box (a container you will delete) and you accept the risk:\n'
    + '       bc-axi init --onboard --allow-root\n'
    + '     That launches her with IS_SANDBOX=1, which is the escape hatch claude itself checks.\n'
    + '     It turns off a guard that exists because an agent with skipped permissions running as\n'
    + '     root can do anything to the machine. Never on a box you care about.\n\n'
    + 'ASK the person which one. Do not pick --allow-root for them.';
}

// The agent CLI itself. Cheap and certain (is it on PATH?), so it is answered
// before the spawn instead of being guessed at from a timeout afterwards.
function agentMissingText(harness) {
  const cmd = harness === 'codex'
    ? 'npm i -g @openai/codex'
    : 'npm i -g @anthropic-ai/claude-code';
  return 'the `' + (harness || 'claude') + '` CLI is not on PATH, so Bridget has nothing to be a session of.\n'
    + 'The board is up and her welcome message is on it — she just cannot answer yet.\n\n'
    + 'ASK the person for permission, then install it and run the SAME command again:\n'
    + '  ' + cmd + '\n'
    + '  ' + (harness === 'codex' ? 'codex' : 'claude') + '        # run it once by hand: it has a setup screen of its own to get past';
}

// diagnoseSpawn — read the pane, do not guess at it.
//
// A spawn failure arrives with the tail of the session's own pane attached, and
// that tail says exactly what happened. Every branch below is a signature seen
// in a real container; the fallback is the only place a guess is allowed, and it
// is labelled as one. Guessing "not installed, or not logged in" at a pane that
// plainly says something else is how a tester loses an afternoon.
function diagnoseSpawn(text) {
  const t = String(text || '');
  const tail = (/pane tail:\n([\s\S]*)$/.exec(t) || [, ''])[1].trim();
  const hit = (re, cause, headline, fix) => (re.test(t) ? { cause, headline, fix, tail } : null);
  return hit(/cannot be used with root\/sudo privileges/, 'root',
    'claude refuses --dangerously-skip-permissions as root, and exited.',
    'Do the first run as a normal user (`useradd -m dev && su - dev`), or, on a throwaway box,\n'
      + 're-run with --allow-root — see the block that command prints before it starts.')
  || hit(/Choose the text style|run \/theme|Let's get started/, 'setup',
    'the `claude` CLI has never been run on this machine — her pane is parked on its setup wizard\n'
      + '(theme picker), which comes BEFORE any login question.',
    'Run it once by hand, answer its questions, quit with /exit, then run the SAME command again:\n'
      + '  claude')
  || hit(/command not found|ENOENT|not found: claude/, 'missing',
    'the agent CLI is not installed — the shell answered "command not found".',
    'Install it and run the SAME command again:\n  npm i -g @anthropic-ai/claude-code')
  || hit(/\/login|Invalid API key|not authenticated|Please run .*login|Sign in|log in to/i, 'auth',
    'the `claude` CLI is installed but not logged in — her pane is on its login screen.',
    'Log in once by hand, then run the SAME command again:\n  claude   (and follow its login)')
  || { cause: 'unknown', headline: 'I could not tell from her pane why it failed. Read it above and act on what it says.',
    fix: 'If the pane is empty, the usual causes are the `claude` CLI missing, never run, or not\nlogged in — but that is a guess, not what this pane showed.', tail };
}

// portFree — can we bind it? An occupied port is not automatically a problem
// (it may be this very workspace's board), so the caller probes for a board
// first and only then walks forward.
function portFree(port, host) {
  return new Promise((resolve) => {
    const srv = net.createServer();
    srv.once('error', () => resolve(false));
    srv.listen(port, host || '127.0.0.1', () => srv.close(() => resolve(true)));
  });
}

// ---------- onboarding state ----------
// The steps the board remembers, in order. A re-run reads the step and resumes
// from it instead of starting the conversation over.
const ONBOARDING_STEPS = ['board-up', 'tools', 'project', 'checklist', 'done'];

module.exports = {
  IGNORABLE, MANIFESTS, SOURCE_DIRS, SOURCE_EXT, ONBOARDING_STEPS,
  isWorkspaceDir, inspectTarget, listPhrase, refusalText,
  hasBin, isRoot, installCommand, tmuxMissingText, gitIdentity, gitIdentityText, portFree,
  rootBlockText, agentMissingText, diagnoseSpawn,
};
