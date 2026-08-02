// main.js — the board as a world you stand inside.
//
// The first room was a wall of live terminals and the captain killed it in one
// sentence. The second was panels — better, and still 2D inside 3D: pictures of
// the board hanging in the air. This is the third, and the difference is that
// the things in it are THINGS. Four bounded shelves with their names on the
// floor beneath them, cards as slabs standing in slots, eight lieutenants as
// spheres at positions that never move, and a ray that lands on any of it.
//
// Nothing in here moves yet. Grabbing, breathing, the twitch per event, the card
// detail panel and the chat are each their own card, and every one of them needs
// this one still and correct underneath. What this card owes is a world whose
// geometry is right, measured at the distance each thing actually sits.
//
// Every number is authored in DEGREES and lives in `world.js`; why those are the
// numbers lives in the `vr-design` skill and nowhere else. See the README beside
// this file for how to run and photograph it without a headset.

import * as THREE from 'three';
import * as W from './world.js';
import { Shelf, Decal } from './shelves.js';
import { Agents } from './agents.js';
import { CardList, ListPlate } from './list.js';
import { Rays } from './hover.js';
import { updateRoots, sortTransparent, rootCount, COL } from './kit.js';

const say = (m) => { const el = document.getElementById('status'); if (el) el.textContent = m; };

// The dev loop's two switches, both off unless the URL asks — see README.md.
// `?capture=1` keeps the drawing buffer so a screenshot is not an empty PNG;
// `?xr=emulate` puts a headset that is not there behind navigator.xr. Neither
// costs the normal room anything: false IS WebGLRenderer's default for
// preserveDrawingBuffer, and devxr.js is not so much as fetched without the flag.
const DEV = new URLSearchParams(location.search);

let renderer;
try {
  renderer = new THREE.WebGLRenderer({ antialias: true, alpha: false, preserveDrawingBuffer: DEV.has('capture') });
} catch (e) {
  say('no WebGL in this browser — ' + ((e && e.message) || e));
  throw e;
}
renderer.setPixelRatio(window.devicePixelRatio);
renderer.setSize(window.innerWidth, window.innerHeight);
renderer.xr.enabled = true;
renderer.xr.setReferenceSpaceType('local-floor');
// three.js ships foveation at 1.0 — MAXIMUM — which renders the edges of the
// view at reduced resolution. This room parks two whole shelves out past 30° on
// purpose, for a head turn to find, so the default blurs exactly the things it
// was told to keep readable. A room of small type pays the GPU instead.
renderer.xr.setFoveation(0);
sortTransparent(renderer);
document.body.appendChild(renderer.domElement);

const scene = new THREE.Scene();
scene.background = new THREE.Color(COL.ink);
// Near at 0.3 m: closer than that a thing is intersecting his face, and nothing
// he reads is ever meant to be inside 0.5 m anyway.
const camera = new THREE.PerspectiveCamera(70, window.innerWidth / window.innerHeight, 0.3, 100);
camera.position.set(0, W.EYE, 0);
scene.add(camera);

// One hemisphere light and nothing else. A sphere with no shading is a disc, so
// the room needs SOME light — but dynamic lighting will exceed a mobile GPU and
// the frame budget here is 11 ms, so it is one baked gradient, no shadows, no
// point lights, and emissive is the only thing that ever changes.
scene.add(new THREE.HemisphereLight(0xdfe9f5, 0x0a0f16, 2.1));

// ---- the ground, aligned to the real floor ---------------------------------
//
// Non-negotiable for orientation, and free: the session is `local-floor`, so
// y = 0 IS the floor he is standing on.
const ground = new THREE.Mesh(
  new THREE.CircleGeometry(6, 48),
  new THREE.MeshBasicMaterial({ color: '#0a1018' }),
);
ground.rotation.x = -Math.PI / 2;
scene.add(ground);
const grid = new THREE.PolarGridHelper(6, 8, 6, 64, 0x16202c, 0x101823);
grid.material.opacity = 0.5;
grid.material.transparent = true;
scene.add(grid);

// ---- the room's contents ---------------------------------------------------

let doc = { cards: [], lieutenants: [], columns: [] };

const shelves = [];
const decals = [];
for (let i = 0; i < W.SHELF.azimuths.length; i++) {
  const s = new Shelf(i);
  const d = new Decal(i);
  shelves.push(s);
  decals.push(d);
  scene.add(s.group, d.group);
}

const agents = new Agents();
scene.add(agents.group);

const list = new CardList();
scene.add(list.group);
const plate = new ListPlate(() => list.setOpen(!list.open));
scene.add(plate.group);
list.setOpen(false);

