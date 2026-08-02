// main.js — the board, as a room you work in.
//
// This is the second design. The first one was a wall of live terminals, and
// the captain killed it in one sentence: a terminal is the LAST thing that
// matters, a thing he opens for two seconds to confirm something is really
// running. I had built the easy surface and mistaken that for a reason.
//
// What the room is now, in his order:
//
//   the LIEUTENANTS are always in front and never close — talking to one is the
//   interaction itself;
//   the BOARD is the remembering surface: what is in flight, and where his
//   attention should go next. One button pushes it back so something else can
//   take the front;
//   the WINDOWS are the work. Click a card, it comes forward with its chat
//   beside it, and he moves it, sizes it and closes it. Several at once, of
//   different agents or the same one twice, as many as attention allows.
//
// Everything on a surface is painted by us onto a canvas, because inside an
// immersive session the browser stops drawing HTML and none of the board's own
// screens come across. That is the real cost of the room and it is paid here.

import * as THREE from '../../vendor/three/three.module.min.js';
import { BoardPanel, LieutenantBar, CardWindow, ChatWindow } from './panels.js';
import { EYE, FRONT, BACK, BAR, TYPE, placeWindow, nextFront, openWindows, eyeDistance } from './room.js';
import { whenFaces } from './faces.js';
import { keyForEvent } from '../panekeys.js';

const say = (m) => { const el = document.getElementById('status'); if (el) el.textContent = m; };

// The dev loop's two switches, both off unless the URL asks — see README.md.
// `?capture=1` keeps the drawing buffer so a screenshot of the room is not an
// empty PNG; `?xr=emulate` puts a headset that is not there behind navigator.xr.
// Neither costs the normal room anything: false IS WebGLRenderer's default for
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
// view at reduced resolution. This room parks its secondary panels off-centre on
// purpose, for a head turn to find, so the default blurs exactly the things it
// was told to keep readable. A room of text pays the GPU instead.
renderer.xr.setFoveation(0);
document.body.appendChild(renderer.domElement);

const scene = new THREE.Scene();
scene.background = new THREE.Color('#05070b');
// Near at 0.3 m: closer than that a panel is intersecting his face, and nothing
// he reads is ever meant to be inside 0.5 m anyway.
const camera = new THREE.PerspectiveCamera(70, window.innerWidth / window.innerHeight, 0.3, 100);
camera.position.set(0, EYE, 0);
scene.add(camera);

const rig = new THREE.Group();      // what the thumbstick turns
scene.add(rig);

const floor = new THREE.Mesh(
  new THREE.RingGeometry(0.5, 9, 40),
  new THREE.MeshBasicMaterial({ color: '#0d141e', side: THREE.DoubleSide, transparent: true, opacity: 0.5 }),
);
floor.rotation.x = -Math.PI / 2;
scene.add(floor);
scene.add(new THREE.GridHelper(10, 20, 0x182436, 0x101823));

window.addEventListener('resize', () => {
  camera.aspect = window.innerWidth / window.innerHeight;
  camera.updateProjectionMatrix();
  renderer.setSize(window.innerWidth, window.innerHeight);
});

// ---------- the room's contents ----------

let doc = { cards: [], lieutenants: [], columns: [] };
const bar = new LieutenantBar();
const board = new BoardPanel();
const windows = new Map();          // id -> Surface  ('card:<id>' | 'lt:<id>')
const state = { open: [], front: 'board' };

rig.add(bar.group, board.group);
bar.group.position.set(BAR.x, BAR.y, BAR.z);
bar.group.lookAt(0, EYE, 0);

// The sheet of faces arrives after the first paint, and a bar of dots that never
// became faces is worse than one that took a moment to.
whenFaces(() => repaint());

function surfaceFor(id) {
  if (id === 'board') return board;
  return windows.get(id) || null;
}

function open(id) {
  if (!windows.has(id)) {
    const s = id.startsWith('card:') ? new CardWindow(id.slice(5)) : new ChatWindow(id.slice(3));
    windows.set(id, s);
    rig.add(s.group);
  }
  state.open = openWindows(state.open, id);
  state.front = nextFront(state, { kind: 'open', id });
  layout();
}

