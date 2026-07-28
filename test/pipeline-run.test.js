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

  const runDir = path.join(s.dir, '.bridge-commander', 'pipeline', 'demo');
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
