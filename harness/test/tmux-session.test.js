'use strict';
const test = require('node:test');
const assert = require('node:assert');
const { detectLaunchFailure } = require('../tmux-session.js');

test('detectLaunchFailure: missing CLI gets a crisp reason', () => {
  const sig = {
    failureDetectors: [
      { re: /claude: command not found/i, message: 'claude CLI is not installed or not on PATH; install Claude Code and retry' },
    ],
  };
  assert.strictEqual(
    detectLaunchFailure(sig, 'bash: claude: command not found'),
    'claude CLI is not installed or not on PATH; install Claude Code and retry'
  );
});

test('detectLaunchFailure: sign-in screen gets a crisp reason', () => {
  const sig = {
    failureDetectors: [
      { re: /sign in to openai|codex login/i, message: 'codex CLI is waiting for interactive sign-in; run `codex login` in a normal terminal and retry' },
    ],
  };
  assert.strictEqual(
    detectLaunchFailure(sig, 'OpenAI Codex Login\nSign in to OpenAI to continue'),
    'codex CLI is waiting for interactive sign-in; run `codex login` in a normal terminal and retry'
  );
});

test('detectLaunchFailure: unmatched pane tail yields null', () => {
  const sig = { failureDetectors: [{ re: /command not found/i, message: 'missing' }] };
  assert.strictEqual(detectLaunchFailure(sig, 'all good\n❯'), null);
});