function close(id) {
  const s = windows.get(id);
  if (!s) return;
  state.front = nextFront(state, { kind: 'close', id });
  state.open = state.open.filter((x) => x !== id);
  rig.remove(s.group);
  s.dispose();
  windows.delete(id);
  layout();
}

// Placement only moves what the captain has not moved himself: once he has
// picked a window up and put it somewhere, that is where it lives. A room that
// tidies itself behind your back is a room you cannot arrange.
function layout() {
  const ids = state.open;
  ids.forEach((id, i) => {
    const s = windows.get(id);
    if (!s || s.placed) return;
    const p = placeWindow(i, ids.length);
    s.group.position.set(p.x, p.y, p.z);
    s.group.lookAt(0, EYE, 0);
    s.setDistance(eyeDistance(p));
  });
  const boardBack = state.front !== 'board';
  const at = boardBack ? BACK : FRONT;
  board.group.position.set(0, at.y, at.z);
  board.group.lookAt(0, EYE, 0);
  // Pushing the board back moves it 36 cm further off, and its type is re-cut
  // for the new distance — that is what "readable wherever it sits" costs.
  board.setDistance(eyeDistance({ x: 0, y: at.y, z: at.z }));
  board.setFront(!boardBack);
  for (const [id, s] of windows) s.setFront(id === state.front);
  repaint();
}

function repaint() {
  bar.paint(doc);
  board.paint(doc);
  for (const s of windows.values()) s.paint(doc);
}

async function refresh() {
  try {
    doc = await fetch('/api/board').then((r) => r.json());
    repaint();
    say('');
  } catch (e) { say('the board did not answer: ' + ((e && e.message) || e)); }
}

// ---------- pointing at things ----------

const raycaster = new THREE.Raycaster();
const tmpMat = new THREE.Matrix4();
const tmpOrigin = new THREE.Vector3();
const tmpDir = new THREE.Vector3();

function pick(origin, direction) {
  raycaster.ray.origin.copy(origin);
  raycaster.ray.direction.copy(direction);
  const meshes = [bar.mesh, board.mesh, ...[...windows.values()].map((s) => s.mesh)];
  const hit = raycaster.intersectObjects(meshes, false)[0];
  if (!hit || !hit.uv) return null;
  const s = hit.object.userData.surface;
  return { surface: s, action: s.hitTest(hit.uv), point: hit.point, distance: hit.distance };
}

function idOf(surface) {
  if (surface === board) return 'board';
  for (const [id, s] of windows) if (s === surface) return id;
  return null;
}

// A click is the ordinary verb: it opens, it closes, it brings forward.
function activate(hit) {
  if (!hit) return;
  const { surface, action } = hit;
  const id = idOf(surface);
  if (action && action.kind === 'close' && id) return close(id);
  if (action && action.kind === 'card') return open('card:' + action.id);
  if (action && action.kind === 'lieutenant') return open('lt:' + action.id);
  if (id) { state.front = nextFront(state, { kind: 'focus', id }); layout(); }
}

// ---------- controllers: point, squeeze to carry, stick to size ----------

