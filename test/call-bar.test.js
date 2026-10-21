'use strict';
// The call outlives the board's navigation (MNC-299). call.js binds the DOM at
// import, so — as in hooks-column.test.js — what is pinned here is read off the
// source: no screen, tab or pane switch can reach endCall; the only things
// that end a call are the ones that ended it before; the bar carries the
// controls; and Send ends the utterance through the VAD rather than waiting.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const ui = (...p) => path.join(__dirname, '..', 'ui', ...p);
const read = (...p) => fs.readFileSync(ui(...p), 'utf8');
const call = read('js', 'call.js');
const css = read('app.css');

test('switching screens never ends the call: nothing outside call.js can hang up', () => {
  for (const f of fs.readdirSync(ui('js')).filter((f) => f.endsWith('.js') && f !== 'call.js')) {
    const src = read('js', f);
    assert.ok(!/\bendCall\b/.test(src), f + ' must not end the call');
  }
  // main.js only feeds it board payloads; chat.js only mounts the 📞
  assert.match(read('js', 'main.js'), /import \{ callBoard \} from '\.\/call\.js'/);
});

test('a call ends by hang-up, the lieutenant gone, a long absence or the page unloading — nothing else', () => {
  const reasons = [...call.matchAll(/endCall\('(\w+)'\)/g)].map((m) => m[1]);
  assert.deepStrictEqual([...new Set(reasons)].sort(), ['away', 'gone', 'hangup']);
  // the view going away is not one of them: minimize only swaps the faces
  const min = call.slice(call.indexOf('function minimize('), call.indexOf('function placeBar('));
  assert.ok(min.length > 0, 'minimize() exists');
  assert.ok(!/endCall|player\.stop|getTracks|ctx\.close|offActivity/.test(min), 'minimize touches no audio: ' + min);
});

test('the bar: who, the state, Send, mute, hang up and the way back', () => {
  const bar = call.slice(call.indexOf('function buildBar('), call.indexOf('function minimize('));
  for (const cls of ['cb-open', 'cb-name', 'cb-label', 'cb-send', 'cb-mute', 'cb-hangup']) {
    assert.ok(bar.includes(cls), 'bar has .' + cls);
  }
  // in the page's column before #layout: it pushes the composer, never covers it
  assert.match(bar, /insertBefore\(b, layout\)/);
  assert.match(css, /\.call-bar \{\s*flex: none;/);
  assert.ok(!/\.call-bar \{[^}]*position: (fixed|absolute)/.test(css), 'not floating over anything');
  assert.match(css, /body\.call-minimized #detail \{ top: var\(--callbar-bottom/, 'card detail starts under it');
  // the same handlers drive both faces
  assert.match(call, /c\.view\.send\.onclick = bar\.send\.onclick/);
  assert.match(call, /c\.view\.mute\.onclick = bar\.mute\.onclick/);
  assert.match(call, /c\.view\.hangup\.onclick = bar\.hangup\.onclick/);
});

test('Send ends the utterance now through the VAD, in both end modes', () => {
  const send = call.slice(call.indexOf('function sendTurn('), call.indexOf('function flushTurn('));
  assert.match(send, /c\.vad\.flush\(performance\.now\(\)\)/);
  assert.match(send, /onVad\(c, ev\)/);
  assert.ok(!/c\.mode !== 'keyword'/.test(send), 'silence mode has Send too');
  assert.match(call, /c\.view\.send\.hidden = false/);
  // silence is the fallback, longer now that Send is the end of turn
  assert.match(call, /: \{ hangMs: SILENCE_HANG_MS \}/);
});
