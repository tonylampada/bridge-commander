import test from 'node:test';
import assert from 'node:assert/strict';
import { buildSetupState } from '../ui/js/onboarding.mjs';

function sampleDoc(overrides = {}) {
  return {
    lieutenants: [],
    cards: [],
    projects: [],
    workers: [],
    ...overrides,
  };
}

test('buildSetupState shows onboarding gaps for a fresh board', () => {
  const state = buildSetupState(sampleDoc(), { workspace: '/tmp/myfleet', queue_pending: 0 }, true);
  assert.equal(state.show, true);
  assert.equal(state.workspace, 'myfleet');
  assert.equal(state.items.find((item) => item.key === 'session').done, false);
  assert.equal(state.items.find((item) => item.key === 'card').done, false);
  assert.equal(state.actions.some((action) => action.id === 'add-lieutenant'), true);
  assert.match(state.nextStep, /registering a lieutenant session/i);
});

test('buildSetupState collapses once the board is ready', () => {
  const state = buildSetupState(sampleDoc({
    lieutenants: [{ id: 'ops', ref: { harness: 'claude', session: 'bc-ops', cwd: '/tmp/myfleet' } }],
    cards: [{ id: 'card-1' }],
    projects: [{ name: 'bridge-commander', mode: 'local-only', path: '/tmp/myfleet/projects/bridge-commander' }],
    workers: [{ card: 'card-1', ref: { harness: 'claude', session: 'bc-ops:1', cwd: '/tmp/myfleet' } }],
  }), { workspace: '/tmp/myfleet', queue_pending: 2 }, true);
  assert.equal(state.show, false);
  assert.equal(state.items.find((item) => item.key === 'session').done, true);
  assert.equal(state.items.find((item) => item.key === 'project').done, true);
  assert.equal(state.items.find((item) => item.key === 'harness').done, true);
  assert.equal(state.counts.queuePending, 2);
});
