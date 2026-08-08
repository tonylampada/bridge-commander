'use strict';
// The settings screen: labels left the gear dropdown for a board-region mode of
// their own, beside the chat. Two things are pinned here — where the markup
// lives (ui/index.html), and the rule that decides which modes are remembered
// (setBoardMode in ui/js/main.js). main.js binds DOM at import, so the function
// is lifted out of the source and run against stubs, same spirit as
// av-dispatch.test.js.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const ui = (...p) => path.join(__dirname, '..', 'ui', ...p);
const html = fs.readFileSync(ui('index.html'), 'utf8');
const mainSrc = fs.readFileSync(ui('js', 'main.js'), 'utf8');

// the element with this id, from its opening tag to its matching close
function element(id) {
  const at = html.indexOf('id="' + id + '"');
  assert.ok(at > -1, '#' + id + ' is in index.html');
  const start = html.lastIndexOf('<', at);
  const tag = /^<(\w+)/.exec(html.slice(start))[1];
  const re = new RegExp('</?' + tag + '\\b', 'g');
  re.lastIndex = start;
  let depth = 0, m;
  while ((m = re.exec(html))) {
    depth += m[0][1] === '/' ? -1 : 1;
    if (depth === 0) return html.slice(start, m.index + m[0].length);
  }
  assert.fail('#' + id + ' is never closed');
}

test('the label manager markup lives in the workspace screen, not the gear panel', () => {
  const panel = element('settings-panel');
  assert.ok(!panel.includes('id="lm-list"'), 'the gear dropdown no longer holds the label list');
  assert.ok(!panel.includes('id="lm-new"'), 'nor the new-label form');
  assert.ok(panel.includes('id="workspace-open"'), 'it holds the row that opens the screen instead');
  assert.ok(!panel.includes('id="labels-open"'), 'and the row is no longer called labels');

  const screen = element('settings-screen');
  assert.ok(screen.includes('id="lm-list"'), 'the screen owns the label list');
  assert.ok(screen.includes('id="lm-new"'), 'and the new-label form');
  // the screen is a board-region mode: it sits inside the board section
  assert.ok(element('board-wrap').includes('id="settings-screen"'));
});

// The gear row is THIS BROWSER's list; the screen it opens is the WORKSPACE —
// the board everyone shares. The row said "labels" while the screen held one
// section; it holds two now, so the row names the screen instead of its first
// section, and the screen says what it is.
test('the workspace row and heading name the workspace, and playbooks are a section of it', () => {
  const panel = element('settings-panel');
  assert.match(panel, /<button id="workspace-open"[^>]*>🗂 workspace<\/button>/);
  const screen = element('settings-screen');
  assert.match(screen, /class="ss-head">workspace</, 'the screen is headed workspace');
  assert.ok(screen.includes('id="ss-playbooks"'), 'the screen has a playbooks section');
  assert.ok(screen.includes('id="pb-list"'), 'with the list the section renders into');
  assert.ok(screen.includes('id="ss-labels"'), 'and the labels section is still there');
  assert.match(element('ss-labels'), /class="ss-title">labels</, 'keeping its own section title');
  assert.match(element('ss-playbooks'), /class="ss-title">playbooks</);
});

test('the workspace row hands off to the screen the way monitoring hands off to the monitor', () => {
  assert.match(mainSrc, /getElementById\('workspace-open'\)\.onclick[\s\S]*?setBoardMode\('settings'\)/);
  assert.match(mainSrc, /getElementById\('workspace-open'\)\.onclick[\s\S]*?spEl\.hidden = true/);
  // …and re-reads the playbooks off disk on the way in
  assert.match(mainSrc, /getElementById\('workspace-open'\)\.onclick[\s\S]*?renderPlaybooks\(true\)/);
});

// The one rule that keeps this from becoming a second editor: the playbooks
// section opens files through the artifact routes and the file screen, the same
// pair a card artifact opens through.
test('the playbooks section reuses the file screen and the artifact routes', () => {
  const pb = fs.readFileSync(ui('js', 'pbmanager.js'), 'utf8');
  assert.match(pb, /import \{ openArtifactFile \} from '\.\/detail\.js'/);
  assert.match(pb, /api\.saveArtifact\(/, 'copy to workspace goes through the guarded write');
  assert.ok(!/mountFileEditor|CodeMirror/.test(pb), 'and never mounts an editor of its own');
  const detail = fs.readFileSync(ui('js', 'detail.js'), 'utf8');
  assert.match(detail, /export async function openArtifactFile/);
});

// setBoardMode, lifted with MODE_BTN and run against stubs
function loadSetBoardMode() {
  const start = mainSrc.indexOf('const MODE_BTN');
  const fnAt = mainSrc.indexOf('function setBoardMode', start);
  const end = mainSrc.indexOf('\n}\n', fnAt) + 3;
  assert.ok(start > -1 && fnAt > start && end > fnAt, 'setBoardMode found in main.js');
  const stored = [];
  const forgotten = [];
  const localStorage = { setItem: (k, v) => stored.push([k, v]) };
  const document = { getElementById: () => ({ classList: { toggle() {} } }) };
  const S = {};
  const make = new Function('document', 'localStorage', 'S', 'forgetFile', 'render',
    mainSrc.slice(start, end) + '\nreturn setBoardMode;');
  return { S, stored, forgotten, setBoardMode: make(document, localStorage, S, () => forgotten.push(1), () => {}) };
}

test('the switcher modes are remembered; the screens are not', () => {
  const { S, stored, setBoardMode } = loadSetBoardMode();
  for (const mode of ['board', 'table', 'archive']) {
    setBoardMode(mode);
    assert.strictEqual(S.boardMode, mode);
    assert.deepStrictEqual(stored[stored.length - 1], ['bc-board-mode', mode], mode + ' sticks');
  }
  const before = stored.length;
  for (const mode of ['file', 'settings']) {
    setBoardMode(mode);
    assert.strictEqual(S.boardMode, mode, mode + ' is a real mode, not coerced to board');
    assert.strictEqual(stored.length, before, mode + ' is never written to localStorage');
  }
});

test('entering the settings screen leaves the file screen', () => {
  const { forgotten, setBoardMode } = loadSetBoardMode();
  setBoardMode('file');
  const before = forgotten.length;
  setBoardMode('settings');
  assert.strictEqual(forgotten.length, before + 1, 'forgetFile() ran');
});

test('an unknown mode still falls back to the kanban', () => {
  const { S, setBoardMode } = loadSetBoardMode();
  setBoardMode('nonsense');
  assert.strictEqual(S.boardMode, 'board');
});
