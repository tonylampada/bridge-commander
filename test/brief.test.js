'use strict';
// brief.js — the worker launch prompt. These tests pin universal ground rules
// that EVERY worker must always see, regardless of card type or delivery mode.
const test = require('node:test');
const assert = require('node:assert');
const { workerBrief } = require('../server/brief.js');

function brief(overrides = {}) {
  return workerBrief({
    card: { id: 'demo', title: 'Demo card', type: 'task', body: 'do the thing' },
    thread: [],
    project: { name: 'proj', path: '/repos/proj', mode: 'direct-PR' },
    worktree: '/wt/demo',
    branch: 'bc/demo',
    workspace: '/ws',
    cli: 'bc-axi',
    cardId: 'demo',
    ...overrides,
  });
}

test('ground rules carry the worktree-isolation rule (misplaced-worker check, work only in the worktree)', () => {
  const out = brief();
  assert.match(out, /verify your\n {2}cwd is exactly that worktree/);
  assert.match(out, /Work only inside your worktree\. Never touch the project clone or the workspace directly\./);
});

test('worktree-isolation rule is present for investigation cards too', () => {
  const out = brief({ card: { id: 'demo', title: 'Look into it', type: 'investigation', body: 'why?' } });
  assert.match(out, /Work only inside your worktree\./);
});
