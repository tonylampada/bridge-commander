'use strict';
// The config screen (#settings-screen): labels left the gear dropdown for a
// board-region mode of their own, beside the chat — the gear is this browser's
// settings, that screen is the board's. Two things are pinned here — the markup
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

test('the label manager markup lives in the config screen, not the gear panel', () => {
  const panel = element('settings-panel');
  assert.ok(!panel.includes('id="lm-list"'), 'the gear dropdown no longer holds the label list');
  assert.ok(!panel.includes('id="lm-new"'), 'nor the new-label form');
  assert.ok(panel.includes('id="config-open"'), 'it holds the row that opens the screen instead');
  assert.ok(!panel.includes('id="labels-open"'), 'and the row is no longer called labels');

  const screen = element('settings-screen');
  assert.ok(screen.includes('id="lm-list"'), 'the screen owns the label list');
  assert.ok(screen.includes('id="lm-new"'), 'and the new-label form');
  // the screen is a board-region mode: it sits inside the board section
  assert.ok(element('board-wrap').includes('id="settings-screen"'));
});

// The gear row is THIS BROWSER's list; the screen it opens is the BOARD's own
// settings — what everyone on it shares. It is what the captain calls it, which
// is config: the same word on the row and on the heading, and the old
// "workspace" spelling survives nowhere, id included.
test('the gear row and the heading say config, and nothing still says workspace-open', () => {
  const panel = element('settings-panel');
  assert.match(panel, /<button id="config-open"[^>]*>🗂 config<\/button>/);
  const screen = element('settings-screen');
  assert.match(screen, /class="ss-head">config</, 'the screen is headed config');
  for (const [where, src] of [['index.html', html], ['main.js', mainSrc], ['app.css', fs.readFileSync(ui('app.css'), 'utf8')]]) {
    assert.ok(!src.includes('workspace-open'), where + ' carries no workspace-open');
  }
});

test('the playbooks section is a section of that screen', () => {
  const screen = element('settings-screen');
  assert.ok(screen.includes('id="ss-playbooks"'), 'the screen has a playbooks section');
  assert.ok(screen.includes('id="pb-list"'), 'with the list the section renders into');
  assert.ok(screen.includes('id="ss-labels"'), 'and the labels section is still there');
  assert.match(element('ss-labels'), /class="ss-title">labels</, 'keeping its own section title');
  assert.match(element('ss-playbooks'), /class="ss-title">playbooks</);
});

test('the config row hands off to the screen the way monitoring hands off to the monitor', () => {
  assert.match(mainSrc, /getElementById\('config-open'\)\.onclick[\s\S]*?setBoardMode\('settings'\)/);
  assert.match(mainSrc, /getElementById\('config-open'\)\.onclick[\s\S]*?spEl\.hidden = true/);
  // …landing on labels, every time: the tab is not remembered either
  assert.match(mainSrc, /getElementById\('config-open'\)\.onclick[\s\S]*?setWsTab\('labels'\)/);
});

