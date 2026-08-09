'use strict';
// Named hooks, the one door that runs them, and the trace every run leaves.
//
// The namespace is free: hooks/<event>/<name> is a lifecycle hook exactly as it
// always was, and hooks/<name> — an executable file DIRECTLY in hooks/ — is a
// named hook that nothing fires but a caller. Directory means event, file means
// name, and listHooks() only ever reads the directories, so the two cannot
// collide.
//
// `bc-axi hook run <name>` is that caller, and it is also what the board's ▶
// posts to and what a schedule will call: one code path, three triggers, and the
// trace line is identical but for which one it was.
//
// The trace is .bridge-commander/hookruns.jsonl, written by the RUNNER — so the
// lifecycle hooks a workspace already had land in it too and stop being
// invisible — and read back from the TAIL.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { runHooks, runNamedHook, listAllHooks, listHooks, readRuns } = require('../server/hooks.js');
const { startServerWithLieutenant, withOwner, runCli, sleep } = require('./helper');

function scratchWs() { return fs.mkdtempSync(path.join(os.tmpdir(), 'bc-hookrun-')); }
function runsFile(ws) { return path.join(ws, '.bridge-commander', 'hookruns.jsonl'); }
function lines(ws) {
  return fs.readFileSync(runsFile(ws), 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l));
}
// a named hook: an executable file directly in hooks/
function named(ws, name, script) {
  const dir = path.join(ws, '.bridge-commander', 'hooks');
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, name);
  fs.writeFileSync(file, '#!/bin/sh\n' + script + '\n');
  fs.chmodSync(file, 0o755);
  return file;
}
// a lifecycle hook: an executable file in hooks/<event>/
function lifecycle(ws, event, name, script) {
  const dir = path.join(ws, '.bridge-commander', 'hooks', event);
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, name);
  fs.writeFileSync(file, '#!/bin/sh\n' + script + '\n');
  fs.chmodSync(file, 0o755);
  return file;
}

// ---------- the namespace ----------

test('directory means event, file means name — the two live in one hooks/ and never collide', async () => {
  const ws = scratchWs();
  try {
    named(ws, 'gh-watch', 'echo named');
    lifecycle(ws, 'worker-done', 'sweep.sh', 'echo lifecycle');
    assert.deepStrictEqual(listAllHooks(ws).map((h) => [h.name, h.event]),
      [['gh-watch', ''], ['sweep.sh', 'worker-done']]);
    // the lifecycle side is unchanged: worker-done still runs its own dir, and
    // the named hook sitting one level up is not part of any event
    const r = await runHooks('worker-done', { workspace: ws, card: 'c1' });
    assert.deepStrictEqual(r.map((x) => [x.hook, x.output]), [['sweep.sh', 'lifecycle']]);
  } finally { fs.rmSync(ws, { recursive: true, force: true }); }
});

test('a non-executable file in hooks/ is not a named hook, and neither is a name that is not an id', async () => {
  const ws = scratchWs();
  try {
    const f = named(ws, 'inert', 'echo nope');
    fs.chmodSync(f, 0o644);
    named(ws, 'real', 'echo yes');
    assert.deepStrictEqual(listAllHooks(ws).map((h) => h.name), ['real']);
    await assert.rejects(() => runNamedHook(ws, 'inert', {}), (e) => e.code === 'ENOHOOK');
    await assert.rejects(() => runNamedHook(ws, '../real', {}), (e) => e.code === 'ENOHOOK');
  } finally { fs.rmSync(ws, { recursive: true, force: true }); }
});

// The listing is what the tab and `hook list` read, and every row it prints
// carries a ✎ that goes through the artifact gate — which matches the board's id
// shape. A lifecycle hook the gate would refuse is left off the listing rather
// than offered with a pencil that 404s; the RUNNER is untouched and still runs
// whatever the workspace installed.
test('a lifecycle hook whose name the editor gate would refuse is not listed — but still runs', async () => {
  const ws = scratchWs();
  try {
    lifecycle(ws, 'worker-done', '10 deploy.sh', 'echo spacey');
    lifecycle(ws, 'worker-done', 'sweep.sh', 'echo fine');
    assert.deepStrictEqual(listAllHooks(ws).map((h) => [h.name, h.event]), [['sweep.sh', 'worker-done']]);
    assert.deepStrictEqual(listHooks(ws, 'worker-done').map((f) => path.basename(f)),
      ['10 deploy.sh', 'sweep.sh'], 'the runner still sees both');
    const r = await runHooks('worker-done', { workspace: ws, card: 'c1' });
    assert.deepStrictEqual(r.map((x) => x.output), ['spacey', 'fine']);
  } finally { fs.rmSync(ws, { recursive: true, force: true }); }
});

