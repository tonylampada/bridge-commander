// hover.js — the ray, and what a thing does when it is pointed at.
//
// This is the part most likely to be under-built, and four vendors say so
// independently for the same reason: there is no tactile channel in the air, so
// the visual channel carries the affordance alone. Remove the signifier and 36%
// of people do not know where to press.
//
// **Six states, not three** — default, hovered-far, hovered-near *with the
// distance in it*, contact, held, released — and the proximity treatment worth
// copying is a spotlight on the surface that SHRINKS as you approach, closing to
// a dot on contact. That is the fix for having no depth certainty and no touch.
//
// The pointer itself is `@pmndrs/pointer-events`, vendored: W3C-shaped
// pointerover / pointerout / pointerdown / pointerup on real three.js objects,
// with the ray stopping at what it hits. The hand-rolled rectangles the old room
// declared while it painted are gone, and with them the whole class of bug where
// what was drawn and what answered a ray drifted apart.

import * as THREE from 'three';
import { createRayPointer } from '../../vendor/pointer-events/pointer/ray.js';
import { forwardHtmlEvents } from '../../vendor/pointer-events/forward.js';
import { STEP, ACK_MS, NEAR_M, spotlight } from './world.js';

const ACCENT = new THREE.Color('#4cc2ff');
const RING = new THREE.Color('#7fd8ff');

// A thing you can point at. `mesh` answers the ray; `mark` is what visibly
// reacts (usually the slab or sphere standing in front of it); `spot` is the
// shrinking spotlight ring drawn on the surface.
export class Target {
  constructor({ mesh, mark, spot, base, baseOpacity, onSelect, name }) {
    this.mesh = mesh;
    this.mark = mark || null;
    this.spot = spot || null;
    this.base = base ? base.clone() : new THREE.Color('#161f2b');
    this.baseOpacity = baseOpacity == null ? 0.14 : baseOpacity;
    this.onSelect = onSelect || null;
    this.name = name || '';
    this.state = 'idle';
    this.distance = Infinity;
    this._scale = 1;
    this._want = 1;
    mesh.userData.target = this;
    if (this.spot) this.spot.visible = false;

    mesh.addEventListener('pointerover', (e) => this._enter(e));
    mesh.addEventListener('pointermove', (e) => this._move(e));
    mesh.addEventListener('pointerout', () => this._leave());
    mesh.addEventListener('pointerdown', () => this._down());
    mesh.addEventListener('pointerup', () => this._up());
  }

  _enter(e) { this.distance = e.distance; this._set(e.distance < NEAR_M ? 'hovered-near' : 'hovered-far'); }
  _move(e) {
    this.distance = e.distance;
    if (this.state === 'contact' || this.state === 'held') return;
    this._set(e.distance < NEAR_M ? 'hovered-near' : 'hovered-far');
  }
  _leave() { this.distance = Infinity; this._set('idle'); }
  _down() { this._set('contact'); }
  _up() {
    // Released, and only then does the thing actually happen — the same order a
    // button has had since buttons, so a press you slide off is a press you took
    // back.
    const was = this.state === 'contact' || this.state === 'held';
    this._set(this.distance === Infinity ? 'idle' : 'released');
    if (was && this.onSelect) this.onSelect(this);
  }

  _set(state) {
    if (state === this.state) return;
    this.state = state;
    if (state === 'contact') this._until = performance.now() + ACK_MS;
    if (state === 'released') this._until = performance.now() + 220;
    this._paint();
  }

  _paint() {
    const s = this.state;
    const lit = s !== 'idle';
    const hot = s === 'contact' || s === 'held';
    // The mark steps up ~5% on hover and a little further on contact: the
    // acknowledgement has to land inside 100 ms, and Quest 3 has already spent
    // 70 of them on tracking before the event arrives.
    this._want = s === 'idle' || s === 'released' ? 1 : (hot ? STEP * 1.03 : STEP);
    if (this.mesh.material && this.mesh.material.color) {
      this.mesh.material.color.copy(hot ? ACCENT : (lit ? RING : this.base));
      if (this.mesh.material.opacity !== undefined) this.mesh.material.opacity = lit ? (hot ? 0.55 : 0.34) : this.baseOpacity;
    }
    if (this.spot) this.spot.visible = lit;
  }

