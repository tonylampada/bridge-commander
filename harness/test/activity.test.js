'use strict';
// activity — the live "what is it doing" line: transcript → turn state, tool
// call → label, and the redaction that keeps secrets off the captain's screen.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { redact, shortCommand, toolLabel, claudeActivityFromLines, claudeActivity, labelAt, TOOL_HOLD_MS } = require('../activity');

const L = (o) => JSON.stringify(o);
const prompt = (ts, text) => L({ type: 'user', timestamp: ts, message: { role: 'user', content: text } });
const use = (ts, id, name, input) => L({ type: 'assistant', timestamp: ts, message: { content: [{ type: 'tool_use', id, name, input }] } });
const result = (ts, id) => L({ type: 'user', timestamp: ts, message: { content: [{ type: 'tool_result', tool_use_id: id, content: 'ok' }] } });
const said = (ts, text) => L({ type: 'assistant', timestamp: ts, message: { content: [{ type: 'text', text }], stop_reason: 'end_turn' } });
const end = (ts) => L({ type: 'system', subtype: 'turn_duration', timestamp: ts });

test('tool → label: the common tools', () => {
  assert.deepStrictEqual(toolLabel('Bash', { command: 'gh pr checks 162' }), { kind: 'bash', label: '🔧 running: gh pr checks 162' });
  assert.deepStrictEqual(toolLabel('Read', { file_path: '/home/ai/x/server/server.js' }), { kind: 'read', label: '📖 reading server.js' });
  assert.deepStrictEqual(toolLabel('Edit', { file_path: '/a/ui/app.css' }), { kind: 'edit', label: '✏️ editing app.css' });
  assert.deepStrictEqual(toolLabel('Write', { file_path: '/a/b.md' }), { kind: 'edit', label: '📝 writing b.md' });
  assert.strictEqual(toolLabel('Agent', { description: 'find the bug' }).label, '🤖 subagent working: find the bug');
  assert.strictEqual(toolLabel('Task', {}).label, '🤖 subagent working');
  assert.strictEqual(toolLabel('Agent', {}).kind, 'agent');
  assert.deepStrictEqual(toolLabel('WebSearch', {}), { kind: 'web', label: '🌐 searching the web' });
  assert.strictEqual(toolLabel('WebFetch', { url: 'https://example.com/a?b' }).label, '🌐 reading example.com');
  assert.strictEqual(toolLabel('Grep', { pattern: 'callBoard' }).label, '🔎 searching for callBoard');
  assert.strictEqual(toolLabel('mcp__claude_ai_Gmail__search_threads', {}).label, '🔌 Gmail: search threads');
  assert.strictEqual(toolLabel('Frobnicate', null).label, '⚙️ Frobnicate');
});

test('tool → label: the board\'s own verbs', () => {
  assert.deepStrictEqual(toolLabel('Bash', { command: 'echo "Nine." | bc-axi say lieutenant:lia --text-file -' }), { kind: 'reply', label: '💬 writing the reply' });
  assert.strictEqual(toolLabel('Bash', { command: 'export PATH=$PATH:/x/cli && bc-axi drain' }).label, '📥 reading the queue');
});

test('a command loses its plumbing and its binary path', () => {
  assert.strictEqual(shortCommand('export PATH=$PATH:/x/cli && cd /repo && /home/ai/bc/cli/bc-axi card list'), 'bc-axi card list');
  assert.strictEqual(shortCommand('FOO=1 BAR="a b" npm test'), 'npm test');
  assert.strictEqual(shortCommand('cat <<EOF > f\nsecret body\nEOF'), 'cat <<EOF > f');
  const long = shortCommand('node -e "' + 'x'.repeat(200) + '"');
  assert.ok(long.length <= 60 && long.endsWith('…'), long);
});

test('redaction: obvious secrets never reach the label', () => {
  const cases = [
    ['curl -H "Authorization: Bearer abc.def.ghi123456" https://api.x', /abc\.def/],
    ['GITHUB_TOKEN=ghp_abcdefghijklmnopqrstuvwxyz0123 gh pr list', /ghp_/],
    ['OPENAI_API_KEY=sk-proj-abcdefghijklmnopqrstuv python x.py', /sk-proj/],
    ['mysql --password=hunter2 -u root', /hunter2/],
    ['tool --token s3cr3tvalue', /s3cr3tvalue/],
    ['git clone https://tony:p4ss@github.com/x/y', /p4ss/],
    ['echo xoxb-1234567890-abcdefghij', /xoxb-/],
    ['aws s3 ls AKIAIOSFODNN7EXAMPLE', /AKIAIOSFODNN7EXAMPLE/],
    ['export password: hunter2', /hunter2/],
    ['curl -d \'{"apiKey": "zzzz9999yyyy"}\'', /zzzz9999/],
    ['x eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.dozjgNryP4J3jVmNHl0w5N', /eyJhbGci/],
    ['use key AbCdEfGhIjKlMnOpQrStUvWxYz0123456789abcdEF', /AbCdEfGh/],
  ];
  for (const [cmd, leak] of cases) {
    const out = redact(cmd);
    assert.doesNotMatch(out, leak, cmd + ' → ' + out);
    assert.match(out, /•••/, cmd);
    assert.doesNotMatch(toolLabel('Bash', { command: cmd }).label, leak, 'label of ' + cmd);
  }
});

