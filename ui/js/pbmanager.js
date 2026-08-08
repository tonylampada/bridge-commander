// The workspace screen's playbooks section: every playbook the board can start
// a card with, and the way to edit one.
//
// A playbook is a file, so editing one is the file screen — the same editor,
// the same 💾, the same 409 as a card artifact (detail.js: openArtifactFile).
// Nothing here knows how any of that works.
//
// Two populations, and the difference is the whole section:
//   workspace — <STATE_DIR>/playbooks/<id>.md. Yours. Opens and saves.
//   packaged  — the set that ships with the install. That is a git checkout, so
//               it is never written: it opens read-only and offers to copy
//               itself into the workspace, after which it is a workspace one.
import { api } from './api.js';
import { openArtifactFile } from './detail.js';
import { fileNotice } from './filepane.js';

const listEl = document.getElementById('pb-list');
const dirEl = document.getElementById('pb-dir');
const refEl = document.getElementById('pb-ref');

let items = null;  // [{id, source, file}] — last answer from the server
let dir = '';      // where a copy lands
let reference = null; // {placeholders, frontmatter} — written in server/playbooks.js
let loading = false;

// Paints from the last answer and fetches when there isn't one. `reload` is
// what the playbooks tab passes on the way in, so showing the section always
// reads disk afresh (a playbook dropped in a second ago is in the list) while
// the renders that follow — one per board event — cost nothing. Nothing runs
// at all while another tab is up: opening the screen for labels reads no disk.
export async function renderPlaybooks(reload) {
  if (reload) items = null;
  if (items) return paint();
  if (loading) return;
  loading = true;
  try {
    const r = await api.playbooks();
    items = r.items || [];
    dir = r.dir || '';
    reference = r.reference || null;
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
    row.className = 'pb-row';
    const name = document.createElement('button');
    name.type = 'button';
    name.className = 'pb-name';
    name.textContent = p.id;
    name.title = p.file;
    name.onclick = () => open(p);
    row.append(name);
    if (p.source === 'packaged') {
      const tag = document.createElement('span');
      tag.className = 'pb-tag';
      tag.textContent = 'packaged';
      tag.title = 'ships with the install — copy it to the workspace to edit it';
      row.append(tag);
    }
    listEl.appendChild(row);
  }
  if (!items.length) listEl.textContent = 'no playbooks';
  dirEl.textContent = dir;
  paintRef();
}

// The reference: two blocks of `name — one line`, from the server's own text.
// One loop, no markdown, nothing restated here — an added placeholder shows up
// the moment playbooks.js names it.
function paintRef() {
  refEl.textContent = '';
  if (!reference) return;
  block('placeholders', '{{NAME}} in the playbook, filled at card start. A name that is not one of '
    + 'these is left in the brief exactly as written.', reference.placeholders, 'name');
  block('frontmatter', 'an optional --- block at the very top, read by the code that starts the '
    + 'card. All keys optional.', reference.frontmatter, 'key');
}

function block(title, note, rows, field) {
  if (!rows || !rows.length) return;
  const h = document.createElement('div');
  h.className = 'ss-title';
  h.textContent = title;
  const n = document.createElement('div');
  n.className = 'ss-note pb-ref-note';
  n.textContent = note;
  refEl.append(h, n);
  for (const r of rows) {
    const row = document.createElement('div');
    row.className = 'pb-ref-row';
    const k = document.createElement('code');
    k.className = 'pb-ref-k';
    k.textContent = r[field];
    const d = document.createElement('span');
    d.className = 'pb-ref-d';
    d.textContent = r.desc;
    row.append(k, d);
    refEl.appendChild(row);
  }
}

async function open(p) {
  const packaged = p.source === 'packaged';
  try {
    await openArtifactFile('file://' + p.file, p.id + '.md', {
      readOnly: packaged && 'this playbook ships with the install and is never written — ' +
        'copy it to the workspace first, then it is yours to edit.',
    });
  } catch (e) {
    listEl.textContent = '⚠ cannot open ' + p.id + ' — ' + e.message;
    return;
  }
  // The read-only case says so where he is about to type, with the one action
  // that changes it — a screen that only refuses on save teaches him nothing
  // until after he has written a paragraph.
  if (packaged) {
    fileNotice('packaged playbook — read-only', 'warn',
      [{ label: '⧉ copy to workspace', title: 'write ' + dir + '/' + p.id + '.md and edit that', onClick: () => copy(p) }]);
  }
}

// Copy = create the workspace file with the packaged content, through the same
// guarded write (version '' means "I expect no file", so a file that turned up
// meanwhile is a 409 and nothing is clobbered). Then reopen: the same id now
// resolves to the workspace copy, and it is editable.
async function copy(p) {
  const target = dir + '/' + p.id + '.md';
  try {
    const src = await api.artifact('file://' + p.file);
    await api.saveArtifact('file://' + target, src.content, '');
  } catch (e) {
    return fileNotice('⚠ could not copy — ' + e.message, 'err');
  }
  items = null;
  await renderPlaybooks();
  await open({ id: p.id, file: target, source: 'workspace' });
  fileNotice('copied to the workspace — this is yours now', 'ok');
}
