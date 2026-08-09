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

function tmuxMissingText(opts = {}) {
  const root = opts.root === undefined ? isRoot() : opts.root;
  const has = opts.hasBin || hasBin;
  const cmd = installCommand('tmux', { root, hasBin: has });
  // Neither root nor sudo: the command below is correct and will still be
  // refused by the package manager. Say that up front rather than letting a
  // permission-denied read as a broken instruction.
  const needsAdmin = !root && !has('sudo') && cmd;
  return 'tmux is not installed on this machine, and Bridge Commander needs it: a lieutenant is a\n'
    + 'real agent session, and it lives in a tmux session so the board can reach it and the\n'
    + 'person can attach to it later. You will never have to type a tmux command yourself.\n\n'
    + (cmd
      ? 'ASK the person for permission, then install it:\n  ' + cmd + '\n'
      : 'I could not identify a package manager here. ASK the person how they want tmux installed.\n')
    + (needsAdmin
      ? '\nNote: this user is not root and there is no `sudo` here, so that command will be refused.\n'
        + 'It needs an administrator — `su -` if they have the root password, or whoever owns the box.\n'
      : '')
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
    + '       useradd -m dev && su - dev\n'
    + '     Then, as that user: install the skill (npx skills add …), install the agent CLI in a\n'
    + '     way that needs no root (curl -fsSL https://claude.ai/install.sh | bash puts it in\n'
    + '     ~/.local/bin — `npm i -g` would fail with EACCES for them), and run this again.\n\n'
    + '  2. This is a throwaway box (a container you will delete) and you accept the risk:\n'
    + '       bc-axi init --onboard --allow-root\n'
    + '     That launches her with IS_SANDBOX=1, which is the escape hatch claude itself checks.\n'
    + '     It turns off a guard that exists because an agent with skipped permissions running as\n'
    + '     root can do anything to the machine. Never on a box you care about.\n\n'
    + 'ASK the person which one. Do not pick --allow-root for them.';
}

// The agent CLI itself. Cheap and certain (is it on PATH?), so it is answered
// before the spawn instead of being guessed at from a timeout afterwards.
//
// The install line has to work for the user who will RUN it. `npm i -g` on a
// stock image writes into a root-owned prefix and fails with EACCES for exactly
// the normal user the root block just told them to become — two blocks that
// contradict each other are worse than either one alone. The official installer
// puts the binary under ~/.local/bin and needs no root, so that is what is
// offered first.
// Installed-but-invisible is a different problem from not-installed, and it has
// a different fix. The curl installer puts the binary in ~/.local/bin and leaves
// the PATH edit to the user; on Debian a normal login shell picks that up from
// ~/.profile, but root's does not — so as root the very next step dies with
// "command not found" and re-running loops forever on the same message.
function agentAtHome(bin) {
  const home = process.env.HOME || '';
  if (!home) return '';
  const p = path.join(home, '.local', 'bin', bin);
  try { fs.accessSync(p, fs.constants.X_OK); return p; } catch (e) { return ''; }
}

function agentMissingText(harness, workspace) {
  const codex = harness === 'codex';
  const bin = codex ? 'codex' : 'claude';
  const here = workspace || '<the workspace folder>';
  const installed = agentAtHome(bin);
  const runByHand = 'Then run it once by hand IN THE WORKSPACE — it has setup screens of its own that a spawned\n'
    + 'session cannot answer (a theme picker, a login, a trust question about this folder, and a\n'
    + 'one-time bypass-permissions consent screen that only the launch flag raises):\n'
    + '  cd ' + here + ' && ' + bin + ' --dangerously-skip-permissions';
  if (installed) {
    return '`' + bin + '` is installed at ' + installed + ' but is not on PATH, so neither I nor her\n'
      + 'session can start it. The board is up and her welcome message is on it.\n\n'
      + 'Put it on PATH for this user — both now and for the shells her session is launched from:\n'
      + '  export PATH="$HOME/.local/bin:$PATH"\n'
      + '  echo \'export PATH="$HOME/.local/bin:$PATH"\' >> ~/.bashrc\n\n'
      + runByHand;
  }
  const install = codex
    ? '  npm i -g @openai/codex          # a user-local npm prefix, or an administrator, may be needed'
    : '  curl -fsSL https://claude.ai/install.sh | bash    # installs to ~/.local/bin — no root needed\n'
      + '  # It does NOT edit your PATH. Afterwards:\n'
      + '  export PATH="$HOME/.local/bin:$PATH" && echo \'export PATH="$HOME/.local/bin:$PATH"\' >> ~/.bashrc\n'
      + '  # (npm i -g @anthropic-ai/claude-code also works, but as a normal user it needs a\n'
      + '  #  user-local prefix: npm config set prefix ~/.npm-global, and that dir on PATH)';
  return 'the `' + bin + '` CLI is not on PATH, so Bridget has nothing to be a session of.\n'
    + 'The board is up and her welcome message is on it — she just cannot answer yet.\n\n'
    + 'ASK the person for permission, then install it as the user who will run it:\n'
    + install + '\n\n'
    + runByHand;
}

