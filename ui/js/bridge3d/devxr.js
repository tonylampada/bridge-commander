// devxr.js — a headset that is not there.
//
// Fetched only when the URL says `?xr=emulate`, and nothing in the room imports
// it otherwise, so the normal page never pays for it and never loads it.
//
// IWER — Meta's Immersive Web Emulation Runtime — puts a synthetic
// `navigator.xr` in front of the page, so `requestSession('immersive-vr')`
// returns a GENUINE session: the same WebXRManager path, the same reference
// space, the same input sources three.js takes in a real headset. That matters
// more than it sounds. A "desktop preview" that fakes the camera proves the
// flat view works; this proves the SESSION works, which is the half that only
// ever broke in the headset.
//
// Two ways to drive it. A script poses the head at a named viewpoint and takes
// a photograph (dev/room-shots.js). A person drags to look and walks with the
// arrow keys, because a session you cannot look around inside is a still.
//
// Every number the shots are judged against lives in the `vr-design` skill, and
// the arc they are measured at is asserted in test/bridge3d.test.js. This file
// only gets a head into the room.

import { XRDevice, metaQuest3, eulerToQuat } from '../../vendor/iwer/iwer.module.min.js';
import { VIEWPOINTS, byName, aimAt, FOVY } from './viewpoints.js';
import { EYE } from './world.js';

// Mono, not stereo: side-by-side eyes halve the horizontal resolution of every
// screenshot to photograph the same room twice. The per-eye transforms are
// still there — this only says what lands on the canvas.
const STEREO = false;

