// notifysettings.js — persisted notification settings, the "notifications"
// section of the settings panel, and the driver that turns new board events
// into toasts/sounds. Mirrors voice.js's localStorage + gesture-unlock pattern.
import { kinds, kindEmoji } from './state.js';
import { defaultsFor, policyFor, selectNewEvents } from './notifypolicy.js';
import * as sound from './sound.js';
import * as toast from './toast.js';

const KEY = 'bc-notif-settings';

function loadSettings() {
  try {
    const raw = JSON.parse(localStorage.getItem(KEY));
    if (raw && typeof raw === 'object') {
      return { master: raw.master !== false, volume: typeof raw.volume === 'number' ? raw.volume : 0.7, kinds: Object.assign({}, raw.kinds) };
    }
  } catch (e) {}
  return { master: true, volume: 0.7, kinds: {} };
}
const settings = loadSettings();
sound.setVolume(settings.volume);

function saveSettings() {
  try { localStorage.setItem(KEY, JSON.stringify(settings)); } catch (e) {}
}

function effective(kind, level) {
  const ov = settings.kinds[kind] || {};
  const base = defaultsFor(kind, level);
  return {
    toast: ov.toast !== undefined ? ov.toast : base.toast,
    sound: ov.sound !== undefined ? ov.sound : base.sound,
  };
}
function setOverride(kind, patch) {
  settings.kinds[kind] = Object.assign({}, settings.kinds[kind], patch);
  saveSettings();
}

// ---------- driver: new events -> toast/sound ----------
// mirrors voice.js's trackMessages: first call just seeds the seen-set (no
// firing), thereafter each genuinely-new event resolves its policy.
let firstLoad = true;
const seen = new Set();
export function trackEvents(doc) {
  if (!doc) return;
  const events = selectNewEvents(seen, doc);
  if (firstLoad) { firstLoad = false; return; }
  for (const e of events) {
    const p = policyFor(e.kind, e.level, settings);
    if (p.toast) toast.push({ emoji: kindEmoji(e.kind), text: e.text, cardTitle: e.cardTitle, actor: e.actor, card: e.card });
    if (p.sound && p.sound !== 'none') sound.play(p.sound);
  }
}

// ---------- settings section (rendered inside #settings-panel while open) ----------
const masterBtn = document.getElementById('ns-master-btn');
const volumeInput = document.getElementById('ns-volume');
const bodyEl = document.getElementById('ns-body');
const listEl = document.getElementById('ns-list');

function renderMaster() {
  masterBtn.classList.toggle('on', settings.master);
  masterBtn.textContent = settings.master ? '🔔 on' : '🔕 off';
  bodyEl.classList.toggle('dim', !settings.master);
  if (document.activeElement !== volumeInput) volumeInput.value = settings.volume;
}
masterBtn.onclick = () => { settings.master = !settings.master; saveSettings(); renderMaster(); };
volumeInput.oninput = () => { settings.volume = parseFloat(volumeInput.value); sound.setVolume(settings.volume); saveSettings(); };

function rowFor(kind, level) {
  const row = document.createElement('div');
  row.className = 'ns-row';

  const em = document.createElement('span');
  em.className = 'ns-em';
  em.textContent = kindEmoji(kind) || '·';

  const name = document.createElement('span');
  name.className = 'ns-name';
  name.textContent = kind;

  const eff = effective(kind, level);

  const cb = document.createElement('input');
  cb.type = 'checkbox';
  cb.title = 'show toast';
  cb.checked = eff.toast;
  cb.onchange = () => setOverride(kind, { toast: cb.checked });

  const sel = document.createElement('select');
  sel.title = 'sound';
  for (const n of sound.SOUND_NAMES) {
    const o = document.createElement('option');
    o.value = n;
    o.textContent = n;
    sel.appendChild(o);
  }
  sel.value = eff.sound;
  sel.onchange = () => setOverride(kind, { sound: sel.value });

  const prev = document.createElement('button');
  prev.type = 'button';
  prev.className = 'ns-prev';
  prev.title = 'preview this sound';
  prev.textContent = '▶';
  prev.onclick = () => sound.play(sel.value);

  row.append(em, name, cb, sel, prev);
  return row;
}

let lastListHtml = null;
function renderList() {
  if (listEl.contains(document.activeElement)) return; // don't clobber an in-progress edit
  const km = kinds();
  const entries = Object.keys(km).map((k) => ({ kind: k, level: km[k].level === 2 ? 2 : 1 }));
  entries.sort((a, b) => a.kind.localeCompare(b.kind));
  const lvl1 = entries.filter((e) => e.level === 1);
  const lvl2 = entries.filter((e) => e.level === 2);

  const tmp = document.createElement('div');
  for (const e of lvl1) tmp.appendChild(rowFor(e.kind, e.level));
  if (lvl2.length) {
    const det = document.createElement('details');
    det.className = 'ns-quiet';
    const sum = document.createElement('summary');
    sum.textContent = 'quiet events (' + lvl2.length + ')';
    det.appendChild(sum);
    for (const e of lvl2) det.appendChild(rowFor(e.kind, e.level));
    tmp.appendChild(det);
  }
  if (lastListHtml === tmp.innerHTML) return; // same kinds set — leave live rows/interactions alone
  lastListHtml = tmp.innerHTML;
  listEl.textContent = '';
  while (tmp.firstChild) listEl.appendChild(tmp.firstChild);
}

export function renderNotifSettings() {
  renderMaster();
  renderList();
}
