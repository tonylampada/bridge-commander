'use strict';
// ui/js/detail.js viewer dispatch — the extension-regex seams that route an
// artifact/attachment name to a media branch. detail.js binds DOM at import
// time, so pin the decision at the source level: extract the regex literals
// and assert an audio name picks the audio branch, not the known-binary
// download (BIN_EXT used to include mp3|wav|ogg|flac and stole the case).
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const src = fs.readFileSync(path.join(__dirname, '..', 'ui', 'js', 'detail.js'), 'utf8');
function extractRegex(name) {
  const m = new RegExp('const ' + name + ' = /(.+)/(\\w*);').exec(src);
  assert.ok(m, name + ' regex literal found in detail.js');
  return new RegExp(m[1], m[2]);
}
const AUDIO_EXT = extractRegex('AUDIO_EXT');
const VIDEO_EXT = extractRegex('VIDEO_EXT');
const BIN_EXT = extractRegex('BIN_EXT');

test('audio extensions match AUDIO_EXT and are out of BIN_EXT', () => {
  for (const ext of ['mp3', 'wav', 'm4a', 'aac', 'ogg', 'oga', 'opus', 'flac']) {
    const name = 'reply.' + ext;
    assert.ok(AUDIO_EXT.test(name), name + ' picks the audio branch');
    assert.ok(!BIN_EXT.test(name), name + ' no longer falls into the download branch');
  }
});

test('AUDIO_EXT does not steal video, text, or binary names', () => {
  for (const name of ['demo.mp4', 'clip.mov', 'notes.txt', 'report.md', 'bundle.zip']) {
    assert.ok(!AUDIO_EXT.test(name), name + ' is not audio');
  }
  assert.ok(VIDEO_EXT.test('demo.mp4') && BIN_EXT.test('bundle.zip'), 'other branches intact');
});

test('openArtifact checks AUDIO_EXT before the BIN_EXT download fallback', () => {
  const audioAt = src.indexOf('AUDIO_EXT.test(name)');
  const binAt = src.indexOf('BIN_EXT.test(name)');
  assert.ok(audioAt > -1 && binAt > -1 && audioAt < binAt);
});

test('openAttachment dispatches audio by mime, name fallback, and served Content-Type', () => {
  assert.match(src, /isAudioMime\(mime\) \|\| \(!mime && AUDIO_EXT\.test\(name\)\)\) return showAudio\(\)/);
  assert.match(src, /isAudioMime\(ct\)\) return showAudio\(\)/);
});

const PDF_EXT = extractRegex('PDF_EXT');
test('a .pdf picks the pdf viewer, not the known-binary download', () => {
  assert.ok(PDF_EXT.test('spec.pdf') && PDF_EXT.test('SPEC.PDF'));
  assert.ok(!BIN_EXT.test('spec.pdf'), 'pdf left BIN_EXT');
  const pdfAt = src.indexOf('PDF_EXT.test(name)) {');
  assert.ok(pdfAt > -1 && pdfAt < src.indexOf('BIN_EXT.test(name)'), 'openArtifact checks PDF_EXT before BIN_EXT');
  assert.match(src, /return showPdf\(rawUrl\)/, 'card artifact renders from the raw byte serve');
});

test('openAttachment dispatches pdf by mime, name, and served Content-Type', () => {
  assert.match(src, /isPdfMime\(mime\) \|\| PDF_EXT\.test\(name\)\) return showPdf\(url\)/);
  assert.match(src, /isPdfMime\(ct\)\) return showPdf\(url\)/);
});

test('pdf: native viewer in an iframe, pdf.js (vendored, no CDN) on iOS', () => {
  assert.match(src, /if \(!isIOS\(\)\) \{ avFrame\.hidden = false; avFrame\.src = url; return; \}/);
  assert.match(src, /import\('\/ui\/vendor\/pdfjs\/pdf\.min\.js'\)/);
  const vendor = path.join(__dirname, '..', 'ui', 'vendor', 'pdfjs');
  for (const f of ['pdf.min.js', 'pdf.worker.min.js']) assert.ok(fs.existsSync(path.join(vendor, f)), f + ' vendored');
});
