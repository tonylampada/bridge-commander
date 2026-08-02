// bulk.js — one action, many cards, ONE report. The action bar that appears
// with a selection (selection.js holds the selection itself) and the per-card
// work behind its buttons.
//
// DOM-free at import on purpose — the bar is built lazily the first time
// selection mode turns on, the way toast.js builds its stack — so nothing new
// is on screen while selection mode is off, and so the decisions below (what
// labels a card ends up with, what refuses to archive, what the report says)
// are plain functions a unit test can import.
import { cards, columns, cardStatus, cardVisible, card, workerFor, render } from './state.js';
import { api } from './api.js';
import { push as toast } from './toast.js';
import { selectionOn, selectedIds, selCount, exitSelection, reconcile } from './selection.js';

// ---------- the decisions (pure) ----------

// Labels ADD and REMOVE — they never replace. The API takes the whole list
// (PATCH /api/cards/:id with `labels` in full), so the merge happens here, per
// card, against that card's own labels. Deliberately not a new server verb: the
// client already knows every card's labels, and a card the merge is computed
// from is the card the PATCH is sent for.
export function labelsAfter(labels, add, remove) {
  const out = (labels || []).filter((n) => n !== remove);
  if (add && !out.includes(add)) out.push(add);
  return out;
}

// A card with a live worker is not archivable: archiving kills that session and
// drops its worktree binding. The question is asked of the WORKER REGISTRY
// (board.workers, via workerFor) — the same record the server consults before it
// kills anything, and an entry with done !== true is live work. card.status is
// only an advisory lease that nothing but POST /api/cards/:id/status writes, so
// its `absent` is evidence of nothing; it is asked second, never alone.
// null = go ahead.
export function archiveRefusal(c) {
  const w = workerFor(c.id);
  if (w && w.done !== true) return 'live worker' + (w.branch ? ' on ' + w.branch : '');
  const lease = cardStatus(c).worker;
  return lease && lease.state && lease.state !== 'absent' ? 'worker ' + lease.state : null;
}
// what "archive the selection" will actually do, before it happens
export function archivePlan(list) {
  const go = [], refused = [];
  for (const c of list) (archiveRefusal(c) ? refused : go).push(c);
  return { go, refused };
}

// results: [{title, ok, note}] → the one report. Every card that did anything
// other than the plain thing — refused, ordered, already there — is named in
// the sub-line, once. A toast per card is a punishment.
export function reportText(verb, results) {
  const done = results.filter((r) => r.ok).length;
  return {
    text: verb + ' ' + done + ' of ' + results.length + ' card' + (results.length === 1 ? '' : 's'),
    sub: results.filter((r) => r.note).map((r) => r.title + ' — ' + r.note).join(' · '),
    allOk: done === results.length,
  };
}

// ---------- running one action over the selection ----------
// Sequential, not all-at-once: every write broadcasts the whole board, and
// twelve of those in flight together is a stampede for no gain at this size.
// `act` returns a note (or nothing) for a card it handled, and throws to refuse.
async function run(verb, act) {
  const list = selectedIds().map(card).filter(Boolean);
  if (!list.length) return;
  const results = [];
  for (const c of list) {
    const title = c.title || c.id;
    try { results.push({ title, ok: true, note: (await act(c)) || '' }); }
    catch (e) { results.push({ title, ok: false, note: e.message }); }
  }
  const r = reportText(verb, results);
  // a report with refusals stays until it is dismissed — it is the only place
  // the captain learns what did NOT happen
  toast({ emoji: r.allOk ? '✅' : '⚠️', text: r.text, sub: r.sub, sticky: !r.allOk });
  render();
}

async function bulkMove(to) {
  const label = (columns().find((k) => k.id === to) || {}).title || to;
  await run('Moved ' + selCount() + ' → ' + label + ':', async (c) => {
    if (c.column === to) return 'already in ' + label;
    // a captain move into Working (or review → backlog) is an ORDER: the
    // lieutenant moves the card, not the board
    const r = await api.moveCard(c.id, to);
    return r.ordered ? r.ordered + ' sent to ' + c.owner : '';
  });
}

async function bulkArchive() {
  await run('Archived', async (c) => {
    const why = archiveRefusal(c);
    if (why) throw new Error(why);
    await api.archiveCard(c.id);
  });
}

