'use strict';
// ui/js/voice.js — the board's speech POLICY, which is now mostly a queue: one
// message at a time, in the order they arrived. speech.js is left REAL
// underneath (it has its own tests, and faking it would fake away the thing the
// queue is built on), so what these assert is what the board actually sends: the
// order of the engine requests, and the fact that there is never a second one in
// flight.
//
// Nothing here waits on speech. Every fake utterance is 240 samples — 10ms of
// audio — so the queue's "let the buffers finish before the next one" wait is
// bounded by that. No real clock is raced and no audio is produced.
const test = require('node:test');
const assert = require('node:assert');
const path = require('node:path');
const { pathToFileURL } = require('node:url');

let speak, stopSpeaking, stripForSpeech;

const ENGINE = 'http://127.0.0.1:8883';
const tick = (ms) => new Promise((r) => setTimeout(r, ms));
// Poll rather than sleep: every test below is waiting for a REQUEST to happen,
// and a request that never happens should fail loudly, not slowly.
async function until(what, why, ms = 2000) {
  for (let waited = 0; waited < ms; waited += 2) {
    if (what()) return;
    await tick(2);
  }
  assert.fail('timed out waiting for ' + why);
}
// toast.js arms a 6s dismiss timer per toast. Nothing here waits for one, but a
// live timer holds the test runner open long after the assertions are done.
const realSetTimeout = global.setTimeout;
global.setTimeout = (fn, ms, ...rest) => {
  const t = realSetTimeout(fn, ms, ...rest);
  if (ms >= 1000) t.unref?.();
  return t;
};

// ── the page ──────────────────────────────────────────────────────────────
// One element kind for everything the modules build or look up. It is a real
// enough tree for toast.js (which counts children and removes the oldest) and
// for speech.js (which builds its transport and its <audio>).
const made = [];                  // every element created, which is where toasts are read
let audioEl = null;               // speech.js makes ONE, for the life of the page
function el(tag) {
  const n = {
    tag, textContent: '', className: '', value: '', type: '', title: '',
    hidden: true, paused: true, srcObject: null, children: [], parent: null,
    classList: { toggle() {}, add() {}, remove() {} },
    play() { n.paused = false; return Promise.resolve(); },
    pause() { n.paused = true; },
    querySelectorAll() { return [el('button'), el('button'), el('button')]; },
    querySelector() { return el('span'); },
  };
  n.appendChild = (c) => { c.parent = n; n.children.push(c); return c; };
  n.append = (...cs) => { cs.forEach(n.appendChild); };
  n.remove = () => {
    const i = n.parent ? n.parent.children.indexOf(n) : -1;
    if (i >= 0) n.parent.children.splice(i, 1);
  };
  Object.defineProperty(n, 'firstChild', { get: () => n.children[0] || null });
  if (tag === 'audio') audioEl = n;
  return n;
}
const byId = {};
function fakePage() {
  global.document = {
    createElement(tag) { const n = el(tag); made.push(n); return n; },
    getElementById(id) { return (byId[id] ||= el(id)); },
    head: { appendChild: (n) => n },
    body: { appendChild: (n) => n },
  };
  const store = { 'bc-voice-on': '1', 'bc-tts-voice': 'v1' };   // voice on, a voice picked
  global.localStorage = {
    getItem: (k) => (k in store ? store[k] : null),
    setItem: (k, v) => { store[k] = String(v); },
    removeItem: (k) => { delete store[k]; },
  };
}
// What the captain was told. mute() is the board's only way to be silent, and it
// is always a toast — toast.js puts the words in a .tx element.
const toasts = () => made.filter((n) => n.className === 'tx').map((n) => n.textContent);
// speech.js's own <audio> — paused is "no sound is leaving the board". It is
// made once and kept (iOS blesses an element once), so it outlives `made`.
const speaker = () => audioEl;

// ── the speakers ──────────────────────────────────────────────────────────
// Enough AudioContext to schedule buffers into. Timing is irrelevant here — the
// assertions are about requests, not sound.
class FakeCtx {
  constructor() { this.state = 'running'; this.destination = {}; }
  get currentTime() { return 0; }
  resume() { this.state = 'running'; return Promise.resolve(); }
  suspend() { this.state = 'suspended'; return Promise.resolve(); }
  createMediaStreamDestination() { return { stream: { id: 'live' } }; }
  createBuffer(ch, len, rate) {
    const data = new Float32Array(len);
    return { length: len, duration: len / rate, getChannelData: () => data };
  }
  createBufferSource() {
    let cb = null;
    return {
      connect() {}, start() { setTimeout(() => cb && cb(), 1); },
      set onended(f) { cb = f; }, get onended() { return cb; },
    };
  }
}