test('an unknown name is an error naming the hooks directory, never a silent success', async () => {
  const ws = scratchWs();
  try {
    named(ws, 'real', 'echo yes');
    await assert.rejects(() => runNamedHook(ws, 'ghost', {}), (e) => {
      assert.strictEqual(e.code, 'ENOHOOK');
      assert.match(e.message, /no hook "ghost"/);
      assert.ok(e.message.includes(path.join(ws, '.bridge-commander', 'hooks')), 'the directory is named');
      return true;
    });
    assert.ok(!fs.existsSync(runsFile(ws)), 'and nothing was traced for a hook that never ran');
  } finally { fs.rmSync(ws, { recursive: true, force: true }); }
});

// ---------- env and the trace ----------

test('a named hook gets its OWN name in BC_EVENT, empty card context, and bc-axi on its PATH', async () => {
  const ws = scratchWs();
  try {
    named(ws, 'gh-watch',
      'echo "$BC_EVENT|$BC_CARD|$BC_WORKTREE|$BC_BRANCH" > env.out\n'
      + 'command -v bc-axi > cli.out');
    const run = await runNamedHook(ws, 'gh-watch', {});
    assert.strictEqual(run.ok, true);
    assert.strictEqual(fs.readFileSync(path.join(ws, 'env.out'), 'utf8').trim(), 'gh-watch|||');
    assert.match(fs.readFileSync(path.join(ws, 'cli.out'), 'utf8').trim(), /bc-axi$/,
      'a hook is bash with the board CLI on its PATH — that is the whole API');
  } finally { fs.rmSync(ws, { recursive: true, force: true }); }
});

// The PATH guarantee is *reachable*, not *mine*: a `bc-axi` the operator put
// earlier on PATH is the one that runs. Shadowing it would make a hook resolve
// a name differently from the shell he tested it in.
test('the CLI is APPENDED to PATH, so an operator-installed bc-axi still wins', async () => {
  const ws = scratchWs();
  const mine = path.join(ws, 'bin');
  const savedPath = process.env.PATH;
  try {
    fs.mkdirSync(mine, { recursive: true });
    fs.writeFileSync(path.join(mine, 'bc-axi'), '#!/bin/sh\necho operator\n');
    fs.chmodSync(path.join(mine, 'bc-axi'), 0o755);
    process.env.PATH = mine + path.delimiter + savedPath;
    named(ws, 'which-cli', 'command -v bc-axi > cli.out');
    const run = await runNamedHook(ws, 'which-cli', {});
    assert.strictEqual(run.ok, true);
    assert.strictEqual(fs.readFileSync(path.join(ws, 'cli.out'), 'utf8').trim(),
      path.join(mine, 'bc-axi'), 'the board makes its CLI reachable, it does not take the name');
  } finally {
    process.env.PATH = savedPath;
    fs.rmSync(ws, { recursive: true, force: true });
  }
});

test('a card supplied by the caller fills BC_CARD/BC_WORKTREE/BC_BRANCH', async () => {
  const ws = scratchWs();
  try {
    named(ws, 'ctx', 'echo "$BC_CARD|$BC_WORKTREE|$BC_BRANCH" > env.out');
    await runNamedHook(ws, 'ctx', { card: 'MNC-9', worktree: '/w', branch: 'bc/MNC-9' });
    assert.strictEqual(fs.readFileSync(path.join(ws, 'env.out'), 'utf8').trim(), 'MNC-9|/w|bc/MNC-9');
    assert.strictEqual(lines(ws)[0].card, 'MNC-9');
  } finally { fs.rmSync(ws, { recursive: true, force: true }); }
});

