'use strict';
// ui/js/state.js — lieutenantByActor, the seam behind the notification/toast
// click routing for card-less chat-message items. state.js touches no DOM at
// import, so it's imported directly (same pattern as notifypolicy.test.js).
const test = require('node:test');
const assert = require('node:assert');
const path = require('node:path');
const { pathToFileURL } = require('node:url');

let S, lieutenantByActor;
test.before(async () => {
  ({ S, lieutenantByActor } =
    await import(pathToFileURL(path.join(__dirname, '..', 'ui', 'js', 'state.js')).href));
});

function withDoc(doc, fn) {
  const prev = S.doc;
  S.doc = doc;
  try { fn(); } finally { S.doc = prev; }
}

test('lieutenantByActor: matches by id', () => {
  withDoc({ lieutenants: [{ id: 'spock', name: 'Mr. Spock' }] }, () => {
    assert.strictEqual(lieutenantByActor('spock').id, 'spock');
  });
});

test('lieutenantByActor: matches by name (chat-say events carry the author name)', () => {
  withDoc({ lieutenants: [{ id: 'spock', name: 'Mr. Spock' }] }, () => {
    assert.strictEqual(lieutenantByActor('Mr. Spock').id, 'spock');
  });
});

test('lieutenantByActor: non-lieutenant actors resolve to nothing', () => {
  withDoc({ lieutenants: [{ id: 'spock', name: 'Mr. Spock' }] }, () => {
    for (const actor of ['server', 'user', 'worker', '', null, undefined]) {
      assert.strictEqual(lieutenantByActor(actor), undefined);
    }
  });
});

test('lieutenantByActor: safe with no board doc', () => {
  withDoc(null, () => {
    assert.strictEqual(lieutenantByActor('spock'), undefined);
  });
});
