'use strict';
// ui/js/callcore.js — what a call decides: what is said out loud, where a
// sentence ends, when he stopped talking, which state the call is in, and when
// a wait earns an "um momento…". It imports nothing and reads no clock, so every
// test here hands it the time.
const test = require('node:test');
const assert = require('node:assert');
const path = require('node:path');
const { pathToFileURL } = require('node:url');

const MOD = pathToFileURL(path.join(__dirname, '..', 'ui', 'js', 'callcore.js')).href;
let C;
test.before(async () => { C = await import(MOD); });

// ── the text cleaner ─────────────────────────────────────────────────────────

test('code, links, tables and paths become one pointer at the chat', () => {
  const out = C.cleanForCall([
    'Feito. O PR está em https://github.com/x/y/pull/12 e o diff abaixo:',
    '```js',
    'const a = 1;',
    '```',
    '| col | b |',
    '|-----|---|',
    '| 1   | 2 |',
    'Arquivo em /home/ai/repos/x/server.js.',
  ].join('\n'));
  assert.doesNotMatch(out, /https?:|```|\||const a/);
  assert.match(out, /link no chat/);
  assert.match(out, /código no chat/);
  assert.match(out, /tabela no chat/);
  assert.match(out, /caminho no chat/);
});

test('markdown gives up its marks and keeps its words', () => {
  const out = C.cleanForCall('## Resumo\n- **primeiro** item\n- segundo com `foo`\n> citação\nVeja [o card](http://x/y).');
  assert.strictEqual(out, 'Resumo.\nprimeiro item.\nsegundo com foo.\ncitação\nVeja o card.');
});

test('snake_case survives, emoji do not, a repeated pointer is said once', () => {
  assert.strictEqual(C.cleanForCall('use call_mode ✅ agora'), 'use call_mode agora');
  assert.strictEqual(C.cleanForCall('veja http://a.com e http://b.com'), 'veja link no chat');
});

test('an unclosed fence still says nothing of its code', () => {
  assert.strictEqual(C.cleanForCall('olha:\n```\nrm -rf x'), 'olha:\ncódigo no chat.');
});

// ── the sentence splitter ────────────────────────────────────────────────────

test('splits on sentence ends and newlines', () => {
  assert.deepStrictEqual(
    C.splitSentences('O build passou. Os testes também! Quer que eu abra o PR?\nPosso fazer agora.'),
    ['O build passou.', 'Os testes também!', 'Quer que eu abra o PR?', 'Posso fazer agora.']);
});

test('numbers, versions and abbreviations are not ends', () => {
  assert.deepStrictEqual(
    C.splitSentences('Subiu para a versão 1.5 hoje cedo. O Sr. Silva aprovou, etc. e tal.'),
    ['Subiu para a versão 1.5 hoje cedo.', 'O Sr. Silva aprovou, etc. e tal.']);
});

test('a short fragment rides with its neighbour', () => {
  assert.deepStrictEqual(C.splitSentences('Sim. O deploy terminou sem erros.'), ['Sim. O deploy terminou sem erros.']);
  assert.deepStrictEqual(C.splitSentences('O deploy terminou sem erros. Ok.'), ['O deploy terminou sem erros. Ok.']);
});

test('a run of marks ends together', () => {
  assert.deepStrictEqual(C.splitSentences('Sério?! Não acredito... Vamos ver então.'),
    ['Sério?! Não acredito...', 'Vamos ver então.']);
});

test('a long sentence is cut at a comma before max', () => {
  const long = 'Primeiro eu olhei o servidor inteiro, depois os logs da última hora, e por fim o cliente no telefone do capitão sem pressa nenhuma';
  const parts = C.splitSentences(long, { max: 60 });
  assert.ok(parts.length >= 2);
  for (const p of parts) assert.ok(p.length <= 60, p);
  assert.strictEqual(parts.join(' '), long);
  assert.match(parts[0], /,$/);
});

test('nothing in, nothing out', () => {
  assert.deepStrictEqual(C.splitSentences(''), []);
  assert.deepStrictEqual(C.splitSentences('   \n '), []);
});

// ── the VAD ──────────────────────────────────────────────────────────────────
// Feed it a script of [db, ms] stretches at 20ms frames; collect the events.
function drive(vad, script, t0 = 0) {
  let t = t0;
  const evs = [];
  for (const [db, ms] of script) {
    for (let k = 0; k < ms; k += 20) {
      t += 20;
      const e = vad.frame(db, t);
      if (e) evs.push(Object.assign({ t }, e));
    }
  }
  return { evs, t };
}

test('an utterance starts after minSpeechMs and ends after hangMs of silence', () => {
  const vad = C.createVad({ hangMs: 800 });
  const { evs } = drive(vad, [[-70, 1000], [-25, 1200], [-70, 1200]]);
  assert.deepStrictEqual(evs.map((e) => e.type), ['start', 'end']);
  const [s, e] = evs;
  assert.ok(s.t - 1000 >= 120 && s.t - 1000 <= 160, 'start after ~120ms of voice: ' + (s.t - 1000));
  assert.strictEqual(e.lastVoice, 2200);
  assert.ok(e.t - e.lastVoice >= 800 && e.t - e.lastVoice < 820);
});

test('a pause shorter than hangMs stays inside the utterance', () => {
  const vad = C.createVad({ hangMs: 800 });
  const { evs } = drive(vad, [[-70, 600], [-25, 600], [-70, 500], [-25, 600], [-70, 1000]]);
  assert.deepStrictEqual(evs.map((e) => e.type), ['start', 'end']);
});

test('a click is dropped, not sent', () => {
  const vad = C.createVad({ hangMs: 800, minUtteranceMs: 350 });
  const { evs } = drive(vad, [[-70, 600], [-25, 200], [-70, 1000]]);
  assert.deepStrictEqual(evs.map((e) => e.type), ['start', 'drop']);
});

test('the floor is calibrated from the first frames: a fan already running never triggers', () => {
  const vad = C.createVad();
  const { evs } = drive(vad, [[-45, 6000]]);
  assert.deepStrictEqual(evs, []);
  assert.ok(Math.abs(vad.floor - -45) < 1, 'floor is the fan: ' + vad.floor);
  // and his voice over the fan still does
  const him = drive(vad, [[-20, 600], [-45, 1000]], 6000).evs;
  assert.deepStrictEqual(him.map((e) => e.type), ['start', 'end']);
});

test('a fan switched on mid-call is learned within seconds, not held as one long utterance', () => {
  const vad = C.createVad();
  const { t } = drive(vad, [[-70, 1000]]);
  const { evs } = drive(vad, [[-50, 60000]], t);
  const starts = evs.filter((e) => e.type === 'start').length;
  assert.ok(starts <= 1, 'at most one false start: ' + starts);
  const quiet = drive(vad, [[-50, 5000]], t + 60000).evs;
  assert.deepStrictEqual(quiet.filter((e) => e.type === 'start'), []);
});

test('barge mode: the echo of the reply, or a passing noise, does not trigger; his sustained voice does', () => {
  const vad = C.createVad();
  drive(vad, [[-70, 1000]]);
  vad.setBarge(true);
  // speaker leak: moderately loud, bursty
  const echo = drive(vad, [[-42, 200], [-70, 60], [-42, 200], [-70, 60], [-40, 150]], 1000);
  assert.deepStrictEqual(echo.evs, []);
  // him, close to the mic, sustained
  const him = drive(vad, [[-22, 700]], echo.t);
  assert.strictEqual(him.evs[0].type, 'start');
  assert.ok(him.evs[0].t - echo.t >= C.VAD_DEFAULTS.bargeHoldMs, 'held for bargeHoldMs');
});

test('rmsDb', () => {
  assert.strictEqual(C.rmsDb(new Float32Array(10)), -100);
  assert.ok(Math.abs(C.rmsDb(new Float32Array(10).fill(0.1)) - -20) < 1e-5);
});

// ── the call state machine ───────────────────────────────────────────────────

function run(events, opts) {
  let s = 'idle';
  const seen = [s];
  for (const e of events) {
    const [ev, o] = Array.isArray(e) ? e : [e, opts];
    s = C.nextCallState(s, ev, o);
    seen.push(s);
  }
  return seen;
}

test('a whole turn: listening → capturing → sending → thinking → speaking → listening', () => {
  assert.deepStrictEqual(run(['start', 'speech', 'end', 'sent', 'reply', 'done']),
    ['idle', 'listening', 'capturing', 'sending', 'thinking', 'speaking', 'listening']);
});

test('barge-in: speech while speaking goes straight to capturing', () => {
  const s = run(['start', 'speech', 'end', 'sent', 'reply', 'speech']);
  assert.strictEqual(s[s.length - 1], 'capturing');
});

test('a dropped utterance lands back where the call was', () => {
  assert.strictEqual(C.nextCallState('capturing', 'drop', { awaiting: false }), 'listening');
  assert.strictEqual(C.nextCallState('capturing', 'drop', { awaiting: true }), 'thinking');
});

test('a reply that finishes while another answer is owed goes back to thinking', () => {
  assert.strictEqual(C.nextCallState('speaking', 'done', { awaiting: true }), 'thinking');
});

test('a reply arriving while he talks does not interrupt him', () => {
  assert.strictEqual(C.nextCallState('capturing', 'reply'), 'capturing');
});

test('a failed send goes back to listening', () => {
  assert.strictEqual(C.nextCallState('sending', 'failed'), 'listening');
});

test('hangup and hidden end the call from anywhere; ended is final', () => {
  for (const st of ['listening', 'capturing', 'sending', 'thinking', 'speaking']) {
    assert.strictEqual(C.nextCallState(st, 'hangup'), 'ended');
    assert.strictEqual(C.nextCallState(st, 'hidden'), 'ended');
  }
  assert.strictEqual(C.nextCallState('ended', 'start'), 'ended');
  assert.strictEqual(C.nextCallState('idle', 'hangup'), 'idle');
});

test('events that mean nothing leave the state alone', () => {
  assert.strictEqual(C.nextCallState('listening', 'done'), 'listening');
  assert.strictEqual(C.nextCallState('thinking', 'sent'), 'thinking');
  assert.strictEqual(C.nextCallState('idle', 'speech'), 'idle');
});

// ── the filler rules ─────────────────────────────────────────────────────────

test('a filler is due once, from delayMs after the send', () => {
  const f = C.createFillerPolicy({ delayMs: 3000 });
  assert.strictEqual(f.due(10000), false, 'no wait open');
  f.sent(1000);
  assert.strictEqual(f.due(3999), false);
  assert.strictEqual(f.due(4000), true);
  assert.strictEqual(f.due(5000), false, 'never twice per wait');
  f.sent(6000);
  assert.strictEqual(f.due(9000), true, 'a new wait earns a new one');
});

test('no filler when the answer lands first', () => {
  const f = C.createFillerPolicy({ delayMs: 3000 });
  f.sent(0);
  f.replied();
  assert.strictEqual(f.due(5000), false);
});

test('no filler after he speaks again (cancel)', () => {
  const f = C.createFillerPolicy({ delayMs: 3000 });
  f.sent(0);
  f.cancel();
  assert.strictEqual(f.due(5000), false);
});

test('the same filler never plays twice running', () => {
  let r = 0;
  const seq = [0, 0, 0.99, 0.5, 0, 0];
  const f = C.createFillerPolicy({ rand: () => seq[r++ % seq.length] });
  let prev = -1;
  for (let i = 0; i < 30; i++) {
    const p = f.pick(5);
    assert.ok(p >= 0 && p < 5);
    assert.notStrictEqual(p, prev);
    prev = p;
  }
  assert.strictEqual(f.pick(0), -1);
  assert.strictEqual(C.createFillerPolicy().pick(1), 0);
});

test('there are several phrases to vary between', () => {
  assert.ok(C.FILLER_PHRASES.length >= 3);
});

// ── the latency legs ─────────────────────────────────────────────────────────

test('turnLegs breaks a turn into VAD / STT / post / lieutenant / TTS', () => {
  const legs = C.turnLegs({ lastVoice: 1000, vadEnd: 1800, sttDone: 2300, posted: 2350, reply: 6000, firstAudio: 6700 });
  assert.deepStrictEqual(legs, { vad: 800, stt: 500, post: 50, lieutenant: 3650, tts: 700, ours: 2050 });
  assert.strictEqual(C.turnLegs({ lastVoice: 1 }).ours, null);
});

// ── the WAV ──────────────────────────────────────────────────────────────────

test('encodeWav16k: 48k floats → a 16k mono 16-bit WAV', () => {
  const a = new Float32Array(4800).fill(0.5), b = new Float32Array(4800).fill(-0.5);
  const wav = C.encodeWav16k([a, b], 48000);
  const v = new DataView(wav.buffer);
  assert.strictEqual(String.fromCharCode(...wav.slice(0, 4)), 'RIFF');
  assert.strictEqual(v.getUint32(24, true), 16000);
  assert.strictEqual(v.getUint32(40, true), 3200 * 2);   // 0.2s at 16k
  assert.strictEqual(wav.length, 44 + 6400);
  assert.ok(Math.abs(v.getInt16(44, true) - 16383) <= 1);
  assert.ok(Math.abs(v.getInt16(44 + 3199 * 2, true) + 16384) <= 1);
});

// ── phantoms and later replies ───────────────────────────────────────────────

test('a short take that comes back as a subtitle sign-off is noise', () => {
  assert.strictEqual(C.isPhantom('Obrigado.', 600), true);
  assert.strictEqual(C.isPhantom('Legendas pela comunidade Amara.org', 900), true);
  assert.strictEqual(C.isPhantom('', 3000), true);
  assert.strictEqual(C.isPhantom('Obrigado.', 2500), false, 'a long take is taken at its word');
  assert.strictEqual(C.isPhantom('obrigado, pode fazer o merge', 800), false);
});

test('the first reply is spoken whole; a long later one is announced', () => {
  const long = 'x'.repeat(400);
  assert.strictEqual(C.spokenReply(long, 0), long);
  assert.strictEqual(C.spokenReply('curto.', 1), 'curto.');
  assert.strictEqual(C.spokenReply(long, 1), 'Mandei mais detalhes no chat.');
  assert.strictEqual(C.spokenReply('', 0), '');
});

test('syllabic speech — short gaps between bursts — still counts as one run', () => {
  const vad = C.createVad();
  const { t } = drive(vad, [[-70, 1000]]);
  vad.setBarge(true);
  // the real "Espera, para" envelope: 100ms bursts with 40-80ms dips
  const him = drive(vad, [[-25, 100], [-60, 60], [-22, 180], [-60, 80], [-20, 400], [-70, 1000]], t);
  assert.strictEqual(him.evs[0].type, 'start');
  assert.strictEqual(him.evs[0].at, t, 'the run starts at the first burst');
  assert.ok(him.evs[0].t - t <= C.VAD_DEFAULTS.bargeHoldMs + 40, 'gaps did not reset the hold: ' + (him.evs[0].t - t));
});

test('bursts further apart than gapMs do not add up', () => {
  const vad = C.createVad();
  const { t } = drive(vad, [[-70, 1000]]);
  vad.setBarge(true);
  const echo = drive(vad, [[-25, 140], [-70, 200], [-25, 140], [-70, 200], [-25, 140], [-70, 400]], t);
  assert.deepStrictEqual(echo.evs, []);
});

// ── the keyword ──────────────────────────────────────────────────────────────

test('takeKeyword: the STT variants of "câmbio" all end the turn', () => {
  const kw = 'câmbio';
  for (const [inp, out] of [
    ['qual o status do deploy câmbio', 'qual o status do deploy'],
    ['Qual o status do deploy? Câmbio.', 'Qual o status do deploy?'],
    ['qual o status do deploy, cambio', 'qual o status do deploy'],
    ['qual o status câmbio, câmbio.', 'qual o status'],
    ['qual o status CÂMBIO!', 'qual o status'],
    ['qual o status cam bio', 'qual o status'],
    ['Câmbio.', ''],
  ]) {
    assert.deepStrictEqual(C.takeKeyword(inp, kw), { hit: true, text: out }, inp);
  }
});

test('takeKeyword: the keyword anywhere but the end does not end the turn', () => {
  assert.deepStrictEqual(C.takeKeyword('o câmbio do dólar subiu', 'câmbio'), { hit: false, text: 'o câmbio do dólar subiu' });
  assert.deepStrictEqual(C.takeKeyword('', 'câmbio'), { hit: false, text: '' });
  assert.strictEqual(C.takeKeyword('faz isso câmbio', '').hit, false);
});

test('takeKeyword: a multi-word keyword, and "cancela"', () => {
  assert.deepStrictEqual(C.takeKeyword('faz o deploy over and out', 'over and out'), { hit: true, text: 'faz o deploy' });
  assert.strictEqual(C.takeKeyword('não, cancela', 'cancela').hit, true);
  assert.strictEqual(C.takeKeyword('Cancela.', 'cancela').hit, true);
});

test('hasWords: noise transcribed as punctuation is not words', () => {
  assert.strictEqual(C.hasWords('...'), false);
  assert.strictEqual(C.hasWords('—'), false);
  assert.strictEqual(C.hasWords('espera'), true);
});

test('keyword mode: a chunk drops back, the keyword commits, a commit mid-speech waits', () => {
  assert.deepStrictEqual(run(['start', 'speech', 'drop', 'speech', 'drop', 'commit', 'sent', 'reply', 'done']),
    ['idle', 'listening', 'capturing', 'listening', 'capturing', 'listening', 'sending', 'thinking', 'speaking', 'listening']);
  assert.strictEqual(C.nextCallState('thinking', 'commit'), 'sending');
  assert.strictEqual(C.nextCallState('capturing', 'commit'), 'capturing');
  assert.strictEqual(C.nextCallState('sending', 'failed', { awaiting: true }), 'thinking');
});
