// room.js — where things stand, and what standing there means.
//
// Pure: no three.js, no DOM. The room's policy is the part most likely to be
// wrong about the captain's habits, so it is the part that has to be arguable
// in a test rather than only in a headset.
//
// The captain's own model, in his order:
//
//   the LIEUTENANTS are always in front and never close — talking to one is the
//   interaction, and everything else is optional;
//   the BOARD is where he remembers what is in flight and decides where his
//   attention goes next, so it is always available but not always in front;
//   the WINDOWS are the work, as many as attention allows.
//
// Nothing is ever put behind him. Swapping has to cost a button press, never a
// neck movement — that is the whole reason "background" here means further away
// and dimmer rather than over your shoulder.

export const EYE = 1.45;

// ---- arc, the only unit a person actually perceives -------------------------
//
// A size in canvas pixels means nothing on its own, and neither does a size in
// metres: half a metre is a wall at arm's length and a postage stamp across the
// room. Everything the captain reads or points at is authored in DEGREES here
// and converted at the distance its own panel sits — which is why a Surface is
// told where it stands, and sizes its own type from that.

export const PPD = 25;              // what a Quest 3 effectively resolves, px/°
export const CAP = 0.72;            // cap height as a fraction of the em box

// Em-box degrees. The floor is 0.7° of CAP height, and `meta` is the smallest
// thing painted anywhere in the room: 1.15 × 0.72 = 0.83°, clear of it.
export const TYPE = { head: 2.0, body: 1.4, meta: 1.15 };

// A target under 3° is a target you stab at; two of them closer than 1.6° apart
// are one target that sometimes does the other thing. These are the FLOORS —
// what a measurement is held against.
export const HIT = { min: 3.0, gap: 1.6 };

// And this is what the room BUILDS to. A box constructed to land exactly on
// 3.000° lands a rounding error under it about half the time, and
// fractionally-below is not met — so every target is cut a hair over its floor
// and the floor stays the floor.
export const BUILD = { min: HIT.min + 0.06, gap: HIT.gap + 0.06 };

// Nothing readable comes nearer than NEAR — discomfort rises exponentially as
// content approaches the face — and past FAR the eyes are working at a depth
// the headset's fixed focal plane cannot meet.
export const NEAR = 0.5;
export const FAR = 2.0;

// Looking up is the fastest route to a sore neck: nothing's top edge goes above
// RISE, and a panel he reads sits with its centre a comfortable glance DOWN.
export const RISE = 10;
export const DROP = [10, 20];

export function arcDeg(sizeM, distM) { return 2 * Math.atan(sizeM / (2 * distM)) * 180 / Math.PI; }
export function sizeForArc(deg, distM) { return 2 * distM * Math.tan(deg * Math.PI / 360); }

// Canvas texels a panel wants per world metre, so one degree of its arc gets PPD
// of them. Under-resolving here is the usual reason canvas text looks soft.
export function texelsPerMetre(distM) { return PPD / sizeForArc(1, distM); }

// How far a thing placed at p is from the eye — the number every arc above is
// measured against, so it is computed and never assumed from z alone.
export function eyeDistance(p) {
  return Math.hypot(p.x || 0, (p.y === undefined ? EYE : p.y) - EYE, p.z || 0);
}

// What each surface is, in metres. Here rather than in panels.js because these
// are half of every arc figure in the room, and the tests check them.
//
// How tall a panel may be is not a taste: the room has about 45° of usable
// vertical field — from +10°, past which looking up is a sore neck, down to the
// bottom of a comfortable glance — and the bar takes the bottom 9° of it. What
// is left is ~35°, which is 0.90 m at the distance the board stands. A panel's
// METRES do not decide how much it shows; its DEGREES do, and they are all the
// room has to spend.
export const PANEL = {
  bar: { widthM: 1.2, heightM: 0.15 },
  board: { widthM: 1.9, heightM: 0.90 },
  card: { widthM: 1.5, heightM: 0.86 },
  chat: { widthM: 0.9, heightM: 0.86 },
};

// The board reads at 1.58 m in front and 1.93 m pushed back — both inside the
// comfort band, where the old back position (3.1 m) put its body text at 0.35°
// and made the remembering surface a thing he had to lean towards. Centred 11°
// below the horizon, which is where the eyes rest.
export const FRONT = { z: -1.55, y: EYE - 0.30, dim: 1 };
export const BACK = { z: -1.90, y: EYE - 0.36, dim: 0.55 };

// The bar sits low and close, under the conversation rather than in it — near
// enough to hit without aiming, far enough down not to cover a face. Its top
// edge clears the bottom of everything in the front row: the lieutenants are
// the one thing always visible, so they are also the one thing that must never
// be sitting on top of the work.
export const BAR = { x: 0, y: EYE - 0.62, z: -1.00 };

// placeWindow(index, count) — where the n-th open window goes: an arc in front,
// widening as more open, never wrapping past the shoulders. Beyond that the
// captain is out of attention, which is his limit to set, not ours — so they
// stack rather than spiral out of reach.
//
// Rows step back and down together, and by little: the far row still has to land
// inside FAR, or the windows he is not working on become the unreadable ones.
// Which is also why there is a LAST row — a fourth would have landed at 2.20 m
// with its bottom edge under the floor. Past it the windows crowd into the row
// he already has rather than going further away, which is what "they stack"
// meant all along.
export function placeWindow(index, count) {
  const perRow = 3, rows = 3;
  const row = Math.min(rows - 1, Math.floor(index / perRow));
  const col = index - row * perRow;
  const left = count - row * perRow;
  const inRow = Math.max(1, row === rows - 1 ? left : Math.min(perRow, left));
  const spread = 60;                                    // degrees across a row
  const step = inRow > 1 ? spread / (inRow - 1) : 0;
  const a = ((inRow > 1 ? -spread / 2 + col * step : 0)) * Math.PI / 180;
  const radius = 1.35 + row * 0.15;
  return {
    x: Math.sin(a) * radius,
    y: EYE - 0.24 - row * 0.34,
    z: -Math.cos(a) * radius,
  };
}

// Which single thing is in front. The board and the windows share one front;
// the bar is not in the running because it never leaves.
//
// Opening something takes the front, because opening it IS the decision to work
// on it. Closing the front hands it back to the board — never to nothing, or
// the room would go empty in his hands.
export function nextFront(state, event) {
  const open = state.open || [];
  if (event.kind === 'open') return event.id;
  if (event.kind === 'close') {
    const rest = open.filter((id) => id !== event.id);
    if (state.front !== event.id) return state.front;
    return rest.length ? rest[rest.length - 1] : 'board';
  }
  if (event.kind === 'swap') return state.front === 'board' ? (open[open.length - 1] || 'board') : 'board';
  if (event.kind === 'focus') return event.id;
  return state.front;
}

// One window per thing. Clicking the same card twice brings it forward instead
// of opening a second copy of it — but the SAME lieutenant may be opened beside
// a card, because two chats with one agent at once is a thing he asked for.
export function openWindows(open, id) {
  return open.includes(id) ? open : open.concat([id]);
}
