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
const dirEl = document.getElementById('hk-dir');

let items = null; // [{name, event, file, last, running}] — last answer from the server
let dir = '';
let loading = false;

// Same contract as the playbooks and lieutenants sections: `reload` is what the
// tab passes on the way in, so entering reads disk (and the trace) afresh while
// the renders that follow — one per board event — repaint what is already here.
// Nothing runs at all while another tab is up.
export async function renderHooks(reload) {
  if (reload) items = null;
  if (items) return paint();
  if (loading) return;
  loading = true;
  try {
    const r = await api.hooks();
    items = r.hooks || [];
    dir = r.dir || '';
  } catch (e) {
    listEl.textContent = '⚠ ' + e.message;
    return;
  } finally { loading = false; }
  paint();
}

function paint() {
  listEl.textContent = '';
  for (const h of items) listEl.appendChild(row(h));
  if (!items.length) listEl.textContent = 'no hooks';
  dirEl.textContent = dir + ' — a file here is a named hook; a directory is a lifecycle event';
}

function row(h) {
  const el = document.createElement('div');
  el.className = 'hk-row';
  el.append(name(h), facts(h), actions(h));
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

function facts(h) {
  const el = document.createElement('span');
  el.className = 'hk-facts';
  el.title = h.event ? 'fires on ' + h.event + '; last run' : 'nothing fires this one — ▶ does';
  if (h.event) el.append(h.event + ' · ');
  const last = document.createElement('span');
  last.className = h.running ? 'hk-running' : !h.last ? 'hk-never' : h.last.ok ? 'hk-ok' : 'hk-bad';
  last.textContent = h.running ? 'running now' : outcome(h.last);
  el.append(last);
  return el;
}

function actions(h) {
  const el = document.createElement('span');
  el.className = 'hk-acts';
  const run = action('▶', 'run it now — the same door bc-axi hook run posts to', () => runNow(h, run));
  // A lifecycle hook is fired by the event that owns it. Running one by hand
  // would hand it an empty BC_CARD and a card-shaped script would do the wrong
  // thing quietly, so the button says why instead of pretending.
  if (h.event) {
    run.disabled = true;
    run.title = h.event + ' fires this one — running it by hand would hand it no card';
  }
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

// The run says what it did on the row itself: the button is where he pressed,
// so it is where the answer belongs. A refusal (409 — already in flight) and a
// non-zero exit both read here; the output tail is `bc-axi hook runs`.
async function runNow(h, btn) {
  btn.disabled = true;
  btn.textContent = '…';
  let note;
  try {
    const r = await api.runHook(h.name);
    note = r.run.timedOut ? 'timed out' : r.run.error ? 'never started' : 'exit ' + r.run.code;
  } catch (e) {
    note = e.message;
  }
  btn.textContent = '▶';
  btn.disabled = false;
  items = null;
  await renderHooks();
  const el = document.createElement('div');
  el.className = 'hk-note';
  el.textContent = h.name + ': ' + note;
  listEl.appendChild(el);
}

// A hook is a file, so editing it is the file screen — the same 💾, the same
// version check, the same 409 as a playbook or a card artifact.
async function edit(h) {
  try {
    await openArtifactFile('file://' + h.file, h.name);
  } catch (e) {
    listEl.textContent = '⚠ cannot open ' + h.name + ' — ' + e.message;
  }
}
