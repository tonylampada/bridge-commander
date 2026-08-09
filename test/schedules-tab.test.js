'use strict';
// The config screen's schedules tab — the clock MNC-25 shipped without a screen.
//
//   ▸ gh-watch  → gh-watch                              ⏸ ✕
//     every 5m · in 3m · fired 2m ago · exit 0 · tonylampada
//
// scmanager.js binds DOM at import, so the parts that decide what a row SAYS
// are lifted out of the source and run against stubs — the same spirit as
// hooks-tab.test.js. What is pinned here: the markup lives in index.html, the
// row speaks the CLI's own words, PAUSED is a state rather than a shade, a
// `problem` is shown in full and in red, the server's refusal survives verbatim,
// and nothing here grew an endpoint of its own.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const ui = (...p) => path.join(__dirname, '..', 'ui', ...p);
const html = fs.readFileSync(ui('index.html'), 'utf8');
const css = fs.readFileSync(ui('app.css'), 'utf8');
const src = fs.readFileSync(ui('js', 'scmanager.js'), 'utf8');
const apiSrc = fs.readFileSync(ui('js', 'api.js'), 'utf8');

test('the schedules section is a section of the config screen, beside hooks', () => {
  assert.ok(html.includes('data-tab="schedules"'), 'a tab for it');
  assert.ok(html.includes('id="ss-schedules"'), 'and the section it names');
  assert.ok(html.includes('data-sec="schedules"'));
  assert.ok(html.includes('id="sc-list"'), 'the list');
  // A press's only answer must outlive the next board event: paint() clears the
  // list on every repaint, so the note cannot live inside it.
  assert.ok(html.includes('id="sc-note"'), 'the note a press answers in');
  assert.ok(html.indexOf('id="sc-note"') > html.indexOf('id="sc-list"'), 'outside the list, after it');
  assert.ok(html.indexOf('data-tab="schedules"') > html.indexOf('data-tab="hooks"'),
    'the clock reads next to the hooks it fires');
});

// The two decisions a row makes, lifted and run against records shaped like
// GET /api/schedules answers.
function loadRowText() {
  const at = src.indexOf('function until');
  const end = src.indexOf('\nfunction problem');
  assert.ok(at > -1 && end > at, 'the wording helpers found in scmanager.js');
  const document = { createElement: () => {
    const parts = [];
    const e = { parts, className: '', title: '', textContent: '', append: (...xs) => parts.push(...xs) };
    Object.defineProperty(e, 'text', { get() {
      return e.parts.map((p) => (typeof p === 'string' ? p : p.textContent)).join('');
    } });
    return e;
  } };
  const make = new Function('document', src.slice(at, end)
    + '\nreturn { until, since, howRunEnded, fireOutcome, outcomeClass, facts };');
  return make(document);
}
const iso = (deltaSec) => new Date(Date.now() + deltaSec * 1000).toISOString();

test('next fire and last fire are relative, in the words the CLI prints', () => {
  const { until, since, fireOutcome } = loadRowText();
  assert.strictEqual(until(iso(180)), 'in 3m');
  assert.strictEqual(until(iso(2 * 3600)), 'in 2h');
  assert.strictEqual(until(iso(-5)), 'due now');
  assert.strictEqual(until(null), 'never', 'a `when` that no longer parses has no next fire');
  assert.strictEqual(since(iso(-120)), '2m ago');
  assert.strictEqual(since(iso(-5)), '5s ago', 'a past firing is never "now"');
  assert.strictEqual(fireOutcome(null), 'never fired', 'a schedule that never fired says so');
  assert.strictEqual(fireOutcome({ started: iso(-120), code: 0, ok: true }), 'fired 2m ago · exit 0');
  assert.strictEqual(fireOutcome({ started: iso(-3600), code: 3 }), 'fired 1h ago · exit 3');
  // A skip IS a firing — a schedule whose every window is skipped must not read
  // like one that is quietly working.
  assert.strictEqual(fireOutcome({ started: iso(-120), skipped: true }),
    'skipped 2m ago (previous firing still going)');
});

