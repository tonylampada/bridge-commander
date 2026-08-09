// The config screen's schedules section: the board's own clock, beside the
// hooks it fires.
//
// MNC-25 shipped the clock and gave it no screen, so the board could be
// scheduled and nothing on the board said so. This is the said-so half — one
// block per schedule, the facts the CLI prints, in the words the CLI prints
// them in:
//
//   ▸ gh-watch  → gh-watch                              ⏸ ✕
//     every 5m · in 3m · fired 2m ago · exit 0 · tonylampada
//
//   ▸ nightly   → digest            PAUSED              ▶ ✕
//     cron 0 9 * * mon · paused · never fired · tonylampada
//
// The `problem` is why this section is worth having at all. A schedule whose
// hook was deleted, or whose `when` stopped parsing, fires nothing forever and
// looks exactly like one that is working — that is the silent failure the clock
// exists to end, so a broken row is a red bar and the server's whole sentence,
// never a subtly greyed line and the word "invalid".
//
// Same rule for the add form's refusals: the server names the offending text
// ("bad schedule expression \"*/5 * * *\": a cron expression has 5 fields…"),
// and that message is shown VERBATIM. Replacing it with "invalid" would throw
// away the only part of it that helps.
//
// No endpoint was added for any of this. Every read and every write here is a
// door `bc-axi schedule …` already posts to, including the firings: they come
// off hookruns.jsonl, filtered to this schedule's trigger server-side, so the
// screen and the CLI read one truth.
import { api } from './api.js';
import { ansiToHtml } from './ansi.js';
import { hhmm } from './util.js';

const listEl = document.getElementById('sc-list');
const noteEl = document.getElementById('sc-note');
const addEl = document.getElementById('sc-add');
const formEl = document.getElementById('sc-form');
const nameEl = document.getElementById('sc-name');
const hookEl = document.getElementById('sc-hook');
const whenEl = document.getElementById('sc-when');
const ownerEl = document.getElementById('sc-owner');
const overlapEl = document.getElementById('sc-overlap');
const catchupEl = document.getElementById('sc-catchup');

// The one place the note is written, so a refusal always reads like one: every
// failure here leads with a ⚠, and that is what colours it. A refusal in the
// same faint grey as "added" is how a screen teaches him not to read it.
function say(text) {
  noteEl.textContent = text;
  noteEl.classList.toggle('sc-warn', text.startsWith('⚠'));
}

let items = null; // the last GET /api/schedules answer
let loading = false;
let stale = false; // a render arrived while a read was in flight
const open = new Set(); // schedules whose firings are showing
const runs = new Map(); // name -> its firings, as last read
const busy = new Set(); // names with a press still in flight — state, not a mutated button

// The hook name jumps to that hook's row on the hooks tab. main.js owns the tab
// switching, so it hands the action down here rather than this module reaching
// up for it — the same shape filepane uses for onModeSwitch.
let openHookFn = null;
export function onOpenHook(fn) { openHookFn = fn; }

// Same contract as its neighbours: `reload` is what the tab passes on the way
// in. Every render ASKS, though, not just the entering one — a schedule fires,
// is paused from the CLI, or has its hook deleted out from under it, and the
// board event that brought us here is the only nudge this tab gets. Which is
// also why there is no polling: nothing runs while another tab is up.
export async function renderSchedules(reload) {
  if (reload) say(''); // entering is a fresh look, not last visit's answer
  if (loading) { stale = true; return; } // the read in flight answers for both askers
  loading = true;
  try {
    do {
      stale = false;
      items = (await api.schedules()).schedules || [];
      // Only what he opened is re-read — the firings on screen must not go on
      // saying a firing ago is the newest one, and a panel nobody opened costs
      // nothing.
      for (const name of [...open]) {
        try { runs.set(name, (await api.schedule(name)).runs || []); }
        catch (e) { open.delete(name); runs.delete(name); }
      }
    } while (stale);
  } catch (e) {
    // A read that failed says so where a press says so — blanking a list that is
    // still true on screen would be the worse lie.
    if (items) say('⚠ ' + e.message);
    else listEl.textContent = '⚠ ' + e.message;
    return;
  } finally { loading = false; }
  if (reload) loadPickers();
  paint();
}

