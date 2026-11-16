'use strict';
// Lieutenant page actions (server/ltactions.js): POST /lt/<id>/action/<name>
// runs lieutenants/<id>/actions/<name>; POST /lt/<id>/comment is the built-in
// comment-on-selection; every served HTML page carries the comment overlay.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const { startServerWithLieutenant, startServer, sleep, runCli } = require('./helper');
const lta = require('../server/ltactions.js');

const EXAMPLE = path.join(__dirname, '..', 'examples', 'lt-page-actions');
const ltDir = (s) => path.join(s.dir, 'lieutenants', 'ada');

function writeAction(s, name, body, mode = 0o755) {
  const f = path.join(ltDir(s), 'actions', name);
  fs.mkdirSync(path.dirname(f), { recursive: true });
  fs.writeFileSync(f, body, { mode });
  fs.chmodSync(f, mode);
  return f;
}
const post = (s, p, body, headers) => fetch(s.base + p, {
  method: 'POST',
  headers: headers || { 'Content-Type': 'application/json' },
  body: typeof body === 'string' ? body : JSON.stringify(body),
}).then(async (r) => ({ status: r.status, body: await r.json().catch(() => null) }));
const act = (s, name, args, notify) => post(s, '/lt/ada/action/' + name, { args, notify });
const feed = async (s) => (await s.api('GET', '/api/feed?lieutenant=ada')).body.items;
const log = (s) => {
  try { return fs.readFileSync(path.join(ltDir(s), 'state', 'actions.jsonl'), 'utf8').trim().split('\n').map(JSON.parse); }
  catch (e) { return []; }
};

// An action that answers with what it was given and where it ran.
const ECHO = `#!/usr/bin/env node
let i = ''; process.stdin.on('data', (c) => i += c).on('end', () => {
  process.stdout.write(JSON.stringify({ ok: true, result: { input: JSON.parse(i), cwd: process.cwd() } }));
});`;

test('route validation: bad names, traversal, unknown lieutenant or action are 404 and run nothing', async () => {
  const s = await startServerWithLieutenant();
  try {
    writeAction(s, 'echo', ECHO);
    fs.writeFileSync(path.join(ltDir(s), 'secret'), '#!/bin/sh\necho pwned > ' + path.join(s.dir, 'pwned') + '\n', { mode: 0o755 });
    for (const p of ['/lt/ada/action/..%2Fsecret', '/lt/ada/action/%2E%2E', '/lt/ada/action/.echo', '/lt/ada/action/Echo',
      '/lt/ada/action/a%2Fb', '/lt/ada/action/' + 'a'.repeat(80), '/lt/ada/action/nope', '/lt/ada/action/%E0%A4%A',
      '/lt/ghost/action/echo', '/lt/..%2Fada/action/echo']) {
      const r = await post(s, p, { args: {} });
      assert.strictEqual(r.status, 404, p);
      assert.notStrictEqual(r.body && r.body.ok, true, p);
    }
    // not executable: not an action
    writeAction(s, 'plain', ECHO, 0o644);
    assert.strictEqual((await act(s, 'plain', {})).status, 404);
    // a symlink in actions/ pointing out of it is out
    fs.symlinkSync(path.join(ltDir(s), 'secret'), path.join(ltDir(s), 'actions', 'leak'));
    assert.strictEqual((await act(s, 'leak', {})).status, 404);
    assert.ok(!fs.existsSync(path.join(s.dir, 'pwned')), 'nothing ran');
    // a GET never runs an action
    assert.strictEqual((await fetch(s.base + '/lt/ada/action/echo')).status, 404);
    // a body that is not declared JSON is refused (no cross-site form posts)
    const r = await post(s, '/lt/ada/action/echo', '{"args":{}}', { 'Content-Type': 'text/plain' });
    assert.strictEqual(r.status, 415);
    assert.strictEqual((await post(s, '/lt/ada/action/echo', 'not json')).status, 400);
    assert.strictEqual((await post(s, '/lt/ada/action/echo', [1, 2])).status, 400);
    assert.deepStrictEqual(log(s), [], 'refused requests are not actions');
  } finally { await s.stop(); }
});

