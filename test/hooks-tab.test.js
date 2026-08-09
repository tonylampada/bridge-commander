'use strict';
// The config screen's hooks tab — one dense row per hook, the way the
// lieutenants tab is one row per lieutenant:
//
//   gh-watch          ran 4m ago · exit 0        ▶ ✎
//   teardown-devcont  worker-done · ran 2h · 0   ▶ ✎
//
// hkmanager.js binds DOM at import, so the parts that decide what a row SAYS
// are lifted out of the source and run against stubs — the same spirit as
// settings-screen.test.js. What is pinned here: the markup lives in
// index.html, a row is one line at a phone width, the row says how the last run
// ended, and ▶/✎ reuse the two doors that already exist rather than growing a
// hook API of their own.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const ui = (...p) => path.join(__dirname, '..', 'ui', ...p);
const html = fs.readFileSync(ui('index.html'), 'utf8');
const css = fs.readFileSync(ui('app.css'), 'utf8');
const src = fs.readFileSync(ui('js', 'hkmanager.js'), 'utf8');

test('the hooks section is a section of the config screen, with the list it paints into', () => {
  assert.ok(html.includes('data-tab="hooks"'), 'a tab for it');
  assert.ok(html.includes('id="ss-hooks"'), 'and the section it names');
  assert.ok(html.includes('data-sec="hooks"'));
  assert.ok(html.includes('id="hk-list"'), 'the list');
  assert.ok(html.includes('id="hk-dir"'), 'and the directory it reads, said once');
  // A press's only answer must outlive the next board event: paint() clears the
  // list on every repaint, so the note cannot live inside it.
  assert.ok(html.includes('id="hk-note"'), 'the note the ▶ and the ✎ answer in');
  assert.ok(html.indexOf('id="hk-note"') > html.indexOf('id="hk-list"'), 'outside the list, after it');
  assert.ok(!/listEl\.appendChild\(el\)|listEl\.textContent = '⚠ cannot open/.test(src),
    'and neither a run outcome nor a failed open is written into the list');
  // the tab is last — the four that were there keep their order
  const tabs = [...html.matchAll(/data-tab="([^"]+)"/g)].map((m) => m[1]);
  assert.deepStrictEqual(tabs, ['labels', 'playbooks', 'projects', 'lieutenants', 'hooks']);
});

test('a row is ONE line at a phone width: the name ellipses, the facts run stays whole', () => {
  assert.match(css, /\.hk-row \{[^}]*display: flex/);
  assert.match(css, /\.hk-name \{[^}]*text-overflow: ellipsis/, 'the name is what gives way');
  assert.match(css, /\.hk-name \{[^}]*white-space: nowrap/);
  assert.match(css, /\.hk-facts \{[^}]*white-space: nowrap/, 'the facts never wrap');
  assert.match(css, /\.hk-facts \{[^}]*flex: 1 0 auto/, 'nor get clipped in half');
  assert.match(css, /\.hk-acts \{[^}]*margin-left: auto/, 'the actions sit at the right end');
});

// The two functions that decide what a row says, lifted and run against records
// shaped like GET /api/hooks answers.
function loadRowText() {
  const at = src.indexOf('function outcome');
  const end = src.indexOf('\nfunction actions');
  assert.ok(at > -1 && end > at, 'outcome + facts found in hkmanager.js');
  const el = () => {
    const parts = [];
    return { parts, className: '', title: '', textContent: '',
      append: (...xs) => parts.push(...xs), toString() { return parts.join(''); } };
  };
  const document = { createElement: () => {
    const e = el();
    Object.defineProperty(e, 'text', { get() {
      return e.parts.map((p) => (typeof p === 'string' ? p : p.textContent)).join('');
    } });
    return e;
  } };
  const make = new Function('document', 'ago', src.slice(at, end)
    + '\nreturn { outcome, facts };');
  return make(document, (iso) => (iso === 'NOW' ? 'now' : iso));
}

