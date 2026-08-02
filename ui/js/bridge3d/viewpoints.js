// viewpoints.js — the handful of places the room is looked at from.
//
// Pure: the room's own constants and some trigonometry. No three.js, no DOM, no
// emulated headset. The page poses a head with these, the capture script names
// its PNGs after them, and the tests measure them — which is the only reason
// they are a module rather than five literals inside a script.
//
// A viewpoint is a place to STAND and a thing to LOOK AT, never a raw
// quaternion: the point of a named shot is "this is what the board looks like
// from where he reads it", and that survives the board moving. Every target is
// read out of room.js, so a panel that gets repositioned drags its photograph
// along with it instead of quietly becoming a picture of the floor.

import { EYE, FRONT, BAR, PANEL, placeWindow } from './room.js';

const DEG = 180 / Math.PI;

// The emulated headset's vertical field of view, in degrees — IWER's own
// default, said out loud here because it is half of "is the thing this shot is
// named after actually IN the shot", which the tests measure.
export const FOVY = 90;

// Where a head at `eye` has to be turned to face `target`: yaw about Y, pitch
// about X, both in degrees. WebXR is right-handed with forward at -Z, so a head
// at rest is yaw 0 / pitch 0, positive yaw turns left and positive pitch looks
// up — the same convention IWER's eulerToQuat takes.
export function aimAt(eye, target) {
  const dx = target[0] - eye[0], dy = target[1] - eye[1], dz = target[2] - eye[2];
  return {
    yaw: Math.atan2(-dx, -dz) * DEG,
    pitch: Math.atan2(dy, Math.hypot(dx, dz)) * DEG,
  };
}

// How far the thing being looked at is — the distance every arc in the room is
// measured at, so a viewpoint carries it rather than guessing from z.
export function gazeDistance(v) {
  return Math.hypot(v.look[0] - v.eye[0], v.look[1] - v.eye[1], v.look[2] - v.eye[2]);
}

// Standing where the captain stands. The room is authored around one head at
// the origin at eye height; a viewpoint that moved the body would be
// photographing a different room than the one the arc tests measure.
const HERE = [0, EYE, 0];

const LEFT = placeWindow(0, 3);
const MIDDLE = placeWindow(1, 3);
const RIGHT = placeWindow(2, 3);

// Each one exists to answer a question a screenshot can answer; anything a
// screenshot cannot answer is measured in test/bridge3d.test.js instead, and no
// photograph is a substitute for wearing it.
//
// `scene` is what has to be OPEN for the shot to be of anything: 'empty' is the
// room as it opens, 'working' is three windows up — which is also what pushes
// the board back, so the working shot is a photograph of the same button press
// rather than of a special mode.
//
// There is deliberately no photograph of the board pushed back on its own,
// because there is no such view: whatever pushed it back is standing in front
// of it, and it is wider in arc than the board is. That the pushed-back board
// re-cuts its type for the further distance is a thing the arc tests measure
// and a photograph could never have shown. That division is the whole point.
export const VIEWPOINTS = [
  {
    name: 'resting', scene: 'empty',
    why: 'head level, dead ahead — what he sees when he stops moving, and the shot that catches anything drifting up over the horizon',
    eye: HERE,
    look: [0, EYE, FRONT.z],
    frames: { panel: PANEL.board, at: { x: 0, y: FRONT.y, z: FRONT.z } },
  },
  {
    name: 'board', scene: 'empty',
    why: 'the remembering surface, read straight on: every card title, every column, at the distance it really stands',
    eye: HERE,
    look: [0, FRONT.y, FRONT.z],
    frames: { panel: PANEL.board, at: { x: 0, y: FRONT.y, z: FRONT.z } },
  },
  {
    name: 'lieutenants', scene: 'empty',
    why: 'the bar, low and close: are the faces faces, and is the plate under each of them still a target',
    eye: HERE,
    look: [BAR.x, BAR.y, BAR.z],
    frames: { panel: PANEL.bar, at: BAR },
  },
  {
    name: 'working', scene: 'working',
    why: 'the room with work up: three windows in front and the board gone back and quiet behind them, which is what the swap button actually buys',
    eye: HERE,
    look: [MIDDLE.x, MIDDLE.y, MIDDLE.z],
    frames: { panel: PANEL.card, at: MIDDLE },
  },
  {
    name: 'left-window', scene: 'working',
    why: 'a window off to one side — where foveation blurs what it should not, and where a panel turned to face the eye stops facing it',
    eye: HERE,
    look: [LEFT.x, LEFT.y, LEFT.z],
    frames: { panel: PANEL.card, at: LEFT },
  },
  {
    name: 'right-window', scene: 'working',
    why: 'and the mirror of it, because a room that is only ever photographed from the middle is a room with one good side',
    eye: HERE,
    look: [RIGHT.x, RIGHT.y, RIGHT.z],
    frames: { panel: PANEL.chat, at: RIGHT },
  },
];

export const byName = (name) => VIEWPOINTS.find((v) => v.name === name) || null;