test('how a firing ended is said the one way the CLI says it', () => {
  const { howRunEnded } = loadRowText();
  assert.strictEqual(howRunEnded({ code: 0 }), 'exit 0');
  assert.strictEqual(howRunEnded({ timedOut: true }), 'timed out');
  assert.strictEqual(howRunEnded({ error: 'ENOENT' }), 'failed to start');
  assert.strictEqual(howRunEnded({ canceled: true, code: null }), 'restarted mid-run');
  assert.strictEqual(howRunEnded({ code: null }), 'killed');
  assert.strictEqual(howRunEnded({ skipped: true }), 'skipped');
});

test('a row carries when, next fire, last fire and owner as one run', () => {
  const { facts } = loadRowText();
  assert.strictEqual(facts({ describe: 'every 5m', next: iso(180), owner: 'tonylampada',
    last: { started: iso(-120), code: 0, ok: true } }).text,
  'every 5m · in 3m · fired 2m ago · exit 0 · tonylampada');
  // Paused replaces the next fire, because there is not one — printing a
  // plausible "in 3m" for a clock that fires nothing is the lie the chip exists
  // to stop.
  assert.strictEqual(facts({ describe: 'cron 0 9 * * mon', next: iso(180), owner: 'tonylampada',
    paused: true, last: null }).text,
  'cron 0 9 * * mon · paused · never fired · tonylampada');
  // A schedule with a problem HAS a next window and the tick will refuse it, so
  // "in 3m" would be exactly the plausible-looking lie `problem` exists to
  // replace.
  assert.strictEqual(facts({ describe: 'every 5m', next: iso(180), owner: 'tonylampada',
    problem: 'hook "doomed" is gone', last: null }).text,
  'every 5m · fires nothing · never fired · tonylampada');
});

test('the last fire wears a colour, so a red schedule is what the eye lands on', () => {
  const { outcomeClass } = loadRowText();
  assert.strictEqual(outcomeClass(null), 'sc-never');
  assert.strictEqual(outcomeClass({ ok: true }), 'sc-ok');
  assert.strictEqual(outcomeClass({ ok: false }), 'sc-bad');
  assert.strictEqual(outcomeClass({ skipped: true }), 'sc-skip');
  assert.match(css, /\.sc-bad \{ color: var\(--danger\); \}/);
});

// The whole reason this tab is worth having: a schedule whose hook was deleted,
// or whose `when` stopped parsing, fires nothing forever and looks exactly like
// a working one.
test('a problem is unmissable — the whole sentence, in red, on a red row', () => {
  assert.match(src, /el\.textContent = '⚠ ' \+ s\.problem/, 'in full: never truncated, never a title');
  assert.ok(!/s\.problem\.slice|s\.problem\.split/.test(src), 'and never cut down');
  assert.match(src, /'sc-row' \+ \(s\.problem \? ' sc-broken' : ''\)/, 'the row itself is flagged');
  assert.match(css, /\.sc-problem \{[^}]*color: var\(--danger\)/);
  assert.match(css, /\.sc-row\.sc-broken \{ border-left-color: var\(--danger\); \}/);
  assert.match(css, /\.sc-problem \{[^}]*overflow-wrap: anywhere/, 'a whole sentence wraps rather than clips');
});

test('paused is a state at a glance, not an inference from a greyed row', () => {
  assert.match(src, /chip\.textContent = 'PAUSED'/);
  assert.match(css, /\.sc-chip \{[^}]*color: var\(--warn\)/);
  assert.match(css, /\.sc-row\.sc-off \{ border-left-color: var\(--warn\); \}/);
});

