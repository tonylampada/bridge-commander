'use strict';
// ui/js/mic.js — the microphone on the chat composer. The button and the red
// dot are a screenshot's problem; this is the part underneath: what gets posted,
// what reaches the composer, and what is let go of afterwards.
//
// mic.js imports NOTHING and takes its elements as arguments, which is why this
// test can exist — the rest of chat.js pulls in half the board. What it touches
// of the browser (getUserMedia, MediaRecorder, fetch) is stubbed below, so the
// state machine is driven rather than read.
const test = require('node:test');
const assert = require('node:assert');
const path = require('node:path');
const { pathToFileURL } = require('node:url');

const MOD = pathToFileURL(path.join(__dirname, '..', 'ui', 'js', 'mic.js')).href;
const tick = () => new Promise((r) => setTimeout(r, 0));

// ---- the page, as far as mic.js can tell -----------------------------------

function el(tag) {
  const n = {
    tag, id: '', className: '', type: '', title: '', textContent: '', value: '',
    hidden: true, children: [], listeners: {}, focused: 0, caret: null,
    insertBefore(child, before) {
      const i = n.children.indexOf(before);
      n.children.splice(i < 0 ? n.children.length : i, 0, child);
      return child;
    },
    addEventListener(ev, fn) { (n.listeners[ev] ||= []).push(fn); },
    dispatchEvent(e) { for (const fn of n.listeners[e.type] || []) fn(e); return true; },
    setSelectionRange(a, b) { n.caret = [a, b]; },
    focus() { n.focused++; },
  };
  return n;
}

let docKeys = [];
let recorders = [];
let posted = [];
let tracksStopped = 0;
let gum = null;                      // what getUserMedia does this test

class FakeRecorder {
  constructor(stream, opts) {
    this.stream = stream; this.opts = opts; this.state = 'inactive';
    recorders.push(this);
  }
  static isTypeSupported() { return true; }
  start() { this.state = 'recording'; }
  stop() {
    this.state = 'inactive';
    if (this.ondataavailable) this.ondataavailable({ data: new Blob(['AUDIO'], { type: 'audio/webm' }) });
    if (this.onstop) this.onstop();
  }
}

function fakeStream() {
  return { getTracks: () => [{ stop() { tracksStopped++; } }] };
}

function fakePage() {
  docKeys = []; recorders = []; posted = []; tracksStopped = 0;
  gum = async () => fakeStream();
  global.document = {
    createElement: (tag) => el(tag),
    addEventListener(ev, fn) { if (ev === 'keydown') docKeys.push(fn); },
  };
  Object.defineProperty(global, 'navigator', {
    configurable: true,
    value: { mediaDevices: { getUserMedia: (c) => gum(c) } },
  });
  global.isSecureContext = true;
  global.MediaRecorder = FakeRecorder;
  global.fetch = async (url, init) => {
    posted.push({ url, init });
    return { ok: true, status: 200, json: async () => ({ text: 'olá capitão' }) };
  };
}

function composer() {
  const form = el('form');
  const input = el('textarea');
  const errEl = el('div');
  form.children.push(input);
  return { form, input, errEl };
}

const escape = () => { for (const fn of docKeys) fn({ key: 'Escape' }); };

// ---- the tests -------------------------------------------------------------

test('no stt on the board: no button, nothing added to the composer', async () => {
  fakePage();
  const { mountMic } = await import(MOD);
  const c = composer();
  assert.equal(mountMic({ form: c.form, input: c.input, errEl: c.errEl, stt: false }), null);
  assert.deepEqual(c.form.children, [c.input]);       // the composer it always was
  assert.equal(c.form.children.length, 1);
});

// The captain's home-screen web app: `stt` is true, `navigator.mediaDevices` is
// not there. The button must still mount — a composer with no microphone and no
// explanation is the bug this replaced.
test('no getUserMedia: the button mounts, and the tap says why it cannot record', async () => {
  fakePage();
  Object.defineProperty(global, 'navigator', { configurable: true, value: {} });
  global.isSecureContext = true;
  const { mountMic } = await import(MOD);
  const c = composer();
  const btn = mountMic({ form: c.form, input: c.input, errEl: c.errEl, stt: true });
  assert.ok(btn);
  assert.deepEqual(c.form.children, [btn, c.input]);
  btn.onclick();
  assert.match(c.errEl.textContent, /Safari/);
  assert.equal(c.errEl.hidden, false);
  assert.equal(recorders.length, 0);                  // nothing was opened
});