// ---------- the tab strip ----------
// The sections stack no longer: one tab per section in the heading row, one
// section visible. The pairing is data-tab ⇄ data-sec, so a fourth section
// (lieutenants) is markup plus one WS_RENDER entry — the switching below never
// learns its name.
const SECTIONS = ['labels', 'playbooks', 'projects', 'lieutenants'];
test('the heading row carries a tab per section', () => {
  const screen = element('settings-screen');
  const tabs = element('ss-tabs');
  const tabNames = [...tabs.matchAll(/data-tab="([^"]+)"/g)].map((m) => m[1]);
  assert.deepStrictEqual(tabNames, SECTIONS, 'a button per section');
  const secNames = [...screen.matchAll(/data-sec="([^"]+)"/g)].map((m) => m[1]);
  assert.deepStrictEqual(secNames, tabNames, 'every tab names a section of the screen');
  // every section lives inside the screen, and labels is the one that starts up
  for (const s of SECTIONS) assert.ok(screen.includes('id="ss-' + s + '"'), s + ' is in the screen');
  assert.match(element('ss-labels'), /class="ss-sec on"/, 'labels is the section shown at rest');
  for (const s of SECTIONS.slice(1)) assert.match(element('ss-' + s), /class="ss-sec"/);
  // the active tab is marked the way the ▦☰🧊 switcher marks its mode: .on
  const css = fs.readFileSync(ui('app.css'), 'utf8');
  assert.match(css, /#view-seg button\.on, #ss-tabs button\.on/, 'the tabs reuse the switcher rule');
  assert.match(css, /\.ss-sec \{[^}]*display: none/, 'a section is hidden unless it is the active one');
  assert.match(css, /\.ss-sec\.on \{[^}]*display: flex/);
});

// setWsTab, lifted with WS_RENDER and run against stubs — same spirit as
// loadSetBoardMode below.
function loadSetWsTab() {
  const start = mainSrc.indexOf('const WS_RENDER');
  const fnAt = mainSrc.indexOf('function setWsTab', start);
  const end = mainSrc.indexOf('\n}\n', fnAt) + 3;
  assert.ok(start > -1 && fnAt > start && end > fnAt, 'setWsTab found in main.js');
  const secs = SECTIONS.map((sec) => ({ dataset: { sec }, on: false }));
  const tabs = SECTIONS.map((tab) => ({ dataset: { tab }, on: false }));
  for (const el of [...secs, ...tabs]) el.classList = { toggle: (c, v) => { el.on = v; } };
  const document = {
    querySelectorAll: (q) => (q.includes('data-sec') ? secs : tabs),
  };
  const painted = [];
  const stub = (name) => (reload) => painted.push([name, reload]);
  const make = new Function('document', 'renderLabelManager', 'renderPlaybooks', 'renderProjects',
    'renderLieutenants', mainSrc.slice(start, end) + '\nreturn { setWsTab, wsTab: () => wsTab };');
  const api = make(document, stub('labels'), stub('playbooks'), stub('projects'), stub('lieutenants'));
  return { secs, tabs, painted, ...api };
}

test('switching to a tab shows that section and hides every other one', () => {
  const only = (name) => SECTIONS.map((s) => s === name);
  for (const name of SECTIONS) {
    const { setWsTab, secs, tabs, wsTab } = loadSetWsTab();
    setWsTab(name);
    assert.strictEqual(wsTab(), name);
    assert.deepStrictEqual(secs.map((s) => s.on), only(name));
    assert.deepStrictEqual(tabs.map((t) => t.on), only(name));
  }
});

test('a section paints when its tab is shown, and only then', () => {
  const { setWsTab, painted } = loadSetWsTab();
  setWsTab('labels');
  assert.deepStrictEqual(painted, [['labels', true]], 'no playbooks fetch on the way into labels');
  setWsTab('playbooks');
  assert.deepStrictEqual(painted[1], ['playbooks', true], 'the fetch runs when the tab is shown');
  // …and the board-event render loop repaints only the active section
  assert.match(mainSrc, /S\.boardMode === 'settings'\) WS_RENDER\[wsTab\]\(\)/);
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

// ---------- the way out of a screen ----------
// On a phone the ▦☰🧊 switcher collapses to the active mode's button, and the
// screens have none — so a screen used to be a dead end you left by reloading.
// Two exits now, both answering one question: which switcher mode do we go back
// to? Lifted the same way setBoardMode is, with tapBoardTab along for the ride.
function loadScreenExits(remembered) {
  const start = mainSrc.indexOf('const MODE_BTN');
  const fnAt = mainSrc.indexOf('function tapBoardTab', start);
  const end = mainSrc.indexOf('\n}\n', fnAt) + 3;
  assert.ok(start > -1 && fnAt > start && end > fnAt, 'tapBoardTab found in main.js');
  const localStorage = { getItem: () => remembered, setItem() {} };
  const document = { getElementById: () => ({ classList: { toggle() {} } }) };
  const S = {};
  const renders = [];
  const make = new Function('document', 'localStorage', 'S', 'forgetFile', 'render',
    mainSrc.slice(start, end) + '\nreturn { setBoardMode, leaveScreen, tapBoardTab };');
  return { S, renders, ...make(document, localStorage, S, () => {}, () => renders.push(1)) };
}

test('the config heading row carries a back control', () => {
  const row = /<div class="ss-headrow">[\s\S]*?<\/div>/.exec(element('settings-screen'))[0];
  assert.match(row, /id="ss-back"/, 'the ⟵ is in the heading row');
  assert.ok(row.indexOf('id="ss-back"') < row.indexOf('class="ss-head"'), 'left of the title');
  assert.match(row, /id="ss-back"[^>]*>⟵</);
  assert.match(mainSrc, /getElementById\('ss-back'\)\.onclick = leaveScreen/);
});

test('the ⟵ leaves the screen for the remembered switcher mode', () => {
  for (const mode of ['table', 'archive', 'board']) {
    const { S, setBoardMode, leaveScreen } = loadScreenExits(mode);
    setBoardMode('settings');
    leaveScreen();
    assert.strictEqual(S.boardMode, mode);
  }
});

test('…and the kanban when nothing is remembered', () => {
  for (const remembered of [null, 'settings', 'file', 'nonsense']) {
    const { S, setBoardMode, leaveScreen } = loadScreenExits(remembered);
    setBoardMode('settings');
    leaveScreen();
    assert.strictEqual(S.boardMode, 'board', String(remembered) + ' is not a switcher mode');
  }
});

test('the mobile board tab is that same exit while a screen is up', () => {
  for (const screen of ['settings', 'file']) {
    const { S, setBoardMode, tapBoardTab } = loadScreenExits('table');
    setBoardMode(screen);
    S.view = 'chat';
    tapBoardTab();
    assert.strictEqual(S.view, 'board');
    assert.strictEqual(S.boardMode, 'table', 'tapping ▦ Board left ' + screen);
  }
});

test('…and does exactly what it always did while a switcher mode is up', () => {
  for (const mode of ['board', 'table', 'archive']) {
    const { S, renders, setBoardMode, tapBoardTab } = loadScreenExits('archive');
    setBoardMode(mode);
    S.view = 'chat';
    const before = renders.length;
    tapBoardTab();
    assert.strictEqual(S.view, 'board');
    assert.strictEqual(S.boardMode, mode, 'the mode is left alone');
    assert.strictEqual(renders.length, before + 1, 'one repaint, as before');
  }
});

// The panel that says what a playbook may contain: markup here, text on the
// server (server/playbooks.js), so there is only ever one copy of it.
test('the playbooks section holds the reference panel, and does not restate its text', () => {
  const sec = element('ss-playbooks');
  assert.ok(sec.includes('id="pb-ref"'), 'the reference panel sits in the playbooks section');
  assert.ok(sec.indexOf('id="pb-list"') < sec.indexOf('id="pb-ref"'), 'under the list');
  assert.ok(!/CARD_ID|keep_worktree/.test(html), 'the names live on the server, not in the markup');

  const pb = fs.readFileSync(ui('js', 'pbmanager.js'), 'utf8');
  assert.match(pb, /r\.reference/, 'the section renders what /api/playbooks sent');
  assert.ok(!/CARD_ID|keep_worktree/.test(pb), 'and holds no second copy of the list');
});

// The third section, added the way the second one said a third would be: markup,
// a tab, one WS_RENDER entry, and a module of its own. Showing only — the
// registry is written from a terminal, never from here.
test('projects are a section of the config screen, painted by their own module', () => {
  const sec = element('ss-projects');
  assert.match(sec, /class="ss-title">projects</);
  assert.ok(sec.includes('id="pj-list"'), 'with the list the section renders into');
  assert.match(mainSrc, /import \{ renderProjects \} from '\.\/projmanager\.js'/);
  assert.match(mainSrc, /const WS_RENDER = \{[^}]*projects: renderProjects/, 'one WS_RENDER entry');

  const pj = fs.readFileSync(ui('js', 'projmanager.js'), 'utf8');
  assert.match(pj, /api\.projects\(true\)/, 'the tab is what asks for the git reads');
  assert.ok(!/api\.addProject|POST|DELETE/.test(pj), 'and the section only ever shows');
  const apiSrc = fs.readFileSync(ui('js', 'api.js'), 'utf8');
  assert.match(apiSrc, /projects: \(git\) => j\('GET', '\/api\/projects' \+ \(git \? '\?git=1' : ''\)\)/);
});

// The fourth section, added exactly the way the third one said a fourth would
// be: markup, a tab, one WS_RENDER entry, a module of its own — and the
// tab-switching code untouched (asserted above, where SECTIONS drives it).
test('lieutenants are a section of the config screen, painted by their own module', () => {
  const sec = element('ss-lieutenants');
  assert.match(sec, /class="ss-title">lieutenants</);
  assert.ok(sec.includes('id="lt-list"'), 'with the list the section renders into');
  assert.match(mainSrc, /import \{ renderLieutenants \} from '\.\/ltmanager\.js'/);
  assert.match(mainSrc, /const WS_RENDER = \{[^}]*lieutenants: renderLieutenants/, 'one WS_RENDER entry');

  const lt = fs.readFileSync(ui('js', 'ltmanager.js'), 'utf8');
  assert.match(lt, /api\.lieutenants\(true\)/, 'the tab is what asks for the session probes');
  const apiSrc = fs.readFileSync(ui('js', 'api.js'), 'utf8');
  assert.match(apiSrc, /lieutenants: \(live\) => j\('GET', '\/api\/lieutenants' \+ \(live \? '\?live=1' : ''\)\)/);
});

// The two actions are the point: neither is new. ⚙ calls the switcher's own
// openLtSettings, ✎ goes through openArtifactFile — so there is no second form
// over the same four fields and no second editor. And retire is NOT here: the
// switcher's ⋯ menu is the one door onto it.
test('the lieutenant row reuses the settings modal and the file screen, and offers no retire', () => {
  const lt = fs.readFileSync(ui('js', 'ltmanager.js'), 'utf8');
  assert.match(lt, /import \{ openLtSettings \} from '\.\/ltswitcher\.js'/);
  assert.match(lt, /onclick[^\n]*openLtSettings\(l\.id\)|\(\) => openLtSettings\(l\.id\)/,
    'the ⚙ action calls the existing handler');
  assert.match(fs.readFileSync(ui('js', 'ltswitcher.js'), 'utf8'), /export function openLtSettings/);

  assert.match(lt, /import \{ openArtifactFile \} from '\.\/detail\.js'/);
  assert.ok(!/mountFileEditor|CodeMirror|ls-color|ls-grid|ls-voice/.test(lt),
    'and mounts neither an editor nor a second settings form');
  assert.ok(!/retire/i.test(lt), 'retiring stays in the switcher — one door onto the destructive verb');
});

// The facts the row exists for. Three of them are nowhere else in the UI: the
// next card id, the live-card count, and whether the session is up.
test('a lieutenant row reports the prefix, the next number, the cards and the session', () => {
  const lt = fs.readFileSync(ui('js', 'ltmanager.js'), 'utf8');
  assert.match(lt, /l\.next \+ ' · ' \+ countText\(l\.cards\) \+ ' · '/, 'the id the next card would carry');
  assert.match(lt, /countText = \(n\)/, 'the live-card count');
  assert.match(lt, /SESSION\[l\.session\]/, 'and the session state');
  for (const state of ['live', 'dead', 'none']) {
    assert.match(lt, new RegExp('\\n  ' + state + ': \\{'), state + ' is a state the row says out loud');
  }
});

// The tab is a list, not a form: the three facts are one run of text in one
// element — `WAL-4 · 14 cards · live` — not a label/value pair apiece. Eight
// rows fit a phone only because nothing here spells `mints` or `cards` out as
// a caption eight times over.
test('the three facts are one line, not a label/value pair per fact', () => {
  const lt = fs.readFileSync(ui('js', 'ltmanager.js'), 'utf8');
  assert.match(lt, /el\.className = 'lt-facts'/, 'one element carries the run');
  assert.ok(!/'lt-k'|'lt-v'|'lt-fact'|function fact\(/.test(lt), 'and no key/value pair survives');
  const css = fs.readFileSync(ui('app.css'), 'utf8');
  assert.ok(!/\.lt-k \{|\.lt-v \{|\.lt-fact \{|\.lt-head \{/.test(css), 'nor the rules that laid them out');
  // the density rule the playbooks list already has: rows a few px apart
  assert.match(css, /#lt-list \{[^}]*gap: 4px/, 'rows sit as close as playbook rows');
  assert.match(css, /\.lt-row \{[^}]*display: flex;[^}]*align-items: center/, 'and each row is one line');
  assert.ok(!/\.lt-row \{[^}]*flex-direction: column/.test(css), 'not a stack');
  // colour is the only thing the session keeps
  for (const [state, v] of [['live', 'ok'], ['dead', 'danger'], ['none', 'faint']]) {
    assert.match(css, new RegExp('\\.lt-' + state + ' \\{ color: var\\(--' + v + '\\)'), state + ' keeps its colour');
  }
});

// `1 card`, not `1 cards`, and not `14 live cards` either — the word `live`
// belongs to the section, said once, not to every row.
test('the card count reads 1 card and 14 cards', () => {
  const lt = fs.readFileSync(ui('js', 'ltmanager.js'), 'utf8');
  const src = /const countText = [^\n]+/.exec(lt);
  assert.ok(src, 'countText is a one-liner the test can lift');
  const countText = new Function(src[0] + '; return countText;')();
  assert.strictEqual(countText(1), '1 card');
  assert.strictEqual(countText(0), '0 cards');
  assert.strictEqual(countText(14), '14 cards');
});

// Icons, not full-width buttons — but the words they lose are still reachable,
// and they call exactly the handlers they called as words.
test('the two actions are icons carrying their words in a title', () => {
  const lt = fs.readFileSync(ui('js', 'ltmanager.js'), 'utf8');
  assert.match(lt, /action\('⚙', 'settings — [^']+', \(\) => openLtSettings\(l\.id\)\)/);
  assert.match(lt, /action\('✎', 'charter — ' \+ l\.memory, \(\) => openCharter\(l\)\)/);
  assert.match(lt, /b\.title = title/, 'the title is what carries the words');
  const css = fs.readFileSync(ui('app.css'), 'utf8');
  assert.match(css, /\.lt-acts \{[^}]*margin-left: auto/, 'and they sit at the right end of the row');
});
