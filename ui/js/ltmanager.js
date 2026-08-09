// The config screen's lieutenants section: who is on this board, and the facts
// about each one that nowhere else shows.
//
// Three of them are invisible today. The card PREFIX and the NEXT number it
// would mint — the id of the card he is about to create, before he creates it.
// The count of live cards it owns. And whether its SESSION is up: a lieutenant
// whose agent died still sits on the board looking exactly like a working one,
// so this row is the only place the difference reads.
//
// Both actions reuse what already exists — ⚙ is the switcher's own settings
// modal (name, colour, avatar, voice), ✎ opens the charter on the file screen,
// the same editor a playbook opens in. Retiring is deliberately absent: the
// switcher's ⋯ menu already has it, and a second door onto the one destructive
// verb is how it gets opened by accident.
import { api } from './api.js';
import { lieutenantColor } from './state.js';
import { avatarHtml } from './avatars.js';
import { openLtSettings } from './ltswitcher.js';
import { openArtifactFile } from './detail.js';

const listEl = document.getElementById('lt-list');

// [{id, name, color, avatar, prefix, next, cards, memory, session}] — the last
// answer from /api/lieutenants?live=1, in the order the board holds them.
let items = null;
let loading = false;

// Same contract as the projects and playbooks sections: `reload` is what the tab
// passes on the way in, so entering reads the session probes afresh while the
// renders that follow — one per board event — repaint what is already here.
// Nothing runs while another tab is up, so opening the screen for labels asks
// the harness nothing.
export async function renderLieutenants(reload) {
  if (reload) items = null;
  if (items) return paint();
  if (loading) return;
  loading = true;
  try {
    items = (await api.lieutenants(true)).lieutenants || [];
  } catch (e) {
    listEl.textContent = '⚠ ' + e.message;
    return;
  } finally { loading = false; }
  paint();
}

// The three session states the server answers with, each said as the thing the
// captain would do about it.
const SESSION = {
  live: { text: 'live', cls: 'lt-live', title: 'the harness says its session is up' },
  dead: { text: 'dead', cls: 'lt-dead', title: 'it had a session and it is gone — the board respawns it, or reset it yourself' },
  none: { text: 'no session', cls: 'lt-none', title: 'never spawned: this lieutenant is registered but nothing is running for it' },
};

function paint() {
  listEl.textContent = '';
  for (const l of items) {
    const row = document.createElement('div');
    row.className = 'lt-row';
    row.appendChild(head(l));
    row.appendChild(fact('mints', l.next, 'the id of the next card ' + (l.name || l.id) + ' creates'));
    row.appendChild(fact('cards', l.cards === 1 ? '1 live card' : l.cards + ' live cards'));
    const st = SESSION[l.session] || SESSION.none;
    row.appendChild(fact('session', st.text, st.title, st.cls));
    row.appendChild(actions(l));
    listEl.appendChild(row);
  }
  if (!items.length) listEl.textContent = 'no lieutenants';
}

// avatar in its own colour, the display name, and the id — the id is what every
// verb takes, so it reads as a value rather than a caption.
function head(l) {
  const el = document.createElement('div');
  el.className = 'lt-head';
  const face = document.createElement('span');
  if (Number.isInteger(l.avatar) && l.avatar >= 0 && l.avatar <= 63) {
    face.className = 'lt-face';
    face.style.borderColor = lieutenantColor(l.id);
    face.innerHTML = avatarHtml(l.avatar);
  } else {
    face.className = 'lt-dot';
    face.style.background = lieutenantColor(l.id);
  }
  const name = document.createElement('span');
  name.className = 'lt-name';
  name.textContent = l.name || l.id;
  const id = document.createElement('span');
  id.className = 'lt-id';
  id.textContent = l.id;
  el.append(face, name, id);
  return el;
}

function fact(key, value, title, cls) {
  const row = document.createElement('div');
  row.className = 'lt-fact' + (cls ? ' ' + cls : '');
  if (title) row.title = title;
  const k = document.createElement('span');
  k.className = 'lt-k';
  k.textContent = key;
  const v = document.createElement('span');
  v.className = 'lt-v';
  v.textContent = value;
  row.append(k, v);
  return row;
}

function actions(l) {
  const el = document.createElement('div');
  el.className = 'lt-acts';
  el.append(
    action('⚙ settings', 'name, colour, avatar, voice, card prefix', () => openLtSettings(l.id)),
    action('✎ charter', l.memory, () => openCharter(l)),
  );
  return el;
}

function action(label, title, onClick) {
  const b = document.createElement('button');
  b.type = 'button';
  b.className = 'lt-act';
  b.textContent = label;
  b.title = title;
  b.onclick = onClick;
  return b;
}

// The charter is a file, so editing it is the file screen — the same 💾, the
// same version check, the same 409 as a playbook or a card artifact. A
// lieutenant that never wrote one opens on the empty document (the board answers
// version '' for it), and the first save creates the file.
async function openCharter(l) {
  try {
    await openArtifactFile('file://' + l.memory, (l.name || l.id) + ' — README.md');
  } catch (e) {
    listEl.textContent = '⚠ cannot open the charter of ' + l.id + ' — ' + e.message;
  }
}
