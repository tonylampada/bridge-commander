'use strict';
// The executor, end to end — the only test that answers "did it work".
//
// Not "it ran once": a card crosses BOTH stages with at least one rejection and
// one bounce, and the text of the findings arrives in the implementer's second
// round. A rejection that does not come back, or comes back without the text,
// is the card failing in silence — the failure mode that costs the most.
//
// And the other half: the executor is launched by a command harness whose
// resume RE-RUNS THE COMMAND from the top. So it is killed mid-flight here and
// restarted, and what is pinned is that it picks up at the round it was on. An
// executor that restarted the pipeline from the beginning would throw away the
// implementer's work, quietly.
//
// The stage agents are the fake harness (BC_FAKE_STATE): no tmux, no tokens.
// Their verdicts are written by the real verdict CLI, the same way a live agent
// would write them.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawn, execFileSync } = require('node:child_process');
const { startServerWithLieutenant, withOwner, LT } = require('./helper');

const RUN = path.join(__dirname, '..', 'pipeline', 'run.js');
const VERDICT = path.join(__dirname, '..', 'pipeline', 'verdict.js');

// A pipeline with the same SHAPE as the factory one and none of its cost:
// two stages, a `run` whose output must reach the validator, a findings block
// that must appear only on a bounce.
const TINY = `
name: tiny
max_rounds: 2
preamble: |
  Card {{card.id}} ({{card.title}}) in {{worktree}} on {{branch}}.
working:
  prompt: |
    IMPLEMENT: {{card.task}}
    round {{round}} of {{max_rounds}}
    {{#findings}}
    FIX THESE FIRST:
    {{findings}}
    {{/findings}}
    report with: {{done}}
validating:
  run:
    - echo "gate output for round {{round}}"
  prompt: |
    VALIDATE round {{round}}. The run said:
    {{run.output}}
    say no with: {{reject}}
    say yes with: {{done}}
`;

async function boot() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'bc-pipe-run-'));
  const repo = path.join(root, 'srcrepo');
  fs.mkdirSync(repo, { recursive: true });
  execFileSync('git', ['init', '-q', '-b', 'main', repo], { stdio: 'ignore' });
  fs.writeFileSync(path.join(repo, 'README.md'), 'hi\n');
  execFileSync('git', ['-C', repo, 'add', '.'], { stdio: 'ignore' });
  execFileSync('git', ['-C', repo, '-c', 'user.email=t@t', '-c', 'user.name=t', 'commit', '-q', '-m', 'init'],
    { stdio: 'ignore' });
  const fdir = path.join(root, 'fake');
  const s = await startServerWithLieutenant({
    env: { BC_FAKE_STATE: fdir, BC_WORKTREE_TOOL: 'git', BC_SUPERVISE_INTERVAL_MS: '0', BC_PRWATCH_INTERVAL_MS: '0' },
  });
  assert.strictEqual((await s.api('POST', '/api/projects', { source: repo, name: 'proj', mode: 'local-only' })).status, 200);

  // A card the executor can read: the worktree/branch a real `card start`
  // would have bound, without spawning anything.
  const wt = path.join(root, 'worktree');
  fs.mkdirSync(wt, { recursive: true });
  await s.api('POST', '/api/cards', withOwner({
    title: 'Make it work', id: 'demo', body: 'The button 404s. Fix it.',
    attributes: { repo: 'proj', worktree: wt, branch: 'bc/demo' },
  }));

  const pipes = path.join(s.dir, '.bridge-commander', 'pipelines');
  fs.mkdirSync(pipes, { recursive: true });
  fs.writeFileSync(path.join(pipes, 'tiny.yaml'), TINY);

  const runDir = path.join(s.dir, '.bridge-commander', 'pipeline_runs', 'demo');
  return {
    s, root, fdir, runDir, wt,
    teardown: async () => { await s.stop(); fs.rmSync(root, { recursive: true, force: true }); },
  };
}

// startExecutor — the child under test, run exactly as the command harness
// would run it. Killed by PID, never by pattern.
function startExecutor(s, fdir) {
  const child = spawn(process.execPath,
    [RUN, 'demo', '--workspace', s.dir, '--port', String(s.port), '--pipeline', 'tiny', '--harness', 'fake'],
    {
      env: Object.assign({}, process.env, { BC_PIPELINE_POLL_MS: '40', BC_FAKE_STATE: fdir }),
      stdio: ['ignore', 'pipe', 'pipe'],
    });
  const out = { text: '', code: null };
  child.stdout.on('data', (c) => (out.text += c));
  child.stderr.on('data', (c) => (out.text += c));
  const exited = new Promise((r) => child.on('close', (code) => { out.code = code; r(code); }));
  return { child, out, exited };
}