test('executor: stdin carries {action, args, lieutenant, ts}, cwd is the lieutenant folder, stdout is the answer', async () => {
  const s = await startServerWithLieutenant();
  try {
    writeAction(s, 'echo', ECHO);
    const args = { op: 'add', text: '$(touch ' + path.join(s.dir, 'pwned') + '); `id`', n: [1, 2] };
    const r = await act(s, 'echo', args);
    assert.strictEqual(r.status, 200);
    assert.strictEqual(r.body.ok, true);
    const { input, cwd } = r.body.result;
    assert.deepStrictEqual(Object.keys(input).sort(), ['action', 'args', 'lieutenant', 'ts']);
    assert.strictEqual(input.action, 'echo');
    assert.strictEqual(input.lieutenant, 'ada');
    assert.deepStrictEqual(input.args, args, 'args arrive verbatim');
    assert.ok(!Number.isNaN(Date.parse(input.ts)));
    assert.strictEqual(fs.realpathSync(cwd), fs.realpathSync(ltDir(s)));
    assert.ok(!fs.existsSync(path.join(s.dir, 'pwned')), 'no shell ever saw the args');
    // no args at all: {}
    assert.deepStrictEqual((await post(s, '/lt/ada/action/echo', {})).body.result.input.args, {});
  } finally { await s.stop(); }
});

test('executor failures: refusal 422, non-zero exit 500, bad JSON 502, timeout 504 — each with the stderr tail', async () => {
  const s = await startServerWithLieutenant({ env: { BC_LT_ACTION_TIMEOUT_MS: '700' } });
  try {
    writeAction(s, 'refuse', '#!/bin/sh\ncat >/dev/null\necho \'{"ok":false,"message":"text is empty"}\'\n');
    writeAction(s, 'crash', '#!/bin/sh\necho "boom: disk on fire" >&2\nexit 3\n');
    writeAction(s, 'garbage', '#!/bin/sh\necho "warn: legacy" >&2\necho "hello"\n');
    writeAction(s, 'noisy', '#!/bin/sh\necho \'{"result":1}\'\n');
    writeAction(s, 'slow', '#!/bin/sh\necho "about to hang" >&2\nsleep 30 &\nsleep 30\n');

    let r = await act(s, 'refuse', {});
    assert.strictEqual(r.status, 422);
    assert.deepStrictEqual([r.body.ok, r.body.error], [false, 'text is empty']);

    r = await act(s, 'crash', {});
    assert.strictEqual(r.status, 500);
    assert.match(r.body.error, /exited 3/);
    assert.match(r.body.stderr, /disk on fire/);

    r = await act(s, 'garbage', {});
    assert.strictEqual(r.status, 502);
    assert.match(r.body.stderr, /legacy/);
    assert.strictEqual((await act(s, 'noisy', {})).status, 502, 'JSON without ok is not the contract');

    const t0 = Date.now();
    r = await act(s, 'slow', {});
    assert.strictEqual(r.status, 504);
    assert.match(r.body.error, /timed out/);
    assert.match(r.body.stderr, /about to hang/);
    assert.ok(Date.now() - t0 < 5000, 'killed, not waited out (the backgrounded child too)');

    const l = log(s);
    assert.deepStrictEqual(l.map((x) => [x.action, x.ok]),
      [['refuse', false], ['crash', false], ['garbage', false], ['noisy', false], ['slow', false]]);
  } finally { await s.stop(); }
});

test('notify: true queues a page-action item for the lieutenant; false only logs — both logged', async () => {
  const s = await startServerWithLieutenant();
  try {
    writeAction(s, 'echo', ECHO);
    const before = (await feed(s)).length;
    assert.strictEqual((await act(s, 'echo', { a: 1 }, false)).status, 200);
    assert.strictEqual((await feed(s)).length, before, 'notify:false wakes nobody');
    assert.strictEqual((await act(s, 'echo', { b: 2 }, true)).status, 200);
    const items = (await feed(s)).slice(before);
    assert.strictEqual(items.length, 1);
    const it = items[0];
    assert.strictEqual(it.kind, 'page-action');
    assert.strictEqual(it.action, 'echo');
    assert.strictEqual(it.ok, true);
    assert.match(it.text, /args: \{"b":2\}/);
    assert.match(it.text, /result: /);
    const l = log(s);
    assert.strictEqual(l.length, 2);
    assert.deepStrictEqual(l.map((x) => [x.action, x.ok, x.notify]), [['echo', true, false], ['echo', true, true]]);
    assert.deepStrictEqual(l[0].args, { a: 1 });
    assert.ok(l[0].ts && l[0].result, 'ts and result on the record');
  } finally { await s.stop(); }
});