  // The distance half of the near treatment, and the only part that is
  // continuous rather than a step: the ring closes as the pointer comes in.
  tick(now) {
    if ((this.state === 'contact' || this.state === 'released') && now > this._until) {
      this._set(this.state === 'contact' ? 'held' : (this.distance === Infinity ? 'idle' : 'hovered-far'));
    }
    if (this.spot && this.spot.visible) {
      const k = this.state === 'contact' || this.state === 'held' ? 0.14 : spotlight(this.distance);
      this.spot.scale.setScalar(k);
    }
    if (this.mark) {
      // 150 ms ease-out in, a touch quicker out: enter slower than you exit.
      const rate = this._want > this._scale ? 0.22 : 0.3;
      this._scale += (this._want - this._scale) * rate;
      this.mark.scale.setScalar(this._scale);
    }
  }
}

// ---- the ray -----------------------------------------------------------

// A ray that goes through what it is pointing at reports nothing about depth and
// makes aiming a guess, so every frame it is cut to the thing it lands on and a
// dot marks the spot.
export function makeRay(controller) {
  const line = new THREE.Line(
    new THREE.BufferGeometry().setFromPoints([new THREE.Vector3(0, 0, 0), new THREE.Vector3(0, 0, -1)]),
    new THREE.LineBasicMaterial({ color: 0x4cc2ff, transparent: true, opacity: 0.6 }),
  );
  const dot = new THREE.Mesh(
    new THREE.SphereGeometry(0.008, 10, 8),
    new THREE.MeshBasicMaterial({ color: 0x4cc2ff }),
  );
  dot.visible = false;
  controller.add(line, dot);
  return { line, dot };
}

const REACH = 2.4;                      // how far the ray is drawn when it lands on nothing

export class Rays {
  constructor(renderer, scene, camera, domElement) {
    this.scene = scene;
    this.camera = camera;
    this.domElement = domElement;
    this.pointers = [];
    this.controllers = [];
    this.presenting = false;
    const state = {};
    for (let i = 0; i < 2; i++) {
      const c = renderer.xr.getController(i);
      scene.add(c);
      const decor = makeRay(c);
      const pointer = createRayPointer(() => camera, { current: c }, state, {});
      const at = (e) => ({ button: 0, timeStamp: (e && e.timeStamp) || performance.now() });
      c.addEventListener('selectstart', (e) => pointer.down(at(e)));
      c.addEventListener('selectend', (e) => pointer.up(at(e)));
      this.controllers.push(c);
      this.pointers.push({ pointer, decor, controller: c });
    }
    // At a desk the mouse is the ray, through the same event pipe: one
    // interaction model end to end, so nothing in the room grows a second way of
    // being clicked. It is torn down inside a session, where a DOM click reaches
    // nobody and a second pointer would only fight the controller.
    this.desk = null;
    this.setPresenting(false);
  }

  setPresenting(on) {
    this.presenting = on;
    if (on && this.desk) { this.desk.destroy(); this.desk = null; }
    if (!on && !this.desk) this.desk = forwardHtmlEvents(this.domElement, () => this.camera, this.scene);
  }

  update() {
    const ev = { timeStamp: performance.now() };
    for (const { pointer, decor, controller } of this.pointers) {
      // A controller the runtime has not connected sits at the feet with its ray
      // pointing across the room, and a pointer running from there hovers
      // whatever it happens to cross. three turns its group invisible; that is
      // the signal.
      const live = this.presenting && controller.visible;
      pointer.setEnabled(live, ev);
      if (!live) { decor.line.visible = false; decor.dot.visible = false; continue; }
      decor.line.visible = true;
      pointer.move(this.scene, ev);
      const hit = pointer.getIntersection();
      const landed = !!(hit && hit.object && !hit.object.isVoidObject);
      const reach = landed ? hit.distance : REACH;
      decor.line.scale.z = reach;
      decor.dot.position.z = -reach;
      decor.dot.visible = landed;
    }
    if (this.desk) this.desk.update();
  }
}
