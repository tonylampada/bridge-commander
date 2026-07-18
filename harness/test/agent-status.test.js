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
  claudeSidecarStatus, findBridgeWorkspace,
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

// ---------- claude statusline sidecar ----------
// The sidecar (statusline.js writes it) carries the REAL context window that the
// transcript+map path can only guess. Written under <workspace>/
// .bridge-commander/statusline/<session_id>.json.
function writeSidecar(workspace, sid, payload, now) {
  const dir = path.join(workspace, '.bridge-commander', 'statusline');
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, sid + '.json'),
    JSON.stringify({ receivedAt: now || '2026-07-14T00:00:00.000Z', payload }));
}

test('claudeStatus: prefers the sidecar — real 1M window + rate limits (Opus case)', () => {
  const ws = tmpdir('bc-status-sidecar-');
  try {
    fs.mkdirSync(path.join(ws, '.bridge-commander'), { recursive: true });
    const sid = 'sc-1111-2222';
    writeSidecar(ws, sid, {
      session_id: sid,
      cwd: ws,
      model: { id: 'claude-opus-4-8', display_name: 'Opus 4.8' },
      effort: { level: 'high' },
      context_window: { context_window_size: 1000000, total_input_tokens: 118213, used_percentage: 11.8 },
      rate_limits: {
        five_hour: { used_percentage: 42, resets_at: 2000000000 },
        seven_day: { used_percentage: 7, resets_at: 2000100000 },
      },
    });
    // A transcript with the OLD 200k guess also exists — the sidecar must win.
    const projectsDir = tmpdir('bc-status-sidecar-tx-');
    try {
      const tdir = path.join(projectsDir, claudeProjectSlug(ws));
      fs.mkdirSync(tdir, { recursive: true });
      fs.writeFileSync(path.join(tdir, sid + '.jsonl'), assistantLine('claude-opus-4-8', USAGE));
      const st = claudeStatus({ cwd: ws, resumeId: sid }, { projectsDir });
      assert.strictEqual(st.contextWindow, 1000000);
      assert.strictEqual(st.contextUsed, 118213);
      assert.strictEqual(st.model, 'claude-opus-4-8');
      assert.strictEqual(st.effort, 'high');
      assert.deepStrictEqual(st.rateLimits, {
        primary: { usedPercent: 42, windowMinutes: 300, resetsAt: 2000000000 },
        secondary: { usedPercent: 7, windowMinutes: 10080, resetsAt: 2000100000 },
      });
      assert.match(formatStatus(st), /model: claude-opus-4-8 \(high\)/);
      assert.match(formatStatus(st), /context: 118,213 \/ 1,000,000 tokens \(12%\)/);
      assert.match(formatStatus(st), /5h limit: 42% used/);
      assert.match(formatStatus(st), /1w limit: 7% used/);
    } finally {
      fs.rmSync(projectsDir, { recursive: true, force: true });
    }
  } finally {
    fs.rmSync(ws, { recursive: true, force: true });
  }
});

test('claudeSidecarStatus: no effort field → effort absent from the status shape', () => {
  const ws = tmpdir('bc-status-sidecar-noeffort-');
  try {
    const sid = 'noeffort-1';
    writeSidecar(ws, sid, {
      session_id: sid,
      cwd: ws,
      model: { id: 'claude-opus-4-8' },
      context_window: { context_window_size: 200000, total_input_tokens: 5000 },
    });
    const st = claudeSidecarStatus({ cwd: ws, resumeId: sid });
    assert.deepStrictEqual(st, { model: 'claude-opus-4-8', contextUsed: 5000, contextWindow: 200000 });
    assert.strictEqual(formatStatus(st), 'model: claude-opus-4-8\n\ncontext: 5,000 / 200,000 tokens (3%)');
  } finally {
    fs.rmSync(ws, { recursive: true, force: true });
  }
});

test('claudeStatus: no sidecar → transcript+map fallback unchanged (opus → 200k)', () => {
  const ws = tmpdir('bc-status-nosidecar-');
  const projectsDir = tmpdir('bc-status-nosidecar-tx-');
  try {
    fs.mkdirSync(path.join(ws, '.bridge-commander'), { recursive: true }); // workspace, but NO statusline/ dir
    const sid = 'nofile-1111';
    const tdir = path.join(projectsDir, claudeProjectSlug(ws));
    fs.mkdirSync(tdir, { recursive: true });
    fs.writeFileSync(path.join(tdir, sid + '.jsonl'), assistantLine('claude-opus-4-8', USAGE));
    const st = claudeStatus({ cwd: ws, resumeId: sid }, { projectsDir });
    assert.deepStrictEqual(st, { model: 'claude-opus-4-8', contextUsed: USED, contextWindow: 200000 });
  } finally {
    fs.rmSync(ws, { recursive: true, force: true });
    fs.rmSync(projectsDir, { recursive: true, force: true });
  }
});

