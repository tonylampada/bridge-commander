'use strict';
// claude's /output-style: the style list it offers as `args`, and the
// write-then-cycle that applies one.
//
// Why this command is not a pass-through at all is in claude-tmux.js's own
// comment: claude 2.1.239 answers "Unknown command: /output-style" — the
// dedicated command was removed and styles moved into the interactive /config
// dialog, which is precisely the menu a worker must never be parked on. So the
// board writes the setting into the session's OWN cwd and cycles the session
// through kill+resume to pick it up.
//
// tmux is mocked (tmux-mock.js), so the cycle runs end-to-end here with no real
// tmux and no real claude: what is pinned is the settings file that gets written
// and the fact that the session comes back on --resume.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const claude = require('../claude-tmux.js');
const codex = require('../codex-tmux.js');
const { mockTmux } = require('./tmux-mock.js');

const READY = '⏵⏵ bypass permissions on (shift+tab to cycle)\n❯ ';

function tmpdir(prefix) {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}
function styleFile(dir, name, body) {
  fs.writeFileSync(path.join(dir, name), body);
}
// A style installed the OTHER way claude honours: in the session's own
// <cwd>/.claude/output-styles/.
function projectStyle(cwd, name, body) {
  const dir = path.join(cwd, '.claude', 'output-styles');
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, name), body);
  return dir;
}
function outputStyleCommand() {
  return claude.commands().find((c) => c.name === '/output-style');
}

test('the built-ins are the ones the binary actually ships, not the ones everybody remembers', () => {
  // Pinned against the claude 2.1.239 style table (name + description lifted
  // from the binary). The list that "everybody knows" — default/Explanatory/
  // Learning — is missing two, which is exactly why this assertion is here.
  assert.deepStrictEqual(
    claude.BUILTIN_OUTPUT_STYLES.map((s) => s.value),
    ['default', 'Proactive', 'Concise', 'Explanatory', 'Learning']);
  for (const s of claude.BUILTIN_OUTPUT_STYLES) {
    assert.ok(s.description && s.description.length > 10, s.value + ' carries its description');
  }
});

