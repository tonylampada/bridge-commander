'use strict';
// Unit tests for harness/codex-notify.js — the codex turn-end relay.
// The relay is exercised the way codex runs it: as a child process with the
// payload JSON appended as the final argv.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const http = require('node:http');
const { execFile } = require('node:child_process');

const RELAY = path.join(__dirname, '..', 'codex-notify.js');

function runRelay(args, env = {}) {
  return new Promise((resolve, reject) => {
    execFile('node', [RELAY, ...args], { encoding: 'utf8', env: { ...process.env, ...env } },
      (err, stdout, stderr) => (err ? reject(Object.assign(err, { stderr })) : resolve({ stdout, stderr })));
  });
}

function payload(overrides = {}) {
  return JSON.stringify({
    type: 'agent-turn-complete',
    'thread-id': '019f49a7-81f4-7ad3-822d-3acf8cf81ed6',
    'turn-id': 'turn-1',
    cwd: '/abs/worktree',
    'input-messages': ['do the thing'],
    'last-assistant-message': 'PONG',
    ...overrides,
  });
}

test('codex-notify normalizes agent-turn-complete into the claude-relay event shape', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bc-codex-notify-'));
  try {
    await runRelay([dir, 'bc-x1', payload()]);
    assert.strictEqual(
      fs.readFileSync(path.join(dir, 'bc-x1.session-id'), 'utf8'),
      '019f49a7-81f4-7ad3-822d-3acf8cf81ed6\n',
      'thread-id recorded as the resume ground truth');
    const lines = fs.readFileSync(path.join(dir, 'bc-x1.turnend.jsonl'), 'utf8').trim().split('\n');
    assert.strictEqual(lines.length, 1);
    const ev = JSON.parse(lines[0]);
    assert.strictEqual(ev.session, 'bc-x1');
    assert.strictEqual(ev.event, 'turn-end');
    assert.strictEqual(ev.session_id, '019f49a7-81f4-7ad3-822d-3acf8cf81ed6');
    assert.strictEqual(ev.cwd, '/abs/worktree');
    assert.ok(typeof ev.ts === 'string' && !Number.isNaN(Date.parse(ev.ts)), 'ts is a timestamp');
    assert.ok('tmux_session' in ev, 'tmux_session present (may be empty outside tmux)');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('codex-notify keys state files by the session:window form for window-granular agents', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bc-codex-notify-'));
  try {
    await runRelay([dir, 'bc-lt-a:w-card-7', payload()]);
    assert.ok(fs.existsSync(path.join(dir, 'bc-lt-a:w-card-7.session-id')));
    const ev = JSON.parse(fs.readFileSync(path.join(dir, 'bc-lt-a:w-card-7.turnend.jsonl'), 'utf8').trim());
    assert.strictEqual(ev.session, 'bc-lt-a:w-card-7');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('codex-notify ignores junk payloads and non-turn-complete kinds (still exits 0)', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bc-codex-notify-'));
  try {
    await runRelay([dir, 'bc-x2', 'not json {{{']);
    await runRelay([dir, 'bc-x2', JSON.stringify({ type: 'something-else', 'thread-id': 'nope' })]);
    await runRelay([dir, 'bc-x2']); // payload argv missing entirely
    assert.ok(!fs.existsSync(path.join(dir, 'bc-x2.session-id')), 'no session-id from junk');
    assert.ok(!fs.existsSync(path.join(dir, 'bc-x2.turnend.jsonl')), 'no event from junk');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('codex-notify appends (never truncates) and refreshes the session-id every turn', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bc-codex-notify-'));
  try {
    await runRelay([dir, 'bc-x3', payload()]);
    await runRelay([dir, 'bc-x3', payload({ 'thread-id': 'fresh-thread-id', 'turn-id': 'turn-2' })]);
    const lines = fs.readFileSync(path.join(dir, 'bc-x3.turnend.jsonl'), 'utf8').trim().split('\n');
    assert.strictEqual(lines.length, 2, 'one line per turn boundary');
    assert.strictEqual(
      fs.readFileSync(path.join(dir, 'bc-x3.session-id'), 'utf8'),
      'fresh-thread-id\n',
      'latest thread-id wins');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('codex-notify POSTs the event to the url argv (and still writes files)', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bc-codex-notify-'));
  const got = [];
  const server = http.createServer((req, res) => {
    let body = '';
    req.on('data', (c) => (body += c));
    req.on('end', () => {
      got.push({ url: req.url, body: JSON.parse(body) });
      res.end('{"ok":true}');
    });
  });
  try {
    await new Promise((r) => server.listen(0, '127.0.0.1', r));
    const url = `http://127.0.0.1:${server.address().port}/api/turn-end`;
    await runRelay([dir, 'bc-x4', url, payload()]);
    assert.strictEqual(got.length, 1, 'exactly one POST');
    assert.strictEqual(got[0].url, '/api/turn-end');
    assert.strictEqual(got[0].body.session, 'bc-x4');
    assert.strictEqual(got[0].body.session_id, '019f49a7-81f4-7ad3-822d-3acf8cf81ed6');
    assert.strictEqual(got[0].body.event, 'turn-end');
    assert.ok(fs.existsSync(path.join(dir, 'bc-x4.turnend.jsonl')), 'marker file written too');
  } finally {
    server.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('codex-notify survives an unreachable callback url (files written, exit 0)', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bc-codex-notify-'));
  try {
    await runRelay([dir, 'bc-x5', 'http://127.0.0.1:1/nope', payload()]);
    assert.ok(fs.existsSync(path.join(dir, 'bc-x5.turnend.jsonl')));
    assert.ok(fs.existsSync(path.join(dir, 'bc-x5.session-id')));
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
