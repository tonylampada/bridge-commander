'use strict';
// ui/js/perms.js — the permission prompts agents are blocked on: which view
// shows which prompt, the "announce once" diff behind the notification, and
// the shared approval-block markup. DOM-free at import, so it loads straight
// into Node (pending.test.js pattern).
const test = require('node:test');
const assert = require('node:assert');
const path = require('node:path');
const { pathToFileURL } = require('node:url');

const mod = import(pathToFileURL(path.join(__dirname, '..', 'ui', 'js', 'perms.js')).href);

const P = (o) => Object.assign({ id: 'p1', ts: '2026-09-25T10:00:00Z', tool_name: 'Bash', tool_input: { command: 'ls' },
  summary: 'ls', lieutenant: 'ada', card: null, worker: null, agentLabel: 'Ada' }, o);

test('docPermissions: tolerates a payload without the field (older server)', async () => {
  const { docPermissions } = await mod;
  assert.deepStrictEqual(docPermissions(null), []);
  assert.deepStrictEqual(docPermissions({}), []);
  assert.deepStrictEqual(docPermissions({ permissions: 'x' }), []);
});

test('card thread shows its worker prompts; main chat only the lieutenant\'s own', async () => {
  const { cardPermissions, mainChatPermissions } = await mod;
  const doc = { permissions: [
    P({ id: 'a' }),
    P({ id: 'b', card: 'c1', worker: 'w-c1', agentLabel: 'worker on Fix it' }),
    P({ id: 'c', lieutenant: 'bob', agentLabel: 'Bob' }),
    P({ id: 'd', lieutenant: null, agentLabel: 'repo' }), // unattributed: tray only
  ] };
  assert.deepStrictEqual(cardPermissions(doc, 'c1').map((p) => p.id), ['b']);
  assert.deepStrictEqual(mainChatPermissions(doc, 'ada').map((p) => p.id), ['a']);
  assert.deepStrictEqual(mainChatPermissions(doc, 'bob').map((p) => p.id), ['c']);
});

test('selectNewPermissions: each id announces once, however many broadcasts repeat it', async () => {
  const { selectNewPermissions } = await mod;
  const seen = new Set();
  assert.deepStrictEqual(selectNewPermissions(seen, { permissions: [P({ id: 'a' })] }).map((p) => p.id), ['a']);
  assert.deepStrictEqual(selectNewPermissions(seen, { permissions: [P({ id: 'a' })] }), []);
  // decided + gone, then a new one arrives
  assert.deepStrictEqual(selectNewPermissions(seen, { permissions: [] }), []);
  assert.deepStrictEqual(selectNewPermissions(seen, { permissions: [P({ id: 'b' })] }).map((p) => p.id), ['b']);
});

test('permBlockHtml: escapes agent text; busy disables every control', async () => {
  const { permBlockHtml, setBusy } = await mod;
  const p = P({ id: 'x"1', summary: '<img src=x onerror=alert(1)>', tool_input: { command: '</pre><b>' } });
  const html = permBlockHtml(p, 'tray');
  assert.ok(!html.includes('<img'), 'summary is escaped');
  assert.ok(!html.includes('</pre><b>'), 'tool_input JSON is escaped');
  assert.ok(html.includes('data-perm-id="x&quot;1"'));
  assert.ok(html.includes('data-perm-go='), 'tray label links to the conversation');
  assert.ok(!permBlockHtml(p, 'chat').includes('data-perm-go='), 'chat label is plain text');
  assert.ok(!/disabled/.test(html));
  setBusy('x"1', 'allow');
  const busy = permBlockHtml(p, 'tray');
  assert.strictEqual((busy.match(/ disabled/g) || []).length, 3, 'approve, deny and reason all disabled');
  assert.ok(busy.includes('approving…'));
  setBusy('x"1', '');
});

test('the reason draft stays out of the markup, so typing never forces a rebuild', async () => {
  const { permBlockHtml, setReason, reasonFor } = await mod;
  const p = P({ id: 'r1' });
  const before = permBlockHtml(p, 'chat');
  setReason('r1', 'not in prod');
  assert.strictEqual(permBlockHtml(p, 'chat'), before);
  assert.strictEqual(reasonFor('r1'), 'not in prod');
});

test('prunePermUi drops state of prompts that left the board', async () => {
  const { prunePermUi, setBusy, setError, setReason, setJsonOpen, permUi, reasonFor } = await mod;
  setBusy('gone', 'deny'); setError('gone', 'x'); setReason('gone', 'why'); setJsonOpen('gone', true);
  setBusy('kept', 'allow');
  prunePermUi({ permissions: [P({ id: 'kept' })] });
  assert.deepStrictEqual(permUi('gone'), { busy: '', error: '', open: false });
  assert.strictEqual(reasonFor('gone'), '');
  assert.strictEqual(permUi('kept').busy, 'allow');
  setBusy('kept', '');
});