const REACH = 2.5;                  // how far the ray goes when it hits nothing
const controllers = [];
const held = new Map();             // controller -> { surface, w, h }
for (let i = 0; i < 2; i++) {
  const c = renderer.xr.getController(i);
  const ray = new THREE.Line(
    new THREE.BufferGeometry().setFromPoints([new THREE.Vector3(0, 0, 0), new THREE.Vector3(0, 0, -1)]),
    new THREE.LineBasicMaterial({ color: 0x4cc2ff }),
  );
  ray.scale.z = REACH;
  // The dot rides on the controller, not on the ray: the ray is scaled in z to
  // the hit distance, and a child of it would be stretched by the same amount.
  const dot = new THREE.Mesh(
    new THREE.SphereGeometry(0.012, 10, 8),
    new THREE.MeshBasicMaterial({ color: 0x4cc2ff }),
  );
  dot.visible = false;
  c.add(ray, dot);
  scene.add(c);
  controllers.push(c);

  const aim = () => {
    tmpMat.identity().extractRotation(c.matrixWorld);
    tmpOrigin.setFromMatrixPosition(c.matrixWorld);
    tmpDir.set(0, 0, -1).applyMatrix4(tmpMat).normalize();
    return pick(tmpOrigin, tmpDir);
  };
  // A ray that goes through what it is pointing at reads as "nothing here", so
  // every frame it is cut to the surface it lands on and the dot marks the spot.
  c.userData.aim = () => {
    const hit = aim();
    const len = hit ? hit.distance : REACH;
    ray.scale.z = len;
    dot.position.z = -len;
    dot.visible = !!hit;
  };

  c.addEventListener('selectstart', () => activate(aim()));
  c.addEventListener('squeezestart', () => {
    const hit = aim();
    // The bar is furniture: it does not get carried off, and neither does the
    // board — the board has a place and a button that moves it.
    if (!hit || hit.surface === bar || hit.surface === board) return;
    hit.surface.placed = true;
    held.set(c, { surface: hit.surface, w: hit.surface.widthM, h: hit.surface.heightM });
    c.attach(hit.surface.group);
  });
  c.addEventListener('squeezeend', () => {
    const h = held.get(c);
    if (!h) return;
    rig.attach(h.surface.group);
    held.delete(c);
    // He put it down somewhere else, so it is a different number of degrees
    // wide than it was when he picked it up: re-cut the type at where it now is.
    if (h.surface.setDistance(eyeDistance(h.surface.group.position))) h.surface.paint(doc);
  });
}

const edge = new Map();
function pressed(gp, i, id) {
  const now = !!(gp.buttons[i] && gp.buttons[i].pressed);
  const was = edge.get(id) || false;
  edge.set(id, now);
  return now && !was;
}

function readGamepads(dt) {
  const session = renderer.xr.getSession();
  if (!session) return;
  for (const src of session.inputSources) {
    const gp = src.gamepad;
    if (!gp) continue;
    const side = src.handedness || 'right';
    const ax = gp.axes || [];
    const x = ax.length > 2 ? ax[2] : (ax[0] || 0);
    const y = ax.length > 3 ? ax[3] : (ax[1] || 0);
    const holding = [...held.entries()].find(([c]) => controllers.indexOf(c) === (side === 'left' ? 0 : 1));

    if (pressed(gp, 4, side + '4')) { state.front = nextFront(state, { kind: 'swap' }); layout(); }
    if (pressed(gp, 5, side + '5')) { if (state.front !== 'board') close(state.front); }

    // A held window sizes with the stick; an empty hand turns the room.
    if (holding && Math.abs(y) > 0.2) {
      const s = holding[1].surface;
      const k = 1 - y * dt * 1.1;
      s.resize(s.widthM * k, s.heightM * k);
      s.paint(doc);
    } else if (!holding && Math.abs(x) > 0.2) {
      rig.rotation.y += x * dt * 1.1;
    }
  }
}

// ---------- the keyboard goes to the front window ----------
// A paired keyboard is the input story for now. What is in front is what is
// being worked on, so that is what typing belongs to.

const composing = { text: '' };
window.addEventListener('keydown', (e) => {
  if (desktopKey(e)) return;
  const id = state.front;
  if (!id || id === 'board') return;
  const payload = keyForEvent(e);
  if (!payload) return;
  e.preventDefault();
  if (payload.text) { composing.text += payload.text; return draftPaint(); }
  if (payload.key === 'BSpace') { composing.text = composing.text.slice(0, -1); return draftPaint(); }
  if (payload.key === 'Enter' && composing.text.trim()) return send(id, composing.text.trim());
});

function draftPaint() {
  const s = surfaceFor(state.front);
  if (!s) return;
  s.draft = composing.text;
  s.paint(doc);
  const g = s.ctx;
  const h = s.canvas.height, w = s.canvas.width;
  const strip = s.line(TYPE.body) + s.px(0.4);
  g.fillStyle = '#111a24';
  g.fillRect(0, h - strip, w, strip);
  g.fillStyle = '#4cc2ff';
  g.font = s.font(TYPE.body);
  g.fillText('› ' + composing.text, s.px(0.7), h - s.px(0.5));
  s.texture.needsUpdate = true;
}

