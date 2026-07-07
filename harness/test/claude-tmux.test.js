'use strict';
// Unit tests for the tmux-free parts of harness/claude-tmux.js.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const claude = require('../claude-tmux.js');

test('resumable: ref.resumeId, else the hook-recorded session-id file, else false', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bc-claude-state-'));
  try {
    const ref = { harness: 'claude', session: 'bc-x1', cwd: '/tmp' };
    assert.strictEqual(await claude.resumable(ref, { stateDir: dir }), false, 'no id anywhere');
    assert.strictEqual(await claude.resumable({ ...ref, resumeId: 'uuid-1' }, { stateDir: dir }), true, 'ref carries the id');
    fs.writeFileSync(path.join(dir, 'bc-x1.session-id'), 'uuid-recorded\n');
    assert.strictEqual(await claude.resumable(ref, { stateDir: dir }), true, 'recorded id counts');
    fs.writeFileSync(path.join(dir, 'bc-x1.session-id'), '\n');
    assert.strictEqual(await claude.resumable(ref, { stateDir: dir }), false, 'blank record is no id');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
