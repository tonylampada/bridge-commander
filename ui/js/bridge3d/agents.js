// agents.js — the lieutenants, as eight spheres that never move.
//
// Eight is small enough that a stable arc becomes a memorised landmark set for
// free, and that is the entire win here — so the positions are FIXED and are
// never sorted, reflowed or reordered for any reason. The roster fills the arc
// from the middle outward in a permanent order, which means a lieutenant joining
// never shifts one that is already there, and a half-crewed board is still
// centred rather than piled against one wall.
//
// The arc runs from 0° at the ends to +5° in the middle, above the shelves and
// never higher: looking up is the fastest route to a sore neck.
//
// Nothing here breathes. Idle motion, twitch-per-event and the working states
// are the last card in this line and they need this one still underneath.

import * as THREE from 'three';
import * as W from './world.js';
import { root, Text, COL, fontFor, inert, safe } from './kit.js';
import { Target } from './hover.js';

export class Agents {
  constructor() {
    this.group = new THREE.Group();
    this.slots = [];
    for (let i = 0; i < W.AGENT.slots; i++) this.slots.push(this._slot(i));
  }

  _slot(i) {
    const at = W.agentAt(i);
    const g = new THREE.Group();
    g.position.set(at.pos.x, at.pos.y, at.pos.z);
    g.lookAt(0, W.EYE, 0);
    this.group.add(g);

    const ball = new THREE.Mesh(
      new THREE.SphereGeometry(W.AGENT.diaM / 2, 28, 20),
      new THREE.MeshLambertMaterial({ color: COL.faint }),
    );
    g.add(ball);

    // The drawn sphere is 5.16° and the thing that answers a ray is 6.06°, so
    // the collider is its own geometry rather than the ball itself. It draws
    // nothing at all — no colour, no depth — it only exists to be hit.
    const hitR = W.sphereForArc(W.BUILD.hit, at.dist);
    const hit = new THREE.Mesh(
      new THREE.SphereGeometry(hitR, 12, 8),
      new THREE.MeshBasicMaterial({ colorWrite: false, depthWrite: false }),
    );
    g.add(hit);

    // The proximity ring, on the plane facing the eye, closing to a dot as the
    // pointer comes in.
    const spot = new THREE.Mesh(
      new THREE.RingGeometry(hitR * 0.92, hitR, 32),
      new THREE.MeshBasicMaterial({ color: '#7fd8ff', transparent: true, opacity: 0.8, side: THREE.DoubleSide }),
    );
    spot.visible = false;
    g.add(spot);

    // Colour never travels alone: the name under the sphere is the second
    // channel, and it is what makes two lieutenants of similar hue two people.
    const ui = root({
      sizeX: W.sizeForArc(W.AGENT.pitchDeg - W.BUILD.gap, at.dist),
      sizeY: W.sizeForArc(W.TYPE.body * 1.6, at.dist),
      justifyContent: 'center', alignItems: 'center', backgroundOpacity: 0,
    });
    inert(ui);
    ui.position.y = -(W.AGENT.diaM / 2 + W.sizeForArc(W.TYPE.body * 1.3, at.dist));
    g.add(ui);
    const label = new Text({
      text: '', color: COL.dim, fontWeight: 'semi-bold',
      fontSize: fontFor(W.TYPE.body, at.dist),
    });
    ui.add(label);

    const target = new Target({ mesh: hit, mark: ball, spot, name: 'lieutenant', base: new THREE.Color(COL.faint) });
    // A collider that draws nothing has no colour to change, so the hover state
    // lives on the ball's rim instead — same six states, painted where they can
    // actually be seen.
    target._paint = () => {
      const s = target.state;
      const hot = s === 'contact' || s === 'held';
      const lit = s !== 'idle';
      target._want = s === 'idle' || s === 'released' ? 1 : (hot ? W.STEP * 1.03 : W.STEP);
      ball.material.emissive.set(hot ? '#2a5f7a' : (lit ? '#16303f' : '#000000'));
      spot.visible = lit;
    };

    return { i, at, group: g, ball, hit, spot, ui, label, target, lt: null };
  }

  // Who sits where. `index` is the lieutenant's place in the board's own roster,
  // and the mapping from that to a slot is fixed for the life of the roster.
  paint(doc) {
    const lts = doc.lieutenants || [];
    for (const s of this.slots) { s.lt = null; }
    lts.forEach((lt, index) => {
      const slot = W.agentSlotFor(index);
      if (slot < 0) return;
      const s = this.slots[slot];
      s.lt = lt;
      s.ball.material.color.set(W.agentColour(lt.color));
      s.label.setProperties({ text: safe(lt.name || lt.id) });
    });
    for (const s of this.slots) {
      const on = !!s.lt;
      s.ball.visible = on;
      s.ui.visible = on;
      // An empty berth answers no ray — `pointerEvents`, not `visible`, because
      // that is the property the pointer library actually reads.
      s.hit.pointerEvents = on ? 'listener' : 'none';
      // An empty berth is still a place — it says the arc holds eight and four
      // of them are not crewed, which is information rather than a gap.
      if (!on) { s.label.setProperties({ text: '' }); s.spot.visible = false; }
    }
  }

  tick(now) { for (const s of this.slots) s.target.tick(now); }
}
