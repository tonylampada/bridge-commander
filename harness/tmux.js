'use strict';
// tmux primitives for harness implementations.
//
// Ported from firstmate's battle-tested bin/fm-tmux-lib.sh (ideas, not code):
//  - ghost-text stripping: TUI harnesses render dim/faint (SGR 2) predicted-prompt
//    "ghost" text inside an otherwise-empty composer; a plain capture cannot tell
//    it from typed input, so the composer line is captured WITH ANSI styling and
//    dim runs are dropped before classification.
//  - composer state: classify the cursor line as empty | pending | unknown after
//    stripping ghost text, box-drawing borders, prompt glyphs, and busy footers.
//  - verified submit: type text ONCE, then send Enter and retry Enter ONLY
//    (never retype — a swallowed Enter leaves the text in the composer and a
//    retype would duplicate it) until the composer reads empty.
//
// Zero dependencies; child_process + tmux only.
//
// Everything here is async: these primitives run inside the bridge-command
// server, whose event loop must never block on a subprocess (a sync tmux
// call per session per supervision tick froze the whole server — UI, SSE,
// every request — for the duration).

const { execFile } = require('node:child_process');

const BUSY_RE = /esc (to )?interrupt|Working\.\.\./i;
// '›' (U+203A) is codex's composer prompt; without it a cleared codex composer
// would classify as pending and verified-submit would read every send as stuck.
const PROMPT_GLYPHS = new Set(['>', '❯' /* ❯ */, '›' /* U+203A, codex */, '$', '%', '#']);

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

// tmuxRun(args, input?) -> Promise<stdout>; rejects on tmux error. input, when
// given, is piped to stdin (load-buffer); otherwise stdin is closed immediately.
function tmuxRun(args, input) {
  return new Promise((resolve, reject) => {
    const child = execFile('tmux', args, { encoding: 'utf8' }, (err, stdout, stderr) => {
      if (err) {
        err.stderr = stderr;
        reject(err);
      } else {
        resolve(stdout);
      }
    });
    child.stdin.on('error', () => {}); // EPIPE when tmux exits before reading
    if (input === undefined) child.stdin.end();
    else child.stdin.end(input);
  });
}

// tmux(...args) -> Promise<stdout string>; rejects on tmux error.
function tmux(...args) {
  return tmuxRun(args);
}

// tryTmux(...args) -> Promise<stdout string or null on error>.
async function tryTmux(...args) {
  try {
    return await tmuxRun(args);
  } catch {
    return null;
  }
}

// stripGhost(line) — remove dim/faint (SGR 2) styled runs from one styled
// capture line, drop all remaining escape sequences, return plain text.
// A reset (SGR 0) or normal-intensity (SGR 22) ends a dim run; codes are
// processed left-to-right so "ESC[0;2m" (reset then dim) reads as dim.
// 38/48/58 extended-color payloads are skipped so their "2" (RGB mode)
// never reads as the dim code.
function stripGhost(line) {
  let out = '';
  let dim = false;
  let i = 0;
  const n = line.length;
  while (i < n) {
    const c = line[i];
    if (c === '\x1b') {
      if (line[i + 1] === '[') {
        let j = i + 2;
        let params = '';
        while (j < n && !/[@-~]/.test(line[j])) {
          params += line[j];
          j++;
        }
        if (j < n && line[j] === 'm') {
          const parts = (params === '' ? '0' : params).split(';');
          for (let p = 0; p < parts.length; p++) {
            const v = parts[p];
            const code = (v.split(':')[0] || '0');
            if (code === '38' || code === '48' || code === '58') {
              if (v.includes(':')) continue; // colon form: payload self-contained
              const mode = parts[p + 1] || '';
              if (mode.includes(':')) p += 1;
              else if (mode.split(':')[0] === '5') p += 2;
              else if (mode.split(':')[0] === '2') p += 4;
              else p += 1;
            } else if (code === '2') dim = true;
            else if (code === '0' || code === '22') dim = false;
          }
        }
        i = j < n ? j + 1 : n;
        continue;
      }
      i++; // lone ESC: drop it
      continue;
    }
    if (!dim) out += c;
    i++;
  }
  return out;
}

