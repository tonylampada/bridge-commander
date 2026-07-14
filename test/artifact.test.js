'use strict';
// Artifact viewer serve: the text preview (default) AND the raw byte mode
// (raw=1) that backs the inline <img> and file downloads. The auth guard (uri
// must be listed verbatim on a live card), the path/file:// guard, the size cap,
// and the attachments-grade hardening all hold for raw mode too.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const { startServerWithLieutenant, withOwner } = require('./helper');

// A minimal but valid 1x1 PNG.
const PNG = Buffer.from(
  '89504e470d0a1a0a0000000d49484452000000010000000108060000001f15c4890000000d4944415478' +
  '9c6200010000050001' + '0d0a2db400000000' + '49454e44ae426082',
  'hex'
);

// Create a card and promote a file at `filePath` (bare path or file:// uri) to
// its artifacts; returns the stored artifact uri (normalized by the server).
async function cardWithArtifact(s, uri, label) {
  const cr = await s.api('POST', '/api/cards', withOwner({ title: 'Deliverable' }));
  assert.strictEqual(cr.status, 200, JSON.stringify(cr.body));
  const id = cr.body.card.id;
  const add = await s.api('POST', '/api/cards/' + id + '/artifacts', { uri, label });
  assert.strictEqual(add.status, 200, JSON.stringify(add.body));
  return { id, uri: add.body.artifact.uri };
}

test('raw=1 for a listed image → 200, image Content-Type, hardening headers, exact bytes', async () => {
  const s = await startServerWithLieutenant();
  try {
    const img = path.join(s.dir, 'lunch.png');
    fs.writeFileSync(img, PNG);
    const { uri } = await cardWithArtifact(s, img, 'almoço do captain');

    const res = await fetch(s.base + '/api/artifact?uri=' + encodeURIComponent(uri) + '&raw=1');
    assert.strictEqual(res.status, 200);
    assert.strictEqual(res.headers.get('content-type'), 'image/png');
    assert.strictEqual(res.headers.get('x-content-type-options'), 'nosniff');
    assert.strictEqual(res.headers.get('content-security-policy'), 'sandbox');
    assert.match(res.headers.get('content-disposition') || '', /^inline/);
    const got = Buffer.from(await res.arrayBuffer());
    assert.ok(got.equals(PNG), 'served bytes match the file');
  } finally {
    await s.stop();
  }
});

test('raw=1 for a uri NOT listed on any card → 404 (auth guard holds for raw too)', async () => {
  const s = await startServerWithLieutenant();
  try {
    const img = path.join(s.dir, 'secret.png');
    fs.writeFileSync(img, PNG);
    // never promoted to a card
    const res = await fetch(s.base + '/api/artifact?uri=' + encodeURIComponent('file://' + img) + '&raw=1');
    assert.strictEqual(res.status, 404);
  } finally {
    await s.stop();
  }
});

test('raw=1 over BC_ARTIFACT_MAX_BYTES → 413', async () => {
  const s = await startServerWithLieutenant({ env: { BC_ARTIFACT_MAX_BYTES: '64' } });
  try {
    const big = path.join(s.dir, 'big.png');
    fs.writeFileSync(big, Buffer.alloc(65, 1));
    const { uri } = await cardWithArtifact(s, big);
    const res = await fetch(s.base + '/api/artifact?uri=' + encodeURIComponent(uri) + '&raw=1');
    assert.strictEqual(res.status, 413);
  } finally {
    await s.stop();
  }
});

test('raw=1 rejects a traversal file:// uri and a non-file:// uri', async () => {
  const s = await startServerWithLieutenant();
  try {
    // A file:// uri with a `..` segment passes through the promote normalizer
    // verbatim; the raw serve must reject it (resolves away from the given path).
    const trav = await cardWithArtifact(s, 'file:///tmp/../etc/passwd');
    const r1 = await fetch(s.base + '/api/artifact?uri=' + encodeURIComponent(trav.uri) + '&raw=1');
    assert.strictEqual(r1.status, 400);

    // A non-file artifact (http) is not servable as local bytes.
    const web = await cardWithArtifact(s, 'https://example.com/x.png');
    const r2 = await fetch(s.base + '/api/artifact?uri=' + encodeURIComponent(web.uri) + '&raw=1');
    assert.strictEqual(r2.status, 400);
  } finally {
    await s.stop();
  }
});

test('raw=1 for a listed .html → 200, text/html inline, sandbox allow-scripts CSP', async () => {
  const s = await startServerWithLieutenant();
  try {
    const page = path.join(s.dir, 'teach-me.html');
    fs.writeFileSync(page, '<!doctype html><title>Diff</title><script>document.title="ok"</script>');
    const { uri } = await cardWithArtifact(s, page, 'explain diff');

    const res = await fetch(s.base + '/api/artifact?uri=' + encodeURIComponent(uri) + '&raw=1');
    assert.strictEqual(res.status, 200);
    assert.strictEqual(res.headers.get('content-type'), 'text/html; charset=utf-8');
    assert.strictEqual(res.headers.get('x-content-type-options'), 'nosniff');
    const csp = res.headers.get('content-security-policy') || '';
    assert.match(csp, /sandbox/);
    assert.match(csp, /allow-scripts/);
    assert.match(res.headers.get('content-disposition') || '', /^inline/);
    assert.match(await res.text(), /teach|Diff|doctype/i);
  } finally {
    await s.stop();
  }
});

test('non-image binary served as bytes with attachment disposition', async () => {
  const s = await startServerWithLieutenant();
  try {
    const zip = path.join(s.dir, 'bundle.zip');
    fs.writeFileSync(zip, Buffer.from('PKrest-of-zip'));
    const { uri } = await cardWithArtifact(s, zip);
    const res = await fetch(s.base + '/api/artifact?uri=' + encodeURIComponent(uri) + '&raw=1');
    assert.strictEqual(res.status, 200);
    assert.strictEqual(res.headers.get('content-type'), 'application/octet-stream');
    assert.match(res.headers.get('content-disposition') || '', /^attachment/);
  } finally {
    await s.stop();
  }
});

test('text artifact still returns the text preview (no raw)', async () => {
  const s = await startServerWithLieutenant();
  try {
    const md = path.join(s.dir, 'report.md');
    fs.writeFileSync(md, '# Findings\n\nall good');
    const { uri } = await cardWithArtifact(s, md, 'report');
    const res = await s.api('GET', '/api/artifact?uri=' + encodeURIComponent(uri));
    assert.strictEqual(res.status, 200);
    assert.strictEqual(res.body.name, 'report.md');
    assert.match(res.body.content, /# Findings/);
  } finally {
    await s.stop();
  }
});
