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
    const cfgFile = path.join(dir, '.bridge-command', 'config.json');
    assert.ok(fs.existsSync(cfgFile), 'config.json written under .bridge-command');
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

test('cli resolves the workspace by walking up from cwd to .bridge-command', async () => {
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
    r = await runCli(['drain', '--lieutenant', LT, ...args]);
    assert.strictEqual(r.code, 0, r.stderr);
    const items = r.stdout.trim().split('\n').map((l) => JSON.parse(l));
    assert.strictEqual(items.length, 1);
    assert.strictEqual(items[0].kind, 'message');
    assert.strictEqual(items[0].text, 'question from the board');

    r = await runCli(['ack', String(items[0].seq), ...args]);
    assert.strictEqual(r.code, 0, r.stderr);
    assert.match(r.stdout, /acked 1 \(lieutenant=ada committed=1\)/);
    r = await runCli(['drain', ...args]);
    assert.strictEqual(r.stdout.trim(), '');

    // lieutenant reply via say (interlocutor default: the owning lieutenant)
    const sayFile = path.join(s.dir, 'reply.md');
    fs.writeFileSync(sayFile, 'on it, captain');
    r = await runCli(['say', 'card:cli-card', '--text-file', sayFile, ...args]);
    assert.strictEqual(r.code, 0, r.stderr);
    const card = (await s.api('GET', '/api/cards/cli-card')).body;
    assert.strictEqual(card.thread[1].author, 'Ada');
    assert.strictEqual(card.thread[1].text, 'on it, captain');

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