function paint() {
  if (!items) return;
  listEl.textContent = '';
  for (const s of items) listEl.appendChild(row(s));
  if (!items.length) listEl.textContent = 'no schedules';
}

function row(s) {
  const el = document.createElement('div');
  el.className = 'sc-row' + (s.problem ? ' sc-broken' : '') + (s.paused ? ' sc-off' : '');
  el.append(head(s), facts(s));
  // In full and above the fold: a problem is the reason to look at this tab, so
  // it is not a title attribute and it is not truncated.
  if (s.problem) el.append(problem(s));
  if (open.has(s.name)) el.append(firings(s));
  return el;
}

function head(s) {
  const el = document.createElement('div');
  el.className = 'sc-head';
  el.title = open.has(s.name) ? 'hide the firings' : 'the recent firings — time, how each ended, and the output';
  el.onclick = () => toggle(s);
  const nm = document.createElement('span');
  nm.className = 'sc-name';
  nm.textContent = (open.has(s.name) ? '▾ ' : '▸ ') + s.name;
  el.append(nm, hookLink(s));
  // Paused is a state, not a shade: a greyed row and a row on a dim screen look
  // the same, and "why did this stop firing" is the question the tab answers.
  if (s.paused) {
    const chip = document.createElement('span');
    chip.className = 'sc-chip';
    chip.textContent = 'PAUSED';
    chip.title = 'this schedule fires nothing until it is resumed';
    el.append(chip);
  }
  el.append(acts(s));
  return el;
}

function hookLink(s) {
  const b = document.createElement('button');
  b.type = 'button';
  b.className = 'sc-hook';
  b.textContent = '→ ' + s.hook;
  b.title = 'the hook this fires — show it on the hooks tab';
  b.onclick = (e) => { e.stopPropagation(); if (openHookFn) openHookFn(s.hook); };
  return b;
}

function acts(s) {
  const el = document.createElement('span');
  el.className = 'sc-acts';
  el.onclick = (e) => e.stopPropagation(); // the head toggles the firings; these do not
  const b = busy.has(s.name);
  // '‖' rather than the pause pictograph: U+23F8 has no glyph in the fonts this
  // board ships with and renders as a box, which is not a button anyone presses.
  el.append(
    act(b ? '…' : s.paused ? '▶' : '‖', b,
      s.paused ? 'resume — the cursor re-arms at now, so it wakes up owing no windows'
        : 'pause — it fires nothing until resumed',
      () => setPaused(s, !s.paused)),
    act('✕', b, 'remove this schedule — the hook itself survives', () => remove(s)),
  );
  return el;
}

function act(label, disabled, title, onClick) {
  const b = document.createElement('button');
  b.type = 'button';
  b.className = 'sc-act';
  b.textContent = label;
  b.title = title;
  b.disabled = disabled;
  b.onclick = onClick;
  return b;
}

// ---------- the words, exactly the ones `schedule list` says ----------
// A screen and a CLI describing the same clock in two vocabularies is two
// things to learn, so these are the CLI's own phrasings.

// 'in 3m' — how far off the next fire is.
function until(iso) {
  const t = Date.parse(iso || '');
  if (!t) return 'never';
  const s = Math.round((t - Date.now()) / 1000);
  if (s <= 0) return 'due now';
  if (s < 60) return 'in ' + s + 's';
  if (s < 3600) return 'in ' + Math.round(s / 60) + 'm';
  if (s < 86400) return 'in ' + Math.round(s / 3600) + 'h';
  return 'in ' + Math.round(s / 86400) + 'd';
}

