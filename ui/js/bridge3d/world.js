// world.js — where every thing in the room stands, said in degrees first.
//
// Pure: no three.js, no uikit, no DOM. Everything here is arithmetic about a
// head at the origin, so the room's geometry is arguable in a test rather than
// only in a headset.
//
// What is CORRECT — the arc a target has to cover, how far a thing stands, what
// earns being an object rather than a panel — lives in the `vr-design` skill and
// its `world.md`. This file is the room BUILT to those numbers; it does not
// restate the reasoning, it cites it.
//
// The one line that governs the whole thing: **give a thing a place, not a
// space.** Four bounded shelves that never move, a landmark on the floor under
// each, objects in slots on a surface, and the third axis deliberately spent on
// nothing at all.
//
// ---- the angles, and where they come from ---------------------------------
//
// A degree is the only unit a person perceives. Every figure below is authored
// in degrees and turned into metres at the distance the thing actually sits —
// which for a shelf tilted back from vertical is NOT the shelf's own radius, so
// slot positions are found by intersecting a gaze ray with the shelf plane and
// the distance falls out of that.

const D = Math.PI / 180;

export const EYE = 1.45;                 // eye height above the real floor, metres

export function arcDeg(sizeM, distM) { return 2 * Math.atan(sizeM / (2 * distM)) * 180 / Math.PI; }
export function sizeForArc(deg, distM) { return 2 * distM * Math.tan(deg * D / 2); }

// A sphere is not a flat card: what it covers is set by its radius against the
// line of sight, so the radius that subtends `deg` is a sine and not a tangent.
export function sphereForArc(deg, distM) { return distM * Math.sin(deg * D / 2); }

// Em-box degrees. The floor is 0.7° of CAP height; `meta`, the smallest thing
// painted anywhere in the room, is 1.15 × 0.72 = 0.83°, clear of it.
export const CAP = 0.72;
export const TYPE = { head: 2.0, body: 1.4, meta: 1.15 };

// The floors, corrected. 3° is the floor for the DRAWN MARK and it is not a
// specification for the hit box: a hand-held ray scatters to an effective width
// of 3.7°–6°, so a 3° collider is missed a good fraction of the time by somebody
// aiming correctly. Draw at 3°, pad the responsive region to 6°, and keep 1.6°
// of clear air between two of them.
export const MARK = 3.0;
export const HIT = 6.0;
export const GAP = 1.6;

// And this is what the room BUILDS to. A figure constructed to land exactly on
// its floor lands a rounding error under it about half the time, so everything
// is cut a hair over and the floor stays the floor.
export const BUILD = { mark: MARK + 0.06, hit: HIT + 0.06, gap: GAP + 0.06 };

// Nothing readable comes nearer than NEAR — discomfort rises exponentially as
// content approaches the face — and past FAR the eyes work at a depth the fixed
// focal plane cannot meet.
export const NEAR = 0.5;
export const FAR = 2.0;

// Looking up is the fastest route to a sore neck. RISE is the ceiling for
// anything at all; DROP is where a surface he READS is centred; FLOOR_LOOK is
// how far down a glance may go for a thing that is on the actual floor, because
// the floor is where floors are and a landmark on it cannot be raised.
export const RISE = 10;
export const DROP = [15, 20];
export const SINK = 35;
export const FLOOR_LOOK = 60;

// ---- the lattice ----------------------------------------------------------
//
// Everything interactive in this room sits on one angular lattice, and the
// lattice pitch is the floor: a 6.06° responsive region with 1.66° of air beside
// it. That is 7.72°, and it is the number the whole layout is built out of.
export const PITCH = BUILD.hit + BUILD.gap;                 // 7.72°

// Four shelves, one per column, centres 22.5° apart so the set spans ±33.75°
// of centre and ±42.6° of edge — inside the ±45° bound, with nothing behind him.
// The plate's own extent is not declared here — it is derived from the slots it
// holds, in `shelfExtent`, because the lattice fans as it drops and a width
// guessed at the shelf's centre would clip the bottom row.
export const SHELF = {
  radius: 1.75,             // metres, to the centre of each shelf
  tiltDeg: 25,              // back from vertical
  azimuths: [-33.75, -11.25, 11.25, 33.75],
};

