// archive.js — the paginated archived-cards store behind the 🧊 mode.
// The real archive is an append-only unbounded jsonl, so it is read on demand
// in pages (newest first) and never mixed into the live board doc: page-in
// with loadMore(), keep the total for the "shown X of Y" footer. The filters
// that make sense on frozen snapshots (text/owner/label/type) apply
// client-side to the pages loaded so far.
import { api } from './api.js';
import { S, cards, lieutenantName, render } from './state.js';

export const PAGE = 20;
let recs = [];        // pages loaded so far, newest first
let total = 0;        // server-side record count
let loaded = false;
let loading = false;

export function ensureArchive() { if (!loaded && !loading) fetch(PAGE, true); }
export function loadMore() { if (!loading) fetch(PAGE, false); }
// resync everything already on screen (after a restore): one fetch of the
// same window size, so the row count doesn't jump back to one page
function refetch() { fetch(Math.max(PAGE, recs.length), true); }
function fetch(limit, reset) {
  loading = true;
  api.archive(limit, reset ? 0 : recs.length)
    .then((r) => {
      const page = r.archive || [];
      recs = reset ? page : recs.concat(page);
      total = r.total || page.length;
      loaded = true;
    })
    .catch(() => { if (reset) { recs = []; total = 0; } })
    .finally(() => { loading = false; render(); });
}

function haystack(c) {
  return [c.title, c.id, c.body, c.type, c.owner, lieutenantName(c.owner), (c.labels || []).join(' ')]
    .filter(Boolean).join(' ').toLowerCase();
}
function archVisible(c) {
  const q = S.filters.text.trim().toLowerCase();
  if (q && !haystack(c).includes(q)) return false;
  if (S.filters.type && c.type !== S.filters.type) return false;
  for (const f of S.filters.sel) {
    if (f.kind === 'owner') { if ((c.owner || '') !== f.value) return false; }
    else if (!(c.labels || []).includes(f.value)) return false;
  }
  return true;
}

// visible frozen rows over the loaded pages: latest record per id, minus cards
// live again (a record stays in the append-only archive after a restore — the
// board is truth), then the frozen-side filters
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
export function archiveStats() {
  return { loaded: recs.length, total, more: loaded && recs.length < total, loading };
}

export function unarchive(id, btn) {
  if (btn) btn.disabled = true;
  api.restoreCard(id)
    .then(() => refetch()) // the broadcast brings the live card; refetch drops the row
    .catch((e) => { if (btn) btn.disabled = false; alert(e.message); });
}