// diagnoseSpawn — read the pane, do not guess at it.
//
// A spawn failure arrives with the tail of the session's own pane attached, and
// that tail says exactly what happened. Every branch below is a signature seen
// in a real container; the fallback is the only place a guess is allowed, and it
// is labelled as one. Guessing "not installed, or not logged in" at a pane that
// plainly says something else is how a tester loses an afternoon.
function diagnoseSpawn(text, workspace) {
  const t = String(text || '');
  const tail = (/pane tail:\n([\s\S]*)$/.exec(t) || [, ''])[1].trim();
  const here = workspace || '<the workspace folder>';
  const hit = (re, cause, headline, fix) => (re.test(t) ? { cause, headline, fix, tail } : null);
  // First, because it is the one screen our own launch line raises and the one
  // no hand-run of plain `claude` can ever clear.
  return hit(/Bypass Permissions mode|Yes, I accept/, 'bypass',
    'her pane is on Claude Code\'s one-time bypass-permissions consent screen. That warning is\n'
      + 'raised BY the --dangerously-skip-permissions flag the spawn uses, so running plain `claude`\n'
      + 'never sees it — and it is not mine to accept for anyone: it is consent to an agent that\n'
      + 'skips permission prompts on this machine.',
    'Have the person run the launch line itself, once, and answer 2 (Yes, I accept) — then /exit\n'
      + 'and run the SAME command again:\n'
      + '  cd ' + here + ' && claude --dangerously-skip-permissions\n'
      + '(The preselected option on that screen is "No, exit", so it is theirs to answer, not mine.)')
  || hit(/Quick safety check|trust this folder|Accessing workspace/, 'trust',
    'her pane is on Claude Code\'s folder-trust question for the workspace — it asks about any\n'
      + 'directory it has not already trusted, and it comes BEFORE login.',
    'Trust is inherited from a trusted ancestor, so running `claude` in their home directory MAY\n'
      + 'have cleared it (a workspace under ~ usually is) — but it may not have. Run it in the\n'
      + 'workspace itself, answer the question, quit with /exit, then run the SAME command again:\n'
      + '  cd ' + here + ' && claude')
  || hit(/cannot be used with root\/sudo privileges/, 'root',
    'claude refuses --dangerously-skip-permissions as root, and exited.',
    'Do the first run as a normal user (`useradd -m dev && su - dev`), or, on a throwaway box,\n'
      + 're-run with --allow-root — see the block that command prints before it starts.')
  || hit(/Choose the text style|run \/theme|Let's get started/, 'setup',
    'the `claude` CLI has never been run on this machine — her pane is parked on its setup wizard\n'
      + '(theme picker), which comes BEFORE any login question.',
    'Run it once by hand IN THE WORKSPACE, answer its questions (there is a folder-trust one about\n'
      + 'this directory after the theme), quit with /exit, then run the SAME command again:\n'
      + '  cd ' + here + ' && claude')
  || hit(/command not found|ENOENT|not found: claude/, 'missing',
    'the agent CLI is not installed — the shell answered "command not found".',
    'Install it and run the SAME command again:\n  npm i -g @anthropic-ai/claude-code')
  || hit(/\/login|Invalid API key|not authenticated|Please run .*login|Sign in|log in to/i, 'auth',
    'the `claude` CLI is installed but not logged in — her pane is on its login screen.',
    'Log in once by hand in the workspace, then run the SAME command again:\n'
      + '  cd ' + here + ' && claude   (and follow its login)')
  // The only branch that guesses — and the guess is different depending on
  // whether there was a pane to read. "Read it above" pointing at nothing is
  // worse than saying plainly that there was nothing to read.
  || (tail
    ? { cause: 'unknown', tail,
      headline: 'I could not match her pane to anything I know. What it shows is printed above — act on that.',
      fix: 'If it is a menu or a prompt, it is waiting for a human: run `claude` by hand in the\n'
        + 'workspace (cd ' + here + ' && claude), get it to a working session, then run the SAME\n'
        + 'command again.' }
    : { cause: 'unknown', tail: '',
      headline: 'her pane was empty — the session left nothing on screen to read.',
      fix: 'With nothing to go on, the usual causes are the `claude` CLI missing, never run, or not\n'
        + 'logged in. That is a guess, not something this pane showed. Check it by hand:\n'
        + '  cd ' + here + ' && claude' });
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
  rootBlockText, agentMissingText, agentAtHome, diagnoseSpawn,
};