test('no getUserMedia off https: the tap blames the origin, not the browser', async () => {
  fakePage();
  Object.defineProperty(global, 'navigator', { configurable: true, value: {} });
  global.isSecureContext = false;
  const { mountMic } = await import(MOD);
  const c = composer();
  const btn = mountMic({ form: c.form, input: c.input, errEl: c.errEl, stt: true });
  btn.onclick();
  assert.match(c.errEl.textContent, /https/);
});

test('permission refused: the message says so', async () => {
  fakePage();
  gum = async () => { const e = new Error('The request is not allowed'); e.name = 'NotAllowedError'; throw e; };
  const { mountMic } = await import(MOD);
  const c = composer();
  const btn = mountMic({ form: c.form, input: c.input, errEl: c.errEl, stt: true });
  btn.onclick();
  await tick();
  assert.match(c.errEl.textContent, /permission refused/);
  assert.equal(btn.textContent, '\u{1F3A4}');                  // back to idle
});

test('tap, speak, tap: the blob is posted as multipart and the text lands in the composer', async () => {
  fakePage();
  const { mountMic } = await import(MOD);
  const c = composer();
  const btn = mountMic({ form: c.form, input: c.input, errEl: c.errEl, stt: true });
  assert.ok(btn);
  assert.deepEqual(c.form.children, [btn, c.input]);  // beside the textarea, before it
  assert.equal(btn.textContent, '🎤');

  btn.onclick();
  await tick();
  assert.equal(recorders.length, 1);
  assert.equal(recorders[0].state, 'recording');
  assert.match(btn.textContent, /^● \d+s$/);          // the red dot and the seconds
  assert.match(btn.className, /\brec\b/);

  btn.onclick();                                       // he tapped again
  await tick(); await tick();
  assert.equal(recorders[0].state, 'inactive');
  assert.equal(tracksStopped, 1);                      // the microphone is let go of
  assert.equal(posted.length, 1);
  assert.equal(posted[0].url, '/api/stt/transcribe');
  assert.equal(posted[0].init.method, 'POST');
  const fd = posted[0].init.body;
  assert.ok(fd instanceof FormData);
  assert.equal(fd.get('language'), 'pt');
  assert.ok(fd.get('file'));
  assert.equal(fd.get('file').name, 'speech.webm');

  assert.equal(c.input.value, 'olá capitão');          // in the box, NOT sent
  assert.deepEqual(c.input.caret, [11, 11]);
  assert.equal(c.input.focused, 1);
  assert.equal(btn.textContent, '🎤');                 // and back to idle
  assert.equal(c.errEl.hidden, true);
});

test('the transcript is appended to what he already typed, space-separated', async () => {
  fakePage();
  const { mountMic } = await import(MOD);
  const c = composer();
  c.input.value = 'ada,';
  const btn = mountMic({ form: c.form, input: c.input, errEl: c.errEl, stt: true });
  btn.onclick(); await tick();
  btn.onclick(); await tick(); await tick();
  assert.equal(c.input.value, 'ada, olá capitão');
});

test('Escape discards the take: nothing posted, the microphone closed', async () => {
  fakePage();
  const { mountMic } = await import(MOD);
  const c = composer();
  const btn = mountMic({ form: c.form, input: c.input, errEl: c.errEl, stt: true });
  btn.onclick(); await tick();
  escape();
  await tick(); await tick();
  assert.equal(posted.length, 0);
  assert.equal(c.input.value, '');
  assert.equal(tracksStopped, 1);
  assert.equal(btn.textContent, '🎤');
});

test('a refused microphone is one line under the composer, gone on the next keystroke', async () => {
  fakePage();
  gum = async () => { throw new Error('Permission denied'); };
  const { mountMic } = await import(MOD);
  const c = composer();
  const btn = mountMic({ form: c.form, input: c.input, errEl: c.errEl, stt: true });
  btn.onclick();
  await tick();
  assert.equal(c.errEl.hidden, false);
  assert.match(c.errEl.textContent, /no microphone: Permission denied/);
  assert.equal(btn.textContent, '🎤');
  assert.equal(posted.length, 0);

  c.input.dispatchEvent({ type: 'input' });
  assert.equal(c.errEl.hidden, true);
  assert.equal(c.errEl.textContent, '');
});

test('an engine that is down says so and leaves the composer alone', async () => {
  fakePage();
  global.fetch = async () => ({ ok: false, status: 502, json: async () => ({}) });
  const { mountMic } = await import(MOD);
  const c = composer();
  const btn = mountMic({ form: c.form, input: c.input, errEl: c.errEl, stt: true });
  btn.onclick(); await tick();
  btn.onclick(); await tick(); await tick();
  assert.equal(c.input.value, '');
  assert.equal(c.errEl.hidden, false);
  assert.match(c.errEl.textContent, /transcription failed: HTTP 502/);
  assert.equal(btn.textContent, '🎤');
});
