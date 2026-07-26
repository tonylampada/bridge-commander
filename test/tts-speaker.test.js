'use strict';
// ui/js/tts/index.js — the speaker seam. The rule that matters: a speaker that
// fails is not silence, it is the next speaker down. withFallback is the ONE
// place that knows it, so it is the one place that gets tested for it.
// Browser code (ES module), loaded via dynamic import; nothing here touches DOM.
const test = require('node:test');
const assert = require('node:assert');
const path = require('node:path');
const { pathToFileURL } = require('node:url');

let withFallback, speakerFor;
test.before(async () => {
  ({ withFallback, speakerFor } =
    await import(pathToFileURL(path.join(__dirname, '..', 'ui', 'js', 'tts', 'index.js')).href));
});

// A recording speaker: `fail` makes speak() reject the way a dead engine does.
function fake(id, fail) {
  const calls = { speak: [], cancel: 0, voices: 0, pause: 0, resume: 0 };
  return {
    calls,
    id,
    key: 'key-' + id,
    voices() { calls.voices++; return Promise.resolve([{ id: id + '-v', name: id, lang: 'pt' }]); },
    speak(text, opts) {
      calls.speak.push({ text, opts });
      return fail ? Promise.reject(new Error(id + ' is down')) : Promise.resolve();
    },
    cancel() { calls.cancel++; },
    pause() { calls.pause++; },
    resume() { calls.resume++; },
  };
}

test('primary speaks: the secondary is never asked', async () => {
  const a = fake('remote'), b = fake('browser');
  await withFallback(a, b).speak('olá', { voice: 'x' });
  assert.deepEqual(a.calls.speak, [{ text: 'olá', opts: { voice: 'x' } }]);
  assert.equal(b.calls.speak.length, 0);
});

test('primary rejects: the SAME text is spoken through the secondary', async () => {
  const a = fake('remote', true), b = fake('browser');
  await withFallback(a, b).speak('olá, capitão', { voice: 'pt_BR-faber-medium' });
  assert.equal(a.calls.speak.length, 1);
  assert.equal(b.calls.speak.length, 1, 'a dead primary must not mean silence');
  assert.equal(b.calls.speak[0].text, 'olá, capitão');
});

test('the fallback carries no voice: the picked id belongs to the primary', async () => {
  const a = fake('remote', true), b = fake('browser');
  await withFallback(a, b).speak('olá', { voice: 'pt_BR-faber-medium' });
  assert.deepEqual(b.calls.speak[0].opts, {}, 'never hand one speaker the other one\'s voice id');
});

test('both speakers reject: speak() rejects rather than hanging a caller', async () => {
  const a = fake('remote', true), b = fake('browser', true);
  await assert.rejects(() => withFallback(a, b).speak('olá', {}));
});

test('the picker follows the primary; cancel reaches both', async () => {
  const a = fake('remote'), b = fake('browser');
  const s = withFallback(a, b);
  assert.equal(s.id, 'remote');
  assert.equal(s.key, 'key-remote', 'per-speaker storage key: a browser voice name is never an engine id');
  assert.deepEqual(await s.voices(), [{ id: 'remote-v', name: 'remote', lang: 'pt' }]);
  assert.equal(b.calls.voices, 0, 'the catalogue is the primary\'s alone');
  s.cancel();
  assert.equal(a.calls.cancel, 1);
  assert.equal(b.calls.cancel, 1);
});

// The board's transport presses these, and so does the phone's lock screen. Which
// of the two speakers is actually mid-utterance is not knowable from up here, so
// both hear it — same rule as cancel.
test('pause and resume reach both speakers', () => {
  const a = fake('remote'), b = fake('browser');
  const s = withFallback(a, b);
  s.pause(); s.resume();
  assert.deepEqual([a.calls.pause, a.calls.resume], [1, 1]);
  assert.deepEqual([b.calls.pause, b.calls.resume], [1, 1]);
});

test('speakerFor: no tts config is the browser speaker, plain', () => {
  for (const cfg of [null, {}, { voices: ['Luciana'] }, { tts: { enabled: false } }]) {
    const s = speakerFor(cfg);
    assert.equal(s.id, 'browser', 'cfg=' + JSON.stringify(cfg));
    assert.equal(s.key, 'bc-voice');
  }
});

test('speakerFor: a configured engine is the remote speaker, with the browser under it', () => {
  const s = speakerFor({ tts: { enabled: true, lang: 'pt', voice: null } });
  assert.equal(s.id, 'remote');
  assert.equal(s.key, 'bc-tts-voice');
});

// ---------- pickVoice: whose voice speaks ----------
// A lieutenant may own a voice; one that owns none inherits the board's. That
// inheritance IS the default, so it gets pinned down here.
const CATALOGUE = [
  { id: 'pt_BR-faber-medium', name: 'faber', lang: 'pt_BR' },
  { id: 'pt_BR-edresson-low', name: 'edresson', lang: 'pt_BR' },
];
let pickVoice;
test.before(async () => {
  ({ pickVoice } = await import(pathToFileURL(path.join(__dirname, '..', 'ui', 'js', 'tts', 'index.js')).href));
});

test('pickVoice: the author\'s own voice wins over the board\'s', () => {
  assert.equal(pickVoice('pt_BR-faber-medium', 'pt_BR-edresson-low', CATALOGUE), 'pt_BR-faber-medium');
});

test('pickVoice: no voice of its own falls back to the board\'s', () => {
  for (const own of [undefined, null, '']) {
    assert.equal(pickVoice(own, 'pt_BR-edresson-low', CATALOGUE), 'pt_BR-edresson-low', 'own=' + JSON.stringify(own));
  }
});

test('pickVoice: nothing chosen anywhere is the speaker\'s own default', () => {
  assert.equal(pickVoice('', '', CATALOGUE), '');
});

test('pickVoice: an id the engine does not offer is no voice at all', () => {
  // a pick made against another engine, or a voice since removed — speaking with
  // an unknown id fails, speaking with none does not
  assert.equal(pickVoice('gone-voice', 'pt_BR-faber-medium', CATALOGUE), 'pt_BR-faber-medium',
    'a stale pick still falls through to the board voice');
  assert.equal(pickVoice('', 'gone-voice', CATALOGUE), '');
  assert.equal(pickVoice('pt_BR-faber-medium', '', []), '', 'catalogue not loaded yet');
});
