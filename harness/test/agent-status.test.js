'use strict';
// agent-status — claude/codex status() against fixture jsonl files: the slug
// rule, the context-used math, tail-reading huge files, rate limits, and the
// null-never-throw contract for anything missing or malformed.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const {
  claudeProjectSlug, claudeContextWindow, claudeStatus,
  codexRolloutFile, codexStatus, formatStatus,
} = require('../agent-status.js');

function tmpdir(prefix) {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

// A claude transcript assistant line with the given model + usage numbers.
function assistantLine(model, usage) {
  return JSON.stringify({ type: 'assistant', message: { model, usage } }) + '\n';
}
const USAGE = {
  input_tokens: 2,
  cache_creation_input_tokens: 11889,
  cache_read_input_tokens: 109736,
  output_tokens: 245,
};
const USED = 2 + 11889 + 109736 + 245; // the context-used math under test

test('claudeProjectSlug: every non-alphanumeric becomes a dash (verified rule)', () => {
  assert.strictEqual(
    claudeProjectSlug('/home/ai/.treehouse/bridge-commander-0a532c/1/bridge-commander'),
    '-home-ai--treehouse-bridge-commander-0a532c-1-bridge-commander');
});

test('claudeContextWindow: fable 1M, opus/sonnet 200k, unknown default', () => {
  assert.strictEqual(claudeContextWindow('claude-fable-5'), 1000000);
  assert.strictEqual(claudeContextWindow('claude-opus-4-8'), 200000);
  assert.strictEqual(claudeContextWindow('claude-sonnet-5'), 200000);
  assert.strictEqual(claudeContextWindow('some-new-model'), 200000);
});

test('claudeStatus: last assistant line wins; contextUsed sums the four usage fields', () => {
  const projectsDir = tmpdir('bc-status-claude-');
  try {
    const cwd = '/tmp/some.project/wt';
    const sid = 'aaaaaaaa-1111-2222-3333-444444444444';
    const dir = path.join(projectsDir, claudeProjectSlug(cwd));
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, sid + '.jsonl'),
      JSON.stringify({ type: 'user', message: { role: 'user' } }) + '\n'
      + assistantLine('claude-fable-5', { input_tokens: 1, output_tokens: 1 }) // stale — must not win
      + assistantLine('claude-fable-5', USAGE)
      + JSON.stringify({ type: 'progress' }) + '\n'); // trailing non-assistant noise
    const st = claudeStatus({ cwd, resumeId: sid }, { projectsDir });
    assert.deepStrictEqual(st, { model: 'claude-fable-5', contextUsed: USED, contextWindow: 1000000 });
  } finally {
    fs.rmSync(projectsDir, { recursive: true, force: true });
  }
});

test('claudeStatus: tail-reads huge transcripts (last assistant line buried past the first tail window)', () => {
  const projectsDir = tmpdir('bc-status-claude-big-');
  try {
    const cwd = '/tmp/big';
    const sid = 'bbbbbbbb-1111-2222-3333-444444444444';
    const dir = path.join(projectsDir, claudeProjectSlug(cwd));
    fs.mkdirSync(dir, { recursive: true });
    // the assistant line, then ~600KB of non-assistant lines on top of it —
    // beyond the 256KB first tail window, inside the escalation window
    const filler = JSON.stringify({ type: 'user', message: { content: 'x'.repeat(1000) } }) + '\n';
    fs.writeFileSync(path.join(dir, sid + '.jsonl'),
      assistantLine('claude-opus-4-8', USAGE) + filler.repeat(600));
    const st = claudeStatus({ cwd, resumeId: sid }, { projectsDir });
    assert.deepStrictEqual(st, { model: 'claude-opus-4-8', contextUsed: USED, contextWindow: 200000 });
  } finally {
    fs.rmSync(projectsDir, { recursive: true, force: true });
  }
});

test('claudeStatus: null on missing transcript / ref without resumeId — never a throw', () => {
  const projectsDir = tmpdir('bc-status-claude-miss-');
  try {
    assert.strictEqual(claudeStatus({ cwd: '/tmp/x', resumeId: 'nope' }, { projectsDir }), null);
    assert.strictEqual(claudeStatus({ cwd: '/tmp/x' }, { projectsDir }), null);
    assert.strictEqual(claudeStatus(null, { projectsDir }), null);
  } finally {
    fs.rmSync(projectsDir, { recursive: true, force: true });
  }
});

