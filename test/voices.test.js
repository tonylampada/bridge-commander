'use strict';
// ui/js/voices.js — the catalogue and whose voice speaks. What used to be tested
// here was withFallback: "a speaker that fails is not silence, it is the next
// speaker down". That rule is gone on purpose — a fallback that quietly
// substituted an English browser voice is what cost an afternoon — so what is
// left is the half that survived: the catalogue, and the inheritance rule.
// Browser code (ES module), loaded via dynamic import; nothing here touches DOM.
const test = require('node:test');
const assert = require('node:assert');
const path = require('node:path');
const { pathToFileURL } = require('node:url');

let fetchVoices, pickVoice;
test.before(async () => {
  ({ fetchVoices, pickVoice } =
    await import(pathToFileURL(path.join(__dirname, '..', 'ui', 'js', 'voices.js')).href));
});

// The catalogue is not filtered by the workspace language: voxcpm2 clones from
// any reference clip, so an `en` voice speaking Portuguese is a choice with an
// accent, not an error. Hiding two thirds of the catalogue was the bug.
test('fetchVoices: the whole catalogue comes back, whatever the workspace language', async () => {
  let asked = null;
  global.fetch = (u) => (asked = u) && Promise.resolve(new Response(JSON.stringify({ voices: [
    { id: 'a', name: 'Ana', langs: ['pt'] },
    { id: 'b', name: 'Bell', langs: ['en'] },
    { id: 'c', name: 'Chen', langs: ['zh'] },
    { id: 'd', name: 'Dee' },
  ] }), { status: 200 }));
  const list = await fetchVoices('http://127.0.0.1:8883', 'pt');
  assert.equal(asked, 'http://127.0.0.1:8883/v1/voices', 'the engine, not the board');
  assert.deepEqual(list, [
    { id: 'a', name: 'Ana', lang: 'pt' },
    { id: 'b', name: 'Bell', lang: 'en' },
    { id: 'c', name: 'Chen', lang: 'zh' },
    { id: 'd', name: 'Dee', lang: 'pt' },     // no langs at all: labelled with the default
  ]);
});

// A dead engine means an empty picker, not a broken page. The silence that
// follows is announced when it comes to speaking — see voice.js's mute().
test('fetchVoices: an engine that does not answer is an empty catalogue', async () => {
  global.fetch = () => Promise.reject(new Error('connection refused'));
  assert.deepEqual(await fetchVoices('http://127.0.0.1:1', 'pt'), []);
});

// ---------- pickVoice: whose voice speaks ----------
// A lieutenant may own a voice; one that owns none inherits the board's. That
// inheritance IS the default, so it gets pinned down here.
const CATALOGUE = [
  { id: 'pt_BR-faber-medium', name: 'faber', lang: 'pt_BR' },
  { id: 'pt_BR-edresson-low', name: 'edresson', lang: 'pt_BR' },
];

test('pickVoice: the author\'s own voice wins over the board\'s', () => {
  assert.equal(pickVoice('pt_BR-faber-medium', 'pt_BR-edresson-low', CATALOGUE), 'pt_BR-faber-medium');
});

test('pickVoice: no voice of its own falls back to the board\'s', () => {
  for (const own of [undefined, null, '']) {
    assert.equal(pickVoice(own, 'pt_BR-edresson-low', CATALOGUE), 'pt_BR-edresson-low', 'own=' + JSON.stringify(own));
  }
});

// This used to mean "let the speaker use its own default". There is no default
// any more: speech.js refuses to speak without a voice, and '' is what makes it.
test('pickVoice: nothing chosen anywhere is no voice, and no voice is silence', () => {
  assert.equal(pickVoice('', '', CATALOGUE), '');
});

test('pickVoice: an id the engine does not offer is no voice at all', () => {
  // a pick made against another engine, or a voice since removed — speaking with
  // an unknown id fails, and speaking with none is no longer allowed either
  assert.equal(pickVoice('gone-voice', 'pt_BR-faber-medium', CATALOGUE), 'pt_BR-faber-medium',
    'a stale pick still falls through to the board voice');
  assert.equal(pickVoice('', 'gone-voice', CATALOGUE), '');
  assert.equal(pickVoice('pt_BR-faber-medium', '', []), '', 'catalogue not loaded yet');
});
