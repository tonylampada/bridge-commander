'use strict';
// bc-axi CLI: workspace resolution and an end-to-end slice against a test server.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { startServerWithLieutenant, withOwner, LT, runCli } = require('./helper');

test('cli config reads and writes the workspace config.json', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bc-test-'));
  try {
    let r = await runCli(['config', 'voices', 'alpha,beta', '--workspace', dir]);
    assert.strictEqual(r.code, 0, r.stderr);
    const cfgFile = path.join(dir, '.bridge-commander', 'config.json');
    assert.ok(fs.existsSync(cfgFile), 'config.json written under .bridge-commander');
    assert.deepStrictEqual(JSON.parse(fs.readFileSync(cfgFile, 'utf8')).voices, ['alpha', 'beta']);

    r = await runCli(['config', 'show', '--workspace', dir]);
    assert.deepStrictEqual(JSON.parse(r.stdout).voices, ['alpha', 'beta']);

    r = await runCli(['config', 'voices', '', '--workspace', dir]);
    assert.strictEqual(r.code, 0);
    assert.strictEqual(JSON.parse(fs.readFileSync(cfgFile, 'utf8')).voices, undefined);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('cli resolves the workspace by walking up from cwd to .bridge-commander', async () => {
  const s = await startServerWithLieutenant();
  try {
    const nested = path.join(s.dir, 'projects', 'demo-app', 'src');
    fs.mkdirSync(nested, { recursive: true });
    // no --workspace: cwd is deep inside the workspace; port comes from config.json
    const r = await new Promise((resolve) => {
      const { spawn } = require('node:child_process');
      const child = spawn(process.execPath, [require('./helper').CLI, 'status'], {
        cwd: nested, stdio: ['ignore', 'pipe', 'pipe'],
      });
      let stdout = '', stderr = '';
      child.stdout.on('data', (c) => (stdout += c));
      child.stderr.on('data', (c) => (stderr += c));
      child.on('close', (code) => resolve({ code, stdout, stderr }));
    });
    assert.strictEqual(r.code, 0, r.stderr);
    assert.match(r.stdout, /server: up/);
  } finally {
    await s.stop();
  }
});

test('cli accepts global flags in any position relative to the verb', async () => {
  const s = await startServerWithLieutenant();
  try {
    // flags BEFORE the verb — the classic papercut: `--workspace X board` used to
    // print usage because the parser took the verb from argv[0].
    let r = await runCli(['--workspace', s.dir, '--port', String(s.port), 'board']);
    assert.strictEqual(r.code, 0, r.stderr);
    assert.match(r.stdout, /backlog/i);

    // flags interleaved with a two-word verb and its positionals
    r = await runCli(['--workspace', s.dir, 'card', '--port', String(s.port), 'create',
      '--title', 'Interleaved', '--owner', LT]);
    assert.strictEqual(r.code, 0, r.stderr);
    assert.match(r.stdout, /created interleaved in backlog/);

    // flags AFTER the verb still work (unchanged behavior)
    r = await runCli(['board', '--workspace', s.dir, '--port', String(s.port)]);
    assert.strictEqual(r.code, 0, r.stderr);
    assert.match(r.stdout, /Interleaved/);
  } finally {
    await s.stop();
  }
});

test('cli open installs the statusLine, merging into .claude/settings.local.json', async () => {
  const s = await startServerWithLieutenant();
  const args = ['--workspace', s.dir, '--port', String(s.port)];
  const settingsFile = path.join(s.dir, '.claude', 'settings.local.json');
  try {
    // Pre-seed unrelated keys — the merge must preserve them, never clobber.
    fs.mkdirSync(path.dirname(settingsFile), { recursive: true });
    fs.writeFileSync(settingsFile, JSON.stringify({
      permissions: { allow: ['Bash(ls:*)'] },
      hooks: { Stop: [{ hooks: [{ type: 'command', command: 'keep-me' }] }] },
    }));

    let r = await runCli(['open', ...args]);
    assert.strictEqual(r.code, 0, r.stderr);
    let cfg = JSON.parse(fs.readFileSync(settingsFile, 'utf8'));
    assert.strictEqual(cfg.statusLine.type, 'command');
    assert.match(cfg.statusLine.command, /statusline\.js/);
    assert.deepStrictEqual(cfg.permissions, { allow: ['Bash(ls:*)'] }); // preserved
    assert.strictEqual(cfg.hooks.Stop[0].hooks[0].command, 'keep-me'); // preserved

    // Self-heal: delete the file, re-open, it is recreated with the statusLine.
    fs.rmSync(settingsFile);
    r = await runCli(['open', ...args]);
    assert.strictEqual(r.code, 0, r.stderr);
    cfg = JSON.parse(fs.readFileSync(settingsFile, 'utf8'));
    assert.match(cfg.statusLine.command, /statusline\.js/);
  } finally {
    await s.stop();
  }
});

test('cli card create / board / say / drain / ack round-trip against a test server', async () => {
  const s = await startServerWithLieutenant();
  const args = ['--workspace', s.dir, '--port', String(s.port)];
  try {
    let r = await runCli(['card', 'create', '--title', 'CLI card', '--owner', LT, '--type', 'investigation',
      '--attr', 'repo=alpha', '--label', 'cli', ...args]);
    assert.strictEqual(r.code, 0, r.stderr);
    assert.match(r.stdout, /created cli-card in backlog/);

    r = await runCli(['board', ...args]);
    assert.match(r.stdout, /cli-card {2}CLI card/);
    assert.match(r.stdout, /investigation \| ada/);

    r = await runCli(['card', 'show', 'cli-card', ...args]);
    assert.match(r.stdout, /type=investigation, owner=ada/);

    // captain feedback, then CLI drain offers it and ack commits the cursor
    await s.api('POST', '/api/feedback', { target: 'card:cli-card', text: 'question from the board' });
    r = await runCli(['drain', '--lieutenant', LT, '--json', ...args]);
    assert.strictEqual(r.code, 0, r.stderr);
    const items = r.stdout.trim().split('\n').map((l) => JSON.parse(l));
    assert.strictEqual(items.length, 1);
    assert.strictEqual(items[0].kind, 'message');
    assert.strictEqual(items[0].text, 'question from the board');

    // default drain output is agent-ergonomic: card context, next-action hint, ack instruction
    r = await runCli(['drain', '--lieutenant', LT, ...args]);
    assert.strictEqual(r.code, 0, r.stderr);
    assert.match(r.stdout, /1 pending item\(s\):/);
    assert.match(r.stdout, /captain message on card cli-card "CLI card"/);
    assert.match(r.stdout, /question from the board/);
    assert.match(r.stdout, /bc-axi say card:cli-card/);
    assert.match(r.stdout, new RegExp('bc-axi ack ' + items[0].seq));

    r = await runCli(['ack', String(items[0].seq), ...args]);
    assert.strictEqual(r.code, 0, r.stderr);
    assert.match(r.stdout, /acked 1 \(lieutenant=ada committed=1\)/);
    r = await runCli(['drain', ...args]);
    assert.match(r.stdout, /queue empty/);
    r = await runCli(['drain', '--json', ...args]);
    assert.strictEqual(r.stdout.trim(), '');

    // lieutenant reply via say (interlocutor default: the owning lieutenant)
    const sayFile = path.join(s.dir, 'reply.md');
    fs.writeFileSync(sayFile, 'on it, captain');
    r = await runCli(['say', 'card:cli-card', '--text-file', sayFile, ...args], { TMUX: '' });
    assert.strictEqual(r.code, 0, r.stderr);
    const card = (await s.api('GET', '/api/cards/cli-card')).body;
    assert.strictEqual(card.thread[1].author, 'Ada');
    assert.strictEqual(card.thread[1].text, 'on it, captain');

    // an UNIDENTIFIED card-thread say default-notifies the owner (worker-said);
    // only a session-identified owner is exempt (Ada here has no ref)
    r = await runCli(['drain', '--lieutenant', LT, '--json', ...args]);
    const said = r.stdout.trim().split('\n').map((l) => JSON.parse(l));
    assert.strictEqual(said.length, 1);
    assert.strictEqual(said[0].kind, 'worker-said');
    assert.strictEqual(said[0].text, 'on it, captain');
    r = await runCli(['drain', '--lieutenant', LT, ...args]);
    assert.match(r.stdout, /worker said — card cli-card/);
    assert.match(r.stdout, /bc-axi worker send cli-card/);
    r = await runCli(['ack', String(said[0].seq), ...args]);
    assert.strictEqual(r.code, 0, r.stderr);

    // lieutenant handoff via the CLI
    r = await runCli(['card', 'move', 'cli-card', 'review', ...args]);
    assert.match(r.stdout, /moved cli-card -> review/);
    r = await runCli(['card', 'move', 'cli-card', 'peer', ...args]); // not the lieutenant's to set
    assert.strictEqual(r.code, 1);

    // status reads pending queue from the server
    r = await runCli(['status', ...args]);
    assert.match(r.stdout, /pending-queue=0/);
  } finally {
    await s.stop();
  }
});
