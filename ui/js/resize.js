// draggable widths for the side panels: the left chat pane and the card detail.
// Each panel's width lives in a CSS custom property with its stock value as the
// fallback, so the narrow-screen media queries (which set explicit widths and
// hide the handles) keep winning untouched. Chosen widths persist per panel in
// localStorage; clamps keep the board area usable at either extreme.
const PANELS = [
  { handle: 'chat-resize', key: 'bc-chat-w', prop: '--chat-w',
    min: 280, max: () => Math.min(720, window.innerWidth - 420),
    widthAt: (e) => e.clientX },                       // chat sits at the left edge
  { handle: 'detail-resize', key: 'bc-detail-w', prop: '--detail-w',
    min: 380, max: () => Math.min(920, window.innerWidth - 360),
    widthAt: (e) => window.innerWidth - e.clientX },   // detail is fixed to the right edge
];
const root = document.documentElement;

function clamp(p, w) { return Math.round(Math.min(Math.max(w, p.min), Math.max(p.min, p.max()))); }
function saved(p) {
  try { return parseInt(localStorage.getItem(p.key), 10) || 0; } catch (e) { return 0; }
}
function apply(p, w) { root.style.setProperty(p.prop, clamp(p, w) + 'px'); }

for (const p of PANELS) {
  if (saved(p)) apply(p, saved(p));
  const h = document.getElementById(p.handle);
  h.onpointerdown = (e) => {
    e.preventDefault();
    h.setPointerCapture(e.pointerId);
    document.body.classList.add('resizing');
    h.onpointermove = (ev) => apply(p, p.widthAt(ev));
    h.onpointerup = (ev) => {
      h.onpointermove = null; h.onpointerup = null;
      h.releasePointerCapture(ev.pointerId);
      document.body.classList.remove('resizing');
      try { localStorage.setItem(p.key, String(clamp(p, p.widthAt(ev)))); } catch (err) {}
    };
  };
  // double-click restores the stock width
  h.ondblclick = () => {
    root.style.removeProperty(p.prop);
    try { localStorage.removeItem(p.key); } catch (e) {}
  };
}
// a shrunken window re-clamps any custom width so panels never crush the board
window.addEventListener('resize', () => {
  for (const p of PANELS) if (saved(p)) apply(p, saved(p));
});