// A codex rollout fixture: session_meta + turn_context + token_count lines.
const THREAD = '019ec130-a849-74b2-802e-a3d3bbb57ee0';
function tokenCountLine(total, rateLimits) {
  return JSON.stringify({
    timestamp: '2026-06-13T13:34:56.765Z',
    type: 'event_msg',
    payload: {
      type: 'token_count',
      info: { total_token_usage: { total_tokens: total }, model_context_window: 258400 },
      rate_limits: rateLimits === undefined ? null : rateLimits,
    },
  }) + '\n';
}
function writeRollout(sessionsDir, day, thread, content) {
  const dir = path.join(sessionsDir, ...day.split('/'));
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, 'rollout-' + day.replace(/\//g, '-') + 'T10-00-00-' + thread + '.jsonl');
  fs.writeFileSync(file, content);
  return file;
}

test('codexStatus: last token_count wins — totals, window, model, rate limits', () => {
  const sessionsDir = tmpdir('bc-status-codex-');
  try {
    writeRollout(sessionsDir, '2026/06/13', THREAD,
      JSON.stringify({ type: 'session_meta', payload: { id: THREAD } }) + '\n'
      + JSON.stringify({ type: 'turn_context', payload: { model: 'gpt-5.5' } }) + '\n'
      + tokenCountLine(11111) // stale — must not win
      + tokenCountLine(58034, {
        primary: { used_percent: 1.0, window_minutes: 300, resets_at: 1781371082 },
        secondary: { used_percent: 21.0, window_minutes: 10080, resets_at: 1781782195 },
      }));
    const st = codexStatus({ resumeId: THREAD }, { sessionsDir });
    assert.deepStrictEqual(st, {
      model: 'gpt-5.5',
      contextUsed: 58034,
      contextWindow: 258400,
      rateLimits: {
        primary: { usedPercent: 1.0, windowMinutes: 300, resetsAt: 1781371082 },
        secondary: { usedPercent: 21.0, windowMinutes: 10080, resetsAt: 1781782195 },
      },
    });
    const text = formatStatus(st);
    assert.match(text, /model: gpt-5\.5/);
    assert.match(text, /context: 58,034 \/ 258,400 tokens \(22%\)/);
    assert.match(text, /5h limit: 1% used/);
    assert.match(text, /1w limit: 21% used/);
  } finally {
    fs.rmSync(sessionsDir, { recursive: true, force: true });
  }
});

test('codexStatus: null rate_limits → field omitted; newest day dir wins the glob', () => {
  const sessionsDir = tmpdir('bc-status-codex2-');
  try {
    writeRollout(sessionsDir, '2026/06/13', THREAD, tokenCountLine(100)); // older duplicate
    writeRollout(sessionsDir, '2026/07/02', THREAD,
      JSON.stringify({ type: 'turn_context', payload: { model: 'gpt-5.5' } }) + '\n'
      + tokenCountLine(200));
    assert.strictEqual(
      codexRolloutFile(THREAD, sessionsDir).includes(path.join('2026', '07', '02')), true);
    const st = codexStatus({ resumeId: THREAD }, { sessionsDir });
    assert.deepStrictEqual(st, { model: 'gpt-5.5', contextUsed: 200, contextWindow: 258400 });
  } finally {
    fs.rmSync(sessionsDir, { recursive: true, force: true });
  }
});

test('codexStatus: null on unknown thread / ref without resumeId — never a throw', () => {
  const sessionsDir = tmpdir('bc-status-codex3-');
  try {
    assert.strictEqual(codexStatus({ resumeId: 'no-such-thread' }, { sessionsDir }), null);
    assert.strictEqual(codexStatus({}, { sessionsDir }), null);
  } finally {
    fs.rmSync(sessionsDir, { recursive: true, force: true });
  }
});

test('formatStatus: claude shape (no rate limits) renders model + context only', () => {
  const text = formatStatus({ model: 'claude-fable-5', contextUsed: 185709, contextWindow: 1000000 });
  assert.strictEqual(text,
    'model: claude-fable-5\n\ncontext: 185,709 / 1,000,000 tokens (19%)');
});
