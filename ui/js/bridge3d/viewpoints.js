// viewpoints.js — the handful of places the room is looked at from.
//
// Pure: the room's own constants and some trigonometry. No three.js, no DOM, no
// emulated headset. The page poses a head with these, the capture script names
// its PNGs after them, and the tests measure them — which is the only reason
// they are a module rather than six literals inside a script.
//
// A viewpoint is a place to STAND and a thing to LOOK AT, never a raw
// quaternion: the point of a named shot is "this is what the shelves look like
// from where he reads them", and that survives the shelves moving. Every target
// is read out of world.js, so a thing that gets repositioned drags its
// photograph along with it instead of quietly becoming a picture of the floor.

import * as W from './world.js';

const DEG = 180 / Math.PI;

// The emulated headset's vertical field of view, in degrees — IWER's own
// default, said out loud here because it is half of "is the thing this shot is
// named after actually IN the shot", which the tests measure.
export const FOVY = 90;

// Where a head at `eye` has to be turned to face `target`: yaw about Y, pitch
// about X, both in degrees. WebXR is right-handed with forward at -Z, so a head
// at rest is yaw 0 / pitch 0, positive yaw turns left and positive pitch looks
// up — the same convention IWER's eulerToQuat takes. (world.js measures azimuth
// positive to the RIGHT, which is the same angle with the opposite sign.)
export function aimAt(eye, target) {
  const dx = target[0] - eye[0], dy = target[1] - eye[1], dz = target[2] - eye[2];
  return {
    yaw: Math.atan2(-dx, -dz) * DEG,
    pitch: Math.atan2(dy, Math.hypot(dx, dz)) * DEG,
  };
}

export function gazeDistance(v) {
  return Math.hypot(v.look[0] - v.eye[0], v.look[1] - v.eye[1], v.look[2] - v.eye[2]);
}

// Standing where the captain stands. The room is authored around one head at the
// origin at eye height; a viewpoint that moved the body would be photographing a
// different room than the one the arc tests measure.
const HERE = [0, W.EYE, 0];

const at = (p) => [p.x, p.y, p.z];

// The two shelves worth photographing on their own: the one straight ahead of
// his left shoulder, and the far one out at 33.75°, which is where a panel
// turned to face the eye stops facing it and where foveation blurs what it
// should not.
const NEAR_SHELF = W.shelfPlane(1);
const FAR_SHELF = W.shelfPlane(3);
const nearExtent = W.shelfExtent(1);
const farExtent = W.shelfExtent(3);

// The arc of spheres, as one thing: eight of them 11.25° apart, so the set is
// 78.75° across at 2.0 m plus a sphere at each end.
const ARC = {
  widthM: 2 * W.AGENT.distM * Math.sin((W.AGENT.pitchDeg * (W.AGENT.slots - 1) / 2) * Math.PI / 180) + W.AGENT.diaM,
  heightM: W.sizeForArc(W.AGENT.riseDeg, W.AGENT.distM) + W.AGENT.diaM,
};

const LIST = W.listPanel();
const PLATE = W.plate();
const DECAL = W.decalAt(1);

// Each one exists to answer a question a screenshot can answer; anything a
// screenshot cannot answer is measured in test/bridge3d.test.js instead, and no
// photograph is a substitute for wearing it.
//
// `scene` is what has to be true for the shot to be of anything: 'world' is the
// room standing still, 'list' is the flat panel up in front of it.
export const VIEWPOINTS = [
  {
    name: 'resting', scene: 'world',
    why: 'head level, dead ahead — what he sees when he stops moving, and the shot that catches anything drifting up over the horizon',
    eye: HERE,
    look: [0, W.EYE, -W.SHELF.radius],
    frames: { panel: nearExtent, at: NEAR_SHELF.centre },
  },
  {
    name: 'shelves', scene: 'world',
    why: 'the working shelf read straight on: are the slots a lattice, is a card a slab standing in one, and is the padding around it visible as air rather than as a gap in the drawing',
    eye: HERE,
    look: at(NEAR_SHELF.centre),
    frames: { panel: nearExtent, at: NEAR_SHELF.centre },
  },
  {
    name: 'far-shelf', scene: 'world',
    why: 'the outermost shelf, 33.75° off centre — where a flat plane turned to face the eye stops facing it, and where three.js would have blurred the type if foveation had been left at its default',
    eye: HERE,
    look: at(FAR_SHELF.centre),
    frames: { panel: farExtent, at: FAR_SHELF.centre },
  },
  {
    name: 'lieutenants', scene: 'world',
    why: 'the arc above the shelves: eight fixed berths, the crewed ones in their own colours with their names under them, and nothing of it above +10°',
    eye: HERE,
    look: at(W.agentAt(3).pos),
    frames: { panel: ARC, at: W.agentAt(3).pos },
  },
  {
    name: 'landmarks', scene: 'world',
    why: 'the floor: a baked decal under each shelf carrying its column name, and the plate that opens the list. The layout that lost in the research lost for lacking exactly these',
    eye: HERE,
    look: at(DECAL.pos), floor: true,
    frames: { panel: { widthM: DECAL.widthM, heightM: DECAL.depthM }, at: DECAL.pos },
  },
  {
    name: 'list', scene: 'list',
    why: 'the escape hatch, open: every card, searchable, one gesture away — because spatial memory failing is expected rather than exceptional',
    eye: HERE,
    look: at(LIST.pos),
    frames: { panel: { widthM: LIST.widthM, heightM: LIST.heightM }, at: LIST.pos },
  },
];

export const byName = (name) => VIEWPOINTS.find((v) => v.name === name) || null;

// ---- things the ray has to be able to land on -------------------------------
//
// A photograph proves the room did not go blank. It says nothing at all about
// whether the ray reaches anything, and the way that breaks is silent: a glyph
// layer two millimetres in front of the slots, an invisible panel that is still
// a collider, a pointer library that rewrites the flag you set. Every one of
// those looks perfect in a PNG.
//
// So the capture run also POINTS at one of each kind of thing and checks it
// lights up. Aim is a head pose, in the same degrees everything else here
// speaks: yaw is the opposite sign of world.js's azimuth.
const slot = W.slotAt(1, 0, 0);
const agent = W.agentAt(4);
const mat = W.plate();

export const PROBES = [
  { name: 'a card slot', yaw: -slot.az, pitch: slot.el, expect: 'slot' },
  { name: 'a lieutenant', yaw: -agent.az, pitch: agent.el, expect: 'lieutenant' },
  { name: 'the list mat', yaw: -mat.azimuth, pitch: mat.elevation, expect: 'list-plate' },
];

// Everywhere the room actually stands something — what a viewpoint is allowed to
// be aimed at. A viewpoint pointed anywhere else is a photograph of the floor.
export function places() {
  const out = [LIST.pos, PLATE.pos, { x: 0, y: W.EYE, z: -W.SHELF.radius }];
  for (let i = 0; i < W.SHELF.azimuths.length; i++) {
    out.push(W.shelfPlane(i).centre, W.decalAt(i).pos);
    for (const s of W.slots(i)) out.push(s.pos);
  }
  for (let i = 0; i < W.AGENT.slots; i++) out.push(W.agentAt(i).pos);
  return out;
}