export async function install() {
  const device = new XRDevice(metaQuest3, { stereoEnabled: STEREO, fovy: FOVY * Math.PI / 180 });
  // forceInstall, because desktop Chrome already publishes a navigator.xr that
  // supports nothing at all, and IWER politely declines to replace a runtime
  // that exists. `?xr=emulate` is an instruction, not a preference — on a real
  // headset it would replace the real one too, which is what it says on the tin.
  device.installRuntime({ forceInstall: true });

  const pose = { yaw: 0, pitch: 0, x: 0, y: EYE, z: 0 };
  function apply() {
    device.position.set(pose.x, pose.y, pose.z);
    const q = eulerToQuat({ yaw: pose.yaw, pitch: pose.pitch, roll: 0 });
    device.quaternion.set(q.x, q.y, q.z, q.w);
    aimController();
  }

  // One controller, the right, carried where a hand rests and pointed roughly
  // where the head is. A ray that starts at the eye is a ray that never misses,
  // and never reproduces the scatter the 6° collider exists for.
  //
  // The left hand is put away rather than left at the origin: an unposed
  // controller sits at the feet with its ray drawn across the whole room, and
  // every screenshot then has a blue line through the board.
  const OFFSET = { x: 0.22, y: -0.35, z: -0.12 };
  const REACH = 1.75;                 // the shelf radius: where most of the room stands
  if (device.controllers.left) device.controllers.left.connected = false;
  function aimController() {
    const c = device.controllers.right;
    if (!c) return;
    c.connected = true;
    const at = [pose.x + OFFSET.x, pose.y + OFFSET.y, pose.z + OFFSET.z];
    c.position.set(at[0], at[1], at[2]);
    // Aimed AT what the head is looking at, not merely parallel to it. Held
    // parallel from 35 cm below the eye, the dot lands a third of a metre under
    // the thing you are looking at, and every click misses in a way that reads
    // as the room being broken rather than the hand being somewhere else.
    const r = pose.yaw * Math.PI / 180, p = pose.pitch * Math.PI / 180;
    const target = [
      pose.x - Math.sin(r) * Math.cos(p) * REACH,
      pose.y + Math.sin(p) * REACH,
      pose.z - Math.cos(r) * Math.cos(p) * REACH,
    ];
    const a = aimAt(at, target);
    const q = eulerToQuat({ yaw: a.yaw, pitch: a.pitch, roll: 0 });
    c.quaternion.set(q.x, q.y, q.z, q.w);
  }

  // Turn the head by hand, in the same degrees everything else here speaks.
  function aim(yaw, pitch) {
    pose.yaw = yaw;
    pose.pitch = pitch;
    apply();
    return { yaw, pitch };
  }

  function look(name) {
    const v = byName(name);
    if (!v) throw new Error('no viewpoint called ' + name);
    const a = aimAt(v.eye, v.look);
    pose.x = v.eye[0]; pose.y = v.eye[1]; pose.z = v.eye[2];
    pose.yaw = a.yaw; pose.pitch = a.pitch;
    apply();
    return { name, ...a };
  }

  // A trigger press, held for a frame or two and released — the room reads
  // selectstart/selectend, so a pull that never lets go opens nothing.
  async function press(button = 'trigger') {
    const c = device.controllers.right;
    if (!c) throw new Error('no right controller');
    c.updateButtonValue(button, 1);
    await frames(2);
    c.updateButtonValue(button, 0);
    await frames(2);
  }

  const frames = (n = 1) => new Promise((done) => {
    let left = n;
    const tick = () => (--left <= 0 ? done() : requestAnimationFrame(tick));
    requestAnimationFrame(tick);
  });

  // Is anything actually on the canvas? The structural half of the loop: a
  // photograph proves the room did not go blank, and that is ALL it proves —
  // "that target is 2.58°" is measured in the test suite, never here.
  function frameStats() {
    const src = document.querySelector('canvas');
    if (!src) return null;
    const w = 160, h = Math.max(1, Math.round((src.height / src.width) * w));
    const off = document.createElement('canvas');
    off.width = w; off.height = h;
    const g = off.getContext('2d', { willReadFrequently: true });
    g.drawImage(src, 0, 0, w, h);
    const d = g.getImageData(0, 0, w, h).data;
    const seen = new Set();
    let lum = 0, lit = 0;
    for (let i = 0; i < d.length; i += 4) {
      seen.add((d[i] >> 3 << 10) | (d[i + 1] >> 3 << 5) | (d[i + 2] >> 3));
      const l = (d[i] * 0.2126 + d[i + 1] * 0.7152 + d[i + 2] * 0.0722) / 255;
      lum += l;
      if (l > 0.08) lit++;                       // brighter than the room's own background
    }
    const n = d.length / 4;
    return { width: src.width, height: src.height, colours: seen.size, litFraction: lit / n, meanLuma: lum / n };
  }

  // Drag to look, arrows to walk, so this is a room a person can be inside
  // rather than a still photograph. Deliberately small: IWER ships a full
  // emulator panel as @iwer/devui, and it is 850 KB — four times the runtime
  // itself — for controls a mouse already gives.
  let dragging = false, moved = false;
  addEventListener('pointerdown', () => { dragging = true; moved = false; });
  addEventListener('pointerup', () => {
    dragging = false;
    // A look is not a click — the room's own desk view draws that line too. And
    // a click here has to become a TRIGGER, because inside a session the room
    // listens for selectstart and nothing else; a mouse click reaches nobody.
    // The ray rides the head, so what it opens is what is under the dot in the
    // middle of the view, which is gaze pointing and is meant to be.
    if (!moved && device.activeSession) press('trigger');
  });
  addEventListener('pointermove', (e) => {
    if (!dragging || !device.activeSession) return;
    if (Math.abs(e.movementX) + Math.abs(e.movementY) > 2) moved = true;
    pose.yaw -= e.movementX * 0.15;
    pose.pitch = Math.max(-85, Math.min(85, pose.pitch - e.movementY * 0.15));
    apply();
  });
  addEventListener('keydown', (e) => {
    if (!device.activeSession) return;
    const step = 0.12, r = pose.yaw * Math.PI / 180;
    const go = (f, s) => {
      pose.x += -Math.sin(r) * f + Math.cos(r) * s;
      pose.z += -Math.cos(r) * f - Math.sin(r) * s;
      apply();
    };
    if (e.key === 'ArrowUp') go(step, 0);
    else if (e.key === 'ArrowDown') go(-step, 0);
    else if (e.key === 'ArrowLeft') go(0, -step);
    else if (e.key === 'ArrowRight') go(0, step);
    else return;
    e.preventDefault();
  });

  apply();

  // The handle the capture script drives, and the one to poke at from a console.
  window.__xr = {
    device, look, aim, press, frames, frameStats, pose,
    viewpoints: VIEWPOINTS.map((v) => ({ name: v.name, why: v.why })),
    get presenting() { return !!device.activeSession; },
  };
  return window.__xr;
}
