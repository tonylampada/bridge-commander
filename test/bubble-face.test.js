'use strict';
// ui/js/state.js — bubbleFaceId, whose face a chat bubble wears: the sender's
// when it resolves to a lieutenant, else the feed owner's. state.js touches no
// DOM at import, so it's imported directly (same pattern as state-actor.test.js).
const test = require('node:test');
const assert = require('node:assert');
const path = require('node:path');
const { pathToFileURL } = require('node:url');

let S, bubbleFaceId;
test.before(async () => {
  ({ S, bubbleFaceId } =
    await import(pathToFileURL(path.join(__dirname, '..', 'ui', 'js', 'state.js')).href));
});

const DOC = { lieutenants: [{ id: 'holmes', name: 'Holmes' }, { id: 'monica', name: 'Monica' }] };

function withDoc(doc, fn) {
  const prev = S.doc;
  S.doc = doc;
  try { fn(); } finally { S.doc = prev; }
}

test('bubbleFaceId: the owner writing in its own feed wears its own face', () => {
  withDoc(DOC, () => {
    assert.strictEqual(bubbleFaceId('Holmes', 'holmes'), 'holmes');
  });
});

test('bubbleFaceId: another lieutenant writing in the feed wears its own face', () => {
  withDoc(DOC, () => {
    assert.strictEqual(bubbleFaceId('Monica', 'holmes'), 'monica');
    assert.strictEqual(bubbleFaceId('monica', 'holmes'), 'monica'); // by id
    assert.strictEqual(bubbleFaceId('MONICA', 'holmes'), 'monica'); // any case
  });
});

test('bubbleFaceId: an unresolvable author falls back to the owner', () => {
  withDoc(DOC, () => {
    for (const author of ['worker', 'server', 'Ghost', '', null, undefined]) {
      assert.strictEqual(bubbleFaceId(author, 'holmes'), 'holmes');
    }
  });
});

test('bubbleFaceId: safe with no board doc', () => {
  withDoc(null, () => {
    assert.strictEqual(bubbleFaceId('Monica', 'holmes'), 'holmes');
  });
});
