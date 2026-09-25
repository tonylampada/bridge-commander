'use strict';
// permission-hook.js end to end: a real child process, a real stdin payload and
// a tiny HTTP server playing the board. What claude sees is only the hook's
// stdout and exit code, so that is what is pinned.
const test = require('node:test');
const assert = require('node:assert');
const http = require('node:http');
const path = require('node:path');
const { spawn } = require('node:child_process');

const SCRIPT = path.join(__dirname, '..', 'permission-hook.js');
const PAYLOAD = {
  session_id: 'sess-1', cwd: '/work/tree', transcript_path: '/t.jsonl', permission_mode: 'auto',
  hook_event_name: 'PermissionRequest', tool_name: 'Bash', tool_input: { command: 'rm -rf build' },
};

// board(reply) -> { url, bodies, close } — reply(req body) returns [status, text].
function board(reply) {
  const bodies = [];
  const srv = http.createServer((req, res) => {
    let data = '';
    req.on('data', (c) => (data += c));
    req.on('end', () => {
      bodies.push({ method: req.method, url: req.url, body: JSON.parse(data) });
      const [status, text] = reply();
      res.writeHead(status, { 'content-type': 'application/json' });
      res.end(text);
    });
  });
  return new Promise((resolve) => srv.listen(0, '127.0.0.1', () => resolve({
    url: `http://127.0.0.1:${srv.address().port}/api/permission`,
    bodies,
    close: () => new Promise((r) => srv.close(r)),
  })));
}

function runHook(url, stdin) {
  return new Promise((resolve) => {
    const env = { ...process.env };
    delete env.TMUX; // no tmux lookup from inside a test
    const child = spawn(process.execPath, [SCRIPT, '/state', 'bc-lt:w-card', url], { env });
    let stdout = '';
    child.stdout.on('data', (c) => (stdout += c));
    child.on('close', (code) => resolve({ code, stdout }));
    child.stdin.end(stdin);
  });
}

test('the request reaches the board with the session key and the tool', async () => {
  const b = await board(() => [200, '{"decision":null}']);
  try {
    await runHook(b.url, JSON.stringify(PAYLOAD));
    assert.strictEqual(b.bodies.length, 1);
    const { method, url, body } = b.bodies[0];
    assert.strictEqual(method, 'POST');
    assert.strictEqual(url, '/api/permission');
    assert.strictEqual(body.session, 'bc-lt:w-card');
    assert.strictEqual(body.session_id, 'sess-1');
    assert.strictEqual(body.cwd, '/work/tree');
    assert.strictEqual(body.tmux_session, '');
    assert.strictEqual(body.tool_name, 'Bash');
    assert.deepStrictEqual(body.tool_input, { command: 'rm -rf build' });
    assert.strictEqual(body.permission_mode, 'auto');
    assert.ok(!Number.isNaN(Date.parse(body.ts)));
  } finally { await b.close(); }
});

test('allow and deny become the hook decision claude reads', async () => {
  const cases = [
    ['{"decision":"allow"}', { behavior: 'allow' }],
    ['{"decision":"deny","message":"not on main"}', { behavior: 'deny', message: 'not on main' }],
    ['{"decision":"deny"}', { behavior: 'deny', message: 'Denied by the captain on the board' }],
  ];
  for (const [reply, decision] of cases) {
    const b = await board(() => [200, reply]);
    try {
      const r = await runHook(b.url, JSON.stringify(PAYLOAD));
      assert.strictEqual(r.code, 0);
      assert.deepStrictEqual(JSON.parse(r.stdout),
        { hookSpecificOutput: { hookEventName: 'PermissionRequest', decision } }, reply);
    } finally { await b.close(); }
  }
});

// No decision must never turn into one: claude's own dialog is the fallback.
test('no decision, a server error, bad JSON or no server print nothing and exit 0', async () => {
  for (const reply of [[200, '{"decision":null}'], [200, '{}'], [500, '{"decision":"allow"}'], [200, 'not json']]) {
    const b = await board(() => reply);
    try {
      const r = await runHook(b.url, JSON.stringify(PAYLOAD));
      assert.deepStrictEqual(r, { code: 0, stdout: '' }, JSON.stringify(reply));
    } finally { await b.close(); }
  }
  const gone = await board(() => [200, '{}']);
  const url = gone.url;
  await gone.close();
  assert.deepStrictEqual(await runHook(url, JSON.stringify(PAYLOAD)), { code: 0, stdout: '' });
});

test('a payload that is not JSON asks nobody and prints nothing', async () => {
  const b = await board(() => [200, '{"decision":"allow"}']);
  try {
    assert.deepStrictEqual(await runHook(b.url, 'garbage'), { code: 0, stdout: '' });
    assert.strictEqual(b.bodies.length, 0);
  } finally { await b.close(); }
});