// Two slots across, four rows down. **Not three across**, and that is the one
// place this room departs from the spec it was built from, so here is the
// arithmetic: twelve slots across the room at the 7.72° lattice pitch need
// 92.6° and the room only has 90°. The skill says exactly what to do when
// density will not allow the padding — "show fewer things, not smaller
// padding" — so the shelf holds eight and the ninth card onward becomes a
// count under the shelf. Three across is only reachable by shaving the hit
// boxes or the air between them, which is the mis-hit the padding exists to
// prevent.
//
// The top row is set by the spheres above it: an end sphere sits at 0°
// elevation with a 6.06° region, so its lower edge is at −3.03°, and the first
// row of cards has to start 1.66° below that. Four rows from there land the
// shelf's centre at −19.3°, inside the 15–20° resting band, and the bottom edge
// at −33.9°, clear of the −35° floor.
export const SLOT = { cols: 2, rows: 4, pitchDeg: PITCH, topElevDeg: -PITCH };
export const PER_SHELF = SLOT.cols * SLOT.rows;             // 8 visible

// A card is a slab standing in a slot. The face is authored in degrees, so a
// slot further up the tilted shelf is physically bigger and covers the same
// arc — which is what keeps the room readable rather than keeping a tape
// measure happy. 3.93° is the spec's 12 cm at 1.75 m; the height is the 3° mark
// floor with the room's usual hair on it, because 8 cm at 1.75 m is 2.62° and
// under the floor for a drawn mark.
export const CARD = {
  faceWDeg: arcDeg(0.12, SHELF.radius),                     // 3.93°
  faceHDeg: BUILD.mark,                                     // 3.06° ≈ 9.4 cm
  standM: 0.015,                                            // how far it stands off the shelf
  thinM: 0.010,                                             // slab thickness, brand new
  thickM: 0.030,                                            // slab thickness, old
  ageDays: 14,                                              // ...and how old "old" is
  bandDeg: 0.55,                                            // the owner's colour band, left edge
};

// Eight spheres, one per lieutenant, in an arc over the shelves: 0° at the ends
// rising to +5° in the middle, never higher. Fixed positions that never sort and
// never reflow — eight is small enough that a stable arc becomes a memorised
// landmark set, and that is the whole win.
export const AGENT = {
  slots: 8,
  diaM: 0.18,                                               // 5.16° at 2.0 m
  distM: 2.0,
  pitchDeg: 11.25,
  riseDeg: 5,
};

// The roster fills the arc from the middle outward, in a fixed order, so a
// lieutenant joining never moves one that is already there and a half-crewed
// board is still centred rather than piled against the left wall.
export const AGENT_ORDER = [3, 4, 2, 5, 1, 6, 0, 7];

// The landmark. A baked, non-emissive decal on the real floor under each shelf,
// carrying the column's name. The layout that lost in the research lost for
// lacking one of these, and the deployment lesson behind it is blunter still: an
// abstraction with no physical anchor gets read as a map of something else.
export const DECAL = { radiusM: 1.37, depthM: 0.20 };

// The escape hatch. Spatial memory failing is expected rather than exceptional,
// so every card is one gesture away in a flat list — and a list is a panel,
// because nobody in twenty-seven years of immersive analytics has made text
// spatial and the three vendors say the same thing independently.
export const LIST = { distM: 1.2, widthM: 0.90, heightM: 0.70, centreElevDeg: -15 };

// And the thing you point at to summon it: a mat on the floor, nearer than the
// ring of decals, dead ahead. It is the one thing in the room that sits below
// the band everything readable is held to, and that is deliberate — the whole
// ±45° by +10°/−35° budget is spent on shelves and lieutenants, there is no
// lane wide enough left in it, and a control you glance down at once in a while
// is not a surface you read. It is still inside the −60° a neck will go to.
export const PLATE = { azimuthDeg: 0, radiusM: 1.12, widthDeg: BUILD.hit * 2, heightDeg: BUILD.hit };