// 'now' is not a thing a past event is, so the smallest unit here is seconds —
// util's ago() rounds the first minute to "now", which would read "fired now".
function since(iso) {
  const t = Date.parse(iso || '');
  if (!t) return '';
  const s = Math.max(0, Math.round((Date.now() - t) / 1000));
  if (s < 60) return s + 's ago';
  if (s < 3600) return Math.round(s / 60) + 'm ago';
  if (s < 86400) return Math.round(s / 3600) + 'h ago';
  return Math.round(s / 86400) + 'd ago';
}

function howRunEnded(r) {
  return r.skipped ? 'skipped' : r.timedOut ? 'timed out' : r.error ? 'failed to start'
    : r.canceled ? 'restarted mid-run' : r.code === null ? 'killed' : 'exit ' + r.code;
}

// A SKIP is a firing too — that is the whole point of recording it — so it reads
// as one rather than as silence.
function fireOutcome(r) {
  if (!r) return 'never fired';
  if (r.skipped) return 'skipped ' + since(r.started) + ' (previous firing still going)';
  return 'fired ' + since(r.started) + ' · ' + howRunEnded(r);
}

function outcomeClass(r) {
  if (!r) return 'sc-never';
  return r.skipped ? 'sc-skip' : r.ok ? 'sc-ok' : 'sc-bad';
}

// when · next fire · last fire · owner, as one dim run. Separators, not labels:
// the title says what they are once, so ten rows do not each spell it out. The
// last fire keeps a colour of its own, because a red one has to be what the eye
// lands on.
function facts(s) {
  const el = document.createElement('div');
  el.className = 'sc-facts';
  el.title = 'when it fires · next fire · last fire · owner';
  // A schedule with a problem has a next window and will not take it — the tick
  // refuses to fire it — so "in 4m" would be the plausible-looking lie the
  // problem is there to replace. Paused is the same shape of not-coming.
  el.append(s.describe + ' · ' + (s.paused ? 'paused' : s.problem ? 'fires nothing' : until(s.next)) + ' · ');
  const last = document.createElement('span');
  last.className = outcomeClass(s.last);
  last.textContent = fireOutcome(s.last);
  el.append(last, ' · ' + s.owner);
  return el;
}

function problem(s) {
  const el = document.createElement('div');
  el.className = 'sc-problem';
  el.textContent = '⚠ ' + s.problem;
  return el;
}

// The firings, newest first — the trace's own records, not a second copy kept
// on the schedule.
function firings(s) {
  const el = document.createElement('div');
  el.className = 'sc-runs';
  const list = runs.get(s.name);
  if (!list) { el.textContent = 'reading the firings…'; return el; }
  if (!list.length) { el.textContent = 'no firings recorded'; return el; }
  for (const r of list) el.append(firing(r));
  return el;
}

function firing(r) {
  const el = document.createElement('div');
  el.className = 'sc-run';
  const line = document.createElement('div');
  line.className = 'sc-run-head';
  const how = document.createElement('span');
  how.className = outcomeClass(r);
  how.textContent = howRunEnded(r);
  line.append(hhmm(r.started) + '  ', how, '  ' + r.ms + 'ms');
  el.append(line);
  if (r.output) {
    const pre = document.createElement('pre');
    pre.className = 'sc-out';
    // The output of a hook is a terminal's output — ansiToHtml escapes the text
    // before it adds any markup, the same way the live pane reads a frame.
    pre.innerHTML = ansiToHtml(r.output);
    el.append(pre);
  }
  return el;
}

// ---------- the presses ----------

async function toggle(s) {
  if (open.has(s.name)) { open.delete(s.name); runs.delete(s.name); return paint(); }
  open.add(s.name);
  paint(); // the panel opens now and says it is reading — the fetch fills it in
  try {
    runs.set(s.name, (await api.schedule(s.name)).runs || []);
  } catch (e) {
    open.delete(s.name);
    say('⚠ ' + s.name + ': ' + e.message);
  }
  paint();
}