// classifyComposerLine(raw) -> 'empty' | 'pending' — the pure half of
// composerState: classify one styled cursor-line capture after stripping
// ghost text, box borders, prompt glyphs, and busy footers.
function classifyComposerLine(raw) {
  let s = stripGhost(raw.replace(/\n$/, ''));
  // Strip composer box borders (claude/codex draw "│ … │"; some TUIs use ┃ or |).
  s = s.replace(/[│┃|]/g, '').trim();
  if (s === '') return 'empty';
  if (PROMPT_GLYPHS.has(s)) return 'empty';
  if (BUSY_RE.test(s)) return 'empty'; // busy footer landing on the cursor line
  return 'pending';
}

// composerState(target) -> 'empty' | 'pending' | 'unknown'
//   empty   — no pending input (blank, bare prompt glyph, busy footer, or only
//             ghost text). Safe to inject; also the positive ack that a submit landed.
//   pending — real unsubmitted text on the cursor line.
//   unknown — the pane could not be read.
async function composerState(target) {
  const cy = await tryTmux('display-message', '-p', '-t', target, '#{cursor_y}');
  if (cy === null || !/^\d+$/.test(cy.trim())) return 'unknown';
  const row = cy.trim();
  const raw = await tryTmux('capture-pane', '-e', '-p', '-t', target, '-S', row, '-E', row);
  if (raw === null) return 'unknown';
  return classifyComposerLine(raw);
}

// paneIsBusy(target) — do the last few non-blank lines of the pane show a
// busy footer (agent mid-turn)?
async function paneIsBusy(target) {
  const tail = await tryTmux('capture-pane', '-p', '-t', target, '-S', '-40');
  if (tail === null) return false;
  const lines = tail.split('\n').filter((l) => l.trim() !== '').slice(-6);
  return BUSY_RE.test(lines.join('\n'));
}

// capture(target, lines) — bounded plain-text pane capture (default 60 lines).
async function capture(target, lines = 60) {
  const out = await tryTmux('capture-pane', '-p', '-t', target, '-S', `-${lines}`);
  return out === null ? '' : out;
}

// captureStyled(target, lines) — bounded pane capture WITH ANSI styling (-e
// keeps SGR colors/bold) and scrollback depth (-S -N): the raw material for
// pane frames (openPane / paneSnapshot). Unlike capture(), an unreadable pane
// returns null — callers must tell "pane gone" from "pane blank".
function captureStyled(target, lines = 200) {
  return tryTmux('capture-pane', '-e', '-p', '-t', target, '-S', `-${lines}`);
}

// sendLiteral(target, text) — put text into the composer WITHOUT submitting.
// Single-line text goes via `send-keys -l`. Multi-line text goes via a tmux
// buffer paste in bracketed-paste mode (-p) so embedded newlines land as part
// of the paste instead of acting as Enter presses that submit mid-text.
async function sendLiteral(target, text) {
  if (text.includes('\n')) {
    await tmuxRun(['load-buffer', '-b', 'bc-harness', '-'], text);
    await tmux('paste-buffer', '-p', '-d', '-b', 'bc-harness', '-t', target);
  } else {
    await tmux('send-keys', '-t', target, '-l', text);
  }
}

// sendKey(target, key) — one named tmux key ('Enter', 'Escape', 'C-c', ...).
function sendKey(target, key) {
  return tmux('send-keys', '-t', target, key);
}

// submit(target, text, opts) — type text once, then Enter with verification.
// Enter is retried (never the text) until the composer reads empty or retries
// run out. Returns the final verdict: 'empty' | 'pending' | 'unknown' | 'send-failed'.
//   opts.retries    Enter attempts (default 3)
//   opts.enterSleep ms after each Enter before re-checking (default 400)
//   opts.settle     ms between typing and the first Enter (default 300; slash
//                   commands get 1200 — completion popups swallow a fast Enter)
async function submit(target, text, opts = {}) {
  const retries = opts.retries ?? 3;
  const enterSleep = opts.enterSleep ?? 400;
  const settle = opts.settle ?? (text.startsWith('/') ? 1200 : 300);
  try {
    await sendLiteral(target, text);
  } catch {
    return 'send-failed';
  }
  await sleep(settle);
  for (let i = 0; i < retries; i++) {
    try {
      await sendKey(target, 'Enter');
    } catch {
      // fall through to state check
    }
    await sleep(enterSleep);
    const state = await composerState(target);
    if (state !== 'pending') return state; // 'empty' (landed) or 'unknown' (inconclusive)
  }
  return 'pending';
}

module.exports = {
  tmux,
  tryTmux,
  sleep,
  stripGhost,
  classifyComposerLine,
  composerState,
  paneIsBusy,
  capture,
  captureStyled,
  sendLiteral,
  sendKey,
  submit,
  BUSY_RE,
};