// ---- pointing -------------------------------------------------------------
//
// dir(azimuth, elevation) — a unit vector, in the WebXR convention: forward is
// −Z, +Y is up, and azimuth is measured POSITIVE TO THE RIGHT. (viewpoints.js
// hands a head a yaw, which is the same angle with the opposite sign.)
export function dir(azDeg, elDeg) {
  const a = azDeg * D, e = elDeg * D;
  return [Math.sin(a) * Math.cos(e), Math.sin(e), -Math.cos(a) * Math.cos(e)];
}

// A degree of AZIMUTH is not a degree of ARC anywhere but the horizon. Two
// points at the same elevation, one azimuth degree apart, are only cos(el) of a
// degree apart as the eye sees it — so a 6° collider laid out by azimuth on the
// bottom row of a shelf arrives at 5.2°, which is exactly the kind of quiet
// shortfall this whole file exists to prevent. Everything horizontal is
// therefore authored as TRUE arc and converted to azimuth here, which makes the
// slot lattice fan outward as it goes down. The identity is exact:
//
//   trueArc = 2·asin( cos(el) · sin(azSpan/2) )
export function azSpan(trueDeg, elDeg) {
  const s = Math.sin(trueDeg * D / 2) / Math.cos(elDeg * D);
  return s >= 1 ? 180 : 2 * Math.asin(s) / D;
}

export function pointAt(azDeg, elDeg, distM) {
  const d = dir(azDeg, elDeg);
  return { x: d[0] * distM, y: EYE + d[1] * distM, z: d[2] * distM };
}

// Where a point stands, said back in the room's own units.
export function angleOf(p) {
  const x = p.x || 0, y = (p.y === undefined ? EYE : p.y) - EYE, z = p.z || 0;
  const flat = Math.hypot(x, z);
  return {
    az: Math.atan2(x, -z) / D,
    el: Math.atan2(y, flat) / D,
    dist: Math.hypot(flat, y),
  };
}

export function eyeDistance(p) { return angleOf(p).dist; }

// ---- the shelves ----------------------------------------------------------

// A shelf is a flat bounded plane, not a slice of a cylinder: a flat wall of
// content is recalled significantly more accurately than the same content
// curved around the viewer, and surrounding somebody measurably costs them
// their orientation. Four of them, each turned to face the eye and tilted back.
//
// Returns the plane's origin and its three axes in world coordinates: `right`
// across it, `up` ALONG it (which is the tilted one), and `normal` back out of
// it toward the eye.
export function shelfPlane(i) {
  const az = SHELF.azimuths[i];
  const a = az * D, t = SHELF.tiltDeg * D;
  const centre = pointAt(az, shelfCentreElev(), SHELF.radius);
  const right = [Math.cos(a), 0, Math.sin(a)];
  const up = [Math.sin(t) * Math.sin(a), Math.cos(t), -Math.sin(t) * Math.cos(a)];
  const normal = [-Math.cos(t) * Math.sin(a), Math.sin(t), Math.cos(t) * Math.cos(a)];
  return { index: i, azimuth: az, centre, right, up, normal };
}

export function shelfCentreElev() {
  return SLOT.topElevDeg - (SLOT.rows - 1) * SLOT.pitchDeg / 2;
}

export function slotElevation(row) {
  return SLOT.topElevDeg - row * SLOT.pitchDeg;
}

// The lattice fans as it drops, so that every row's pitch is the same number of
// degrees OF ARC rather than the same number of degrees of azimuth.
export function slotAzimuth(shelf, col, row) {
  return SHELF.azimuths[shelf] + (col - (SLOT.cols - 1) / 2) * azSpan(SLOT.pitchDeg, slotElevation(row));
}