// ── the engine ────────────────────────────────────────────────────────────
const asked = [];                 // what was asked of the engine, in the order it left
let answer;                       // how the engine replies, per test
const json = (o) => Promise.resolve(new Response(JSON.stringify(o), { status: 200 }));
// 10ms of audio, in one chunk, over in a microtask.
function said() {
  const pcm = new Uint8Array(480);
  return Promise.resolve(new Response(new ReadableStream({
    start(c) { c.enqueue(pcm); c.close(); },
  }), { status: 200, headers: { 'x-sample-rate': '24000' } }));
}
// A synthesis that is still running: it never ends on its own, only when the
// board aborts it. This is what "stop while it is speaking" needs.
function stillGoing(signal) {
  return Promise.resolve(new Response(new ReadableStream({
    start(c) {
      c.enqueue(new Uint8Array(480));
      signal.addEventListener('abort', () => {
        try { c.error(new DOMException('aborted', 'AbortError')); } catch (e) {}
      });
    },
  }), { status: 200, headers: { 'x-sample-rate': '24000' } }));
}
const refused = (why) => Promise.resolve(new Response(JSON.stringify({ detail: why }), { status: 500 }));

function fakeEngine() {
  global.fetch = (url, opts = {}) => {
    if (url === '/api/config') {
      return json({ voices: null, tts: { enabled: true, url: ENGINE, lang: 'pt', voice: null, params: {} } });
    }
    if (url === ENGINE + '/v1/voices') return json({ voices: [{ id: 'v1', name: 'Voice One', langs: ['pt-BR'] }] });
    if (url === ENGINE + '/v1/audio/speech') {
      const input = JSON.parse(opts.body).input;
      asked.push(input);
      // A real fetch rejects when its signal fires, however far along it is.
      return Promise.race([answer(input, opts.signal), new Promise((_, rej) =>
        opts.signal.addEventListener('abort', () => rej(new DOMException('aborted', 'AbortError'))))]);
    }
    return Promise.reject(new Error('unexpected fetch: ' + url));
  };
}

test.before(async () => {
  global.window = { AudioContext: FakeCtx };
  fakePage();
  fakeEngine();
  answer = () => said();
  ({ speak, stopSpeaking, stripForSpeech } =
    await import(pathToFileURL(path.join(__dirname, '..', 'ui', 'js', 'voice.js')).href));
  // The catalogue lands a few promises after import; the board is mute (and says
  // so) until it does, so every test would otherwise be testing that instead.
  await until(() => byId['voice-select'].value === 'v1', 'the engine catalogue to land');
});

// The module is a singleton for the life of the file — a queue left running is
// the next test's problem, so each one starts from stopped and empty.
test.beforeEach(async () => {
  stopSpeaking();
  await tick(10);
  asked.length = 0;
  made.length = 0;
  answer = () => said();
});

// ── what is left of the markdown when it has to be heard ──────────────────
// Every assertion below is an EAR test written down. The thing being checked is
// never "the character is gone" — it is what a person would hear: no pipes read
// out, no "greater than" in front of a quotation, a pause where the writing had
// a heading or a list, and the words of a link without the URL after them.
//
// A pause is a full stop or a newline, because those are the two things the
// engine breathes on. That is why these tests look at punctuation and line
// breaks so closely: for speech they ARE the content.
test('a table is not read out — it is announced', () => {
  const said = stripForSpeech('Antes.\n\n| Nome | Idade |\n| --- | --- |\n| Ana | 30 |\n| Bo | 41 |\n\nDepois.');
  assert.ok(!/\|/.test(said), 'no pipe survives to be spoken: ' + JSON.stringify(said));
  assert.match(said, /Antes\.\s+table\.\s+Depois\./,
    'the whole table collapses to ONE announcement — not one per row');
});

test('a quotation is spoken as speech, not as "greater than"', () => {
  const said = stripForSpeech('Ele disse:\n\n> a pressa é inimiga\n> da perfeição\n\nE foi.');
  assert.equal(said, 'Ele disse:\n\na pressa é inimiga\nda perfeição\n\nE foi.',
    'the markers are gone and the words are untouched');
});