test('a notified refusal reads as the action refusing his input, not as a broken action', async () => {
  const s = await startServerWithLieutenant();
  try {
    writeAction(s, 'refuse', '#!/bin/sh\ncat >/dev/null\necho \'{"ok":false,"message":"text is empty"}\'\n');
    writeAction(s, 'mute', '#!/bin/sh\ncat >/dev/null\necho \'{"ok":false}\'\n');
    writeAction(s, 'crash', '#!/bin/sh\necho "boom" >&2\nexit 3\n');
    const before = (await feed(s)).length;
    assert.strictEqual((await act(s, 'refuse', {}, true)).status, 422);
    assert.strictEqual((await act(s, 'mute', {}, true)).status, 422);
    assert.strictEqual((await act(s, 'crash', {}, true)).status, 500);

    // the queue item carries the status and the refusal flag
    const items = (await feed(s)).slice(before);
    assert.deepStrictEqual(items.map((i) => [i.action, i.ok, i.status, i.refused, i.message]), [
      ['refuse', false, 422, true, 'text is empty'],
      ['mute', false, 422, true, undefined],
      ['crash', false, 500, false, undefined],
    ]);
    assert.match(items[0].text, /^refused: text is empty$/m);
    assert.match(items[2].text, /^error: action crash exited 3$/m);

    // drain says which is which
    const r = await runCli(['drain', '--lieutenant', 'ada', '--workspace', s.dir, '--port', String(s.port)]);
    assert.strictEqual(r.code, 0, r.stderr);
    const block = (name) => r.stdout.split(/\n(?=#\d+ {2})/).find((b) => b.includes('captain ran "' + name + '"'));
    assert.match(block('refuse'), /captain ran "refuse" on your page — your action refused it: text is empty\n/);
    assert.match(block('refuse'), /nothing is broken/);
    assert.doesNotMatch(block('refuse'), /IT FAILED|broke under him/);
    assert.match(block('mute'), /your action refused it: \(no message\)/);
    assert.doesNotMatch(block('mute'), /IT FAILED|broke under him/);
    assert.match(block('crash'), /captain ran "crash" on your page — IT FAILED/);
    assert.match(block('crash'), /your action broke under him: fix lieutenants\/ada\/actions\/crash/);
  } finally { await s.stop(); }
});

test('a successful action announces lt-page-changed {id, action, by, updated} on /api/events', async () => {
  const s = await startServerWithLieutenant();
  const ctrl = new AbortController();
  try {
    writeAction(s, 'echo', ECHO);
    fs.mkdirSync(path.join(ltDir(s), 'page'), { recursive: true });
    fs.writeFileSync(path.join(ltDir(s), 'page', 'index.html'), 'hi');
    const res = await fetch(s.base + '/api/events', { signal: ctrl.signal });
    const reader = res.body.getReader();
    await post(s, '/lt/ada/action/echo', { args: {}, client: 'tab-1' });
    let buf = '';
    const deadline = Date.now() + 3000;
    while (!/event: lt-page-changed/.test(buf) && Date.now() < deadline) {
      const r = await Promise.race([reader.read(), sleep(500).then(() => null)]);
      if (r && r.value) buf += Buffer.from(r.value).toString('utf8');
    }
    const m = /event: lt-page-changed\ndata: (.*)\n/.exec(buf);
    assert.ok(m, 'announced: ' + buf);
    const d = JSON.parse(m[1]);
    assert.strictEqual(d.id, 'ada');
    assert.strictEqual(d.action, 'echo');
    assert.strictEqual(d.by, 'tab-1');
    assert.ok(!Number.isNaN(Date.parse(d.updated)), 'the page stamp, so the board frame does not reload');
  } finally { ctrl.abort(); await s.stop(); }
});

test('every served HTML page carries the comment overlay; other files and the file on disk do not', async () => {
  const s = await startServerWithLieutenant();
  try {
    const pg = path.join(ltDir(s), 'page');
    fs.mkdirSync(path.join(pg, 'sub'), { recursive: true });
    fs.writeFileSync(path.join(pg, 'index.html'), '<html><body><h1>ada</h1></body></html>');
    fs.writeFileSync(path.join(pg, 'sub', 'b.html'), '<p>no body tag');
    fs.writeFileSync(path.join(pg, 'x.css'), 'body{}');
    let t = await (await fetch(s.base + '/lt/ada/')).text();
    assert.strictEqual(t, '<html><body><h1>ada</h1>' + lta.OVERLAY_TAG + '</body></html>');
    t = await (await fetch(s.base + '/lt/ada/sub/b.html')).text();
    assert.strictEqual(t, '<p>no body tag' + lta.OVERLAY_TAG);
    assert.strictEqual(await (await fetch(s.base + '/lt/ada/x.css')).text(), 'body{}');
    assert.strictEqual(fs.readFileSync(path.join(pg, 'index.html'), 'utf8'), '<html><body><h1>ada</h1></body></html>');
    for (const f of ['actions', 'comment', 'toast']) {
      const r = await fetch(s.base + '/lt/_sdk/' + f + '.js');
      assert.strictEqual(r.status, 200, f);
      assert.match(r.headers.get('content-type'), /javascript/);
    }
    assert.strictEqual((await fetch(s.base + '/lt/_sdk/nope.js')).status, 404);
  } finally { await s.stop(); }
});

test('injectOverlay: before the LAST </body>, else </html>, else appended', () => {
  const T = lta.OVERLAY_TAG;
  assert.strictEqual(lta.injectOverlay('<body>a</body><!-- </body> -->x</BODY >'), '<body>a</body><!-- </body> -->x' + T + '</BODY >');
  assert.strictEqual(lta.injectOverlay('<html>a</html>'), '<html>a' + T + '</html>');
  assert.strictEqual(lta.injectOverlay('a'), 'a' + T);
});

test('comment: a captain message in the main chat with the quote and the page; logged; validated', async () => {
  const s = await startServerWithLieutenant();
  try {
    const before = (await feed(s)).length;
    let r = await post(s, '/lt/ada/comment', { quote: 'line one\nline two', comment: 'isso está errado', page: '/lt/ada/radar.html' });
    assert.strictEqual(r.status, 200);
    assert.strictEqual(r.body.to, 'ada');
    const it = (await feed(s)).slice(before)[0];
    assert.strictEqual(it.kind, 'message');
    assert.strictEqual(it.via, 'page');
    assert.strictEqual(it.target, 'lieutenant:ada');
    assert.strictEqual(it.text, '💬 comment on your page /lt/ada/radar.html\n> line one\n> line two\n\nisso está errado');
    const chat = (await s.api('GET', '/api/chat?target=lieutenant:ada')).body.messages;
    const last = chat[chat.length - 1];
    assert.strictEqual(last.author, 'user');
    assert.strictEqual(last.text, it.text);
    const l = log(s);
    assert.deepStrictEqual([l[0].action, l[0].notify, l[0].args.comment], ['comment', true, 'isso está errado']);
    // a page path that is not this lieutenant's is replaced by the page root
    r = await post(s, '/lt/ada/comment', { quote: 'q', comment: 'c', page: 'https://evil.example/x' });
    assert.match((await feed(s)).pop().text, /^💬 comment on your page \/lt\/ada\/\n/);
    assert.strictEqual((await post(s, '/lt/ada/comment', { quote: 'q', comment: '  ' })).status, 400);
    assert.strictEqual((await post(s, '/lt/ghost/comment', { comment: 'x' })).status, 404);
    assert.strictEqual((await post(s, '/lt/ada/comment', '{"comment":"x"}', { 'Content-Type': 'text/plain' })).status, 415);
  } finally { await s.stop(); }
});

test('the example: add, edit and delete on a JSON list through the real page action', async () => {
  const s = await startServerWithLieutenant();
  try {
    fs.cpSync(EXAMPLE, ltDir(s), { recursive: true });
    const data = () => JSON.parse(fs.readFileSync(path.join(ltDir(s), 'page', 'data', 'items.json'), 'utf8')).items;
    const n0 = data().length;
    let r = await act(s, 'items', { op: 'add', text: '  ship the radar  ' });
    assert.strictEqual(r.status, 200);
    const id = r.body.result.item.id;
    assert.deepStrictEqual(data().at(-1), { id, text: 'ship the radar', done: false });
    r = await act(s, 'items', { op: 'edit', id, text: 'ship the radar today', done: true });
    assert.strictEqual(r.status, 200);
    assert.deepStrictEqual(data().at(-1), { id, text: 'ship the radar today', done: true });
    r = await act(s, 'items', { op: 'delete', id });
    assert.strictEqual(r.status, 200);
    assert.strictEqual(data().length, n0);
    r = await act(s, 'items', { op: 'add', text: ' ' });
    assert.deepStrictEqual([r.status, r.body.error], [422, 'text is empty']);
    assert.strictEqual((await act(s, 'items', { op: 'delete', id: 'nope' })).status, 422);
    // the page it ships renders from that data, through the SDK
    const html = await (await fetch(s.base + '/lt/ada/')).text();
    assert.match(html, /import \* as bc from '\/lt\/_sdk\/actions\.js'/);
    assert.match(html, /fetch\('data\/items\.json'/);
    assert.ok(html.includes(lta.OVERLAY_TAG));
  } finally { await s.stop(); }
});

test('/lt/_demo/: the example served from the state dir, actions write there, comments go to the line', async () => {
  const s = await startServerWithLieutenant();
  try {
    const r0 = await fetch(s.base + '/lt/_demo/');
    assert.strictEqual(r0.status, 200);
    assert.match(await r0.text(), /Page actions demo/);
    const r = await post(s, '/lt/_demo/action/items', { args: { op: 'add', text: 'from the demo' }, notify: true });
    assert.strictEqual(r.status, 200);
    const file = path.join(s.dir, '.bridge-commander', 'lt-demo', 'page', 'data', 'items.json');
    assert.ok(fs.readFileSync(file, 'utf8').includes('from the demo'));
    assert.strictEqual(JSON.parse(await (await fetch(s.base + '/lt/_demo/data/items.json')).text()).items.at(-1).text, 'from the demo');
    // the repo copy is untouched
    assert.ok(!fs.readFileSync(path.join(EXAMPLE, 'page', 'data', 'items.json'), 'utf8').includes('from the demo'));
    const c = await post(s, '/lt/_demo/comment', { quote: 'x', comment: 'y', page: '/lt/_demo/' });
    assert.strictEqual(c.body.to, 'ada');
    const items = await feed(s);
    assert.deepStrictEqual(items.slice(-2).map((i) => i.kind), ['page-action', 'message']);
    assert.strictEqual(items.at(-2).page, '_demo');
  } finally { await s.stop(); }
});

test('/lt/_demo/ on a board with no lieutenant: the page works, a comment has nobody to reach', async () => {
  const s = await startServer();
  try {
    assert.strictEqual((await fetch(s.base + '/lt/_demo/')).status, 200);
    assert.strictEqual((await post(s, '/lt/_demo/comment', { comment: 'x' })).status, 409);
  } finally { await s.stop(); }
});

test('two actions at once on one lieutenant run one after the other', async () => {
  const s = await startServerWithLieutenant();
  try {
    fs.cpSync(EXAMPLE, ltDir(s), { recursive: true });
    const rs = await Promise.all(Array.from({ length: 6 }, (_, i) => act(s, 'items', { op: 'add', text: 'n' + i })));
    assert.ok(rs.every((r) => r.status === 200));
    const items = JSON.parse(fs.readFileSync(path.join(ltDir(s), 'page', 'data', 'items.json'), 'utf8')).items;
    for (let i = 0; i < 6; i++) assert.ok(items.some((x) => x.text === 'n' + i), 'n' + i + ' survived');
  } finally { await s.stop(); }
});
