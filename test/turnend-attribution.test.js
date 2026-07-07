'use strict';
// Turn-end attribution by tmux session. The Stop hook runs inside the agent's
// own pane, so its tmux_session names the owning lieutenant's ref.session
// exactly — adoption works for any number of founders, and a stray claude in
// the workspace can never be adopted as a lieutenant's resumeId. The legacy
// single-candidate adoption survives only for old hooks (no tmux_session
// field), and even then refuses a session_id whose cwd is foreign.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawn } = require('node:child_process');
const { startServer } = require('./helper');

const HOOK = path.join(__dirname, '..', 'harness', 'turnend-hook.js');

function lts(s) {
  return s.api('GET', '/api/lieutenants').then((r) => r.body.lieutenants);
}

test('two founders both learn their resumeIds via tmux_session', async () => {
  const s = await startServer();
  try {
    await s.api('POST', '/api/lieutenants', { name: 'Alpha', id: 'alpha', ref: { harness: 'fake', session: 'tmux-alpha', cwd: '/tmp' } });
    await s.api('POST', '/api/lieutenants', { name: 'Beta', id: 'beta', ref: { harness: 'fake', session: 'tmux-beta', cwd: '/tmp' } });

    // with two resumeId-less founders the old single-candidate adoption could
    // never fire; tmux attribution resolves each exactly
    let r = await s.api('POST', '/api/turn-end', { session: 'ws', session_id: 'uuid-alpha', cwd: '/tmp', tmux_session: 'tmux-alpha' });
    assert.strictEqual(r.body.lieutenant, 'alpha');
    r = await s.api('POST', '/api/turn-end', { session: 'ws', session_id: 'uuid-beta', cwd: '/tmp', tmux_session: 'tmux-beta' });
    assert.strictEqual(r.body.lieutenant, 'beta');
    let all = await lts(s);
    assert.strictEqual(all.find((l) => l.id === 'alpha').ref.resumeId, 'uuid-alpha');
    assert.strictEqual(all.find((l) => l.id === 'beta').ref.resumeId, 'uuid-beta');
    assert.strictEqual(all.find((l) => l.id === 'alpha').turns, 1);

    // a changed session_id from the same pane refreshes (hook payload is ground truth)
    r = await s.api('POST', '/api/turn-end', { session: 'ws', session_id: 'uuid-alpha-v2', cwd: '/tmp', tmux_session: 'tmux-alpha' });
    assert.strictEqual(r.body.lieutenant, 'alpha');
    all = await lts(s);
    assert.strictEqual(all.find((l) => l.id === 'alpha').ref.resumeId, 'uuid-alpha-v2');
  } finally {
    await s.stop();
  }
});

test('a stray session with a foreign tmux_session is dropped, never adopted', async () => {
  const s = await startServer();
  try {
    // a resumeId-less founder — exactly the candidate the old adoption would hand the stray to
    await s.api('POST', '/api/lieutenants', { name: 'Founder', id: 'founder', ref: { harness: 'fake', session: 'tmux-founder', cwd: '/tmp' } });
    const r = await s.api('POST', '/api/turn-end', { session: 'ws', session_id: 'uuid-stray', cwd: '/tmp', tmux_session: 'captains-own-tmux' });
    assert.strictEqual(r.status, 200);
    assert.strictEqual(r.body.lieutenant, null);
    assert.strictEqual((await lts(s))[0].ref.resumeId, undefined, 'the stray must not become the founder\'s resumeId');
  } finally {
    await s.stop();
  }
});