test('underscore emphasis gives up its underscores; an identifier keeps them', () => {
  assert.equal(stripForSpeech('isso é _assim_ e também __assim__.'), 'isso é assim e também assim.');
  assert.equal(stripForSpeech('a chave bc_voice_on fica.'), 'a chave bc_voice_on fica.',
    'snake_case is one spoken word, not a pair of emphasis marks');
});

test('a heading ends in a full stop instead of colliding with the next line', () => {
  const said = stripForSpeech('## Recomendação\nMantida: pipeline em YAML.');
  assert.equal(said, 'Recomendação.\nMantida: pipeline em YAML.',
    'the hashes are gone AND there is something to breathe on between the two');
});

test('a link says its words and never its URL', () => {
  assert.equal(stripForSpeech('Clique em [abre o card](https://exemplo.com/x?a=1) agora.'),
    'Clique em abre o card agora.',
    'no trailing "link" after the text — the URL had nothing to say');
});

test('list items stay separate items, not one long breath', () => {
  const said = stripForSpeech('Três coisas:\n\n- primeira\n- segunda\n* terceira\n\n1. um\n2. dois');
  assert.equal(said, 'Três coisas:\n\nprimeira.\nsegunda.\nterceira.\n\num.\ndois.',
    'bullets and numbers are gone, and every item is its own sentence');
});

test('a horizontal rule is a silence, not three dashes', () => {
  assert.equal(stripForSpeech('Acima.\n\n---\n\nAbaixo.'), 'Acima.\n\nAbaixo.');
  assert.equal(stripForSpeech('Acima.\n\n***\n\nAbaixo.'), 'Acima.\n\nAbaixo.');
});

test('a code fence is still "code" and a bare URL is still "link"', () => {
  const said = stripForSpeech('Rode:\n\n```sh\nnpm test\n```\n\nveja https://ex.com/a pra mais.');
  assert.match(said, /Rode:\s+code\s+veja link pra mais\./,
    'these two were already right and were left alone: ' + JSON.stringify(said));
});

test('a real message from the board comes out as prose', () => {
  const said = stripForSpeech([
    '**Correção: eu procurei mal.** Achei: [`mattpocock/sandcastle`](https://github.com/mattpocock/sandcastle).',
    '',
    '## O que o Sandcastle faz',
    '',
    '- cria e limpa **git worktree**',
    '- **retoma sessão**: `resumeSession`',
    '',
    'Mantida: pipeline em YAML nosso.',
  ].join('\n'));
  assert.equal(said, [
    'Correção: eu procurei mal. Achei: mattpocock/sandcastle .',
    '',
    'O que o Sandcastle faz.',
    '',
    'cria e limpa git worktree.',
    'retoma sessão: resumeSession .',
    '',
    'Mantida: pipeline em YAML nosso.',
  ].join('\n'));
});

test('a burst past the cap drops the MIDDLE of the queue and keeps the newest', async () => {
  ['one', 'two', 'three', 'four', 'five', 'six'].forEach((m) => speak(m, 'monica'));

  await until(() => asked.length >= 4, 'the queue to drain');
  await tick(20);                                  // …and nothing after it
  assert.deepEqual(asked, ['one', 'two', 'three', 'six'],
    'the first three and the NEWEST were spoken; four and five were dropped from the middle');
  assert.equal(toasts().filter((t) => /skipped/.test(t)).length, 2,
    'each dropped message was announced — nothing is discarded in silence');
});

test('stop empties the queue: it does not just silence what is speaking', async () => {
  answer = (input, signal) => stillGoing(signal);   // the first one is still being said
  ['one', 'two', 'three'].forEach((m) => speak(m, 'monica'));
  await until(() => asked.length >= 1, 'the first message to reach the engine');

  stopSpeaking();

  await tick(30);
  assert.deepEqual(asked, ['one'],
    'the two that were waiting are gone, not merely postponed until the first ends');
  assert.equal(speaker().paused, true, 'and what was speaking stopped there and then');
});

test('a speech that fails toasts, and the queue keeps going', async () => {
  answer = (input, signal) => (input === 'two' ? refused('engine is out of memory') : said());
  ['one', 'two', 'three'].forEach((m) => speak(m, 'monica'));

  await until(() => asked.length >= 3, 'the message after the failing one to be spoken');
  assert.deepEqual(asked, ['one', 'two', 'three'], 'the failure took only its own message down');
  assert.ok(toasts().some((t) => /speech failed: engine is out of memory/.test(t)),
    'and the captain was told why he did not hear it: ' + JSON.stringify(toasts()));
});