const rays = new Rays(renderer, scene, camera, renderer.domElement);

function repaint() {
  const cols = W.columnsOf(doc);
  const lts = new Map((doc.lieutenants || []).map((l) => [l.id, l]));
  shelves.forEach((s, i) => s.paint(doc, cols[i], lts));
  decals.forEach((d, i) => d.paint(doc, cols[i]));
  agents.paint(doc);
  list.paint(doc);
}

async function refresh() {
  try {
    doc = await fetch('/api/board').then((r) => r.json());
    repaint();
    say('');
  } catch (e) { say('the board did not answer: ' + ((e && e.message) || e)); }
}

// ---- entering --------------------------------------------------------------

const gate = document.getElementById('gate');

// The emulated headset installs itself over navigator.xr before anything asks
// navigator.xr a question, which is why this is started here and awaited in
// enter() rather than raced against the first click.
const emulated = DEV.get('xr') === 'emulate'
  ? import('./devxr.js').then((m) => m.install())
    .catch((e) => { say('the emulated headset did not install: ' + ((e && e.message) || e)); })
  : null;

async function enter() {
  if (emulated) await emulated;
  const flat = (why) => { say(why); gate.hidden = true; };
  if (!navigator.xr) return flat('no WebXR in this browser — flat view: drag to look, click to point');
  const ok = await navigator.xr.isSessionSupported('immersive-vr').catch(() => false);
  if (!ok) return flat('no headset here — flat view: drag to look, click to point');
  let session;
  try {
    session = await navigator.xr.requestSession('immersive-vr', {
      optionalFeatures: ['local-floor', 'bounded-floor', 'hand-tracking'],
    });
  } catch (e) { return flat('the headset refused the session: ' + ((e && e.message) || e)); }
  await renderer.xr.setSession(session);
  gate.hidden = true;
  rays.setPresenting(true);
  session.addEventListener('end', () => { gate.hidden = false; rays.setPresenting(false); });
}
document.getElementById('enter').addEventListener('click', enter);

// ---- a desk, so this can be driven without a headset ------------------------
//
// Dragging turns the head; the mouse is the ray, through the same pointer
// library the controller uses, so a click at a desk and a trigger in a headset
// arrive at a target by the same route.

let dragging = false, yaw = 0, pitch = 0;
renderer.domElement.addEventListener('pointerdown', () => { dragging = true; });
window.addEventListener('pointerup', () => { dragging = false; });
window.addEventListener('pointermove', (e) => {
  if (!dragging || renderer.xr.isPresenting) return;
  yaw -= e.movementX * 0.003;
  pitch = Math.max(-1.3, Math.min(1.0, pitch - e.movementY * 0.003));
  camera.rotation.set(pitch, yaw, 0, 'YXZ');
});
window.addEventListener('keydown', (e) => {
  if (e.key === 'l' && !list.search.hasFocus?.value) list.setOpen(!list.open);
});

window.addEventListener('resize', () => {
  camera.aspect = window.innerWidth / window.innerHeight;
  camera.updateProjectionMatrix();
  renderer.setSize(window.innerWidth, window.innerHeight);
});

// ---- loop -------------------------------------------------------------------

let last = 0;
renderer.setAnimationLoop((t) => {
  const dt = last ? Math.min(0.1, (t - last) / 1000) : 0.016;
  last = t;
  rays.update();
  const now = performance.now();
  for (const s of shelves) s.tick(now);
  agents.tick(now);
  plate.tick(now);
  list.tick(now);
  updateRoots(dt);
  renderer.render(scene, camera);
});

// The handle the capture script and a console drive the room through.
window.__bridge = {
  shelves, decals, agents, list, plate, scene, camera, rays,
  openList: (on) => list.setOpen(on),
  search: (q) => { list.query = q || ''; list.repaint(); },
  stats: () => ({
    roots: rootCount(),
    calls: renderer.info.render.calls,
    triangles: renderer.info.render.triangles,
    targets: targets().length,
  }),
  // What the ray is currently on, and how it is behaving about it. The capture
  // run reads this to prove the room is still pointable-at, which no photograph
  // can show.
  lit: () => targets().filter((t) => t.state !== 'idle')
    .map((t) => ({ name: t.name, state: t.state, distance: +t.distance.toFixed(2) })),
  get doc() { return doc; },
};

function targets() {
  const out = [];
  scene.traverse((o) => { if (o.userData && o.userData.target) out.push(o.userData.target); });
  return out;
}

refresh().then(() => { gate.classList.add('ready'); });
setInterval(refresh, 5000);