test('a window-worker hook (session:window key) is never attributed to the cohabited lieutenant', async () => {
  const s = await startServer();
  try {
    // Workers live as windows INSIDE the lieutenant's session, so a worker
    // hook's tmux_session IS the lieutenant's session name. A stale worker
    // POST (its registry record already gone) must not fall through to tmux
    // attribution and corrupt the lieutenant's resumeId.
    await s.api('POST', '/api/lieutenants', { name: 'Monica', id: 'monica',
      ref: { harness: 'fake', session: 'bc-x-lt-monica', cwd: '/tmp', resumeId: 'uuid-lt' } });
    const r = await s.api('POST', '/api/turn-end', {
      session: 'bc-x-lt-monica:w-gone-card', session_id: 'uuid-stale-worker',
      cwd: '/tmp/worktree', tmux_session: 'bc-x-lt-monica',
    });
    assert.strictEqual(r.status, 200);
    assert.strictEqual(r.body.lieutenant, null);
    assert.strictEqual((await lts(s))[0].ref.resumeId, 'uuid-lt', 'lieutenant resumeId untouched');
  } finally {
    await s.stop();
  }
});

test('legacy hooks (no tmux_session field): single-candidate adoption holds, foreign cwd refused', async () => {
  const s = await startServer();
  try {
    await s.api('POST', '/api/lieutenants', { name: 'Old Founder', id: 'oldf', ref: { harness: 'fake', session: 'tmux-oldf', cwd: '/tmp' } });

    // foreign cwd: some other claude on the machine — refused
    let r = await s.api('POST', '/api/turn-end', { session: 'ws', session_id: 'uuid-foreign', cwd: '/somewhere/else' });
    assert.strictEqual(r.body.lieutenant, null);
    assert.strictEqual((await lts(s))[0].ref.resumeId, undefined);

    // matching cwd: the founding teleport learns its claude id as before
    r = await s.api('POST', '/api/turn-end', { session: 'ws', session_id: 'uuid-legacy', cwd: '/tmp' });
    assert.strictEqual(r.body.lieutenant, 'oldf');
    assert.strictEqual((await lts(s))[0].ref.resumeId, 'uuid-legacy');
  } finally {
    await s.stop();
  }
});

// The hook script itself: enriches the recorded event with tmux_session from
// its own pane ($TMUX + tmux display-message), empty when not under tmux, and
// never fails either way.
function runHook(stateDir, session, payload, env) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [HOOK, stateDir, session], {
      env: Object.assign({}, process.env, env),
      stdio: ['pipe', 'ignore', 'pipe'],
    });
    child.stdin.end(JSON.stringify(payload));
    child.on('close', (code) => resolve(code));
  });
}

test('turnend-hook records tmux_session when under tmux, empty string otherwise', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'bc-hook-'));
  try {
    // stub tmux on PATH answering the pane's session name
    const bin = path.join(root, 'bin');
    fs.mkdirSync(bin);
    fs.writeFileSync(path.join(bin, 'tmux'), '#!/bin/sh\necho my-pane-session\n');
    fs.chmodSync(path.join(bin, 'tmux'), 0o755);
    const stateDir = path.join(root, 'state');
    const payload = { hook_event_name: 'Stop', session_id: 'uuid-h', cwd: '/tmp' };

    let code = await runHook(stateDir, 'ws', payload, { TMUX: '/tmp/stub,1,0', PATH: bin + ':' + process.env.PATH });
    assert.strictEqual(code, 0);
    let events = fs.readFileSync(path.join(stateDir, 'ws.turnend.jsonl'), 'utf8').split('\n').filter(Boolean).map(JSON.parse);
    assert.strictEqual(events[0].tmux_session, 'my-pane-session');
    assert.strictEqual(events[0].session_id, 'uuid-h');

    // outside tmux: empty string, hook still exits 0 and records the boundary
    const env = { PATH: bin + ':' + process.env.PATH };
    delete env.TMUX;
    code = await runHook(stateDir, 'ws', payload, Object.assign(env, { TMUX: '' }));
    assert.strictEqual(code, 0);
    events = fs.readFileSync(path.join(stateDir, 'ws.turnend.jsonl'), 'utf8').split('\n').filter(Boolean).map(JSON.parse);
    assert.strictEqual(events.length, 2);
    assert.strictEqual(events[1].tmux_session, '');
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
