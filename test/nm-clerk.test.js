'use strict';
// bin/nm-clerk.sh — the bash driver that answers no-mistakes' gates without a
// model. It shells out to `no-mistakes axi`, which takes minutes and needs a
// real repo, so every test here replaces that binary (NM_BIN) with a fake that
// replays payloads RECORDED FROM REAL RUNS (test/fixtures/nm-clerk/*.toon) and
// logs the argv it was handed.
//
// What is asserted: the three outcomes the pipeline routes on, read from
// $ARTIFACTS_DIR/nm-outcome, and an exit status that is ALWAYS 0 — the outcome
// travels in files, so a non-zero exit only kills whatever is driving the clerk.
const test = require('node:test');
const assert = require('node:assert');
const { execFileSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const CLERK = path.join(__dirname, '..', 'bin', 'nm-clerk.sh');
const FIXTURES = path.join(__dirname, 'fixtures', 'nm-clerk');

const fixture = name => fs.readFileSync(path.join(FIXTURES, `${name}.toon`), 'utf8');

// A fake `no-mistakes` that prints replies[n] on its nth call (the last reply
// repeats forever, which is how the runaway-fixer case is built) and appends
// its arguments to calls.log, one invocation per line.
function fakeNoMistakes(dir, replies) {
  const stateDir = path.join(dir, 'fake');
  fs.mkdirSync(stateDir, { recursive: true });
  replies.forEach((r, i) => fs.writeFileSync(path.join(stateDir, `reply-${i + 1}`), r));
  fs.writeFileSync(path.join(stateDir, 'last'), replies[replies.length - 1]);
  const bin = path.join(dir, 'no-mistakes');
  fs.writeFileSync(bin, `#!/usr/bin/env bash
d=${JSON.stringify(stateDir)}
n=$(( $(cat "$d/n" 2>/dev/null || echo 0) + 1 ))
echo "$n" > "$d/n"
args="$*"; printf '%s\\n' "\${args//$'\\n'/ }" >> "$d/calls.log"   # one line per invocation
cat "$d/reply-$n" 2>/dev/null || cat "$d/last"
`);
  fs.chmodSync(bin, 0o755);
  return bin;
}

// run(replies, env, argv) -> { status, stdout, outcome, escalation, calls }
// `argv` defaults to the --intent-file door; the --respond tests pass their own.
function run(replies, env = {}, argv = null) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'nm-clerk-'));
  const bin = fakeNoMistakes(dir, replies);
  const intent = path.join(dir, 'intent.md');
  fs.writeFileSync(intent, 'REQUIRED: the tile click keeps the selection.\nFORBIDDEN: removing the drag.\n');

  let status = 0;
  let stdout = '';
  try {
    stdout = execFileSync('bash', [CLERK, ...(argv || ['--intent-file', intent])], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
      env: { ...process.env, NM_BIN: bin, ARTIFACTS_DIR: dir, NM_CLERK_LOG: path.join(dir, 'nm.log'), ...env },
    });
  } catch (e) {
    status = e.status;
    stdout = e.stdout || '';
  }
  const read = f => (fs.existsSync(path.join(dir, f)) ? fs.readFileSync(path.join(dir, f), 'utf8') : null);
  return {
    status,
    stdout,
    outcome: (read('nm-outcome') || '').trim(),
    escalation: read('escalation.md'),
    calls: (read('fake/calls.log') || '').trim().split('\n').filter(Boolean),
  };
}

// ---------- passed ----------

test('drives a real run through awaiting_approval and fix_review to passed', () => {
  const r = run([
    fixture('gate-awaiting-approval'),
    fixture('gate-fix-review'),
    fixture('outcome-passed'),
  ]);

  assert.equal(r.status, 0);
  assert.equal(r.outcome, 'passed');
  assert.equal(r.escalation, null, 'nothing was escalated');

  // The intent reached `axi run`, and each gate was answered by finding id.
  assert.match(r.calls[0], /^axi run --intent REQUIRED: the tile click keeps the selection\./);
  assert.equal(
    r.calls[1],
    'axi respond --action fix --findings missing-import-average-discount,empty-prices-zero-division'
  );
  assert.equal(
    r.calls[2],
    'axi respond --action fix --findings committed-pycache-artifacts,manual-raises-assertion'
  );
});

test('approves a gate whose findings are all no-op', () => {
  const noop = fixture('gate-awaiting-approval').replace(/,auto-fix,/g, ',no-op,');
  const r = run([noop, fixture('outcome-passed')]);

  assert.equal(r.status, 0);
  assert.equal(r.outcome, 'passed');
  assert.equal(r.calls[1], 'axi respond --action approve');
  assert.match(r.stdout, /approve — nothing actionable at gate awaiting_approval/);
});

// ---------- escalated ----------