test('a lifecycle hook firing appends a trace line with trigger = its event', async () => {
  const ws = scratchWs();
  try {
    lifecycle(ws, 'worker-done', 'sweep.sh', 'echo swept');
    lifecycle(ws, 'card-archived', 'bury.sh', 'echo buried');
    await runHooks('worker-done', { workspace: ws, card: 'c1' });
    await runHooks('card-archived', { workspace: ws, card: 'c1' });
    assert.deepStrictEqual(lines(ws).map((r) => [r.hook, r.trigger, r.card, r.ok, r.code]), [
      ['sweep.sh', 'worker-done', 'c1', true, 0],
      ['bury.sh', 'card-archived', 'c1', true, 0],
    ]);
  } finally { fs.rmSync(ws, { recursive: true, force: true }); }
});

test('a failing hook lands its exit code and its output tail, and the caller lives', async () => {
  const ws = scratchWs();
  try {
    named(ws, 'boom', 'echo the reason it broke >&2\nexit 7');
    const run = await runNamedHook(ws, 'boom', {}); // resolves — a bad exit is a RESULT
    assert.deepStrictEqual([run.ok, run.code, run.timedOut, run.output], [false, 7, false, 'the reason it broke']);
    assert.deepStrictEqual(lines(ws).map((r) => [r.hook, r.ok, r.code, r.output]),
      [['boom', false, 7, 'the reason it broke']]);
  } finally { fs.rmSync(ws, { recursive: true, force: true }); }
});

test('a hook that hangs past the timeout lands timedOut with what it managed to say', async () => {
  const ws = scratchWs();
  try {
    named(ws, 'hang', 'echo starting\nsleep 30');
    const t0 = Date.now();
    const run = await runNamedHook(ws, 'hang', {}, { timeoutMs: 300 });
    assert.ok(Date.now() - t0 < 5000, 'did not wait for the sleep');
    assert.strictEqual(run.timedOut, true);
    assert.strictEqual(run.ok, false);
    const rec = lines(ws)[0];
    assert.strictEqual(rec.timedOut, true);
    assert.match(rec.output, /starting/, 'the output tail is on the line');
  } finally { fs.rmSync(ws, { recursive: true, force: true }); }
});

test('a broken interpreter is a traced failure, not a crash', async () => {
  const ws = scratchWs();
  try {
    const dir = path.join(ws, '.bridge-commander', 'hooks');
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, 'broken'), '#!/no/such/interpreter\necho hi\n');
    fs.chmodSync(path.join(dir, 'broken'), 0o755);
    const run = await runNamedHook(ws, 'broken', {});
    assert.strictEqual(run.ok, false);
    assert.ok(run.error, 'the spawn failure is on the record');
    assert.ok(lines(ws)[0].error, 'and on the trace line');
  } finally { fs.rmSync(ws, { recursive: true, force: true }); }
});

// ---------- one run per name ----------

test('a second run of a name already in flight is refused, naming the one that is running', async () => {
  const ws = scratchWs();
  try {
    named(ws, 'slow', 'sleep 1');
    const first = runNamedHook(ws, 'slow', { card: 'MNC-1' }, { trigger: 'schedule' });
    await sleep(150);
    await assert.rejects(() => runNamedHook(ws, 'slow', {}, { trigger: 'board' }), (e) => {
      assert.strictEqual(e.code, 'EBUSY');
      assert.match(e.message, /already running/);
      assert.match(e.message, /trigger schedule/, 'it says WHAT is running');
      assert.match(e.message, /card MNC-1/);
      return true;
    });
    await first;
    // …and once it is done the name is free again
    const again = await runNamedHook(ws, 'slow', {}, { trigger: 'board', timeoutMs: 300 });
    assert.ok(again, 'the lock released with the run');
    assert.strictEqual(lines(ws).length, 2, 'the refusal traced nothing — it never ran');
  } finally { fs.rmSync(ws, { recursive: true, force: true }); }
});

// ---------- reading the trace off the tail ----------

