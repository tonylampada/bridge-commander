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

test('ground rules carry the process-safety rule (capture pid, never kill by pattern)', () => {
  const out = brief();
  assert.match(out, /Process safety/);
  assert.match(out, /PID=\$!/);
  assert.match(out, /NEVER `pgrep`\/`pkill`\/`kill` by name or/);
  assert.match(out, /freeze or kill YOU/);
});

test('process-safety rule is present for investigation cards too', () => {
  const out = brief({ card: { id: 'demo', title: 'Look into it', type: 'investigation', body: 'why?' } });
  assert.match(out, /Process safety/);
  assert.match(out, /PID=\$!/);
});
