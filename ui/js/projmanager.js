// The workspace screen's projects section: the registry a card's `repo`
// attribute has to name, and the facts that decide whether a start off one will
// work — how many live cards point at it, where it pushes, and the branch a
// fresh worktree starts detached from.
//
// Showing only. Registering a project clones a repo and removing one deletes a
// checkout that may hold uncommitted work; neither belongs behind a click.
import { api } from './api.js';

const listEl = document.getElementById('pj-list');

let items = null; // [{name, path, cards, remote, branch, missing}] — last answer
let loading = false;

// Same contract as the playbooks section: `reload` is what the tab passes on the
// way in, so entering the tab reads disk afresh while the renders that follow —
// one per board event — repaint what is already here. Nothing runs while another
// tab is up, so opening the screen for labels shells out to git not at all.
export async function renderProjects(reload) {
  if (reload) items = null;
  if (items) return paint();
  if (loading) return;
  loading = true;
  try {
    items = (await api.projects(true)).projects || [];
  } catch (e) {
    listEl.textContent = '⚠ ' + e.message;
    return;
  } finally { loading = false; }
  paint();
}

function paint() {
  listEl.textContent = '';
  for (const p of items) {
    const row = document.createElement('div');
    row.className = 'pj-row';
    const head = document.createElement('div');
    head.className = 'pj-head';
    // The name is the string a card's `repo` must match exactly, so it is the
    // one thing here that reads as a value rather than a caption.
    const name = document.createElement('span');
    name.className = 'pj-name';
    name.textContent = p.name;
    const n = document.createElement('span');
    n.className = 'pj-n';
    n.textContent = p.cards === 1 ? '1 card' : p.cards + ' cards';
    n.title = 'live cards with repo: ' + p.name;
    head.append(name, n);
    const where = document.createElement('div');
    where.className = 'ss-note pj-path';
    where.textContent = p.path;
    row.append(head, where);
    // A project whose clone is gone keeps its row and says so — that is exactly
    // the moment you need to see it, and no git fact would be true anyway.
    if (p.missing) row.append(fact('⚠', 'path not on disk', 'pj-warn'));
    else {
      row.append(fact('remote', p.remote || 'none'));
      row.append(fact('branch', p.branch || 'unknown'));
    }
    listEl.appendChild(row);
  }
  if (!items.length) listEl.textContent = 'no projects';
}

function fact(key, value, cls) {
  const row = document.createElement('div');
  row.className = 'pj-fact' + (cls ? ' ' + cls : '');
  const k = document.createElement('span');
  k.className = 'pj-k';
  k.textContent = key;
  const v = document.createElement('span');
  v.className = 'pj-v';
  v.textContent = value;
  row.append(k, v);
  return row;
}
