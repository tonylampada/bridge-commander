'use strict';
// The fourth board mode (⚡): hooks and schedules left the config screen for a
// board-region mode of their own, beside the chat. Config is a place he visits
// twice a month; the clock and the scripts it fires are things he watches.
//
// The seam this pins is the switcher: a mode is a button in #view-seg, an entry
// in MODE_BTN, a label in the mobile dropdown, and a rule in the CSS that gives
// the region to its screen. Four places, and a mode missing from any one of them
// is a mode you can enter and not leave, or leave and not re-enter.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const ui = (...p) => path.join(__dirname, '..', 'ui', ...p);
const html = fs.readFileSync(ui('index.html'), 'utf8');
const css = fs.readFileSync(ui('app.css'), 'utf8');
const mainSrc = fs.readFileSync(ui('js', 'main.js'), 'utf8');
const autoSrc = fs.readFileSync(ui('js', 'automation.js'), 'utf8');

test('the ⚡ sits in the switcher beside ▦ ☰ 🧊', () => {
  const seg = /<span id="view-seg"[\s\S]*?<\/span>/.exec(html)[0];
  const ids = [...seg.matchAll(/<button id="(vs-[^"]+)"/g)].map((m) => m[1]);
  assert.deepStrictEqual(ids.slice(0, 4), ['vs-board', 'vs-table', 'vs-arch', 'vs-auto'], 'fourth, after the three');
  assert.match(seg, /id="vs-auto"[^>]*>⚡</, 'an icon that reads as automation at 16px');
  assert.match(seg, /id="vs-auto" title="hooks &amp; schedules"/, 'saying what it opens');
});

test('it is a switcher mode, so it is remembered and it is in the mobile dropdown', () => {
  assert.match(mainSrc, /const MODE_BTN = \{ board: 'vs-board', table: 'vs-table', archive: 'vs-arch', auto: 'vs-auto'[,}]/);
  // MODE_BTN is the whole rule for what localStorage keeps, so the entry above
  // is also what makes a reload come back here.
  assert.match(mainSrc, /if \(MODE_BTN\[mode\]\) try \{ localStorage\.setItem\('bc-board-mode', mode\)/);
  // the dropdown a phone's collapsed switcher opens is built from MODE_BTN's
  // keys, so the only thing a fourth mode owes it is a label
  assert.match(mainSrc, /const MODE_LABEL = \{[^}]*auto: '⚡ automation'/);
  assert.match(mainSrc, /for \(const m of Object\.keys\(MODE_BTN\)\)/, 'the dropdown never learns a mode by name');
});

test('the region goes to the ⚡ screen, and the board gets out of its way', () => {
  assert.ok(html.includes('id="auto-screen"'), 'the screen is in the markup');
  const wrap = html.slice(html.indexOf('<section id="board-wrap">'), html.indexOf('</main>'));
  assert.ok(wrap.includes('id="auto-screen"'), 'inside the board region, like every other mode');
  assert.match(mainSrc, /wrap\.classList\.toggle\('auto-mode', mode === 'auto'\)/);
  assert.match(css, /#table, #archive, #filepane, #settings-screen, #auto-screen \{ display: none; \}/);
  assert.match(css, /#board-wrap\.auto-mode #board/, 'the kanban stands down');
  assert.match(css, /#board-wrap\.auto-mode #auto-screen/, 'and the screen takes the region');
});

// A switcher mode's way out is the switcher itself (collapsed to a dropdown on a
// phone) — the same as ▦ ☰ 🧊, and unlike the file and config screens, which need
// a ⟵ because they are not in it.
test('the way out is the switcher, not a back button of its own', () => {
  const screen = html.slice(html.indexOf('id="auto-screen"'), html.indexOf('</main>'));
  assert.ok(!/fs-back|ss-back/.test(screen), 'no ⟵ — it is a switcher mode, not a screen');
  assert.match(mainSrc, /const SCREENS = \['file', 'settings'\];/, 'and it is not one of the screens');
});

// Entering is a fresh look at the clock, the same contract setWsTab gives a
// config section. Every render after that asks anyway — the board event is this
// screen's only nudge — so the flag is spent once and cleared.
test('entering asks for a fresh read, and only entering does', () => {
  assert.match(mainSrc, /if \(mode === 'auto' && S\.boardMode !== 'auto'\) enteringAuto = true;/);
  assert.match(mainSrc, /S\.boardMode === 'auto'\) \{ renderAutomation\(enteringAuto\); enteringAuto = false; \}/);
});

// One story: a schedule fires a hook. The schedules are read FIRST because a
// hook card says which schedules fire it, and it reads that off that answer.
test('the screen reads the clock before the scripts, and writes the one alarm line', () => {
  assert.match(autoSrc, /await renderSchedules\(reload\);\n  await renderHooks\(reload\);/);
  assert.match(autoSrc, /const bad = s\.bad \+ h\.bad;/);
  assert.match(autoSrc, /alarmEl\.hidden = !bad;/, 'silent when nothing is red');
  assert.match(css, /\.au-alarm \{[^}]*color: var\(--danger\)/, 'and loud when something is');
  assert.ok(html.includes('id="au-alarm"') && html.includes('id="au-counts"'));
});
