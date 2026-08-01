'use strict';
// The artifact viewer POPUP follows an outside write, the same way the file
// screen already does. The popup keeps its own state (avEditable) and used to
// sit behind the file-screen guard in artifactWritten(), so a write landed on
// disk and the captain kept reading the old text until he closed and reopened.
//
// detail.js binds DOM at import time, so this drives it against a recording
// stub DOM (the copytext.test.js trick, one size up): getElementById hands out
// the same fake node per id, and the test reads what the viewer wrote into
// #av-body. Everything the popup path does not touch answers through a Proxy.
const test = require('node:test');
const assert = require('node:assert');
const path = require('node:path');
const { pathToFileURL } = require('node:url');

// A fake node: anything read that was never written comes back as another fake,
// so unrelated DOM wiring at import time runs without a real browser.
function fakeNode() {
  const store = {
    style: {}, classList: { add() {}, remove() {}, toggle() {} }, dataset: {},
    querySelectorAll: () => [], querySelector: () => null, closest: () => null, // md.js walks the rendered body
  };
  return new Proxy(store, {
    get(t, k) {
      if (k in t) return t[k];
      if (typeof k !== 'string') return undefined;
      return (t[k] = /^(on|append|remove|add|focus|scroll|load|pause|play|insert|set|get|blur|click)/.test(k)
        ? () => fakeNode() : fakeNode());
    },
    set(t, k, v) { t[k] = v; return true; },
  });
}
const nodes = new Map();
const byId = (id) => nodes.get(id) || (nodes.set(id, fakeNode()), nodes.get(id));
globalThis.document = {
  getElementById: byId,
  createElement: () => fakeNode(),
  addEventListener() {},
  body: fakeNode(),
  querySelector: () => fakeNode(),
  querySelectorAll: () => [],
};
globalThis.window = { innerWidth: 1200, addEventListener() {}, location: { pathname: '/', search: '' } };
globalThis.localStorage = { getItem: () => null, setItem() {}, removeItem() {} };

// The server, faked at fetch: GET /api/artifact hands out whatever `disk` holds.
let disk = { name: 'brief.md', version: 'v1', content: '# brief\n\nfirst\n' };
let gets = 0;
globalThis.fetch = async (url) => {
  if (String(url).startsWith('/api/artifact')) {
    gets++;
    return { ok: true, status: 200, json: async () => disk };
  }
  return { ok: true, status: 200, json: async () => ({}) };
};

const detail = import(pathToFileURL(path.join(__dirname, '..', 'ui', 'js', 'detail.js')).href);
const URI = 'file:///tmp/brief.md';
const shown = () => {
  const b = byId('av-body');
  return String(b.innerHTML || '') + String(b.textContent || '');
};
// Open the popup on the current `disk` state, as a click on the card's artifact does.
async function openPopup(m) {
  byId('av-body').innerHTML = byId('av-body').textContent = '';
  await m.openArtifact(URI);
  assert.ok(shown().includes('first'), 'precondition: the popup shows what was on disk when it opened');
}

test('clean popup: an outside write lands in the open viewer, no click needed', async () => {
  const m = await detail;
  await openPopup(m);

  disk = { name: 'brief.md', version: 'v2', content: '# brief\n\nthe agent rewrote this\n' };
  await m.artifactWritten({ uri: URI, version: 'v2', by: 'agent-tab' });

  assert.ok(shown().includes('the agent rewrote this'), 'the new text is on the screen');
  assert.ok(!shown().includes('first'), 'and the stale text is gone');
});

test('the writer\'s own tab hears its echo and does nothing', async () => {
  const m = await detail;
  const { api } = await import(pathToFileURL(path.join(__dirname, '..', 'ui', 'js', 'api.js')).href);
  disk = { name: 'brief.md', version: 'v1', content: '# brief\n\nfirst\n' };
  await openPopup(m);

  const before = gets;
  disk = { name: 'brief.md', version: 'v9', content: 'should never be fetched\n' };
  await m.artifactWritten({ uri: URI, version: 'v9', by: api.clientId });

  assert.strictEqual(gets, before, 'our own save coming back is not re-read');
  assert.ok(shown().includes('first'), 'and the screen does not flash at itself');
});

test('the version already held: no re-read, no repaint', async () => {
  const m = await detail;
  disk = { name: 'brief.md', version: 'v1', content: '# brief\n\nfirst\n' };
  await openPopup(m);

  const before = gets;
  await m.artifactWritten({ uri: URI, version: 'v1', by: 'agent-tab' });
  assert.strictEqual(gets, before, 'we already hold that version — nothing to do');
});

test('a write on a file the popup is not showing is ignored', async () => {
  const m = await detail;
  disk = { name: 'brief.md', version: 'v1', content: '# brief\n\nfirst\n' };
  await openPopup(m);

  const before = gets;
  await m.artifactWritten({ uri: 'file:///tmp/other.md', version: 'v2', by: 'agent-tab' });
  assert.strictEqual(gets, before, 'a different file is nothing of ours');
  assert.ok(shown().includes('first'));
});

test('a closed popup does not follow — the next open re-reads anyway', async () => {
  const m = await detail;
  disk = { name: 'brief.md', version: 'v1', content: '# brief\n\nfirst\n' };
  await openPopup(m);
  m.closeArtifact();

  const before = gets;
  disk = { name: 'brief.md', version: 'v2', content: 'written while nobody looked\n' };
  await m.artifactWritten({ uri: URI, version: 'v2', by: 'agent-tab' });
  assert.strictEqual(gets, before, 'nothing is on screen, so nothing is fetched');
});

// The file-screen path is not traded away for this: its branch still runs on
// fileKey() and still routes through the editor's update / notice.
test('the file-screen branch is intact', async () => {
  const fs = require('node:fs');
  const src = fs.readFileSync(path.join(__dirname, '..', 'ui', 'js', 'detail.js'), 'utf8');
  assert.match(src, /const onFileScreen = fileKey\(\) === uri;/);
  assert.match(src, /if \(fileKey\(\) !== uri\) return; \/\/ he left the screen/);
  assert.match(src, /if \(!fileDirty\(\) \|\| fileMerges\(\)\) return take\(/);
  assert.match(src, /fileNotice\(/);
});