async function waitForFile(file, out, ms = 15000) {
  const deadline = Date.now() + ms;
  for (;;) {
    if (fs.existsSync(file)) return fs.readFileSync(file, 'utf8');
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${path.basename(file)}\n--- executor said ---\n${out.text}`);
    await new Promise((r) => setTimeout(r, 30));
  }
}
function verdictCli(args) {
  return execFileSync(process.execPath, [VERDICT, ...args], { encoding: 'utf8' });
}

test('two stages, one rejection, and the findings reach the implementer\'s second round', async () => {
  const { s, runDir, fdir, teardown } = await boot();
  const { child, out, exited } = startExecutor(s, fdir);
  try {
    // Round 1, implementer: the task is there, the findings block is not.
    const w1 = await waitForFile(path.join(runDir, 'prompt-working-r1.md'), out);
    assert.match(w1, /IMPLEMENT: The button 404s\. Fix it\./);
    assert.match(w1, /Card demo \(Make it work\)/, 'the preamble rendered');
    assert.match(w1, /round 1 of 2/);
    assert.ok(!/FIX THESE FIRST/.test(w1), 'nothing has been rejected yet');
    verdictCli(['done', '--to', path.join(runDir, 'verdict-working-r1.json'), '--outcome', 'committed 3 files']);

    // Round 1, validator: `run` executed FIRST and its output is in the prompt.
    const v1 = await waitForFile(path.join(runDir, 'prompt-validating-r1.md'), out);
    assert.match(v1, /gate output for round 1/, 'the run output was injected as {{run.output}}');

    // It says no, in writing.
    const findings = path.join(runDir, 'findings.md');
    fs.writeFileSync(findings, 'The fix drops the error branch.\nRepro: click with a 500 from the API.');
    verdictCli(['reject', '--to', path.join(runDir, 'verdict-validating-r1.json'), '--findings', findings]);

    // Round 2, implementer — THE assertion this whole thing exists for.
    const w2 = await waitForFile(path.join(runDir, 'prompt-working-r2.md'), out);
    assert.match(w2, /FIX THESE FIRST/);
    assert.match(w2, /The fix drops the error branch\./);
    assert.match(w2, /Repro: click with a 500 from the API\./);
    assert.match(w2, /round 2 of 2/);

    // The implementer kept its session across the bounce (a send, not a new
    // spawn); the validator got a brand-new one (a reader who did not write it).
    const impl = fs.readdirSync(fdir).filter((f) => f.includes('-impl.json'));
    assert.strictEqual(impl.length, 1, 'one implementer session for both rounds');
    const sends = fs.readFileSync(path.join(fdir, impl[0].replace('.json', '.sends.jsonl')), 'utf8');
    assert.match(sends, /FIX THESE FIRST/, 'round 2 was TYPED into the session that did round 1');
    verdictCli(['done', '--to', path.join(runDir, 'verdict-working-r2.json'), '--outcome', 'fixed the error branch']);
    const v2 = await waitForFile(path.join(runDir, 'prompt-validating-r2.md'), out);
    assert.match(v2, /VALIDATE round 2/);
    // A fresh validator session per round: round 1's is gone, round 2's is a
    // spawn (not a send), and it never saw round 1's reasoning.
    const vals = fs.readdirSync(fdir).filter((f) => /-val\d+\.json$/.test(f));
    assert.strictEqual(vals.length, 1, 'the previous validator was closed, not reused');
    assert.match(vals[0], /:s-demo-val2\.json$/);
    const v2rec = JSON.parse(fs.readFileSync(path.join(fdir, vals[0]), 'utf8'));
    assert.match(v2rec.prompt, /VALIDATE round 2/, 'it was BORN with round 2\'s prompt');
    assert.ok(!fs.existsSync(path.join(fdir, vals[0].replace('val2', 'val1') + '.sends.jsonl')));
    verdictCli(['done', '--to', path.join(runDir, 'verdict-validating-r2.json'),
      '--outcome', 'good — https://github.com/o/r/pull/42']);

    assert.strictEqual(await exited, 0, out.text);

    // What the board learned: the PR, and nothing it was not supposed to.
    // Re-running a finished pipeline (a resume after it ended) must not report
    // a second time — one landing, one item in the lieutenant's queue.
    const again = startExecutor(s, fdir);
    assert.strictEqual(await again.exited, 0, again.out.text);
    assert.match(again.out.text, /already finished/);

    const card = (await s.api('GET', '/api/cards/demo')).body;
    assert.deepStrictEqual(card.attributes.prs, [{ url: 'https://github.com/o/r/pull/42', state: 'open' }]);
    const done = card.events.filter((e) => e.kind === 'worker-done');
    assert.strictEqual(done.length, 1, 'the executor reports done ONCE, at the end');
    assert.match(done[0].text, /finished in 2 rounds/);
    assert.match(done[0].text, /pull\/42/);
    assert.strictEqual(card.column, 'backlog', 'the executor never moves the card — that is the lieutenant\'s');
    const texts = card.events.map((e) => e.text).join('\n');
    assert.match(texts, /validation REJECTED round 1/);
    assert.match(texts, /The fix drops the error branch/, 'the findings are on the card, not only in a prompt');
  } finally {
    child.kill('SIGKILL');
    await teardown();
  }
});

test('killed mid-round, it resumes at that round instead of starting the pipeline over', async () => {
  const { s, runDir, fdir, teardown } = await boot();
  const first = startExecutor(s, fdir);
  try {
    // Get it to round 2 — the round whose loss would cost real work.
    await waitForFile(path.join(runDir, 'prompt-working-r1.md'), first.out);
    verdictCli(['done', '--to', path.join(runDir, 'verdict-working-r1.json'), '--outcome', 'done r1']);
    await waitForFile(path.join(runDir, 'prompt-validating-r1.md'), first.out);
    const findings = path.join(runDir, 'f.md');
    fs.writeFileSync(findings, 'missing test for the 500 path');
    verdictCli(['reject', '--to', path.join(runDir, 'verdict-validating-r1.json'), '--findings', findings]);
    const promptFile = path.join(runDir, 'prompt-working-r2.md');
    await waitForFile(promptFile, first.out);
    const before = { text: fs.readFileSync(promptFile, 'utf8'), mtime: fs.statSync(promptFile).mtimeMs };
    const sessionsBefore = fs.readdirSync(fdir).filter((f) => f.endsWith('.json')).length;

    // The executor dies. By PID.
    first.child.kill('SIGKILL');
    await first.exited;

    const state = JSON.parse(fs.readFileSync(path.join(runDir, 'state.json'), 'utf8'));
    assert.strictEqual(state.stage, 'working');
    assert.strictEqual(state.round, 2);
    assert.strictEqual(state.findings, 'missing test for the 500 path');

    // resume = the same command, from the top. It must land back in round 2.
    const second = startExecutor(s, fdir);
    try {
      await new Promise((r) => setTimeout(r, 600));
      assert.match(second.out.text, /resuming at stage working, round 2/);
      assert.match(second.out.text, /prompt was already delivered/, 'it did not re-brief a working agent');
      assert.strictEqual(fs.statSync(promptFile).mtimeMs, before.mtime, 'round 2 was not composed again');
      assert.strictEqual(fs.readdirSync(fdir).filter((f) => f.endsWith('.json')).length, sessionsBefore,
        'and no fourth agent was spawned');
      assert.ok(!fs.existsSync(path.join(runDir, 'prompt-working-r1.md.tmp')));

      // It is genuinely waiting where it left off: answer round 2 and it walks on.
      verdictCli(['done', '--to', path.join(runDir, 'verdict-working-r2.json'), '--outcome', 'done r2']);
      await waitForFile(path.join(runDir, 'prompt-validating-r2.md'), second.out);
      verdictCli(['done', '--to', path.join(runDir, 'verdict-validating-r2.json'), '--outcome', 'ok https://github.com/o/r/pull/7']);
      assert.strictEqual(await second.exited, 0, second.out.text);

      const card = (await s.api('GET', '/api/cards/demo')).body;
      assert.match(card.events.filter((e) => e.kind === 'worker-done')[0].text, /finished in 2 rounds/);
    } finally {
      second.child.kill('SIGKILL');
    }
  } finally {
    first.child.kill('SIGKILL');
    await teardown();
  }
});

test('the run output is not paid for twice: a restart reuses the recorded one', async () => {
  const { s, runDir, fdir, teardown } = await boot();
  // A `run` with a side effect, so a second execution is visible.
  const marks = path.join(runDir, 'marks.txt');
  fs.mkdirSync(runDir, { recursive: true });
  fs.writeFileSync(path.join(s.dir, '.bridge-commander', 'pipelines', 'tiny.yaml'),
    TINY.replace('- echo "gate output for round {{round}}"', `- echo mark >> ${marks}`));
  const first = startExecutor(s, fdir);
  try {
    await waitForFile(path.join(runDir, 'prompt-working-r1.md'), first.out);
    verdictCli(['done', '--to', path.join(runDir, 'verdict-working-r1.json'), '--outcome', 'r1']);
    await waitForFile(path.join(runDir, 'prompt-validating-r1.md'), first.out);
    assert.strictEqual(fs.readFileSync(marks, 'utf8').trim().split('\n').length, 1);

    first.child.kill('SIGKILL');
    await first.exited;
    const second = startExecutor(s, fdir);
    try {
      await new Promise((r) => setTimeout(r, 600));
      assert.match(second.out.text, /reusing the recorded run output/);
      assert.strictEqual(fs.readFileSync(marks, 'utf8').trim().split('\n').length, 1,
        'an expensive validation run happens once per round, not once per restart');
    } finally {
      second.child.kill('SIGKILL');
    }
  } finally {
    first.child.kill('SIGKILL');
    await teardown();
  }
});

test('a bad pipeline file is refused before anything is spawned', async () => {
  const { s, runDir, fdir, teardown } = await boot();
  try {
    fs.writeFileSync(path.join(s.dir, '.bridge-commander', 'pipelines', 'tiny.yaml'),
      TINY.replace('max_rounds: 2', 'max_rounds: 0').replace('{{card.task}}', '{{card.tsak}}'));
    const { out, exited } = startExecutor(s, fdir);
    assert.strictEqual(await exited, 1);
    assert.match(out.text, /max_rounds/);
    assert.match(out.text, /unknown variable \{\{card\.tsak\}\}/);
    assert.match(out.text, /tiny\.yaml/, 'it says which file');
    assert.ok(!fs.existsSync(path.join(runDir, 'prompt-working-r1.md')), 'no prompt was composed');
    assert.deepStrictEqual(fs.existsSync(fdir) ? fs.readdirSync(fdir) : [], [], 'no agent was spawned');

    const card = (await s.api('GET', '/api/cards/demo')).body;
    const loud = card.events.filter((e) => e.level === 1);
    assert.strictEqual(loud.length, 1, 'the lieutenant is told, once, loudly');
    assert.match(loud[0].text, /refused/);
    assert.match(card.events.filter((e) => e.kind === 'worker-done')[0].text, /nothing was spawned/);
  } finally {
    await teardown();
  }
});

test('rounds are bounded: the third rejection rings the lieutenant instead of bouncing again', async () => {
  const { s, runDir, fdir, teardown } = await boot();
  const { child, out, exited } = startExecutor(s, fdir);
  try {
    for (const round of [1, 2]) {
      await waitForFile(path.join(runDir, `prompt-working-r${round}.md`), out);
      verdictCli(['done', '--to', path.join(runDir, `verdict-working-r${round}.json`), '--outcome', 'r' + round]);
      await waitForFile(path.join(runDir, `prompt-validating-r${round}.md`), out);
      const f = path.join(runDir, `f${round}.md`);
      fs.writeFileSync(f, 'still wrong, round ' + round);
      verdictCli(['reject', '--to', path.join(runDir, `verdict-validating-r${round}.json`), '--findings', f]);
    }
    assert.strictEqual(await exited, 0, out.text);
    assert.ok(!fs.existsSync(path.join(runDir, 'prompt-working-r3.md')), 'max_rounds: 2 means two rounds');

    const card = (await s.api('GET', '/api/cards/demo')).body;
    const loud = card.events.filter((e) => e.level === 1);
    assert.strictEqual(loud.length, 1);
    assert.match(loud[0].text, /needs you/);
    assert.match(loud[0].text, /2 rounds exhausted/);
    assert.match(loud[0].text, /still wrong, round 2/, 'with the findings that ran out of rounds');
    assert.match(card.events.filter((e) => e.kind === 'worker-done')[0].text, /STOPPED without a PR/);
    assert.strictEqual(card.column, 'backlog', 'still not the executor\'s job to move it');
  } finally {
    child.kill('SIGKILL');
    await teardown();
  }
});

test('--check validates and shows the prompts without spawning anything', async () => {
  const { s, runDir, fdir, teardown } = await boot();
  try {
    const r = execFileSync(process.execPath,
      [RUN, 'demo', '--workspace', s.dir, '--port', String(s.port), '--pipeline', 'tiny', '--check'],
      { encoding: 'utf8' });
    assert.match(r, /pipeline tiny is valid/);
    assert.match(r, /=== working \(round 1\) ===/);
    assert.match(r, /IMPLEMENT: The button 404s\. Fix it\./);
    assert.match(r, /=== validating \(round 1\) ===/);
    assert.ok(!fs.existsSync(path.join(runDir, 'prompt-working-r1.md')), 'a check composes nothing on disk');
    assert.deepStrictEqual(fs.existsSync(fdir) ? fs.readdirSync(fdir) : [], []);
    const card = (await s.api('GET', '/api/cards/demo')).body;
    assert.deepStrictEqual(card.events.filter((e) => e.kind === 'signal'), [], 'and says nothing to the board');
  } finally {
    await teardown();
  }
});

// The journal is the executor's memory ACROSS runs — the thing state.json is
// not. What is pinned here is the property the whole idea rests on: nothing is
// ever overwritten, and a verdict is kept WHOLE. A history that folded findings
// into a one-line summary would answer none of the questions it exists for.
test('the journal keeps every run, whole, and a second run appends instead of overwriting', async () => {
  const { s, runDir, fdir, teardown } = await boot();
  const { child, out, exited } = startExecutor(s, fdir);
  const FINDINGS = 'The fix drops the error branch.\nRepro: click with a 500 from the API.\nLine three, which a summary would eat.';
  try {
    await waitForFile(path.join(runDir, 'prompt-working-r1.md'), out);
    verdictCli(['done', '--to', path.join(runDir, 'verdict-working-r1.json'), '--outcome', 'committed 3 files']);
    await waitForFile(path.join(runDir, 'prompt-validating-r1.md'), out);
    const f = path.join(runDir, 'findings.md');
    fs.writeFileSync(f, FINDINGS);
    verdictCli(['reject', '--to', path.join(runDir, 'verdict-validating-r1.json'), '--findings', f]);
    await waitForFile(path.join(runDir, 'prompt-working-r2.md'), out);
    verdictCli(['done', '--to', path.join(runDir, 'verdict-working-r2.json'), '--outcome', 'fixed it']);
    await waitForFile(path.join(runDir, 'prompt-validating-r2.md'), out);
    verdictCli(['done', '--to', path.join(runDir, 'verdict-validating-r2.json'),
      '--outcome', 'good — https://github.com/o/r/pull/7']);
    assert.strictEqual(await exited, 0, out.text);

    const jfile = path.join(s.dir, '.bridge-commander', 'pipeline_runs', 'runs.jsonl');
    const lines = () => fs.readFileSync(jfile, 'utf8').trim().split('\n').map((l) => JSON.parse(l));
    const first = lines();
    assert.ok(first.length >= 8, 'every step is a line:\n' + first.map((r) => r.kind).join(', '));

    // One run, and it carries what it was cut from — the fact that was silently
    // wrong for months and is invisible in a summary.
    const ids = new Set(first.map((r) => r.run));
    assert.strictEqual(ids.size, 1, 'one run id across the whole run');
    const start = first.find((r) => r.kind === 'start');
    assert.strictEqual(start.card, 'demo');
    assert.ok('base' in start, 'the base commit is recorded');
    assert.strictEqual(start.resumed, false);

    // The verdict is stored WHOLE. This is the assertion the file exists for.
    const rej = first.find((r) => r.kind === 'verdict' && r.verdict === 'reject');
    assert.strictEqual(rej.text.trim(), FINDINGS, 'the findings are kept verbatim, not summarised');
    assert.strictEqual(rej.round, 1);
    assert.ok(first.some((r) => r.kind === 'stage-open' && /IMPLEMENT/.test(r.prompt)), 'prompts are kept too');
    assert.ok(first.some((r) => r.kind === 'run' && /gate output/.test(r.output)), 'and the run output');

    // Folded: rounds, rejections, outcome, and durations derived from the stamps.
    const journal = require('../pipeline/journal.js');
    const [row] = journal.runs(s.dir);
    assert.strictEqual(row.card, 'demo');
    assert.strictEqual(row.rounds, 2);
    assert.strictEqual(row.rejections.length, 1);
    assert.strictEqual(row.rejections[0].text.trim(), FINDINGS);
    assert.strictEqual(row.outcomeKind, 'finish');
    assert.match(row.outcome, /pull\/7/);
    assert.ok(Number.isFinite(row.ms) && row.ms >= 0, 'the run has a wall clock');
    assert.strictEqual(row.stages.length, 4, 'each stage of each round is timed');
    assert.ok(row.stages.every((st) => Number.isFinite(st.ms)), 'every stage has a duration');

    // THE PROMISE: run it again and the first run is still there, untouched.
    const again = startExecutor(s, fdir);
    assert.strictEqual(await again.exited, 0, again.out.text);
    const second = lines();
    assert.ok(second.length > first.length, 'the second run appended');
    assert.deepStrictEqual(second.slice(0, first.length), first, 'and did not touch a byte of the first');
    assert.ok(second.some((r) => r.kind === 'start' && r.resumed === true), 'the restart is recorded as one');

    // And the reader answers the question in one command.
    const printed = [];
    require('../pipeline/history.js').main(['--workspace', s.dir], (l) => printed.push(l));
    const text = printed.join('\n');
    assert.match(text, /demo/);
    assert.match(text, /2 rounds/);
    assert.match(text, /1 rej/);
    assert.match(text, /delivered/);
    const rejOut = [];
    require('../pipeline/history.js').main(['--workspace', s.dir, '--rejections'], (l) => rejOut.push(l));
    assert.match(rejOut.join('\n'), /Line three, which a summary would eat/);
  } finally {
    child.kill('SIGKILL');
    await teardown();
  }
});

// Observed in the wild 2026-07-30, on a real card: a pipeline reported itself
// delivered a SECOND time, in zero seconds, repeating an outcome from hours
// earlier. `state.json` had been removed to re-run it — which is what the
// executor's own message tells you to do — but the verdict files survived. The
// round counter went back to 1, `runStage` found last life's `verdict-*-r1`
// and believed both stages had already answered.
//
// A verdict on disk is evidence only if THIS run put it there.
test('a fresh run does not inherit a previous life\'s verdicts and re-report the card done', async () => {
  const { s, runDir, fdir, teardown } = await boot();
  const first = startExecutor(s, fdir);
  try {
    // A complete run, one round, delivered.
    await waitForFile(path.join(runDir, 'prompt-working-r1.md'), first.out);
    verdictCli(['done', '--to', path.join(runDir, 'verdict-working-r1.json'), '--outcome', 'the real work']);
    await waitForFile(path.join(runDir, 'prompt-validating-r1.md'), first.out);
    verdictCli(['done', '--to', path.join(runDir, 'verdict-validating-r1.json'),
      '--outcome', 'first landing — https://github.com/o/r/pull/1']);
    assert.strictEqual(await first.exited, 0, first.out.text);

    let card = (await s.api('GET', '/api/cards/demo')).body;
    assert.strictEqual(card.events.filter((e) => e.kind === 'worker-done').length, 1);

    // Exactly what a person does to run it again: remove the state file. The
    // verdicts stay — nothing tells you to delete those.
    fs.rmSync(path.join(runDir, 'state.json'));
    assert.ok(fs.existsSync(path.join(runDir, 'verdict-validating-r1.json')), 'last life\'s answer is still there');

    const second = startExecutor(s, fdir);
    // Waiting for the prompt file proves nothing here — last life's copy is
    // still on disk. Wait for the sweep to be announced instead.
    const deadline = Date.now() + 15000;
    while (!/discarded \d+ artefact/.test(second.out.text)) {
      if (Date.now() > deadline) assert.fail('never swept:\n' + second.out.text);
      await new Promise((r) => setTimeout(r, 30));
    }
    assert.ok(!fs.existsSync(path.join(runDir, 'verdict-validating-r1.json')),
      'the previous life\'s answer is gone');

    // and it is genuinely waiting for an answer rather than having finished
    card = (await s.api('GET', '/api/cards/demo')).body;
    assert.strictEqual(card.events.filter((e) => e.kind === 'worker-done').length, 1,
      'the card was NOT reported done a second time');

    verdictCli(['done', '--to', path.join(runDir, 'verdict-working-r1.json'), '--outcome', 'redone']);
    await waitForFile(path.join(runDir, 'prompt-validating-r1.md'), second.out);
    verdictCli(['done', '--to', path.join(runDir, 'verdict-validating-r1.json'),
      '--outcome', 'second landing — https://github.com/o/r/pull/2']);
    assert.strictEqual(await second.exited, 0, second.out.text);

    card = (await s.api('GET', '/api/cards/demo')).body;
    const done = card.events.filter((e) => e.kind === 'worker-done');
    assert.strictEqual(done.length, 2, 'two real runs, two reports');
    assert.match(done[1].text, /pull\/2/, 'the second report is the second run\'s outcome, not a replay of the first');
    second.child.kill('SIGKILL');
  } finally {
    first.child.kill('SIGKILL');
    await teardown();
  }
});

// The journal keeps the executor's half of a round. The agent's own half — its
// reasoning, the files it read, what it tried and dropped — lives in the
// harness's session transcript. The journal points at it rather than swallowing
// it: megabytes read one at a time do not belong in a file you grep across runs.
test('an agent\'s transcript is located and pointed at from the journal', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'bc-transcript-'));
  try {
    const stage = require('../pipeline/stage.js');
    const { claudeProjectSlug } = require('../harness/agent-status.js');
    const projects = path.join(root, 'projects');
    const cwd = path.join(root, 'worktree');
    const ref = { harness: 'claude', cwd, resumeId: 'abc-123' };
    const dir = path.join(projects, claudeProjectSlug(cwd));
    fs.mkdirSync(dir, { recursive: true });
    const BODY = '{"type":"assistant","text":"reading selecto source"}\n';
    fs.writeFileSync(path.join(dir, 'abc-123.jsonl'), BODY);

    const prev = process.env.BC_CLAUDE_PROJECTS_DIR;
    process.env.BC_CLAUDE_PROJECTS_DIR = projects;
    try {
      assert.strictEqual(stage.transcriptPath(ref), path.join(dir, 'abc-123.jsonl'));

      const found = stage.transcriptOf(ref);
      assert.ok(found, 'the transcript was located');
      assert.strictEqual(found.path, path.join(dir, 'abc-123.jsonl'), 'the pointer is the real file');
      assert.strictEqual(found.bytes, Buffer.byteLength(BODY), 'and its size, so you know what you are opening');

      // Best effort, always. A harness with no transcript, an agent with no
      // session yet, or a file that has gone away must never cost anyone a run.
      assert.strictEqual(stage.transcriptPath({ harness: 'fake', cwd }), null);
      assert.strictEqual(stage.transcriptPath({ harness: 'claude', cwd }), null, 'no resumeId yet');
      assert.strictEqual(stage.transcriptPath(null), null);
      fs.rmSync(path.join(dir, 'abc-123.jsonl'));
      assert.strictEqual(stage.transcriptOf(ref), null, 'gone — null, not a throw');
      assert.strictEqual(stage.transcriptOf({ harness: 'fake', cwd }), null);
    } finally {
      if (prev === undefined) delete process.env.BC_CLAUDE_PROJECTS_DIR;
      else process.env.BC_CLAUDE_PROJECTS_DIR = prev;
    }
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('a rejection with no text is refused at the source', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bc-verdict-'));
  try {
    const to = path.join(dir, 'v.json');
    const empty = path.join(dir, 'empty.md');
    fs.writeFileSync(empty, '   \n');
    assert.throws(() => verdictCli(['reject', '--to', to, '--findings', empty]), (e) => {
      assert.match(String(e.stderr), /is empty/);
      assert.match(String(e.stderr), /nothing to fix/);
      return true;
    });
    assert.ok(!fs.existsSync(to), 'and nothing is recorded — the round is not consumed by an empty bounce');
    assert.throws(() => verdictCli(['reject', '--to', to]), (e) => /--findings/.test(String(e.stderr)));
    assert.throws(() => verdictCli(['done', '--to', to]), (e) => /--outcome/.test(String(e.stderr)));
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
