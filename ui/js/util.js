// small shared helpers
export function esc(s) {
  return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}
export function ago(iso) {
  if (!iso) return '';
  const s = (Date.now() - new Date(iso).getTime()) / 1000;
  if (s < 60) return 'now';
  if (s < 3600) return Math.floor(s / 60) + 'm';
  if (s < 86400) return Math.floor(s / 3600) + 'h';
  return Math.floor(s / 86400) + 'd';
}
export function hhmm(iso) {
  try { return new Date(iso).toTimeString().slice(0, 5); } catch (e) { return ''; }
}
export function dayLabel(iso) {
  const d = new Date(iso), today = new Date();
  const key = d.toDateString();
  if (key === today.toDateString()) return 'today';
  const yd = new Date(today.getTime() - 86400000);
  if (key === yd.toDateString()) return 'yesterday';
  return d.toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
}

// default emojis for the card `type` attribute; attributes.emoji overrides,
// unknown types fall back to the neutral marker below
const TYPE_EMOJI = {
  plan: '🧠', implementation: '🔥', investigation: '🕵️‍♂️',
};
export function cardEmoji(card) {
  const at = (card && card.attributes) || {};
  if (at.emoji) return String(at.emoji);
  if (at.type && TYPE_EMOJI[String(at.type).toLowerCase()]) return TYPE_EMOJI[String(at.type).toLowerCase()];
  return '▫️';
}

const OWNER_PALETTE = ['#58b6ff', '#3ecf8e', '#e6c04a', '#c678dd', '#e2795b', '#56b6c2', '#98c379', '#e06c75'];
export function ownerColor(name) {
  let h = 5381;
  for (let i = 0; i < name.length; i++) h = ((h * 33) ^ name.charCodeAt(i)) >>> 0;
  return OWNER_PALETTE[h % OWNER_PALETTE.length];
}

// attributes.prs — [{url, state: open|merged|closed}] — the only PR source on a card
const PR_STATES = new Set(['open', 'merged', 'closed']);
export function cardPrs(card) {
  const v = card && card.attributes && card.attributes.prs;
  if (!Array.isArray(v)) return [];
  return v.filter((e) => e && typeof e === 'object' && typeof e.url === 'string' && e.url);
}
// state is whitelisted before it reaches the class name (XSS-safe); unknown
// states render as open. withState adds the state word for the roomier detail view.
export function prChipHtml(pr, withState) {
  const state = PR_STATES.has(pr.state) ? pr.state : 'open';
  const m = /\/pull\/(\d+)\b/.exec(pr.url);
  const label = (m ? '#' + m[1] : 'PR') + (withState ? ' · ' + state : '');
  return '<a class="prchip pr-' + state + '" href="' + esc(pr.url) + '" target="_blank" rel="noopener"' +
    ' title="' + esc(pr.url) + ' (' + state + ')">' + esc(label) + '</a>';
}

// last path segment of a uri/path (query/hash stripped) — the artifact display name
export function uriBasename(uri) {
  const s = String(uri).replace(/[?#].*$/, '').replace(/\/+$/, '');
  const i = s.lastIndexOf('/');
  return i >= 0 ? s.slice(i + 1) : s;
}

// attributes.artifacts — [{uri, label}] — resources hung on the card (briefs, docs)
export function cardArtifacts(card) {
  const v = card && card.attributes && card.attributes.artifacts;
  if (!Array.isArray(v)) return [];
  return v.filter((e) => e && typeof e === 'object' && typeof e.uri === 'string' && e.uri);
}