// Sending is the board's own feedback route — the same one the composer uses.
async function send(id, text) {
  const target = id.startsWith('card:') ? 'card:' + id.slice(5) : 'lieutenant:' + id.slice(3);
  composing.text = '';
  try {
    await fetch('/api/feedback', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ actor: 'user', target, text }),
    });
  } catch (e) { /* the next refresh tells the truth either way */ }
  await refresh();
}

function desktopKey(e) {
  if (renderer.xr.isPresenting) return false;
  if (e.key === 'b') { state.front = nextFront(state, { kind: 'swap' }); layout(); return true; }
  return false;
}

// ---------- a desk, so this can be driven without a headset ----------

let dragging = false, moved = false, yaw = 0, pitch = 0;
renderer.domElement.addEventListener('pointerdown', () => { dragging = true; moved = false; });
window.addEventListener('pointermove', (e) => {
  if (!dragging || renderer.xr.isPresenting) return;
  if (Math.abs(e.movementX) + Math.abs(e.movementY) > 2) moved = true;
  yaw -= e.movementX * 0.003;
  pitch = Math.max(-1.2, Math.min(1.2, pitch - e.movementY * 0.003));
  camera.rotation.set(pitch, yaw, 0, 'YXZ');
});
window.addEventListener('pointerup', (e) => {
  const wasDragging = dragging;
  dragging = false;
  if (!wasDragging || moved || renderer.xr.isPresenting) return;   // a look is not a click
  const ndc = new THREE.Vector2(
    (e.clientX / window.innerWidth) * 2 - 1,
    -(e.clientY / window.innerHeight) * 2 + 1,
  );
  raycaster.setFromCamera(ndc, camera);
  activate(pick(raycaster.ray.origin, raycaster.ray.direction));
});

// ---------- entering ----------

const gate = document.getElementById('gate');
const uibar = document.getElementById('bar');

// The emulated headset installs itself over navigator.xr before anything asks
// navigator.xr a question, which is why this is started here and awaited in
// enter() rather than raced against the first click.
const emulated = DEV.get('xr') === 'emulate'
  ? import('./devxr.js').then((m) => m.install())
    .catch((e) => { say('the emulated headset did not install: ' + ((e && e.message) || e)); })
  : null;

async function enter() {
  if (emulated) await emulated;
  const flat = (why) => { say(why); gate.hidden = true; uibar.hidden = false; };
  if (!navigator.xr) return flat('no WebXR in this browser — flat view, drag to look, click to open');
  const ok = await navigator.xr.isSessionSupported('immersive-vr').catch(() => false);
  if (!ok) return flat('no headset here — flat view, drag to look, click to open');
  let session;
  try {
    session = await navigator.xr.requestSession('immersive-vr', {
      optionalFeatures: ['local-floor', 'bounded-floor', 'hand-tracking'],
    });
  } catch (e) { return flat('the headset refused the session: ' + ((e && e.message) || e)); }
  await renderer.xr.setSession(session);
  gate.hidden = true;
  uibar.hidden = true;
  session.addEventListener('end', () => { gate.hidden = false; uibar.hidden = true; });
}
document.getElementById('enter').addEventListener('click', enter);

uibar.addEventListener('click', (e) => {
  const b = e.target.closest('button');
  if (!b) return;
  if (b.id === 'b-swap') { state.front = nextFront(state, { kind: 'swap' }); layout(); }
  if (b.id === 'b-close' && state.front !== 'board') close(state.front);
});

// ---------- loop ----------

let last = 0;
renderer.setAnimationLoop((t) => {
  const dt = last ? Math.min(0.1, (t - last) / 1000) : 0.016;
  last = t;
  readGamepads(dt);
  if (renderer.xr.isPresenting) for (const c of controllers) c.userData.aim();
  renderer.render(scene, camera);
});

window.__bridge = { state, windows, board, bar, controllers, open, close, layout, get doc() { return doc; } };

refresh().then(() => { layout(); document.getElementById('gate').classList.add('ready'); });
setInterval(refresh, 5000);