test('readRuns answers off the TAIL — a huge trace is never loaded whole', async () => {
  const ws = scratchWs();
  try {
    fs.mkdirSync(path.join(ws, '.bridge-commander'), { recursive: true });
    // ~3MB of history, then the three runs anybody cares about
    const filler = [];
    for (let i = 0; i < 12000; i++) {
      filler.push(JSON.stringify({ hook: 'old', trigger: 'cli', card: '', started: '2020-01-01T00:00:00.000Z',
        ms: 1, code: 0, ok: true, timedOut: false, output: 'x'.repeat(200) }));
    }
    fs.writeFileSync(runsFile(ws), filler.join('\n') + '\n');
    for (const [hook, code] of [['a', 0], ['b', 3], ['a', 0]]) {
      fs.appendFileSync(runsFile(ws), JSON.stringify({ hook, trigger: 'cli', card: '',
        started: '2026-01-01T00:00:00.000Z', ms: 5, code, ok: code === 0, timedOut: false, output: '' }) + '\n');
    }
    assert.ok(fs.statSync(runsFile(ws)).size > 2e6, 'the trace is genuinely large');

    // The proof, not a stopwatch: slurping the file is the thing readRuns must
    // not do, so make slurping the file impossible.
    const real = fs.readFileSync;
    fs.readFileSync = () => { throw new Error('readRuns read the whole file'); };
    let newest, mine;
    try {
      newest = readRuns(ws, { limit: 3 });
      mine = readRuns(ws, { hook: 'b', limit: 5 });
    } finally { fs.readFileSync = real; }

    assert.deepStrictEqual(newest.map((r) => [r.hook, r.code]), [['a', 0], ['b', 3], ['a', 0]].reverse());
    assert.deepStrictEqual(mine.map((r) => r.hook), ['b']);
  } finally { fs.rmSync(ws, { recursive: true, force: true }); }
});

test('a torn line is skipped, and the rest of the trace still reads', async () => {
  const ws = scratchWs();
  try {
    fs.mkdirSync(path.join(ws, '.bridge-commander'), { recursive: true });
    fs.writeFileSync(runsFile(ws),
      JSON.stringify({ hook: 'a', trigger: 'cli', code: 0, ok: true }) + '\n'
      + '{"hook":"torn","trig\n'
      + JSON.stringify({ hook: 'c', trigger: 'cli', code: 0, ok: true }) + '\n');
    assert.deepStrictEqual(readRuns(ws, { limit: 10 }).map((r) => r.hook), ['c', 'a']);
  } finally { fs.rmSync(ws, { recursive: true, force: true }); }
});

// ---------- the three callers ----------

test('CLI and board produce identical trace lines but for the trigger', async () => {
  const s = await startServerWithLieutenant();
  try {
    named(s.dir, 'gh-watch', 'echo checked');
    const cli = await runCli(['hook', 'run', 'gh-watch', '--workspace', s.dir, '--port', String(s.port)]);
    assert.strictEqual(cli.code, 0, cli.stderr);
    assert.match(cli.stdout, /checked/);
    assert.match(cli.stdout, /exit 0/);

    const board = await s.api('POST', '/api/hooks/run', { name: 'gh-watch', trigger: 'board' });
    assert.strictEqual(board.status, 200, JSON.stringify(board.body));

    const [a, b] = lines(s.dir);
    assert.strictEqual(a.trigger, 'cli');
    assert.strictEqual(b.trigger, 'board');
    const same = (r) => ({ hook: r.hook, card: r.card, ok: r.ok, code: r.code, timedOut: r.timedOut, output: r.output });
    assert.deepStrictEqual(same(a), same(b), 'the trigger is the ONLY difference');
    assert.deepStrictEqual(same(a),
      { hook: 'gh-watch', card: '', ok: true, code: 0, timedOut: false, output: 'checked' });
  } finally { await s.stop(); }
});

