// kit.js — the layout engine and the type, wired in once.
//
// Every surface in the old room was painted by hand onto a canvas, and every
// size on it was a number of pixels somebody had to convert back to degrees to
// know whether it was readable. That is gone. `@pmndrs/uikit` brings flexbox
// (Yoga) and MSDF text that stays sharp at any distance, vendored unmodified
// under `ui/vendor/` and reached through the page's import map.
//
// **Components are imported ONE AT A TIME, never the package barrel.** The
// barrel drags in the SVG component, which reaches for a three.js addon we do
// not vendor, and in the finished kits it pulls an icon set of 1,595 modules.
// Per-component is the intended workflow — see `building.md`.

import { Container } from '../../vendor/uikit/components/container.js';
import { Text } from '../../vendor/uikit/components/text.js';
import { Input } from '../../vendor/uikit/components/input.js';
import { reversePainterSortStable } from '../../vendor/uikit/order.js';

export { Container, Text, Input, reversePainterSortStable };

// uikit's own unit is a "pixel", and `pixelSize` says what one is worth in the
// world. At 0.01 a layout unit is a centimetre, which is the size the room
// thinks in — so `width: 12` is 12 cm and `fontSize: 4.3` is a 4.3 cm em box.
export const PIXEL = 0.01;
export const cm = (m) => m / PIXEL;

// The room's palette. Dark plate, light type: 4.5:1 for body text and 3:1 for
// UI shapes, and nothing below #0D0D0D carries information because the panel
// cannot tell those levels from black.
export const COL = {
  shelf: '#111923',
  slot: '#161f2b',
  slotLit: '#22303f',
  slab: '#1d2836',
  text: '#c8d2e0',
  dim: '#8ea2c0',
  faint: '#5b6b82',
  accent: '#4cc2ff',
  ink: '#05070b',
  decal: '#2b3a4d',
};

// Every root has to be told to lay itself out each frame. One registry rather
// than each module keeping its own, so main.js has one line in the loop.
const roots = new Set();

export function root(properties) {
  const c = new Container({ pixelSize: PIXEL, ...properties });
  roots.add(c);
  return c;
}

export function updateRoots(dt) { for (const r of roots) r.update(dt); }

export function rootCount() { return roots.size; }

// A font size in DEGREES, at the distance the surface stands — the only way a
// size gets authored in this room. Returns uikit's own units.
export function fontFor(deg, distM) { return cm(2 * distM * Math.tan(deg * Math.PI / 360)); }

// uikit panels are transparent and have to be sorted back to front, which is
// what this comparator is for. Set once, on the renderer.
export function sortTransparent(renderer) {
  renderer.setTransparentSort(reversePainterSortStable);
}

// Nothing uikit draws is a pointer target unless we say so — the ray in this
// room lands on slots, spheres and the panel's own controls, not on a glyph.
//
// It has to go through `setProperties` and not through the field: uikit rewrites
// `component.pointerEvents` out of its own properties on every effect pass, and
// a plain assignment survives exactly until the next one. That is how a shelf's
// glyph layer — a full-shelf plane sitting two millimetres in FRONT of the slots
// — quietly ate every ray in the room.
export function inert(object) {
  if (object.setProperties) object.setProperties({ pointerEvents: 'none' });
  else object.pointerEvents = 'none';
  return object;
}

// ---- what the font can actually draw ---------------------------------------
//
// An MSDF font is an atlas, not an outline library: the vendored Inter sheet
// carries exactly the 104 glyphs below and nothing else. A character outside it
// is not a fallback, it is a hole in the sentence plus a console warning per
// frame — and the board's own column titles start with an emoji, so this is not
// hypothetical. Every string the room paints goes through `safe` first.
//
// The list is checked against the vendored sheet by a test, so a font swap that
// changes the coverage fails loudly rather than quietly dropping letters.
export const GLYPHS = '|ÖÜWj$Ä()@[]{}§\\/Q%äöüfgw&03689?CGMOSUimpqy!#12457ABDEFHIJKLNPRTVXYZbdhklß;taceos<>nruvxz:~+=_*^°-"\',`.';

const FOLD = {
  '…': '...', '×': 'x', '·': '-', '–': '-', '—': '-', '‘': "'", '’': "'",
  '“': '"', '”': '"', '→': '->', '←': '<-', '•': '-', ' ': ' ',
};

export function safe(text) {
  let out = '';
  for (const ch of String(text == null ? '' : text)) {
    const c = FOLD[ch] !== undefined ? FOLD[ch] : ch;
    for (const k of c) out += (k === ' ' || GLYPHS.includes(k)) ? k : '';
  }
  return out.replace(/\s+/g, ' ').trim();
}
