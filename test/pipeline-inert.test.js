'use strict';
// THE inertness test.
//
// A pipeline executor lives in `pipeline/`. It knows the Bridge Commander;
// the Bridge Commander must never know it. It travels on master and is INERT
// for anyone who installs the board: if someone who has never heard of the
// executor is affected by it, that is the bug.
//
// "Turned off today" is not the promise. The promise is "there is no way to
// turn it on by accident", and the only way to keep a promise like that is a
// test that fails the moment the board's own code so much as MENTIONS the
// thing. So this sweeps server/, harness/, ui/ and cli/bc-axi for the words
// that would give it away — and for any require() that could reach it.
//
// The allowlist below is every pre-existing hit, each one demonstrably about
// something else. It is short on purpose: a new entry is a decision someone
// has to argue for in review, which is exactly the friction wanted here.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.join(__dirname, '..');

// The trees the board itself is made of. ui/vendor is skipped: unmodified
// upstream builds, not our code and not ours to keep clean.
const SCOPE = ['server', 'harness', 'ui', 'cli/bc-axi'];
const SKIP_DIRS = new Set(['vendor', 'node_modules', '.git']);

// The words that would reveal the executor. Not "does this file import it" —
// by the time an import exists the coupling has already happened.
const TELLS = [
  [/\bpipelines?\b/i, 'pipeline'],
  [/\bexecutors?\b/i, 'executor'],
  [/\byaml\b/i, 'YAML'],
  [/\bstages?\b/i, 'stage'],
  [/\bmax_rounds\b/, 'max_rounds'],
  [/\{\{[#/]?[\w.]+\}\}/, 'a {{template}} tag'],
  [/\bvalidated-pr\b/, 'the factory pipeline name'],
];

// Pre-existing, unrelated, and each one checked by hand.
const ALLOWED = [
  { file: 'server/brief.js', re: /no-mistakes pipeline/, why: 'the no-mistakes tool has a pipeline of its own; predates this and means something else' },
  { file: 'ui/js/detail.js', re: /x-yaml\|yaml\|csv/, why: 'a MIME regex listing text types the file viewer renders' },
  { file: 'ui/js/filectx.js', re: /yml: 'yaml'/, why: 'an extension → language map for syntax highlighting' },
  { file: 'ui/js/ltswitcher.js', re: /the stage themselves/, why: 'prose about a UI element, not a pipeline stage' },
];

function walk(dir, out = []) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    if (SKIP_DIRS.has(e.name)) continue;
    const p = path.join(dir, e.name);
    if (e.isDirectory()) walk(p, out);
    else out.push(p);
  }
  return out;
}

function scopeFiles() {
  const files = [];
  for (const entry of SCOPE) {
    const abs = path.join(ROOT, entry);
    if (fs.statSync(abs).isDirectory()) files.push(...walk(abs));
    else files.push(abs);
  }
  return files.map((f) => ({ abs: f, rel: path.relative(ROOT, f) }));
}

function allowed(rel, line) {
  return ALLOWED.some((a) => a.file === rel && a.re.test(line));
}

test('the board never mentions the executor — not by name, not by any of its words', () => {
  const hits = [];
  for (const { abs, rel } of scopeFiles()) {
    const lines = fs.readFileSync(abs, 'utf8').split('\n');
    lines.forEach((line, i) => {
      for (const [re, word] of TELLS) {
        if (re.test(line) && !allowed(rel, line)) {
          hits.push(`${rel}:${i + 1} says "${word}" — ${line.trim().slice(0, 100)}`);
          break;
        }
      }
    });
  }
  assert.deepStrictEqual(hits, [], 'the board is supposed to be unaware of the executor:\n' + hits.join('\n'));
});

test('nothing in the board can reach the executor directory', () => {
  const reaching = [];
  for (const { abs, rel } of scopeFiles()) {
    const text = fs.readFileSync(abs, 'utf8');
    for (const m of text.matchAll(/require\(\s*['"]([^'"]+)['"]/g)) {
      const spec = m[1];
      if (!spec.startsWith('.')) continue;
      const target = path.resolve(path.dirname(abs), spec);
      if (target === path.join(ROOT, 'pipeline') || target.startsWith(path.join(ROOT, 'pipeline') + path.sep)) {
        reaching.push(`${rel} requires ${spec}`);
      }
    }
    for (const m of text.matchAll(/['"`]([^'"`]*\bpipeline\/[^'"`]*)['"`]/g)) {
      reaching.push(`${rel} names the path ${m[1]}`);
    }
  }
  assert.deepStrictEqual(reaching, [], 'the dependency runs one way only:\n' + reaching.join('\n'));
});

test('the executor is where this test thinks it is', () => {
  // A rename that slipped past the sweep would make both tests above pass by
  // scanning for the wrong word. Pin the directory so a move updates the test.
  for (const f of ['run.js', 'config.js', 'verdict.js', 'pipelines/validated-pr.yaml']) {
    assert.ok(fs.existsSync(path.join(ROOT, 'pipeline', f)), 'pipeline/' + f + ' is missing');
  }
});

test('every allowlist entry is still real (a stale exemption hides a new mention)', () => {
  for (const a of ALLOWED) {
    const text = fs.readFileSync(path.join(ROOT, a.file), 'utf8');
    assert.ok(a.re.test(text), `${a.file} no longer matches ${a.re} — drop the exemption (${a.why})`);
  }
});