test('a row says how the last run ended — and a hook that never ran says so', () => {
  const { outcome } = loadRowText();
  assert.strictEqual(outcome(null), 'never ran');
  assert.strictEqual(outcome({ started: '4m', code: 0 }), 'ran 4m ago · exit 0');
  assert.strictEqual(outcome({ started: '2h', code: 3 }), 'ran 2h ago · exit 3');
  assert.strictEqual(outcome({ started: '1d', timedOut: true }), 'ran 1d ago · timed out');
  assert.strictEqual(outcome({ started: '1d', error: 'ENOENT' }), 'ran 1d ago · never started');
  assert.strictEqual(outcome({ started: 'NOW', code: 0 }), 'ran just now · exit 0', 'never "now ago"');
});

test('a lifecycle hook leads with the event that owns it; a named one shows nothing there', () => {
  const { facts } = loadRowText();
  assert.strictEqual(facts({ name: 'sweep.sh', event: 'worker-done', last: { started: '2h', code: 0 } }).text,
    'worker-done · ran 2h ago · exit 0');
  assert.strictEqual(facts({ name: 'gh-watch', event: '', last: { started: '4m', code: 0 } }).text,
    'ran 4m ago · exit 0');
  assert.strictEqual(facts({ name: 'gh-watch', event: '', last: null, running: { hook: 'gh-watch' } }).text,
    'running now');
});

test('the outcome wears a colour, so a red hook is what the eye lands on', () => {
  assert.match(src, /h\.last\.ok \? 'hk-ok' : 'hk-bad'/);
  assert.match(css, /\.hk-bad \{ color: var\(--danger\); \}/);
});

// The one rule that keeps this from becoming a second editor and a second
// runner: ✎ goes through the artifact routes and the file screen, ▶ posts to
// the same door `bc-axi hook run` posts to.
test('▶ and ✎ reuse the doors that exist — no hook API of their own', () => {
  assert.match(src, /import \{ openArtifactFile \} from '\.\/detail\.js'/);
  assert.ok(!/mountFileEditor|CodeMirror/.test(src), 'and it never mounts an editor of its own');
  assert.match(src, /api\.runHook\(/);
  const api = fs.readFileSync(ui('js', 'api.js'), 'utf8');
  assert.match(api, /runHook: \(name\) => j\('POST', '\/api\/hooks\/run', \{ name, trigger: 'board' \}\)/,
    'the board run is traced as a board run');
  assert.match(api, /hooks: \(\) => j\('GET', '\/api\/hooks'\)/);
});

test('the section is wired into the screen the way every other one is', () => {
  const main = fs.readFileSync(ui('js', 'main.js'), 'utf8');
  assert.match(main, /import \{ renderHooks \} from '\.\/hkmanager\.js'/);
  assert.match(main, /hooks: renderHooks/, 'one WS_RENDER entry, nothing else');
  assert.match(src, /export async function renderHooks\(reload\)/);
});

// The tab's only nudge is the board event that already arrives. A hook run from
// the CLI, or a lifecycle hook firing, is exactly what a row must not go on
// lying about — so every render asks, and the press that is still in flight
// survives the repaint that answer causes.
test('every render asks the server, and an in-flight ▶ outlives the repaint', () => {
  assert.ok(!/if \(items\) return paint\(\)/.test(src), 'a list read last time is not the answer');
  assert.match(src, /const running = new Set\(\)/, 'the press is state, not a mutated button');
  assert.match(src, /const busy = running\.has\(h\.name\)/, 'and paint() is what draws it');
  // Keyed PER NAME, because the server's lock is per workspace + name: a tab
  // stricter than the thing it drives owes an argument for being stricter, and
  // there is none. Two hooks running at once is what the server permits.
  assert.match(src, /running\.add\(h\.name\)/);
  assert.match(src, /running\.delete\(h\.name\)/);
  assert.ok(!/if \(running\) return/.test(src), 'one hook in flight never blocks another row');
  assert.ok(!/btn\.disabled|btn\.textContent/.test(src),
    'nothing writes to a button a repaint may already have thrown away');
  assert.ok(!/setInterval|setTimeout/.test(src), 'no polling — the board events are the nudge');
});
