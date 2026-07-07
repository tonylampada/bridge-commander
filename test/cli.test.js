'use strict';
// bridge-axi CLI: BRIDGE_DIR plumbing and an end-to-end slice against a test server.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { startServerWithColumns, runCli } = require('./helper');

test('cli config honors BRIDGE_DIR for config.json', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bridge-test-'));
  try {
    let r = await runCli(['config', 'voices', 'alpha,beta'], { BRIDGE_DIR: dir });
    assert.strictEqual(r.code, 0);
    const cfgFile = path.join(dir, 'config.json');
    assert.ok(fs.existsSync(cfgFile), 'config.json written under BRIDGE_DIR');
    assert.deepStrictEqual(JSON.parse(fs.readFileSync(cfgFile, 'utf8')).voices, ['alpha', 'beta']);

    r = await runCli(['config', 'show'], { BRIDGE_DIR: dir });
    assert.deepStrictEqual(JSON.parse(r.stdout).voices, ['alpha', 'beta']);

    r = await runCli(['config', 'voices', ''], { BRIDGE_DIR: dir });
    assert.strictEqual(r.code, 0);
    assert.strictEqual(JSON.parse(fs.readFileSync(cfgFile, 'utf8')).voices, undefined);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('cli create / board / say / ack round-trip against a test server', async () => {
  const s = await startServerWithColumns();
  const env = { BRIDGE_DIR: s.dir };
  const portArgs = ['--port', String(s.port), '--board', s.board];
  try {
    let r = await runCli(['create', '--title', 'CLI card', '--attr', 'repo=alpha', '--label', 'cli', ...portArgs], env);
    assert.strictEqual(r.code, 0, r.stderr);
    assert.match(r.stdout, /created cli-card in todo/);

    r = await runCli(['board', ...portArgs], env);
    assert.match(r.stdout, /cli-card {2}CLI card/);

    // user feedback, then CLI ack commits the server cursor
    await s.api('POST', '/api/feedback', { target: 'card:cli-card', text: 'question from the board' });
    r = await runCli(['ack', '1', ...portArgs], env);
    assert.strictEqual(r.code, 0, r.stderr);
    assert.match(r.stdout, /acked 1 \(committed=1\)/);
    const poll = await s.api('GET', '/api/poll?nowait=1');
    assert.deepStrictEqual(poll.body.events, []);

    // status reads pending feedback from the server-side ack
    r = await runCli(['status', ...portArgs], env);
    assert.match(r.stdout, /pending-feedback=0/);
  } finally {
    await s.stop();
  }
});