test('an ask-user finding parks: escalation.md written, nothing resolved', () => {
  const r = run([fixture('gate-ask-user'), fixture('outcome-passed')]);

  assert.equal(r.status, 0, 'a bash node that exits non-zero kills the loop_group');
  assert.equal(r.outcome, 'escalated');

  // Exactly one call: the run. It never answered the gate.
  assert.equal(r.calls.length, 1);
  assert.match(r.calls[0], /^axi run /);

  // The whole payload is on the file, all four findings included.
  assert.match(r.escalation, /ask-user finding/);
  for (const id of [
    'drag-starting-on-tile-no-longer-selects',
    'tests-assert-helper-not-behavior',
    'tile-prefix-string-heuristic',
    'tests-share-mutable-global',
  ]) {
    assert.ok(r.escalation.includes(id), `escalation.md is missing ${id}`);
  }
  // And the ask-user ids — not the auto-fix one — are named as the reason.
  assert.match(r.stdout, /ask-user finding\(s\) at gate awaiting_approval: drag-starting-on-tile-no-longer-selects,tests-assert-helper-not-behavior,tile-prefix-string-heuristic/);
});

// ---------- failed: a verdict on the change ----------

test('a fixer that keeps producing findings stops at the round cap', () => {
  // The real shape: run 1's fixer committed __pycache__ and the next gate
  // flagged its own artifact. This fixture repeats forever.
  const r = run([fixture('gate-awaiting-approval'), fixture('gate-fix-review')]);

  assert.equal(r.status, 0);
  assert.equal(r.outcome, 'failed');
  assert.match(r.stdout, /fix-round cap \(3\) reached at gate fix_review/);
  // 1 run + 3 fixes, and then it stopped rather than sending a fourth.
  assert.equal(r.calls.length, 4);
  assert.equal(r.calls.filter(c => c.includes('--action fix')).length, 3);
});

// ---------- refused: the gate never read the change ----------
// The distinction that stops the pipeline asking the wrong agent to fix the
// wrong thing. `failed` bounces back to the implementer; `refused` escalates,
// because no rewrite of the code fixes an uninitialised repo.

test('a precondition error is REFUSED, not failed — the environment is wrong, not the diff', () => {
  const r = run(['error: uncommitted changes in the working tree\nhelp[1]: Commit your work before validating\n']);

  assert.equal(r.status, 0);
  assert.equal(r.outcome, 'refused');
  assert.match(r.stdout, /refused to run: uncommitted changes in the working tree/);
  assert.equal(r.calls.length, 1);
  // Same file an ask-user finding writes: it needs the same person.
  assert.ok(r.escalation, 'a refusal writes escalation.md so the round loop ends and a human is paged');
  assert.match(r.escalation, /never got as far as reading the change/);
  assert.match(r.escalation, /uncommitted changes in the working tree/);
});

test('an unfamiliar gate status is refused rather than guessed at', () => {
  const r = run([fixture('gate-awaiting-approval').replace('status: awaiting_approval', 'status: awaiting_something_new')]);

  assert.equal(r.status, 0);
  assert.equal(r.outcome, 'refused');
  assert.match(r.stdout, /nknown gate status: awaiting_something_new/);
  assert.equal(r.calls.length, 1, 'it answered nothing');
  assert.ok(r.escalation, 'a shape the clerk does not know is a human question, not another round');
});

// ---------- --respond: the human coming back ----------

test('--respond fix answers the parked gate by id and drives the rest to passed', () => {
  // What run one actually left behind: a gate parked on two ask-user findings,
  // and a lieutenant who ruled they are mechanical. From there it is the
  // clerk's ordinary job again — the fix_review that follows is auto-fix.
  const r = run(
    [fixture('gate-fix-review'), fixture('outcome-passed')],
    {},
    ['--respond', 'fix', '--findings', 'lint-1,lint-2']
  );

  assert.equal(r.status, 0);
  assert.equal(r.outcome, 'passed');
  assert.equal(r.escalation, null);

  // No `axi run` — the run was already open. The decision IS the first call.
  assert.equal(r.calls[0], 'axi respond --action fix --findings lint-1,lint-2');
  assert.equal(
    r.calls[1],
    'axi respond --action fix --findings committed-pycache-artifacts,manual-raises-assertion'
  );
  assert.equal(r.calls.filter(c => c.startsWith('axi run')).length, 0);
});

test('--respond approve needs no findings', () => {
  const r = run([fixture('outcome-passed')], {}, ['--respond', 'approve']);

  assert.equal(r.outcome, 'passed');
  assert.equal(r.calls.length, 1);
  assert.equal(r.calls[0], 'axi respond --action approve');
});

test('--respond skip is passed through as its own action', () => {
  const r = run([fixture('outcome-passed')], {}, ['--respond', 'skip']);

  assert.equal(r.outcome, 'passed');
  assert.equal(r.calls[0], 'axi respond --action skip');
});

test('--respond re-escalates when the answered gate hands back another ask-user', () => {
  // The lieutenant's call did not end it: the next gate asks again. The run
  // must park again rather than approve something nobody ruled on.
  const r = run([fixture('gate-ask-user')], {}, ['--respond', 'fix', '--findings', 'lint-1']);

  assert.equal(r.status, 0);
  assert.equal(r.outcome, 'escalated');
  assert.match(r.escalation, /ask-user finding/);
  assert.equal(r.calls.length, 1, 'it answered nothing after the human’s own decision');
});