test('redaction leaves ordinary commands alone', () => {
  for (const cmd of ['gh pr checks 162', 'git log --oneline -5', 'npm test -- --grep keyword', 'ls -la /tmp', 'node --test test/call.test.js']) {
    assert.strictEqual(redact(cmd), cmd);
  }
});

test('transcript: a running turn, its tool, and its end', () => {
  const lines = [said('t0', 'old'), end('t0'), prompt('2026-01-01T00:00:00Z', 'do it')];
  assert.deepStrictEqual(claudeActivityFromLines(lines).tool.kind, 'think');
  assert.strictEqual(claudeActivityFromLines(lines).since, '2026-01-01T00:00:00Z');
  lines.push(use('t2', 'a', 'Bash', { command: 'gh pr checks 162' }));
  let a = claudeActivityFromLines(lines);
  assert.strictEqual(a.running, true);
  assert.strictEqual(a.tool.label, '🔧 running: gh pr checks 162');
  lines.push(result('2026-01-01T00:00:03Z', 'a'));
  a = claudeActivityFromLines(lines);
  assert.strictEqual(a.tool.kind, 'bash', 'the finished tool is latched…');
  assert.strictEqual(a.tool.doneAt, '2026-01-01T00:00:03Z');
  lines.push(said('t4', 'done'), end('t4'));
  a = claudeActivityFromLines(lines);
  assert.deepStrictEqual([a.running, a.tool], [false, null]);
});

test('transcript: a tool result is not a prompt; a sidechain line is not ours', () => {
  const lines = [prompt('p', 'go'), use('t', 'a', 'Agent', { description: 'dig' }),
    L({ type: 'user', isSidechain: true, timestamp: 's', message: { content: 'sub prompt' } }), result('r0', 'zzz')];
  const a = claudeActivityFromLines(lines);
  assert.strictEqual(a.since, 'p');
  assert.strictEqual(a.tool.kind, 'agent');
});

test('transcript: neither end nor start in the window is unknown, a cut first line is skipped', () => {
  assert.strictEqual(claudeActivityFromLines(['l":1}', use('t', 'a', 'Read', {})]), null);
});

test('claudeActivity reads the session file and caches on size+mtime', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'act-'));
  const cwd = '/w/x';
  const sub = path.join(dir, '-w-x');
  fs.mkdirSync(sub);
  const file = path.join(sub, 'sid.jsonl');
  fs.writeFileSync(file, [prompt('p', 'go'), use('t', 'a', 'Read', { file_path: '/a/b.js' })].join('\n') + '\n');
  const ref = { cwd, resumeId: 'sid' };
  assert.strictEqual(claudeActivity(ref, { projectsDir: dir }).tool.label, '📖 reading b.js');
  fs.appendFileSync(file, result('r', 'a') + '\n' + end('e') + '\n');
  assert.strictEqual(claudeActivity(ref, { projectsDir: dir }).running, false);
  assert.strictEqual(claudeActivity({ cwd, resumeId: 'nope' }, { projectsDir: dir }), null);
  assert.strictEqual(claudeActivity({}, { projectsDir: dir }), null);
});

test('a sub-second tool is held TOOL_HOLD_MS past its end, then thinking', () => {
  const end = Date.parse('2026-01-01T00:00:03Z');
  const tool = Object.assign(toolLabel('Bash', { command: 'ls' }), { doneAt: '2026-01-01T00:00:03Z' });
  assert.strictEqual(labelAt(tool, end + 100).label, '🔧 running: ls');
  assert.strictEqual(labelAt(tool, end + TOOL_HOLD_MS - 1).label, '🔧 running: ls');
  assert.strictEqual(labelAt(tool, end + TOOL_HOLD_MS).label, '💭 thinking');
  const inFlight = toolLabel('Read', { file_path: '/a/b.js' });
  assert.strictEqual(labelAt(inFlight, end + 60000).label, '📖 reading b.js', 'in flight: shown however long it takes');
  assert.strictEqual(labelAt(null, end), null);
});

test('a burst of quick tools, sampled once a second, shows every one of them', () => {
  // the real shape that showed only "thinking": five tools under a second each,
  // a second or two of thinking between them
  const T = (s) => new Date(Date.parse('2026-01-01T00:00:00Z') + s * 1000).toISOString();
  const script = [[1, 'a', 'Bash', { command: 'ls' }, 1.3], [3, 'b', 'Read', { file_path: '/x/callcore.js' }, 3.2],
    [5.5, 'c', 'Bash', { command: 'find . -name x' }, 5.9], [7.5, 'd', 'Bash', { command: 'git log --oneline -5' }, 7.7]];
  const lines = [end(T(-5)), prompt(T(0), 'go')];
  const events = [];
  for (const [at, id, name, input, done] of script) { events.push([at, use(T(at), id, name, input)]); events.push([done, result(T(done), id)]); }
  const seen = new Set();
  for (let t = 0; t <= 10; t += 1) {
    const upTo = lines.concat(events.filter(([at]) => at <= t).map(([, l]) => l));
    const a = claudeActivityFromLines(upTo);
    seen.add(labelAt(a.tool, Date.parse(T(t))).label);
  }
  for (const want of ['🔧 running: ls', '📖 reading callcore.js', '🔧 running: find . -name x', '🔧 running: git log --oneline -5']) {
    assert.ok(seen.has(want), want + ' never showed: ' + [...seen].join(' | '));
  }
});
