'use strict';
// statusline.js — the BC-owned Claude Code statusLine command: the sidecar tee
// (workspace discovery, atomic write, session keying) and the pretty render for
// full / no-rate-limits / model-only payloads.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { findWorkspace, writeSidecar, render, fmtEta, toEpochSecs } = require('../statusline.js');

function tmpdir(prefix) {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

// A full statusLine stdin payload, matching the Claude Code binary's shape.
function fullPayload(sid, cwd) {
  return {
    session_id: sid,
    cwd,
    model: { id: 'claude-opus-4-8', display_name: 'Opus 4.8' },
    context_window: {
      context_window_size: 1000000,
      total_input_tokens: 118213,
      used_percentage: 11.8,
    },
    rate_limits: {
      five_hour: { used_percentage: 42, resets_at: 2000000000 },
      seven_day: { used_percentage: 7, resets_at: 2000100000 },
    },
  };
}

// strip ANSI so assertions read the plain text.
function plain(s) {
  return s.replace(/\x1b\[[0-9;]*m/g, '');
}

test('writeSidecar: tees the payload under the nearest .bridge-commander/, keyed by session_id', () => {
  const root = tmpdir('bc-statusline-ws-');
  try {
    fs.mkdirSync(path.join(root, '.bridge-commander'), { recursive: true });
    const cwd = path.join(root, 'projects', 'app', 'src');
    fs.mkdirSync(cwd, { recursive: true });
    const sid = 'sess-1111';
    const written = writeSidecar(fullPayload(sid, cwd), { now: '2026-07-14T00:00:00.000Z' });
    assert.strictEqual(written, path.join(root, '.bridge-commander', 'statusline', sid + '.json'));
    const doc = JSON.parse(fs.readFileSync(written, 'utf8'));
    assert.strictEqual(doc.receivedAt, '2026-07-14T00:00:00.000Z');
    assert.strictEqual(doc.payload.context_window.context_window_size, 1000000);
    assert.strictEqual(doc.payload.session_id, sid);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('writeSidecar: null (writes nothing) when no workspace / no session_id — never throws', () => {
  const root = tmpdir('bc-statusline-none-');
  try {
    // cwd with no .bridge-commander anywhere above → no workspace
    assert.strictEqual(writeSidecar(fullPayload('s', root)), null);
    // no session_id → null even with a workspace
    fs.mkdirSync(path.join(root, '.bridge-commander'), { recursive: true });
    assert.strictEqual(writeSidecar({ cwd: root }), null);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('findWorkspace: walks up to the nearest .bridge-commander/; null when none', () => {
  const root = tmpdir('bc-statusline-find-');
  try {
    fs.mkdirSync(path.join(root, '.bridge-commander'), { recursive: true });
    const deep = path.join(root, 'a', 'b', 'c');
    fs.mkdirSync(deep, { recursive: true });
    assert.strictEqual(findWorkspace(deep), root);
    assert.strictEqual(findWorkspace('/'), null);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('render: full payload — model, bar, used%, tokens, and both rate limits', () => {
  const now = Date.UTC(2033, 4, 18) / 1; // arbitrary fixed clock (epoch ms)
  const txt = plain(render(fullPayload('s', '/x'), Date.parse('2033-05-18T03:33:20Z')));
  // resets_at 2000000000 = 2033-05-18T03:33:20Z → same instant → 0m ETA
  assert.match(txt, /^Opus 4\.8 \| /);
  assert.match(txt, /12% \| 118k\/1000k/); // 11.8% rounds to 12; tokens/window in k
  assert.match(txt, /\| 5h 42% \(/);
  assert.match(txt, /\| 7d 7% \(/);
  void now;
});

test('render: payload without rate_limits — model + context bar only, no 5h/7d', () => {
  const p = fullPayload('s', '/x');
  delete p.rate_limits;
  const txt = plain(render(p, 0));
  assert.match(txt, /Opus 4\.8 \| .* 12% \| 118k\/1000k/);
  assert.doesNotMatch(txt, /5h|7d/);
});

test('render: model-only payload (no context_window) → just the model name', () => {
  const txt = plain(render({ model: { display_name: 'Opus 4.8' } }, 0));
  assert.strictEqual(txt, 'Opus 4.8');
});

test('render: empty payload → Unknown', () => {
  assert.strictEqual(plain(render({}, 0)), 'Unknown');
});

test('fmtEta / toEpochSecs: compact forms and format coercion', () => {
  const now = 1_000_000 * 1000; // epoch ms
  assert.strictEqual(fmtEta(1_000_000 + 2 * 86400 + 4 * 3600, now), '2d4h');
  assert.strictEqual(fmtEta(1_000_000 + 3 * 3600 + 12 * 60, now), '3h12m');
  assert.strictEqual(fmtEta(1_000_000 + 45 * 60, now), '45m');
  assert.strictEqual(fmtEta(1_000_000 - 500, now), '0m'); // past → clamped
  assert.strictEqual(fmtEta('nonsense', now), '');
  // ISO string and epoch-millis both coerce to seconds
  assert.strictEqual(toEpochSecs('2026-01-01T00:00:00Z'), Math.floor(Date.parse('2026-01-01T00:00:00Z') / 1000));
  assert.strictEqual(toEpochSecs(1700000000000), 1700000000);
  assert.strictEqual(toEpochSecs(1700000000), 1700000000);
});