test('--respond keeps the fix-round cap', () => {
  const r = run([fixture('gate-fix-review')], {}, ['--respond', 'fix', '--findings', 'lint-1']);

  assert.equal(r.status, 0);
  assert.equal(r.outcome, 'failed');
  assert.match(r.stdout, /fix-round cap \(3\) reached at gate fix_review/);
});

// ---------- --instructions: the human arguing back ----------

test('--instructions rides along with the fix so the fixer hears the argument', () => {
  const r = run([fixture('outcome-passed')], {}, [
    '--respond', 'fix', '--findings', 'lint-1',
    '--instructions', 'the unused export is deliberate — re-export it instead of deleting it',
  ]);

  assert.equal(r.outcome, 'passed');
  assert.equal(
    r.calls[0],
    'axi respond --action fix --findings lint-1 --instructions the unused export is deliberate — re-export it instead of deleting it'
  );
  assert.match(r.stdout, /with guidance/);
});

test('a bare fix carrying instructions still resolves the ids off the parked gate', () => {
  // Reply one is the gate being read for its ids; reply two answers it.
  const r = run([fixture('gate-awaiting-approval'), fixture('outcome-passed')], {}, [
    '--respond', 'fix', '--instructions', 'keep the guard, widen the type',
  ]);

  assert.equal(r.outcome, 'passed');
  assert.equal(r.calls[0], 'axi status');
  assert.match(r.calls[1], /^axi respond --action fix --findings \S+ --instructions keep the guard, widen the type$/);
});

test('instructions on anything but a fix is refused rather than silently dropped', () => {
  for (const action of ['approve', 'skip']) {
    const r = run([fixture('outcome-passed')], {}, ['--respond', action, '--instructions', 'because I said so']);

    assert.equal(r.status, 0);
    assert.equal(r.outcome, 'refused', `${action} swallowed the guidance`);
    assert.equal(r.calls.length, 0);
  }
});

test('instructions on the --intent-file door is refused — guidance answers a gate', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'nm-clerk-'));
  const intent = path.join(dir, 'intent.md');
  fs.writeFileSync(intent, 'REQUIRED: nothing.\n');
  const r = run([fixture('outcome-passed')], {}, ['--intent-file', intent, '--instructions', 'go easy']);

  assert.equal(r.status, 0);
  assert.equal(r.outcome, 'refused');
  assert.equal(r.calls.length, 0);
});

test('an unknown --respond action is refused, not sent', () => {
  const r = run([fixture('outcome-passed')], {}, ['--respond', 'merge-it']);

  assert.equal(r.status, 0);
  assert.equal(r.outcome, 'refused');
  assert.match(r.stdout, /not fix, approve or skip/);
  assert.equal(r.calls.length, 0);
});

test('--respond and --intent-file together is refused rather than half-honoured', () => {
  const r = run([fixture('outcome-passed')], {}, ['--respond', 'approve', '--intent-file', '/dev/null']);

  assert.equal(r.status, 0);
  assert.equal(r.outcome, 'refused');
  assert.equal(r.calls.length, 0);
});

// ---------- the parser ----------

test('columns are read from the header, not counted from the left', () => {
  // Same gate with the findings table transposed: action first, id last.
  const src = fixture('gate-awaiting-approval');
  const reordered = src
    .replace('findings[2]{id,severity,file,action,description}:', 'findings[2]{action,file,severity,description,id}:')
    .replace(
      /^ {4}missing-import-average-discount,error,test_calc\.py,auto-fix,(".*")$/m,
      '    auto-fix,test_calc.py,error,$1,missing-import-average-discount'
    )
    .replace(
      /^ {4}empty-prices-zero-division,warning,calc\.py,auto-fix,(".*")$/m,
      '    auto-fix,calc.py,warning,$1,empty-prices-zero-division'
    );
  assert.notEqual(reordered, src, 'the fixture rewrite matched nothing');

  const r = run([reordered, fixture('outcome-passed')]);
  assert.equal(r.outcome, 'passed');
  assert.equal(
    r.calls[1],
    'axi respond --action fix --findings missing-import-average-discount,empty-prices-zero-division'
  );
});

test('a description full of commas and escaped quotes does not shift the columns', () => {
  // gate-ask-user's descriptions carry both. If the split were naive, the
  // ask-user rows would parse as something else and the clerk would answer.
  const r = run([fixture('gate-ask-user')]);
  assert.equal(r.outcome, 'escalated');
});

test('a missing --intent-file is refused, not a usage crash', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'nm-clerk-'));
  let status = 0;
  try {
    execFileSync('bash', [CLERK], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
      env: { ...process.env, ARTIFACTS_DIR: dir },
    });
  } catch (e) {
    status = e.status;
  }
  assert.equal(status, 0);
  assert.equal(fs.readFileSync(path.join(dir, 'nm-outcome'), 'utf8').trim(), 'refused');
});