// Where a slot IS: the point where the gaze ray for that slot's angles lands on
// the shelf's plane. Doing it this way round rather than stepping metres across
// the plane is the whole discipline of the card — the angular pitch is then
// exactly the lattice pitch on every row, and the distance the slot really sits
// at falls out instead of being assumed from the shelf's radius.
export function slotAt(shelf, col, row) {
  const plane = shelfPlane(shelf);
  const el = slotElevation(row), az = slotAzimuth(shelf, col, row);
  const d = dir(az, el);
  const c = plane.centre, n = plane.normal;
  const num = c.x * n[0] + (c.y - EYE) * n[1] + c.z * n[2];
  const den = d[0] * n[0] + d[1] * n[1] + d[2] * n[2];
  const dist = num / den;
  return {
    shelf, col, row, az, el, dist,
    pos: { x: d[0] * dist, y: EYE + d[1] * dist, z: d[2] * dist },
    // Everything drawn in this slot is scaled by where the slot really sits, so
    // its arc is the same as every other slot's and its metres are not.
    scale: dist / SHELF.radius,
    plane,
  };
}

export function slots(shelf) {
  const out = [];
  for (let row = 0; row < SLOT.rows; row++) {
    for (let col = 0; col < SLOT.cols; col++) out.push(slotAt(shelf, col, row));
  }
  return out;
}

// The floor decal under a shelf: as wide as the shelf it names, which is the
// point of a landmark.
export function decalAt(shelf) {
  const az = SHELF.azimuths[shelf];
  const r = DECAL.radiusM;
  const d = dir(az, 0);
  const half = shelfHalfAngle(shelf) * D;
  return {
    shelf, azimuth: az,
    pos: { x: d[0] * r, y: 0, z: d[2] * r },
    widthM: 2 * r * Math.sin(half),
    depthM: DECAL.depthM,
  };
}

// The extent of a shelf's plate, in the plane's own metres: everything the slots
// cover plus 1.66° of margin, so the bounded region reads as a region and no
// card is standing on its edge. Derived from the slots rather than declared,
// because the lattice fans as it drops and a rectangle guessed at the shelf's
// centre would clip the bottom row.
export function shelfExtent(shelf) {
  const plane = shelfPlane(shelf);
  let u0 = Infinity, u1 = -Infinity, v0 = Infinity, v1 = -Infinity;
  for (let row = 0; row < SLOT.rows; row++) {
    for (let col = 0; col < SLOT.cols; col++) {
      const r = slotRegion(shelf, col, row);
      u0 = Math.min(u0, r.u - r.w / 2); u1 = Math.max(u1, r.u + r.w / 2);
      v0 = Math.min(v0, r.v - r.h / 2); v1 = Math.max(v1, r.v + r.h / 2);
    }
  }
  const margin = sizeForArc(BUILD.gap, SHELF.radius);
  return {
    plane,
    widthM: (u1 - u0) + 2 * margin,
    heightM: (v1 - v0) + 2 * margin,
    // The plate is centred on the slots it holds, which after the fan is not
    // quite the shelf's own centre.
    offsetU: (u0 + u1) / 2,
    offsetV: (v0 + v1) / 2,
  };
}

// Where a point lands in a shelf plane's own two coordinates: `u` across it,
// `v` along it (which is the tilted axis), both metres from the shelf's centre.
export function planeCoords(plane, p) {
  const d = [p.x - plane.centre.x, p.y - plane.centre.y, p.z - plane.centre.z];
  return {
    u: d[0] * plane.right[0] + d[1] * plane.right[1] + d[2] * plane.right[2],
    v: d[0] * plane.up[0] + d[1] * plane.up[1] + d[2] * plane.up[2],
  };
}