// The confirm the destructive action carries. It is the bar itself in a second
// state, not a dialog: the selection stays on screen behind it, and it says the
// count and the refusals BEFORE anything happens. There is no undo window —
// archived cards come back one at a time from 🧊 archived — so this line is
// where the weight sits.
export function archiveConfirmText(list) {
  const { go, refused } = archivePlan(list);
  return {
    n: go.length,
    text: go.length
      ? 'Archive ' + go.length + ' card' + (go.length === 1 ? '' : 's') + '? They leave the board (restorable one at a time from 🧊).'
      : 'Nothing to archive — every selected card has a live worker.',
    refused: refused.length
      ? refused.length + ' refused, live worker: ' + refused.map((c) => c.title || c.id).join(', ')
      : '',
  };
}

async function bulkLabel(add) {
  const name = (prompt((add ? 'Add label to ' : 'Remove label from ') + selCount() + ' cards:', '') || '').trim();
  if (!name) return;
  await run((add ? 'Labelled ' : 'Unlabelled ') + name + ':', async (c) => {
    const next = labelsAfter(c.labels, add ? name : null, add ? null : name);
    if (next.length === (c.labels || []).length) return add ? 'already had it' : 'did not have it';
    await api.patchCard(c.id, { labels: next });
  });
}

// ---------- the bar ----------
let bar = null;
let confirming = 0; // >0 = the archive confirm is up, over this many selected cards
function ensureBar() {
  if (bar) return bar;
  bar = document.createElement('div');
  bar.id = 'bulk-bar';
  bar.innerHTML = '<span class="bb-n"></span>'
    + '<span class="bb-acts">'
    + '<select class="bb-move" title="move the selection"><option value="">move to…</option></select>'
    + '<button class="bb-lab" type="button">＋ label</button>'
    + '<button class="bb-unlab" type="button">－ label</button>'
    + '<button class="bb-arch danger" type="button">✕ archive</button>'
    + '<button class="bb-x" type="button" title="leave selection mode">done</button>'
    + '</span>'
    + '<span class="bb-confirm" hidden><span class="bb-msg"></span><span class="bb-refused"></span>'
    + '<button class="bb-no" type="button">cancel</button>'
    + '<button class="bb-yes danger" type="button">archive</button></span>';
  const mv = bar.querySelector('.bb-move');
  mv.onchange = () => { const to = mv.value; mv.value = ''; if (to) bulkMove(to); };
  bar.querySelector('.bb-lab').onclick = () => bulkLabel(true);
  bar.querySelector('.bb-unlab').onclick = () => bulkLabel(false);
  bar.querySelector('.bb-arch').onclick = () => { confirming = selCount(); render(); };
  bar.querySelector('.bb-no').onclick = () => { confirming = 0; render(); };
  bar.querySelector('.bb-yes').onclick = () => { confirming = 0; bulkArchive(); };
  bar.querySelector('.bb-x').onclick = () => { exitSelection(); render(); };
  document.body.appendChild(bar);
  return bar;
}
// what the confirm row says right now, and whether "archive" can be pressed
function paintConfirm(b) {
  const plan = archiveConfirmText(selectedIds().map(card).filter(Boolean));
  b.querySelector('.bb-msg').textContent = plan.text;
  b.querySelector('.bb-refused').textContent = plan.refused;
  const yes = b.querySelector('.bb-yes');
  yes.textContent = plan.n ? 'archive ' + plan.n : 'archive';
  yes.disabled = !plan.n;
}

// Called once per render pass, BEFORE the board/table repaint, so the selection
// the views draw is the one the actions will hit.
export function renderBulkBar() {
  reconcile(cards().filter(cardVisible).map((c) => c.id));
  if (!selectionOn()) {
    if (bar) { bar.remove(); bar = null; }
    confirming = 0;
    return;
  }
  const b = ensureBar();
  const n = selCount();
  if (confirming && confirming !== n) confirming = 0; // the selection moved under it
  b.querySelector('.bb-n').textContent = n ? n + ' selected' : 'none selected';
  b.querySelector('.bb-acts').hidden = !!confirming;
  b.querySelector('.bb-confirm').hidden = !confirming;
  if (confirming) { paintConfirm(b); return; }
  const mv = b.querySelector('.bb-move');
  const cols = columns().map((c) => c.id).join(',');
  if (mv.dataset.cols !== cols) { // columns rarely change; don't rebuild under a click
    mv.dataset.cols = cols;
    mv.textContent = '';
    const head = document.createElement('option');
    head.value = ''; head.textContent = 'move to…';
    mv.appendChild(head);
    for (const col of columns()) {
      const o = document.createElement('option');
      o.value = col.id; o.textContent = col.title || col.id;
      mv.appendChild(o);
    }
  }
  for (const el of b.querySelectorAll('select, button')) {
    if (!el.classList.contains('bb-x')) el.disabled = !n; // the way out is never disabled
  }
}
