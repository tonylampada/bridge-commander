// notifysettings.js — persisted notification settings, the "notifications"
// section of the settings panel, and the driver that turns new board events
// into toasts/sounds. Mirrors voice.js's localStorage + gesture-unlock pattern.
import { kindEmoji } from './state.js';
import { defaultCategoryPolicy, policyFor, selectNewEvents } from './notifypolicy.js';
import * as sound from './sound.js';
import * as toast from './toast.js';

// New key: the old per-kind blob (bc-notif-settings) is simply ignored, no
// migration — the settings shape changed too much to translate meaningfully.
const KEY = 'bc-notify2';

// One row per category, not per kind — the captain said per-kind was too
// many options. Order here is render order.
const CATEGORIES = [
  { key: 'done', emoji: '✅', label: 'Card finished' },
  { key: 'chat', emoji: '💬', label: 'New chat message' },
  { key: 'error', emoji: '💥', label: 'Something went wrong' },
  { key: 'other', emoji: '🔔', label: 'Everything else' },
];

function loadSettings() {
  try {
    const raw = JSON.parse(localStorage.getItem(KEY));
    if (raw && typeof raw === 'object') {
      return { master: raw.master !== false, volume: typeof raw.volume === 'number' ? raw.volume : 0.7, categories: Object.assign({}, raw.categories) };
    }
  } catch (e) {}
  return { master: true, volume: 0.7, categories: {} };
}
const settings = loadSettings();
sound.setVolume(settings.volume);

function saveSettings() {
  try { localStorage.setItem(KEY, JSON.stringify(settings)); } catch (e) {}
}

function effective(cat) {
  const ov = settings.categories[cat] || {};
  const base = defaultCategoryPolicy()[cat];
  return {
    toast: ov.toast !== undefined ? ov.toast : base.toast,
    sound: ov.sound !== undefined ? ov.sound : base.sound,
  };
}
function setOverride(cat, patch) {
  settings.categories[cat] = Object.assign({}, settings.categories[cat], patch);
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

function rowFor(cat) {
  const row = document.createElement('div');
  row.className = 'ns-row';

  const em = document.createElement('span');
  em.className = 'ns-em';
  em.textContent = cat.emoji;

  const name = document.createElement('span');
  name.className = 'ns-name';
  name.textContent = cat.label;

  const eff = effective(cat.key);

  const cb = document.createElement('input');
  cb.type = 'checkbox';
  cb.title = 'show toast';
  cb.checked = eff.toast;
  cb.onchange = () => setOverride(cat.key, { toast: cb.checked });

  const sel = document.createElement('select');
  sel.title = 'sound';
  for (const n of sound.SOUND_NAMES) {
    const o = document.createElement('option');
    o.value = n;
    o.textContent = n;
    sel.appendChild(o);
  }
  sel.value = eff.sound;
  sel.onchange = () => setOverride(cat.key, { sound: sel.value });

  const prev = document.createElement('button');
  prev.type = 'button';
  prev.className = 'ns-prev';
  prev.title = 'preview this sound';
  prev.textContent = '▶';
  prev.onclick = () => sound.play(sel.value);

  row.append(em, name, cb, sel, prev);
  return row;
}

function renderList() {
  if (listEl.contains(document.activeElement)) return; // don't clobber an in-progress edit
  listEl.textContent = '';
  for (const cat of CATEGORIES) listEl.appendChild(rowFor(cat));
}

export function renderNotifSettings() {
  renderMaster();
  renderList();
}