// The press is held HERE and not on the button, because a board event repaints
// every row mid-request: a button that came back enabled under his thumb would
// be a second write the server then has to sort out.
async function setPaused(s, paused) {
  if (busy.has(s.name)) return;
  busy.add(s.name);
  paint();
  let note;
  try {
    const r = await api.pauseSchedule(s.name, paused);
    note = s.name + (paused ? ' paused — it fires nothing until resumed'
      : ' resumed — next fire ' + until(r.schedule && r.schedule.next));
  } catch (e) { note = '⚠ ' + s.name + ': ' + e.message; }
  busy.delete(s.name);
  await renderSchedules();
  say(note);
}

// The confirm says what removal does NOT do, because that is the part he cannot
// see from here: it forgets a clock entry, it does not delete a script. It says
// "untouched" rather than "still there" — the schedule most likely to be removed
// from this screen is one whose hook is already gone, and that is exactly the row
// a promise about the file still existing would be a lie on.
async function remove(s) {
  if (busy.has(s.name)) return;
  if (!confirm('Remove the schedule "' + s.name + '"?\n\n'
    + 'The hook ' + s.hook + ' is untouched — only the clock entry goes, so nothing fires it any more.')) return;
  busy.add(s.name);
  paint();
  let note;
  try {
    await api.removeSchedule(s.name);
    note = s.name + ' removed — the hook ' + s.hook + ' is untouched';
  } catch (e) { note = '⚠ ' + s.name + ': ' + e.message; }
  busy.delete(s.name);
  open.delete(s.name);
  runs.delete(s.name);
  await renderSchedules();
  say(note);
}

// ---------- add ----------
// The two pickers are the point of having a form at all: a hook that exists and
// an owner who is registered are the two refusals `add` spends most of its time
// on, and a free-text box would earn both of them again every time.
async function loadPickers() {
  try {
    const [h, l] = await Promise.all([api.hooks(), api.lieutenants()]);
    // A schedule fires a NAMED hook — a lifecycle hook is fired by the event
    // that owns it, so it is not on this list.
    fill(hookEl, (h.hooks || []).filter((x) => !x.event).map((x) => x.name), 'no named hooks');
    fill(ownerEl, (l.lieutenants || []).map((x) => x.id), 'no lieutenants');
  } catch (e) { say('⚠ ' + e.message); }
}

// Rebuilt only when the set actually changed: a repaint that reset a picker
// under his finger would be the same bug as one that ate what he typed.
function fill(sel, values, empty) {
  const want = values.join('\n');
  if (sel.dataset.filled === want) return;
  sel.dataset.filled = want;
  const had = sel.value;
  sel.textContent = '';
  for (const v of (values.length ? values : [''])) {
    const o = document.createElement('option');
    o.value = values.length ? v : '';
    o.textContent = values.length ? v : empty;
    sel.append(o);
  }
  if (values.includes(had)) sel.value = had;
}

// Opening the form is the moment its pickers have to be right — a hook dropped
// in a minute ago belongs on the list he is about to choose from.
addEl.ontoggle = () => { if (addEl.open) loadPickers(); };

formEl.onsubmit = async (e) => {
  e.preventDefault();
  say('');
  try {
    const r = await api.addSchedule({
      name: nameEl.value.trim(), hook: hookEl.value, when: whenEl.value.trim(),
      owner: ownerEl.value, overlap: overlapEl.value, catchup: catchupEl.value,
    });
    nameEl.value = '';
    whenEl.value = '';
    addEl.open = false;
    await renderSchedules();
    say(r.schedule.name + ' added — ' + r.schedule.hook + ' ' + r.schedule.describe
      + ', owner ' + r.schedule.owner + '; next fire ' + until(r.schedule.next));
  } catch (err) {
    // VERBATIM. The refusal names the offending text — which `when` did not
    // parse, which hook is not there — and "invalid" would throw all of it away.
    say('⚠ ' + err.message);
  }
};
