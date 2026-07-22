// archive.js — the shared archived-cards cache. Both views render from it when
// the popup's 🧊 toggle is on: the table interleaves frozen rows, the kanban
// grows an extra archived column. Fetched on demand, invalidated on restore;
// the frozen snapshots honor the same filter state as live cards (minus the
// column filter — an archived card is in no live column, so a column filter
// simply hides them).
import { api } from './api.js';
import { S, cards, lieutenantName, render } from './state.js';

let recs = [];        // /api/archive records, newest first
let fetched = false;
let fetching = false;

export function ensureArchive() {
  if (fetched || fetching) return;
  fetching = true;
  api.archive()
    .then((r) => { recs = r.archive || []; fetched = true; })
    .catch(() => { recs = []; })
    .finally(() => { fetching = false; render(); });
}

function haystack(c) {
  return [c.title, c.id, c.body, c.type, c.owner, lieutenantName(c.owner), (c.labels || []).join(' ')]
    .filter(Boolean).join(' ').toLowerCase();
}
function archVisible(c) {
  if (S.filters.column) return false; // archived cards are in no live column
  const q = S.filters.text.trim().toLowerCase();
  if (q && !haystack(c).includes(q)) return false;
  if (S.filters.type && c.type !== S.filters.type) return false;
  for (const f of S.filters.sel) {
    if (f.kind === 'owner') { if ((c.owner || '') !== f.value) return false; }
    else if (!(c.labels || []).includes(f.value)) return false;
  }
  return true;
}

// visible frozen rows: latest record per id, minus cards live again (a record
// stays in the append-only archive after a restore — the board is truth)
export function archivedRows() {
  const live = new Set(cards().map((c) => c.id));
  const seen = new Set();
  const out = [];
  for (const r of recs) {
    if (!r || !r.card || !r.card.id || live.has(r.card.id) || seen.has(r.card.id)) continue;
    seen.add(r.card.id);
    if (archVisible(r.card)) out.push({ c: r.card, arch: r });
  }
  return out;
}

export function unarchive(id, btn) {
  if (btn) btn.disabled = true;
  api.restoreCard(id)
    .then(() => { fetched = false; ensureArchive(); }) // the broadcast brings the live card
    .catch((e) => { if (btn) btn.disabled = false; alert(e.message); });
}