test('the hook name is the way to that hook — the tab switching stays main.js\'s', () => {
  assert.match(src, /export function onOpenHook\(fn\)/);
  assert.match(src, /b\.textContent = '→ ' \+ s\.hook/);
  const main = fs.readFileSync(ui('js', 'main.js'), 'utf8');
  assert.match(main, /onOpenHook\(\(name\) => \{ setWsTab\('hooks'\); focusHook\(name\); \}\)/);
  const hk = fs.readFileSync(ui('js', 'hkmanager.js'), 'utf8');
  assert.match(hk, /export function focusHook\(name\)/);
  assert.match(hk, /marked\.scrollIntoView/, 'and the row it lands on is marked');
  assert.match(css, /\.hk-focus \{/);
});

test('pause, resume and remove go through the CLI\'s own doors', () => {
  assert.match(apiSrc, /pauseSchedule: \(name, paused\) => j\('PATCH', '\/api\/schedules\/' \+ encodeURIComponent\(name\), \{ paused \}\)/);
  assert.match(apiSrc, /removeSchedule: \(name\) => j\('DELETE', '\/api\/schedules\/' \+ encodeURIComponent\(name\)\)/);
  // Removing is destructive and asymmetric — the hook survives, and that is the
  // part he cannot see from this screen.
  assert.match(src, /confirm\('Remove the schedule/);
  // "untouched", not "still there": the schedule most likely to be removed here
  // is one whose hook is already gone.
  assert.match(src, /is untouched — only the clock entry goes/);
});

test('add picks its hook and its owner rather than asking him to spell them', () => {
  assert.ok(html.includes('id="sc-hook"') && html.includes('<select id="sc-hook"'), 'the hook is a picker');
  assert.ok(html.includes('<select id="sc-owner"'), 'and so is the owner');
  assert.match(src, /\.filter\(\(x\) => !x\.event\)/, 'over the NAMED hooks — a lifecycle hook is fired by its event');
  assert.match(src, /api\.lieutenants\(\)/, 'and over the registered lieutenants');
  // A repaint arrives on every board event; a picker rebuilt under his finger
  // would lose the choice he just made.
  assert.match(src, /if \(sel\.dataset\.filled === want\) return/);
});

test('the server\'s refusal is shown verbatim — it names the offending text', () => {
  assert.match(src, /say\('⚠ ' \+ err\.message\)/);
  // …and it reads as a refusal rather than as faint chatter
  assert.match(src, /noteEl\.classList\.toggle\('sc-warn', text\.startsWith\('⚠'\)\)/);
  assert.match(css, /#sc-note\.sc-warn \{ color: var\(--danger\); \}/);
  assert.ok(!/'invalid'|'bad when'/.test(src), 'nothing here replaces the message with a word');
});

test('no new endpoints — every door is one bc-axi schedule already posts to', () => {
  assert.match(apiSrc, /schedules: \(\) => j\('GET', '\/api\/schedules'\)/);
  assert.match(apiSrc, /schedule: \(name\) => j\('GET', '\/api\/schedules\/' \+ encodeURIComponent\(name\)\)/);
  assert.match(apiSrc, /addSchedule: \(s\) => j\('POST', '\/api\/schedules'/);
  // The firings come off the trace through GET /api/schedules/<name>, filtered
  // to this schedule's trigger server-side — no second copy, no second route.
  assert.match(src, /api\.schedule\(s\.name\)\)\.runs/);
  const calls = [...src.matchAll(/api\.(\w+)\(/g)].map((m) => m[1]).sort();
  assert.deepStrictEqual([...new Set(calls)].sort(),
    ['addSchedule', 'hooks', 'lieutenants', 'pauseSchedule', 'removeSchedule', 'schedule', 'schedules'],
    'and the section calls nothing else');
});

test('the section is wired into the screen the way every other one is', () => {
  const main = fs.readFileSync(ui('js', 'main.js'), 'utf8');
  assert.match(main, /import \{ renderSchedules, onOpenHook \} from '\.\/scmanager\.js'/);
  assert.match(main, /schedules: renderSchedules/, 'one WS_RENDER entry, nothing else');
  assert.match(src, /export async function renderSchedules\(reload\)/);
});

// The tab's only nudge is the board event that already arrives — a schedule
// fires, or is paused from the CLI, and a row must not go on lying about it.
test('every render asks the server, and an in-flight press outlives the repaint', () => {
  assert.ok(!/if \(items\) return paint\(\)/.test(src), 'a list read last time is not the answer');
  assert.match(src, /const busy = new Set\(\)/, 'the press is state, not a mutated button');
  assert.match(src, /busy\.add\(s\.name\)/);
  assert.match(src, /busy\.delete\(s\.name\)/);
  assert.ok(!/btn\.disabled|btn\.textContent/.test(src),
    'nothing writes to a button a repaint may already have thrown away');
  assert.ok(!/setInterval|setTimeout/.test(src), 'no polling — the board events are the nudge');
  // Only what he opened is re-read: the firings on screen must stay current,
  // and a panel nobody opened must cost nothing.
  assert.match(src, /for \(const name of \[\.\.\.open\]\)/);
});