test('hook run over the CLI: a failing hook exits 1 and the trace says why; a busy name is refused', async () => {
  const s = await startServerWithLieutenant();
  try {
    named(s.dir, 'boom', 'echo nope >&2\nexit 4');
    // Three seconds, where the in-process refusal test upstairs needs one: this
    // assertion has to outlive a COLD node spawning the CLI — config read, port
    // resolution, the request — before the 409 can be observed at all. The two
    // tests do not pay the same cost, so they do not carry the same margin.
    // Three seconds of wall in one test is nothing; a flake costs an hour every
    // time it fires, on a branch whose author has no reason to suspect it.
    named(s.dir, 'slow', 'sleep 3');
    const ws = ['--workspace', s.dir, '--port', String(s.port)];

    const bad = await runCli(['hook', 'run', 'boom', ...ws]);
    assert.strictEqual(bad.code, 1, 'the caller inherits the hook’s failure');
    assert.match(bad.stdout, /exit 4/);

    const ghost = await runCli(['hook', 'run', 'ghost', ...ws]);
    assert.strictEqual(ghost.code, 1);
    assert.match(ghost.stderr, /no hook "ghost"/);

    const inFlight = s.api('POST', '/api/hooks/run', { name: 'slow', trigger: 'schedule' });
    await sleep(200);
    const clash = await runCli(['hook', 'run', 'slow', ...ws]);
    assert.strictEqual(clash.code, 1);
    assert.match(clash.stderr, /already running/);
    await inFlight;
  } finally { await s.stop(); }
});

test('hook list and hook runs read the workspace and the trace', async () => {
  const s = await startServerWithLieutenant();
  try {
    named(s.dir, 'gh-watch', 'echo checked');
    lifecycle(s.dir, 'worker-done', 'sweep.sh', 'exit 0');
    const ws = ['--workspace', s.dir, '--port', String(s.port)];

    let list = await runCli(['hook', 'list', ...ws]);
    assert.match(list.stdout, /gh-watch\tnamed\tnever ran/);
    assert.match(list.stdout, /sweep\.sh\tworker-done\tnever ran/);

    await runCli(['hook', 'run', 'gh-watch', '--trigger', 'cron', ...ws]);
    list = await runCli(['hook', 'list', ...ws]);
    assert.match(list.stdout, /gh-watch\tnamed\tran .* · exit 0/);
    assert.match(list.stdout, /sweep\.sh\tworker-done\tnever ran/, 'a run of one is not a run of the other');

    const runs = await runCli(['hook', 'runs', ...ws]);
    assert.match(runs.stdout, /gh-watch\s+cron\s+exit 0/);
    const mine = await runCli(['hook', 'runs', 'sweep.sh', ...ws]);
    assert.match(mine.stdout, /no runs recorded for sweep\.sh/);
  } finally { await s.stop(); }
});

test('hook run --card hands the hook the card’s real worktree and branch', async () => {
  const s = await startServerWithLieutenant();
  try {
    const out = path.join(s.dir, 'ctx.out');
    named(s.dir, 'ctx', 'echo "$BC_CARD|$BC_BRANCH" > ' + JSON.stringify(out));
    await s.api('POST', '/api/cards', withOwner({ title: 'Watched', id: 'watched' }));
    const r = await runCli(['hook', 'run', 'ctx', '--card', 'watched',
      '--workspace', s.dir, '--port', String(s.port)]);
    assert.strictEqual(r.code, 0, r.stderr);
    assert.strictEqual(fs.readFileSync(out, 'utf8').trim(), 'watched|');

    const unknown = await s.api('POST', '/api/hooks/run', { name: 'ctx', card: 'nope' });
    assert.strictEqual(unknown.status, 404);
  } finally { await s.stop(); }
});

test('GET /api/hooks: every hook, its kind, and its newest trace line', async () => {
  const s = await startServerWithLieutenant();
  try {
    named(s.dir, 'gh-watch', 'exit 2');
    lifecycle(s.dir, 'worker-done', 'sweep.sh', 'exit 0');
    await s.api('POST', '/api/hooks/run', { name: 'gh-watch', trigger: 'board' });
    const r = await s.api('GET', '/api/hooks');
    assert.strictEqual(r.status, 200);
    assert.strictEqual(r.body.dir, path.join(s.dir, '.bridge-commander', 'hooks'));
    const by = Object.fromEntries(r.body.hooks.map((h) => [h.name, h]));
    assert.strictEqual(by['gh-watch'].event, '');
    assert.deepStrictEqual([by['gh-watch'].last.trigger, by['gh-watch'].last.code, by['gh-watch'].last.ok],
      ['board', 2, false]);
    assert.strictEqual(by['sweep.sh'].event, 'worker-done');
    assert.strictEqual(by['sweep.sh'].last, null, 'it has not fired');
  } finally { await s.stop(); }
});
