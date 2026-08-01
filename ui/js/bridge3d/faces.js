// faces.js — the lieutenants' heads, inside the session.
//
// The 2D board draws these with a CSS sprite (ui/js/avatars.js), which is no use
// in here: an immersive session has no DOM to hang a background-position on.
// Same sheet, same indices, painted onto the panel canvas with drawImage.
//
// One Image for the whole room. It is fetched once and shared, and a panel
// painted before it decodes is repainted when it lands — otherwise the first
// second in the room is a bar of faceless dots that never come back.

const COLS = 8;
const COUNT = COLS * COLS;
// 1254 / 8 = 156.75. The sheet does not divide into whole pixels, so the source
// rect is rounded and pulled in by one on each side: a face that reaches its
// cell's edge otherwise brings a slice of its neighbour along with it.
const CELL = 1254 / COLS;

const img = new Image();
let ready = false;
const waiting = [];

img.onload = () => { ready = true; waiting.splice(0).forEach((fn) => fn()); };
img.src = new URL('../../img/avatars.png', import.meta.url).href;

// whenFaces(cb) — called once the sheet is usable (immediately, if it already
// is). The room hands it its repaint.
export function whenFaces(cb) { if (ready) cb(); else waiting.push(cb); }

// face(g, idx, cx, cy, r, colour) — a head in a circle of the lieutenant's own
// colour, the same mark ltswitcher.js draws on the flat board. No avatar, or a
// sheet that has not landed yet, falls back to the coloured dot — which is the
// fallback and not a bug.
export function face(g, idx, cx, cy, r, colour) {
  const has = ready && Number.isInteger(idx) && idx >= 0 && idx < COUNT;
  g.save();
  g.beginPath();
  g.arc(cx, cy, r, 0, Math.PI * 2);
  if (has) {
    g.clip();
    const s = Math.round(CELL) - 2;
    g.drawImage(img, Math.round((idx % COLS) * CELL) + 1, Math.round(Math.floor(idx / COLS) * CELL) + 1, s, s,
      cx - r, cy - r, r * 2, r * 2);
  } else {
    g.fillStyle = colour || '#66788a';
    g.fill();
  }
  g.restore();
  if (has) {
    g.beginPath();
    g.arc(cx, cy, r, 0, Math.PI * 2);
    g.strokeStyle = colour || '#66788a';
    g.lineWidth = Math.max(2, r * 0.12);
    g.stroke();
  }
}
