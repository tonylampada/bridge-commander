// The config screen's hooks section: the workspace's own executable scripts,
// what fires each one, and when it last ran.
//
// A hook already was everything a hook should be — an executable spawned with
// BC_* in its env, cwd the workspace, a timeout that kills the tree. What it
// could not be is named, triggered or SEEN. This section is the seen half: one
// dense row per hook, the way the lieutenants tab is one row per lieutenant.
//
//   gh-watch          ran 4m ago · exit 0        ▶ ✎
//   teardown-devcont  worker-done · ran 2h · 0   ▶ ✎
//
// ▶ posts to the same door `bc-axi hook run` posts to — one code path, three
// callers. ✎ opens the file on the file screen, the same editor a playbook
// opens in, which is where "he asks a lieutenant to help build one" happens: a
// file on a screen he can point at.
//
// Deliberately absent: run detail (the output tail lives in hookruns.jsonl and
// is read with `bc-axi hook runs`) and a create button (naming a file, making it
// executable and typing bash into a text box on a phone is the worst way to do
// all three).
import { api } from './api.js';
import { ago } from './util.js';
import { openArtifactFile } from './detail.js';

const listEl = document.getElementById('hk-list');
const noteEl = document.getElementById('hk-note');
const dirEl = document.getElementById('hk-dir');

let items = null; // [{name, event, file, last, running}] — last answer from the server
let dir = '';
let loading = false;
let stale = false; // a render arrived while a read was in flight
let running = ''; // the hook whose ▶ was pressed HERE — state, not a mutated button

// Same contract as the playbooks and lieutenants sections: `reload` is what the
// tab passes on the way in. Every render ASKS, though, not just the entering
// one: a hook run from the CLI, or a lifecycle hook firing, changes what a row
// says about its last run, and the board event that brought us here is the only
// nudge this tab gets. That is also why there is no polling — nothing runs at
// all while another tab is up.
export async function renderHooks(reload) {
  if (reload) noteEl.textContent = ''; // entering is a fresh look, not last visit's answer
  if (loading) { stale = true; return; } // the read in flight answers for both askers
  loading = true;
  try {
    do {
      stale = false;
      const r = await api.hooks();
      items = r.hooks || [];
      dir = r.dir || '';
    } while (stale);
  } catch (e) {
    // A read that failed says so where a press says so — blanking a list that is
    // still true on screen would be the worse lie.
    if (items) noteEl.textContent = '⚠ ' + e.message;
    else listEl.textContent = '⚠ ' + e.message;
    return;
  } finally { loading = false; }
  paint();
}

function paint() {
  if (!items) return;
  listEl.textContent = '';
  for (const h of items) listEl.appendChild(row(h));
  if (!items.length) listEl.textContent = 'no hooks';
  dirEl.textContent = dir + ' — a file here is a named hook; a directory is a lifecycle event';
}

function row(h) {
  const el = document.createElement('div');
  el.className = 'hk-row';
  const busy = running === h.name;
  el.append(name(h), facts(h, busy), actions(h, busy));
  return el;
}

function name(h) {
  const el = document.createElement('span');
  el.className = 'hk-name';
  el.textContent = h.name;
  el.title = h.file;
  return el;
}

// How the last run ended, in the words a row has space for. A lifecycle hook
// leads with the event that owns it; a named one shows nothing there, because
// nothing fires it but the ▶.
function outcome(r) {
  if (!r) return 'never ran';
  const when = ago(r.started); // 'now' | '4m' | '2h' | '3d'
  return 'ran ' + (when === 'now' ? 'just now' : when + ' ago') + ' · '
    + (r.timedOut ? 'timed out' : r.error ? 'never started' : 'exit ' + r.code);
}

// `busy` is a press this tab is still waiting on; h.running is the server's own
// answer, which is how a run started from the CLI reads as running here too.
function facts(h, busy) {
  const el = document.createElement('span');
  el.className = 'hk-facts';
  el.title = h.event ? 'fires on ' + h.event + '; last run' : 'nothing fires this one — ▶ does';
  if (h.event) el.append(h.event + ' · ');
  const live = busy || !!h.running;
  const last = document.createElement('span');
  last.className = live ? 'hk-running' : !h.last ? 'hk-never' : h.last.ok ? 'hk-ok' : 'hk-bad';
  last.textContent = live ? 'running now' : outcome(h.last);
  el.append(last);
  return el;
}

function actions(h, busy) {
  const el = document.createElement('span');
  el.className = 'hk-acts';
  const run = action(busy ? '…' : '▶', 'run it now — the same door bc-axi hook run posts to', () => runNow(h));
  // A lifecycle hook is fired by the event that owns it. Running one by hand
  // would hand it an empty BC_CARD and a card-shaped script would do the wrong
  // thing quietly, so the button says why instead of pretending.
  if (h.event) {
    run.disabled = true;
    run.title = h.event + ' fires this one — running it by hand would hand it no card';
  } else if (busy) run.disabled = true;
  el.append(run, action('✎', 'edit — ' + h.file, () => edit(h)));
  return el;
}

function action(label, title, onClick) {
  const b = document.createElement('button');
  b.type = 'button';
  b.className = 'hk-act';
  b.textContent = label;
  b.title = title;
  b.onclick = onClick;
  return b;
}

// The run says what it did just under the list: the button is where he pressed,
// so it is where the answer belongs. A refusal (409 — already in flight) and a
// non-zero exit both read here; the output tail is `bc-axi hook runs`.
//
// The press is held HERE and not on the button, because a board event repaints
// every row mid-run: a button that came back enabled under his thumb would be
// the second press the server then has to refuse, and the '…' would vanish with
// nothing left saying anything is happening.
async function runNow(h) {
  if (running) return;
  running = h.name;
  paint();
  let note;
  try {
    const r = await api.runHook(h.name);
    note = r.run.timedOut ? 'timed out' : r.run.error ? 'never started' : 'exit ' + r.run.code;
  } catch (e) {
    note = e.message;
  }
  running = '';
  await renderHooks();
  noteEl.textContent = h.name + ': ' + note;
}

// A hook is a file, so editing it is the file screen — the same 💾, the same
// version check, the same 409 as a playbook or a card artifact.
async function edit(h) {
  try {
    await openArtifactFile('file://' + h.file, h.name);
  } catch (e) {
    noteEl.textContent = '⚠ cannot open ' + h.name + ' — ' + e.message;
  }
}
