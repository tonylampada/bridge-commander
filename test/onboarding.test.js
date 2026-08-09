'use strict';
// `bc-axi init --onboard` end to end: an empty folder becomes a board with
// Bridget on it, already talking — and running it a second time resumes that
// first run instead of starting it over.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { startServerWithLieutenant, runCli, freePort } = require('./helper');

// HOME is redirected so the run cannot touch the developer's own ~/.claude
// (the worker-duties skill symlink) or read their real git identity — which
// also puts the git-identity warning path under test for free.
function onboardEnv(home) {
  return {
    HOME: home,
    GIT_CONFIG_GLOBAL: path.join(home, 'gitconfig-none'),
    GIT_CONFIG_SYSTEM: '/dev/null',
  };
}

test('onboarding state is board state: set, read, validated, and shipped with the board', async () => {
  const s = await startServerWithLieutenant();
  try {
    assert.deepStrictEqual((await s.api('GET', '/api/onboarding')).body, { onboarding: null });

    let r = await s.api('POST', '/api/onboarding', { step: 'board-up', gitIdentity: false });
    assert.strictEqual(r.status, 200);
    assert.strictEqual(r.body.onboarding.step, 'board-up');

    r = await s.api('POST', '/api/onboarding', { step: 'project' });
    assert.strictEqual(r.body.onboarding.step, 'project');
    assert.strictEqual(r.body.onboarding.gitIdentity, false, 'a step change keeps what was recorded');

    r = await s.api('POST', '/api/onboarding', { step: 'halfway' });
    assert.strictEqual(r.status, 400, 'an unknown step is refused, not silently stored');

    // The board can see it — that is the whole point of it not being a local file.
    const board = await s.api('GET', '/api/board');
    assert.strictEqual(board.body.onboarding.step, 'project');
  } finally { await s.stop(); }
});

test('init --onboard leaves a board with Bridget on it, and a re-run resumes', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bc-onboard-'));
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'bc-home-'));
  const port = await freePort();
  const args = ['init', '--onboard', '--workspace', dir, '--port', String(port), '--harness', 'fake'];
  try {
    let r = await runCli(args, onboardEnv(home));
    assert.strictEqual(r.code, 0, r.stderr + r.stdout);
    assert.match(r.stdout, new RegExp('board: http://localhost:' + port + '/'));
    // git identity is a WARNING, never a wall: the board came up without one.
    assert.match(r.stderr, /git has no identity here/);

    const api = async (p) => (await fetch('http://127.0.0.1:' + port + p)).json();

    // …a chartered lieutenant, spawned…
    const { lieutenants } = await api('/api/board');
    assert.strictEqual(lieutenants.length, 1);
    const bridget = lieutenants[0];
    assert.strictEqual(bridget.id, 'bridget');
    assert.strictEqual(bridget.prefix, 'BRI');
    assert.ok(bridget.ref && bridget.ref.session, 'her session was started');
    const charter = fs.readFileSync(path.join(dir, 'lieutenants', 'bridget', 'README.md'), 'utf8');
    assert.match(charter, /onboarding lieutenant/i);
    assert.match(charter, /bc-axi onboarding/, 'her charter tells her where the first-run state is');

    // …with a message already waiting, before anyone has said anything.
    assert.strictEqual(bridget.chat.length, 1);
    assert.strictEqual(bridget.chat[0].author, 'Bridget');
    assert.match(bridget.chat[0].text, /Welcome aboard/);

    // …and first-run state the board can see.
    assert.strictEqual((await api('/api/onboarding')).onboarding.step, 'board-up');
    assert.strictEqual((await api('/api/onboarding')).onboarding.gitIdentity, false);

    // A re-run is a resume: no second welcome, no second charter, no spawning
    // over a live session, and the step it had reached is kept.
    r = await runCli(['onboarding', 'set', 'tools', '--workspace', dir, '--port', String(port)]);
    assert.strictEqual(r.code, 0, r.stderr);
    r = await runCli(args, onboardEnv(home));
    assert.strictEqual(r.code, 0, r.stderr + r.stdout);
    assert.match(r.stdout, /charter left alone/);
    assert.match(r.stdout, /welcome message already on the board/);
    assert.match(r.stdout, /session is already live/);
    assert.match(r.stdout, /resuming, not restarting/);

    const after = (await api('/api/board')).lieutenants[0];
    assert.strictEqual(after.chat.length, 1, 'the welcome is seeded exactly once');
    assert.strictEqual((await api('/api/onboarding')).onboarding.step, 'tools');

    r = await runCli(['onboarding', '--workspace', dir, '--port', String(port), '--json']);
    assert.strictEqual(JSON.parse(r.stdout).step, 'tools');
  } finally {
    await runCli(['stop', '--workspace', dir, '--port', String(port)]);
    fs.rmSync(dir, { recursive: true, force: true });
    fs.rmSync(home, { recursive: true, force: true });
  }
});