test('claudeSidecarStatus: bad JSON / missing window → null (falls through), never throws', () => {
  const ws = tmpdir('bc-status-sidecar-bad-');
  try {
    const dir = path.join(ws, '.bridge-commander', 'statusline');
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, 'bad.json'), '{not json');
    assert.strictEqual(claudeSidecarStatus({ cwd: ws, resumeId: 'bad' }), null);
    // valid JSON but no context_window_size → null (transcript fallback wins)
    writeSidecar(ws, 'nowin', { session_id: 'nowin', cwd: ws, model: { id: 'claude-opus-4-8' } });
    assert.strictEqual(claudeSidecarStatus({ cwd: ws, resumeId: 'nowin' }), null);
    assert.strictEqual(claudeSidecarStatus({ cwd: ws, resumeId: 'absent' }), null);
  } finally {
    fs.rmSync(ws, { recursive: true, force: true });
  }
});

test('findBridgeWorkspace: nearest .bridge-commander/ ancestor, else null', () => {
  const ws = tmpdir('bc-find-ws-');
  try {
    fs.mkdirSync(path.join(ws, '.bridge-commander'), { recursive: true });
    const deep = path.join(ws, 'x', 'y');
    fs.mkdirSync(deep, { recursive: true });
    assert.strictEqual(findBridgeWorkspace(deep), ws);
    assert.strictEqual(findBridgeWorkspace('/'), null);
  } finally {
    fs.rmSync(ws, { recursive: true, force: true });
  }
});

// A codex rollout fixture: session_meta + turn_context + token_count lines.
const THREAD = '019ec130-a849-74b2-802e-a3d3bbb57ee0';
// `last` is the current-turn occupancy we report; total_token_usage is the
// CUMULATIVE session total and must be ignored — so the fixture always makes it
// far larger (last * 100) to catch any regression back to the cumulative field.
function tokenCountLine(last, rateLimits) {
  return JSON.stringify({
    timestamp: '2026-06-13T13:34:56.765Z',
    type: 'event_msg',
    payload: {
      type: 'token_count',
      info: {
        total_token_usage: { total_tokens: last * 100 },
        last_token_usage: { total_tokens: last },
        model_context_window: 258400,
      },
      rate_limits: rateLimits === undefined ? null : rateLimits,
    },
  }) + '\n';
}
// An old-shape token_count: info populated but WITHOUT last_token_usage.
function legacyTokenCountLine(total) {
  return JSON.stringify({
    timestamp: '2026-06-13T13:34:56.765Z',
    type: 'event_msg',
    payload: {
      type: 'token_count',
      info: { total_token_usage: { total_tokens: total }, model_context_window: 258400 },
      rate_limits: null,
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
      + JSON.stringify({ type: 'turn_context', payload: { model: 'gpt-5.5', effort: 'medium' } }) + '\n'
      + tokenCountLine(11111) // stale — must not win
      + tokenCountLine(58034, {
        primary: { used_percent: 1.0, window_minutes: 300, resets_at: 1781371082 },
        secondary: { used_percent: 21.0, window_minutes: 10080, resets_at: 1781782195 },
      }));
    const st = codexStatus({ resumeId: THREAD }, { sessionsDir });
    assert.deepStrictEqual(st, {
      model: 'gpt-5.5',
      effort: 'medium',
      contextUsed: 58034,
      contextWindow: 258400,
      rateLimits: {
        primary: { usedPercent: 1.0, windowMinutes: 300, resetsAt: 1781371082 },
        secondary: { usedPercent: 21.0, windowMinutes: 10080, resetsAt: 1781782195 },
      },
    });
    const text = formatStatus(st);
    assert.match(text, /model: gpt-5\.5 \(medium\)/);
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

test('codexStatus: reports last-turn occupancy, not the cumulative session total', () => {
  // Real rollout evidence: cumulative 1,110,621 vs last-turn 17,814 / window
  // 353,400 ≈ 5% (the true value; the cumulative total showed a false 100%+).
  const sessionsDir = tmpdir('bc-status-codex-occ-');
  try {
    writeRollout(sessionsDir, '2026/07/10', THREAD,
      JSON.stringify({ type: 'turn_context', payload: { model: 'gpt-5.5' } }) + '\n'
      + JSON.stringify({
        type: 'event_msg',
        payload: {
          type: 'token_count',
          info: {
            total_token_usage: { total_tokens: 1110621 },
            last_token_usage: { total_tokens: 17814 },
            model_context_window: 353400,
          },
          rate_limits: null,
        },
      }) + '\n');
    const st = codexStatus({ resumeId: THREAD }, { sessionsDir });
    assert.deepStrictEqual(st, { model: 'gpt-5.5', contextUsed: 17814, contextWindow: 353400 });
    assert.match(formatStatus(st), /context: 17,814 \/ 353,400 tokens \(5%\)/);
  } finally {
    fs.rmSync(sessionsDir, { recursive: true, force: true });
  }
});

test('codexStatus: legacy token_count without last_token_usage → null (no cumulative fallback)', () => {
  const sessionsDir = tmpdir('bc-status-codex-legacy-');
  try {
    writeRollout(sessionsDir, '2026/04/12', THREAD,
      JSON.stringify({ type: 'turn_context', payload: { model: 'gpt-5.5' } }) + '\n'
      + legacyTokenCountLine(999999));
    assert.strictEqual(codexStatus({ resumeId: THREAD }, { sessionsDir }), null);
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