test('outputStyles: built-ins, plus a *.md per custom style named by its front matter', () => {
  const dir = tmpdir('bc-styles-');
  try {
    styleFile(dir, 'eli5.md', '---\nname: ELI5\ndescription: keep it simple pls\n---\ntalk to me like I am 5\n');
    styleFile(dir, 'quoted.md', '---\nname: "Quoted Name"\ndescription: \'single quoted\'\n---\nbody\n');
    const styles = claude.outputStyles({ stylesDir: dir });

    // the built-ins come first and are untouched
    assert.deepStrictEqual(styles.slice(0, 5).map((s) => s.value),
      claude.BUILTIN_OUTPUT_STYLES.map((s) => s.value));

    const eli5 = styles.find((s) => s.value === 'ELI5');
    assert.ok(eli5, 'the front-matter name is the value, not the basename');
    assert.strictEqual(eli5.description, 'keep it simple pls');

    // quotes around a front-matter scalar are syntax, not part of the name —
    // and a name with a SPACE has to survive, since the command takes the whole
    // remainder of the line as one argument.
    const quoted = styles.find((s) => s.value === 'Quoted Name');
    assert.ok(quoted, 'quotes stripped, spaces kept');
    assert.strictEqual(quoted.description, 'single quoted');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('outputStyles: a style file with no usable front matter falls back to its basename', () => {
  const dir = tmpdir('bc-styles-');
  try {
    styleFile(dir, 'unnamed.md', '---\ndescription: has a description but no name\n---\nbody\n');
    styleFile(dir, 'bare.md', 'no front matter at all, just prose\n');
    const styles = claude.outputStyles({ stylesDir: dir });

    const unnamed = styles.find((s) => s.value === 'unnamed');
    assert.ok(unnamed, 'no name: → the basename');
    assert.strictEqual(unnamed.description, 'has a description but no name');

    const bare = styles.find((s) => s.value === 'bare');
    assert.ok(bare, 'no front matter at all is still a usable style');
    assert.match(bare.description, /bare\.md/, 'and gets a description naming the file');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('outputStyles: junk in the directory is ignored, and a name never collides with a built-in', () => {
  const dir = tmpdir('bc-styles-');
  try {
    styleFile(dir, 'notes.txt', 'not a style file');       // wrong extension
    fs.mkdirSync(path.join(dir, 'subdir.md'));              // a DIRECTORY named *.md
    styleFile(dir, 'shadow.md', '---\nname: Learning\n---\nshadowing a built-in\n');
    const styles = claude.outputStyles({ stylesDir: dir });

    assert.ok(!styles.some((s) => s.value === 'notes'), 'a .txt is not a style');
    assert.ok(!styles.some((s) => s.value === 'subdir'), 'an unreadable *.md entry is skipped, not thrown on');
    assert.strictEqual(styles.filter((s) => s.value === 'Learning').length, 1,
      'a custom file cannot shadow a built-in into the list twice');
    assert.strictEqual(styles.find((s) => s.value === 'Learning').description,
      claude.BUILTIN_OUTPUT_STYLES.find((s) => s.value === 'Learning').description,
      'and the built-in is the one that survives');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('outputStyles: an unreadable directory is the built-ins alone, never a throw', () => {
  const styles = claude.outputStyles({ stylesDir: '/nonexistent/bc-not-a-real-dir' });
  assert.deepStrictEqual(styles.map((s) => s.value), claude.BUILTIN_OUTPUT_STYLES.map((s) => s.value));
});

test('commands(): /output-style rides with its styles as args; the others carry none', () => {
  const dir = tmpdir('bc-styles-');
  const prev = process.env.BC_CLAUDE_OUTPUT_STYLES_DIR;
  process.env.BC_CLAUDE_OUTPUT_STYLES_DIR = dir;
  try {
    styleFile(dir, 'eli5.md', '---\nname: ELI5\ndescription: keep it simple pls\n---\nbody\n');
    const cmds = claude.commands();
    assert.deepStrictEqual(cmds.map((c) => c.name),
      ['/status', '/compact', '/help', '/autocompact', '/output-style']);

    const os_ = cmds.find((c) => c.name === '/output-style');
    assert.ok(Array.isArray(os_.args) && os_.args.length, 'the command reports its own options');
    assert.ok(os_.args.some((a) => a.value === 'ELI5'), 'including the ones on disk');
    for (const a of os_.args) {
      assert.strictEqual(typeof a.value, 'string');
      assert.strictEqual(typeof a.description, 'string');
    }
    // args is OPTIONAL metadata — a command that takes nothing must not grow one
    for (const c of cmds.filter((c) => c.name !== '/output-style')) {
      assert.strictEqual(c.args, undefined, c.name + ' takes no argument');
    }
  } finally {
    if (prev === undefined) delete process.env.BC_CLAUDE_OUTPUT_STYLES_DIR;
    else process.env.BC_CLAUDE_OUTPUT_STYLES_DIR = prev;
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('the BARE form is refused with the list, and nothing is written or restarted', async () => {
  const cwd = tmpdir('bc-osc-');
  const styles = tmpdir('bc-styles-');
  const prev = process.env.BC_CLAUDE_OUTPUT_STYLES_DIR;
  process.env.BC_CLAUDE_OUTPUT_STYLES_DIR = styles;
  const mock = mockTmux({ readyTail: READY });
  try {
    styleFile(styles, 'eli5.md', '---\nname: ELI5\ndescription: keep it simple pls\n---\nbody\n');
    const ref = { harness: 'claude', session: 'bc-os1', cwd, resumeId: 'uuid-os1' };
    // The whole reason this command exists: bare /output-style must never reach
    // the session, because claude's answer to it is an interactive dialog.
    await assert.rejects(
      claude.runCommand(ref, '/output-style', { stateDir: cwd }),
      (e) => {
        assert.match(e.message, /needs a style name/);
        assert.match(e.message, /default/, 'the message carries the list');
        assert.match(e.message, /ELI5/, 'including the custom ones');
        return true;
      });
    assert.ok(!fs.existsSync(path.join(cwd, '.claude', 'settings.local.json')), 'nothing written');
    assert.deepStrictEqual(mock.calls.filter((c) => c.fn === 'submit'), [], 'nothing typed into the session');
  } finally {
    mock.restore();
    if (prev === undefined) delete process.env.BC_CLAUDE_OUTPUT_STYLES_DIR;
    else process.env.BC_CLAUDE_OUTPUT_STYLES_DIR = prev;
    fs.rmSync(cwd, { recursive: true, force: true });
    fs.rmSync(styles, { recursive: true, force: true });
  }
});

test('an unknown style name is refused BEFORE anything is written — a typo must not cost a restart', async () => {
  const cwd = tmpdir('bc-osc-');
  const mock = mockTmux({ readyTail: READY });
  try {
    const ref = { harness: 'claude', session: 'bc-os2', cwd, resumeId: 'uuid-os2' };
    await assert.rejects(
      claude.runCommand(ref, '/output-style Nonsense', { stateDir: cwd }),
      (e) => {
        assert.match(e.message, /unknown output style "Nonsense"/);
        assert.match(e.message, /available: default/);
        return true;
      });
    assert.ok(!fs.existsSync(path.join(cwd, '.claude', 'settings.local.json')), 'no settings file');
    assert.ok(!mock.calls.some((c) => c.fn === 'tmux' && String(c.args[0]).includes('kill')),
      'and the session was never cycled');
  } finally {
    mock.restore();
    fs.rmSync(cwd, { recursive: true, force: true });
  }
});

test('a good name writes outputStyle into the SESSION cwd and cycles the session onto --resume', async () => {
  const cwd = tmpdir('bc-osc-');
  const styles = tmpdir('bc-styles-');
  const state = tmpdir('bc-state-');
  const prev = process.env.BC_CLAUDE_OUTPUT_STYLES_DIR;
  process.env.BC_CLAUDE_OUTPUT_STYLES_DIR = styles;
  const mock = mockTmux({ readyTail: READY });
  try {
    styleFile(styles, 'eli5.md', '---\nname: ELI5\ndescription: keep it simple pls\n---\nbody\n');
    // a settings file that already carries the Stop hook: the write must MERGE,
    // because installHooks owns this very file.
    fs.mkdirSync(path.join(cwd, '.claude'), { recursive: true });
    fs.writeFileSync(path.join(cwd, '.claude', 'settings.local.json'),
      JSON.stringify({ hooks: { Stop: [{ hooks: [{ type: 'command', command: 'node hook.js' }] }] } }, null, 2));

    const ref = { harness: 'claude', session: 'bc-os3', cwd, resumeId: 'uuid-os3' };
    const reply = await claude.runCommand(ref, '/output-style eli5', { stateDir: state });

    const settings = JSON.parse(fs.readFileSync(path.join(cwd, '.claude', 'settings.local.json'), 'utf8'));
    assert.strictEqual(settings.outputStyle, 'ELI5', 'canonical casing, not what was typed');
    assert.ok(settings.hooks && settings.hooks.Stop.length === 1, 'the Stop hook survived the write');

    // The reply says the session restarted — no silent restarts.
    assert.match(reply, /output style now ELI5/);
    assert.match(reply, /resumed/);

    // and the session really was cycled back in on its own resume id
    const launched = mock.calls.filter((c) => c.fn === 'sendLiteral').map((c) => c.args[1]).join('\n');
    assert.match(launched, /claude --dangerously-skip-permissions --resume uuid-os3/,
      'brought back with --resume, so the conversation comes back with it');
  } finally {
    mock.restore();
    if (prev === undefined) delete process.env.BC_CLAUDE_OUTPUT_STYLES_DIR;
    else process.env.BC_CLAUDE_OUTPUT_STYLES_DIR = prev;
    for (const d of [cwd, styles, state]) fs.rmSync(d, { recursive: true, force: true });
  }
});

test('a style name containing spaces round-trips as ONE argument', async () => {
  const cwd = tmpdir('bc-osc-');
  const styles = tmpdir('bc-styles-');
  const prev = process.env.BC_CLAUDE_OUTPUT_STYLES_DIR;
  process.env.BC_CLAUDE_OUTPUT_STYLES_DIR = styles;
  const mock = mockTmux({ readyTail: READY });
  try {
    styleFile(styles, 'two-words.md', '---\nname: Two Words\ndescription: spaced\n---\nbody\n');
    const ref = { harness: 'claude', session: 'bc-os4', cwd, resumeId: 'uuid-os4' };
    const reply = await claude.runCommand(ref, '/output-style Two Words', { stateDir: cwd });
    assert.match(reply, /output style now Two Words/);
    assert.strictEqual(
      JSON.parse(fs.readFileSync(path.join(cwd, '.claude', 'settings.local.json'), 'utf8')).outputStyle,
      'Two Words', 'the argument was never tokenized');
  } finally {
    mock.restore();
    if (prev === undefined) delete process.env.BC_CLAUDE_OUTPUT_STYLES_DIR;
    else process.env.BC_CLAUDE_OUTPUT_STYLES_DIR = prev;
    fs.rmSync(cwd, { recursive: true, force: true });
    fs.rmSync(styles, { recursive: true, force: true });
  }
});

test('outputStyles: a style in the SESSION\'s own .claude/output-styles is offered too', async () => {
  // Verified against the binary in a live pane: a style present ONLY in
  // <cwd>/.claude/output-styles/ is honoured — the session reported
  // `# Output Style: ProjOnly`. Refusing it as "unknown" while writing the
  // setting into that very .claude/ was our own inconsistency.
  const cwd = tmpdir('bc-osp-');
  const styles = tmpdir('bc-styles-');
  try {
    projectStyle(cwd, 'projonly.md', '---\nname: ProjOnly\ndescription: lives in the worktree\n---\nbody\n');
    styleFile(styles, 'eli5.md', '---\nname: ELI5\ndescription: keep it simple pls\n---\nbody\n');
    const list = claude.outputStyles({ stylesDir: styles, cwd });

    const proj = list.find((s) => s.value === 'ProjOnly');
    assert.ok(proj, 'the worktree\'s own style is on offer');
    assert.strictEqual(proj.description, 'lives in the worktree');
    assert.ok(list.some((s) => s.value === 'ELI5'), 'and the user-level ones still are');

    // no cwd — the user directory alone, exactly as before
    assert.ok(!claude.outputStyles({ stylesDir: styles }).some((s) => s.value === 'ProjOnly'));
  } finally {
    for (const d of [cwd, styles]) fs.rmSync(d, { recursive: true, force: true });
  }
});

test('outputStyles: on a name collision the PROJECT style shadows the user one', () => {
  // Also verified against the binary rather than inferred: the same
  // `name: ClashTest` in both directories with different bodies, and the
  // session emitted the PROJECT one. Precedence is copied from that, not
  // from what would seem reasonable.
  const cwd = tmpdir('bc-osp-');
  const styles = tmpdir('bc-styles-');
  try {
    projectStyle(cwd, 'clash.md', '---\nname: ClashTest\ndescription: project side\n---\nbody\n');
    styleFile(styles, 'clash.md', '---\nname: ClashTest\ndescription: user side\n---\nbody\n');
    const list = claude.outputStyles({ stylesDir: styles, cwd });

    const hits = list.filter((s) => s.value === 'ClashTest');
    assert.strictEqual(hits.length, 1, 'one entry, not two');
    assert.strictEqual(hits[0].description, 'project side', 'and it is the project one');
  } finally {
    for (const d of [cwd, styles]) fs.rmSync(d, { recursive: true, force: true });
  }
});

test('outputStyles: a project style still cannot shadow a BUILT-IN, and a broken project dir degrades', () => {
  const cwd = tmpdir('bc-osp-');
  try {
    projectStyle(cwd, 'shadow.md', '---\nname: Concise\ndescription: shadowing a built-in\n---\nbody\n');
    const list = claude.outputStyles({ stylesDir: '/nonexistent/bc-not-a-real-dir', cwd });
    assert.strictEqual(list.filter((s) => s.value === 'Concise').length, 1);
    assert.strictEqual(list.find((s) => s.value === 'Concise').description,
      claude.BUILTIN_OUTPUT_STYLES.find((s) => s.value === 'Concise').description,
      'the built-in survives, from either directory');

    // the same "never a throw" contract as the user directory
    assert.deepStrictEqual(
      claude.outputStyles({ stylesDir: '/nonexistent/a', cwd: '/nonexistent/b' }).map((s) => s.value),
      claude.BUILTIN_OUTPUT_STYLES.map((s) => s.value));
  } finally {
    fs.rmSync(cwd, { recursive: true, force: true });
  }
});

test('a project style can be APPLIED, not merely listed', async () => {
  const cwd = tmpdir('bc-osp-');
  const state = tmpdir('bc-state-');
  const mock = mockTmux({ readyTail: READY });
  try {
    projectStyle(cwd, 'projonly.md', '---\nname: ProjOnly\ndescription: lives in the worktree\n---\nbody\n');
    const ref = { harness: 'claude', session: 'bc-os5', cwd, resumeId: 'uuid-os5' };
    const reply = await claude.runCommand(ref, '/output-style projonly',
      { stateDir: state, stylesDir: '/nonexistent/bc-not-a-real-dir' });
    assert.match(reply, /output style now ProjOnly/);
    assert.strictEqual(
      JSON.parse(fs.readFileSync(path.join(cwd, '.claude', 'settings.local.json'), 'utf8')).outputStyle,
      'ProjOnly');
  } finally {
    mock.restore();
    for (const d of [cwd, state]) fs.rmSync(d, { recursive: true, force: true });
  }
});

test('a MID-TURN session is refused, and nothing is written — the cycle would lose the turn', async () => {
  // `claude --resume` restores the conversation but comes back on an idle
  // composer: an interrupted turn is not continued, it is gone, and a worker
  // stopped that way reports no turn-end and wakes nobody. The refusal is
  // checked BEFORE the write on purpose — refusing after it would leave the
  // setting applied with no cycle, to surface at some unrelated later restart.
  // (What "busy" looks like is pinned in busy-screens.test.js, against real
  // captured panes.)
  const cwd = tmpdir('bc-osc-');
  const styles = tmpdir('bc-styles-');
  const state = tmpdir('bc-state-');
  const BUSY = '\n✻ Working… (12s · still thinking with high effort)\n\n❯ \n  ⏵⏵ bypass permissions on (shift+tab to cycle)\n';
  const mock = mockTmux({ readyTail: BUSY });
  try {
    styleFile(styles, 'eli5.md', '---\nname: ELI5\ndescription: keep it simple pls\n---\nbody\n');
    const ref = { harness: 'claude', session: 'bc-os6', cwd, resumeId: 'uuid-os6' };
    await assert.rejects(
      claude.runCommand(ref, '/output-style ELI5', { stateDir: state, stylesDir: styles }),
      (e) => {
        assert.match(e.message, /mid-turn/);
        assert.match(e.message, /run it again when it is idle/);
        return true;
      });
    assert.ok(!fs.existsSync(path.join(cwd, '.claude', 'settings.local.json')),
      'the setting must NOT be left applied by a refused command');
    assert.ok(!mock.calls.some((c) => c.fn === 'tmux' && String(c.args[0]).includes('kill')),
      'and the session was never touched');
  } finally {
    mock.restore();
    for (const d of [cwd, styles, state]) fs.rmSync(d, { recursive: true, force: true });
  }
});

test('a typo is still refused as a typo, even mid-turn — the name is checked first', async () => {
  const cwd = tmpdir('bc-osc-');
  const BUSY = '\n· Churning…\n\n❯ \n  ⏵⏵ bypass permissions on (shift+tab to cycle)\n';
  const mock = mockTmux({ readyTail: BUSY });
  try {
    const ref = { harness: 'claude', session: 'bc-os7', cwd, resumeId: 'uuid-os7' };
    await assert.rejects(
      claude.runCommand(ref, '/output-style Nonsense', { stateDir: cwd, stylesDir: '/nonexistent/bc-nope' }),
      /unknown output style "Nonsense"/);
  } finally {
    mock.restore();
    fs.rmSync(cwd, { recursive: true, force: true });
  }
});

test('the cycle keeps the session on its PINNED MODEL — a restart is not a demotion', async () => {
  // The server pins --model/--effort from the card's playbook at spawn. Every
  // resume path used to rebuild the launch line without them, so a worker on a
  // pinned model came back on the default one with nobody told — quietly, and
  // for every resume, not just this command's.
  const cwd = tmpdir('bc-osc-');
  const styles = tmpdir('bc-styles-');
  const state = tmpdir('bc-state-');
  const mock = mockTmux({ readyTail: READY });
  try {
    styleFile(styles, 'eli5.md', '---\nname: ELI5\ndescription: keep it simple pls\n---\nbody\n');
    const ref = await claude.spawn(cwd, 'go', {
      session: 'bc-os8', stateDir: state, installHooks: false,
      extraArgs: ['--model', 'opus', '--effort', 'high'],
    });
    const before = mock.calls.filter((c) => c.fn === 'sendLiteral').length;

    await claude.runCommand(ref, '/output-style ELI5', { stateDir: state, stylesDir: styles });

    const relaunch = mock.calls.filter((c) => c.fn === 'sendLiteral').slice(before).map((c) => c.args[1]).join('\n');
    assert.match(relaunch, /--resume /, 'it came back on its own conversation');
    // quoted arg by arg, exactly the way spawn built the same flags
    assert.match(relaunch, /'--model' 'opus'/, 'and still on the model it was pinned to');
    assert.match(relaunch, /'--effort' 'high'/);
  } finally {
    mock.restore();
    for (const d of [cwd, styles, state]) fs.rmSync(d, { recursive: true, force: true });
  }
});

test('resume replays the pinned flags for EVERY caller, not just the cycle', async () => {
  // The older half of the same bug: `card start --resume` after a worker death,
  // and lieutenant supervision's respawn, both go through resume() too.
  const cwd = tmpdir('bc-osc-');
  const state = tmpdir('bc-state-');
  const mock = mockTmux({ readyTail: READY });
  try {
    const ref = await claude.spawn(cwd, 'go', {
      session: 'bc-os9', stateDir: state, installHooks: false, extraArgs: ['--model', 'opus'],
    });
    const before = mock.calls.filter((c) => c.fn === 'sendLiteral').length;
    await claude.resume(ref, { stateDir: state, installHooks: false });
    const relaunch = mock.calls.filter((c) => c.fn === 'sendLiteral').slice(before).map((c) => c.args[1]).join('\n');
    assert.match(relaunch, /'--model' 'opus'/);

    // A record that is missing or corrupt degrades to today's behaviour and
    // never throws — a resume that cannot read a hint must still resume.
    fs.writeFileSync(path.join(state, 'bc-os9.spawn-args'), 'not json at all');
    const before2 = mock.calls.filter((c) => c.fn === 'sendLiteral').length;
    await claude.resume(ref, { stateDir: state, installHooks: false });
    const plain = mock.calls.filter((c) => c.fn === 'sendLiteral').slice(before2).map((c) => c.args[1]).join('\n');
    assert.match(plain, /--resume /);
    assert.ok(!plain.includes('--model'), 'corrupt record: no flags, no throw');
  } finally {
    mock.restore();
    for (const d of [cwd, state]) fs.rmSync(d, { recursive: true, force: true });
  }
});

test('codex is left alone: no /output-style, no args, and its list stays the shared one', async () => {
  // codex has no output styles at all — the picker must never offer it there.
  const cmds = codex.commands();
  assert.deepStrictEqual(cmds.map((c) => c.name), ['/status', '/compact', '/help']);
  for (const c of cmds) assert.strictEqual(c.args, undefined, c.name + ' carries no args');
  await assert.rejects(
    codex.runCommand({ harness: 'codex', session: 'bc-cx', cwd: '/tmp' }, '/output-style ELI5'),
    /unknown command \/output-style/);
});