// A box on a shelf, given in DEGREES and returned in the plane's metres. It is
// built from the four gaze rays at its corners rather than from a size divided
// by a distance, because the shelf is tilted away from the eye: a box a fixed
// number of centimetres tall up there covers fewer degrees than the same box
// lower down, and that difference is exactly what a floor is for.
export function boxOnShelf(shelf, azDeg, elDeg, wDeg, hDeg) {
  const plane = shelfPlane(shelf);
  // Sized along the box's own centre lines rather than from its four corners. A
  // rectangle on a tilted plane is a keystone in the eye's angles — its lower
  // edge covers more azimuth than its upper one — so a bounding box round the
  // corners would come out systematically fat, eat the air beside it, and make
  // the whole lattice creep outward for no gain. Through the middle it is exact,
  // and the corners lean the same way on every cell, which is why the air
  // between two of them stays what it was asked to be.
  const l = planeCoords(plane, planeHit(plane, azDeg - wDeg / 2, elDeg));
  const r = planeCoords(plane, planeHit(plane, azDeg + wDeg / 2, elDeg));
  const t = planeCoords(plane, planeHit(plane, azDeg, elDeg + hDeg / 2));
  const b = planeCoords(plane, planeHit(plane, azDeg, elDeg - hDeg / 2));
  return {
    u: (l.u + r.u) / 2,
    v: (t.v + b.v) / 2,
    w: r.u - l.u,
    h: t.v - b.v,
  };
}

// The responsive region of a slot — 6.06° of arc square where it sits — and the
// card face drawn inside it, which is the smaller mark the padding exists
// around. Both are asked for in true arc and converted to azimuth on the way in.
export function slotRegion(shelf, col, row) {
  const el = slotElevation(row);
  return boxOnShelf(shelf, slotAzimuth(shelf, col, row), el, azSpan(BUILD.hit, el), BUILD.hit);
}

export function cardFace(shelf, col, row) {
  const el = slotElevation(row);
  return boxOnShelf(shelf, slotAzimuth(shelf, col, row), el, azSpan(CARD.faceWDeg, el), CARD.faceHDeg);
}

// How much azimuth a shelf's plate covers, either side of its own centre — the
// figure that says whether two of them have air between them.
export function shelfHalfAngle(shelf) {
  return Math.atan2(shelfExtent(shelf).widthM / 2, SHELF.radius) / D;
}

function planeHit(plane, azDeg, elDeg) {
  const d = dir(azDeg, elDeg);
  const c = plane.centre, n = plane.normal;
  const t = (c.x * n[0] + (c.y - EYE) * n[1] + c.z * n[2]) / (d[0] * n[0] + d[1] * n[1] + d[2] * n[2]);
  return { x: d[0] * t, y: EYE + d[1] * t, z: d[2] * t, dist: t };
}

// ---- the lieutenants ------------------------------------------------------

export function agentSlotAzimuth(slot) {
  return (slot - (AGENT.slots - 1) / 2) * AGENT.pitchDeg;
}

// The arc: 0° at the ends, +5° in the middle, and never higher than that.
export function agentSlotElevation(slot) {
  const az = agentSlotAzimuth(slot);
  const end = agentSlotAzimuth(AGENT.slots - 1);
  return AGENT.riseDeg * (1 - (az / end) ** 2);
}

export function agentAt(slot) {
  const az = agentSlotAzimuth(slot), el = agentSlotElevation(slot);
  return { slot, az, el, dist: AGENT.distM, pos: pointAt(az, el, AGENT.distM) };
}

// Which slot a lieutenant owns — by its place in the board's own roster, filled
// from the middle out, and never re-sorted for any reason.
export function agentSlotFor(index) {
  return index < AGENT_ORDER.length ? AGENT_ORDER[index] : -1;
}

// Full white is uncomfortably bright and the display cannot do anything useful
// with it; the spec's own note is to clamp it to about #EBEBEB.
export function agentColour(hex) {
  const c = String(hex || '#8aa0bb').trim();
  const m = /^#?([0-9a-f]{6})$/i.exec(c);
  if (!m) return '#8aa0bb';
  const n = parseInt(m[1], 16);
  const ch = [(n >> 16) & 255, (n >> 8) & 255, n & 255].map((v) => Math.min(v, 0xeb));
  return '#' + ch.map((v) => v.toString(16).padStart(2, '0')).join('');
}

// ---- the panel and its plate ----------------------------------------------

export function listPanel() {
  return {
    ...LIST,
    pos: pointAt(0, LIST.centreElevDeg, LIST.distM),
    widthDeg: arcDeg(LIST.widthM, LIST.distM),
    heightDeg: arcDeg(LIST.heightM, LIST.distM),
  };
}

