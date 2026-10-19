'use strict';
// POST /api/pastedebug — ui/js/pastedebug.js ships its event log here and the
// server appends it to <ws>/.bridge-commander/pastedebug.log (MNC-280).
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const { startServer } = require('./helper');

test('pastedebug appends tagged lines to the state dir, one line per entry', async () => {
  const s = await startServer();
  try {
    let r = await s.api('POST', '/api/pastedebug', { session: 'ab12/../x', ua: 'Mac', lines: ['keydown a', 'paste\nsplit'] });
    assert.strictEqual(r.status, 200);
    r = await s.api('POST', '/api/pastedebug', { session: 'ab12', lines: ['focus'] });
    assert.strictEqual(r.status, 200);
    const log = fs.readFileSync(path.join(s.dir, '.bridge-commander', 'pastedebug.log'), 'utf8');
    assert.strictEqual(log, 'ab12x keydown a\nab12x paste split\nab12x ua Mac\nab12 focus\n');
  } finally { await s.stop(); }
});