test('init --onboard continues an existing workspace instead of refusing it', async () => {
  // The re-entry case, and the reason the workspace check comes first: this
  // folder is now full of the scaffolding a code-project test would trip on.
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bc-onboard-'));
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'bc-home-'));
  const port = await freePort();
  const args = ['init', '--onboard', '--workspace', dir, '--port', String(port), '--harness', 'fake'];
  try {
    fs.writeFileSync(path.join(dir, 'package.json'), '{}'); // a repo would be refused…
    let r = await runCli(args, onboardEnv(home));
    assert.strictEqual(r.code, 1);
    assert.match(r.stderr, /first run refused \(project\)/);

    // …until the person says this folder is the workspace.
    r = await runCli(args.concat('--here'), onboardEnv(home));
    assert.strictEqual(r.code, 0, r.stderr + r.stdout);

    // From here on the workspace answer wins on its own — no --here needed.
    r = await runCli(args, onboardEnv(home));
    assert.strictEqual(r.code, 0, r.stderr + r.stdout);
    assert.match(r.stdout, /welcome message already on the board/);
  } finally {
    await runCli(['stop', '--workspace', dir, '--port', String(port)]);
    fs.rmSync(dir, { recursive: true, force: true });
    fs.rmSync(home, { recursive: true, force: true });
  }
});

test('--host on an already-running board rebinds it, prints the reachable URL, and persists', async () => {
  // Round 2 of the install test: the person gets a board first and discovers
  // only afterwards that their browser cannot reach it. Asking for a bind at
  // that point used to do nothing at all — "server already running", still
  // loopback, still printing localhost, and nothing written down.
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bc-onboard-'));
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'bc-home-'));
  const port = await freePort();
  const base = ['init', '--onboard', '--workspace', dir, '--port', String(port), '--harness', 'fake'];
  // A second loopback address: bindable, not 127.0.0.1, and reachable from here
  // — so this stays a real rebind without opening anything to the network.
  const HOST = '127.0.0.2';
  try {
    let r = await runCli(base, onboardEnv(home));
    assert.strictEqual(r.code, 0, r.stderr + r.stdout);
    assert.match(r.stdout, /board: http:\/\/localhost:/, 'a loopback board says localhost');

    r = await runCli(base.concat('--host', HOST), onboardEnv(home));
    assert.strictEqual(r.code, 0, r.stderr + r.stdout);
    assert.match(r.stderr, /restarting it on the new address/, 'the flag is not silently ignored');
    assert.match(r.stdout, new RegExp('board: http://' + HOST + ':' + port + '/'),
      'the URL handed over is the one that works');
    assert.doesNotMatch(r.stdout, /board: http:\/\/localhost/);

    const cfg = JSON.parse(fs.readFileSync(path.join(dir, '.bridge-commander', 'config.json'), 'utf8'));
    assert.strictEqual(cfg.host, HOST, 'a bind that does not survive a restart is not a bind');
    const st = await (await fetch('http://' + HOST + ':' + port + '/api/status')).json();
    assert.strictEqual(st.host, HOST, 'and the server says what it actually bound');
  } finally {
    await runCli(['stop', '--workspace', dir, '--port', String(port)]);
    fs.rmSync(dir, { recursive: true, force: true });
    fs.rmSync(home, { recursive: true, force: true });
  }
});

// The walk-forward test needs a base OUTSIDE the ephemeral range: it binds
// base+1 itself, and a port the OS is still handing out to freePort() is a port
// another test in this run is about to try to bind.
function squatLowPort() {
  return new Promise((resolve, reject) => {
    let port = 4900;
    const tryOne = () => {
      if (port > 4990) return reject(new Error('no free port in 4900-4990'));
      const srv = require('node:net').createServer();
      srv.once('error', () => { port += 2; tryOne(); });
      srv.listen(port, '127.0.0.1', () => resolve({ srv, port }));
    };
    tryOne();
  });
}

test('init --onboard walks forward off a port somebody else is holding', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bc-onboard-'));
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'bc-home-'));
  const { srv: squatter, port: taken } = await squatLowPort();
  try {
    const r = await runCli(
      ['init', '--onboard', '--workspace', dir, '--port', String(taken), '--harness', 'fake'],
      onboardEnv(home));
    assert.strictEqual(r.code, 0, r.stderr + r.stdout);
    assert.match(r.stderr, new RegExp('port ' + taken + ' was taken'));
    const used = JSON.parse(fs.readFileSync(path.join(dir, '.bridge-commander', 'config.json'), 'utf8')).port;
    assert.ok(used > taken, 'it moved forward and wrote the port it landed on');
    // …and wrote it down, so every later bc-axi call in this workspace finds it.
    const st = await runCli(['status', '--workspace', dir]);
    assert.match(st.stdout, /server: up/);
    await runCli(['stop', '--workspace', dir]);
  } finally {
    squatter.close();
    fs.rmSync(dir, { recursive: true, force: true });
    fs.rmSync(home, { recursive: true, force: true });
  }
});