// A row in the list is a target like anything else, so its height is the hit
// floor measured at the distance the panel stands.
export function listRow() {
  return { heightM: sizeForArc(BUILD.hit, LIST.distM), gapM: sizeForArc(BUILD.gap, LIST.distM) };
}

export function plate() {
  const r = PLATE.radiusM;
  const d = dir(PLATE.azimuthDeg, 0);
  const pos = { x: d[0] * r, y: 0, z: d[2] * r };
  const a = angleOf(pos);
  // On the floor, a degree of elevation is worth a great deal more radial metres
  // than a degree of azimuth is worth across — so the plate that reads as square
  // in the eye is a long rectangle on the ground, and it is derived rather than
  // eyeballed.
  return {
    pos, azimuth: PLATE.azimuthDeg, elevation: a.el, dist: a.dist,
    widthM: 2 * r * Math.sin(azSpan(PLATE.widthDeg, a.el) * D / 2),
    depthM: PLATE.heightDeg * D * (r * r + EYE * EYE) / EYE,
  };
}

// ---- what goes in the slots ------------------------------------------------
//
// Density has a measured cost — retrieval degrades from 3.2 s to 5.0 s going
// from 33 items to 99 — so a shelf shows the active work and the long tail goes
// to the list. Order is the board's own; the room never re-sorts, because a set
// of things that reorders is a set of things you cannot remember the position
// of.
export function shelfCards(doc, columnId) {
  const all = (doc.cards || []).filter((c) => c.column === columnId);
  return { visible: all.slice(0, PER_SHELF), overflow: Math.max(0, all.length - PER_SHELF), total: all.length };
}

// The four columns the room has shelves for, in the board's own order.
export function columnsOf(doc) {
  return (doc.columns || []).slice(0, SHELF.azimuths.length);
}

// Age in the current column as slab thickness: length, second-ranked of the
// encoding channels at 6.61% error, and it reads edge-on from the side where a
// face does not. Depth INTO the shelf stays unencoded — that is the discipline.
export function slabThickness(card, now) {
  const t = new Date(card && (card.updated || card.created)).getTime();
  const days = Number.isFinite(t) ? (now - t) / 86400000 : 0;
  const k = Math.max(0, Math.min(1, days / CARD.ageDays));
  return CARD.thinM + (CARD.thickM - CARD.thinM) * k;
}

// Colour never travels alone. A card's labels come across as glyphs on the face
// beside the owner's colour band, so the band is never the only thing saying who.
export function glyphsFor(card) {
  return (card && card.labels ? card.labels : []).slice(0, 3).map((l) => String(l).slice(0, 2).toUpperCase());
}

// ---- the six states --------------------------------------------------------
//
// There is no haptic channel, so the visual channel carries the affordance
// alone: remove the signifier and 36% of people do not know where to press.
// Four vendors mandate six states rather than three, and the proximity
// treatment worth copying is a spotlight that SHRINKS as the hand approaches,
// converging to a dot on contact — the fix for having no depth certainty.
export const STATE = ['idle', 'hovered-far', 'hovered-near', 'contact', 'held', 'released'];

// How near is near. A ray has no fingertip, so the distance the spotlight reads
// is how far down the ray the thing sits: something across the room glows wide,
// something you have walked up to closes to a dot. Inside NEAR_M the hover is
// the near treatment, and it carries the distance rather than merely saying
// "hovered" — which is the whole difference between three states and six.
export const REACH_M = [0.30, 2.20];
export const NEAR_M = 1.0;

export function spotlight(distanceM) {
  const [a, b] = REACH_M;
  const k = Math.max(0, Math.min(1, (distanceM - a) / (b - a)));
  return 0.14 + 0.86 * k;                 // fraction of the target's own half-width
}

// Acknowledge inside 100 ms; Quest 3 spends 70 ms on hand tracking before the
// event arrives, so the room's own budget is what is left of it.
export const ACK_MS = 150;
export const STEP = 1.05;                 // the ~5% scale step a hover is worth
