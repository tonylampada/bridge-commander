// shelves.js — four bounded places, and the cards standing in them.
//
// A shelf is a flat plane, turned to face the eye and tilted 25° back from
// vertical, holding eight slots. It is deliberately NOT a slice of a cylinder:
// a flat bounded wall of content is recalled significantly more accurately than
// the same content curved around the viewer, and full surround produces
// measurable loss of orientation. That is the most double-sourced finding in
// the whole spec, and it is why there are four planes here and not one arc.
//
// Under each one, on the real floor, a baked decal with the column's name. The
// layout that lost in the research lost for lacking exactly that — people build
// accurate mental maps from passive landmarks and cannot navigate abstract
// position without one.
//
// A card is a slab standing in a slot. Its POSITION says which column and where
// in it; a colour band on its edge says who owns it; its thickness says how long
// it has been sitting there; glyphs on the slot say what it is labelled. Depth
// into the shelf says **nothing at all**, and that is the discipline rather than
// an omission: two clones of one interface differing only in perspective
// retrieved at 5.98 s flat against 6.77 s in depth, and the "it pays off at
// scale" rebuttal was tested for and not found.

import * as THREE from 'three';
import * as W from './world.js';
import { root, Text, COL, cm, fontFor, inert, safe } from './kit.js';
import { Target } from './hover.js';

const NOW = () => Date.now();

// A slot with nothing in it is still a slot, and it has to look like one — an
// empty berth on a shelf is what teaches the lattice, and a lattice you can see
// is the difference between a place and a direction.
const EMPTY = 0.10;
const FILLED = 0.18;

// Turn a shelf's plane basis into a quaternion, so anything parented to the
// shelf can be positioned in the plane's own two coordinates.
function orient(object, plane) {
  const m = new THREE.Matrix4().makeBasis(
    new THREE.Vector3(...plane.right),
    new THREE.Vector3(...plane.up),
    new THREE.Vector3(...plane.normal),
  );
  object.quaternion.setFromRotationMatrix(m);
  object.position.set(plane.centre.x, plane.centre.y, plane.centre.z);
}

export class Shelf {
  constructor(index) {
    this.index = index;
    this.plane = W.shelfPlane(index);
    this.extent = W.shelfExtent(index);
    this.group = new THREE.Group();
    orient(this.group, this.plane);

    // The plate is centred on the slots it holds rather than on the shelf's own
    // centre — the lattice fans as it drops, so the two are not the same point.
    const board = new THREE.Group();
    board.position.set(this.extent.offsetU, this.extent.offsetV, 0);
    this.group.add(board);
    this.origin = { u: this.extent.offsetU, v: this.extent.offsetV };

    // The bounded region itself: a plate, and a rim a millimetre proud of it,
    // because two coplanar surfaces shimmer against each other and a shimmering
    // border is felt as eyestrain rather than seen as a bug.
    const plate = new THREE.Mesh(
      new THREE.PlaneGeometry(this.extent.widthM, this.extent.heightM),
      new THREE.MeshLambertMaterial({ color: COL.shelf }),
    );
    const rim = new THREE.LineSegments(
      new THREE.EdgesGeometry(new THREE.PlaneGeometry(this.extent.widthM, this.extent.heightM)),
      new THREE.LineBasicMaterial({ color: COL.faint }),
    );
    rim.position.z = 0.001;
    board.add(plate, rim);

    // One uikit root per shelf, coplanar with it, carrying every glyph the shelf
    // shows. One root rather than one per card: the slots are coplanar, so they
    // batch, and thirty-two roots would be thirty-two draw calls for two
    // characters each.
    this.ui = root({
      sizeX: this.extent.widthM,
      sizeY: this.extent.heightM,
      backgroundColor: COL.shelf,
      backgroundOpacity: 0,
    });
    inert(this.ui);
    this.ui.position.z = 0.002;
    board.add(this.ui);

    this.slots = [];
    for (let row = 0; row < W.SLOT.rows; row++) {
      for (let col = 0; col < W.SLOT.cols; col++) this.slots.push(this._slot(col, row));
    }

    // The lattice, scored into the shelf: eight slot outlines in ONE geometry, so
    // an empty berth is still visibly a berth for the price of a single draw
    // call. A slot you can see is what turns a direction into a place, and it is
    // also the only honest way to show a 6° responsive region around a 3.9° card
    // — the air around the mark IS part of the target.
    const pts = [];
    for (const s of this.slots) {
      const { u, v, w, h } = s.region;
      const c = [[u - w / 2, v + h / 2], [u + w / 2, v + h / 2], [u + w / 2, v - h / 2], [u - w / 2, v - h / 2]];
      for (let i = 0; i < 4; i++) {
        const a = c[i], b = c[(i + 1) % 4];
        pts.push(new THREE.Vector3(a[0], a[1], 0), new THREE.Vector3(b[0], b[1], 0));
      }
    }
    const lattice = new THREE.LineSegments(
      new THREE.BufferGeometry().setFromPoints(pts),
      new THREE.LineBasicMaterial({ color: COL.faint, transparent: true, opacity: 0.45 }),
    );
    lattice.position.z = 0.0012;
    this.group.add(lattice);
  }

  _slot(col, row) {
    const at = W.slotAt(this.index, col, row);
    const region = W.slotRegion(this.index, col, row);
    const face = W.cardFace(this.index, col, row);
    const W2 = this.extent.widthM / 2, H2 = this.extent.heightM / 2;

    // The responsive region: 6.06° where it sits, which is a good half again
    // wider than the card drawn inside it. Pad the hit box, not the drawing —
    // a ray scatters, and a collider cut to the mark is missed by somebody
    // aiming correctly.
    const cell = new THREE.Mesh(
      new THREE.PlaneGeometry(region.w, region.h),
      new THREE.MeshBasicMaterial({ color: COL.slot, transparent: true, opacity: EMPTY }),
    );
    cell.position.set(region.u, region.v, 0.0015);
    this.group.add(cell);

    // The spotlight: a ring on the surface that closes as the pointer comes in,
    // converging to a dot on contact. Microsoft's fix for having neither depth
    // certainty nor touch, and the only part of the hover that is continuous.
    const spot = new THREE.Mesh(
      new THREE.RingGeometry(region.w * 0.46, region.w * 0.5, 28),
      new THREE.MeshBasicMaterial({ color: '#7fd8ff', transparent: true, opacity: 0.8, side: THREE.DoubleSide }),
    );
    spot.position.set(region.u, region.v, 0.0035);
    spot.visible = false;
    this.group.add(spot);

    // The slab. It stands proud of the shelf along the normal and grows FORWARD
    // with age, so its thickness reads edge-on from the side — where a length
    // encoding is read — without any card ever sitting at a different place.
    const slab = new THREE.Group();
    slab.position.set(face.u, face.v, W.CARD.standM);
    this.group.add(slab);

    const body = new THREE.Mesh(
      new THREE.BoxGeometry(face.w, face.h, 1),
      new THREE.MeshLambertMaterial({ color: COL.slab }),
    );
    slab.add(body);
    const band = new THREE.Mesh(
      new THREE.BoxGeometry(1, 1, 1),
      new THREE.MeshLambertMaterial({ color: COL.faint }),
    );
    slab.add(band);

    // The glyphs sit on the SLOT, in the margin the padding already bought,
    // rather than on the card face — a 3.9° face at this distance holds about
    // five characters, which is not a label, it is a rumour.
    const strip = 0.04;
    const glyphs = new Text({
      positionType: 'absolute',
      positionLeft: cm(W2 + (region.u - this.origin.u) - region.w / 2),
      positionTop: cm(H2 - (region.v - this.origin.v) + region.h / 2 - strip),
      width: cm(region.w), height: cm(strip),
      textAlign: 'center', verticalAlign: 'center',
      fontSize: fontFor(W.TYPE.meta, at.dist), color: COL.faint, text: '',
    });
    this.ui.add(glyphs);

    const target = new Target({
      mesh: cell, mark: slab, spot, name: 'slot',
      base: new THREE.Color(COL.slot),
    });
    return { col, row, at, region, face, cell, spot, slab, body, band, glyphs, target, card: null };
  }

  // Fill the shelf from the board. Positions are the board's own order and the
  // room never re-sorts them: a set of things that reorders is a set of things
  // whose position you cannot learn.
  paint(doc, column, lieutenants) {
    const { visible } = W.shelfCards(doc, column && column.id);
    const now = NOW();
    this.slots.forEach((s, i) => {
      const card = visible[i] || null;
      s.card = card;
      const on = !!card;
      s.slab.visible = on;
      s.glyphs.setProperties({ text: on ? safe(W.glyphsFor(card).join(' ')) : '' });
      s.target.baseOpacity = on ? FILLED : EMPTY;
      if (s.target.state === 'idle') s.cell.material.opacity = s.target.baseOpacity;
      if (!on) return;
      const t = W.slabThickness(card, now) * s.at.scale;
      s.body.scale.set(1, 1, t);
      s.body.position.z = t / 2;
      const bandW = W.sizeForArc(W.CARD.bandDeg, s.at.dist);
      s.band.scale.set(bandW, s.face.h, t);
      s.band.position.set(-s.face.w / 2 + bandW / 2, 0, t / 2 + 0.0004);
      const lt = lieutenants.get(card.owner);
      s.band.material.color.set(W.agentColour(lt && lt.color));
      // Type is a second, redundant channel on the face itself, because colour
      // is never allowed to travel alone in here.
      s.body.material.color.set(card.type === 'plan' ? '#243347'
        : card.type === 'investigation' ? '#1f2f34' : COL.slab);
    });
  }

  tick(now) { for (const s of this.slots) s.target.tick(now); }
}

// ---- the landmark ---------------------------------------------------------

// A baked, non-emissive decal on the real floor, carrying the column's name.
// Deliberately not a target and deliberately not glowing: it is part of the
// room, which is the whole reason it works as an anchor.
export class Decal {
  constructor(index) {
    const d = W.decalAt(index);
    this.at = d;
    const dist = W.eyeDistance(d.pos);
    this.group = new THREE.Group();
    this.group.position.set(d.pos.x, 0.001, d.pos.z);
    // Lying on the floor and turned to face its own shelf. 'YXZ' so the yaw is
    // the OUTER rotation and happens in the world rather than inside a frame
    // that has already been tipped flat — which is the difference between four
    // decals in a row and four decals fanned across each other.
    this.group.rotation.order = 'YXZ';
    this.group.rotation.set(-Math.PI / 2, -d.azimuth * Math.PI / 180, 0);

    const plate = new THREE.Mesh(
      new THREE.PlaneGeometry(d.widthM, d.depthM),
      new THREE.MeshBasicMaterial({ color: COL.decal, transparent: true, opacity: 0.55 }),
    );
    this.group.add(plate);

    this.ui = root({
      sizeX: d.widthM, sizeY: d.depthM,
      flexDirection: 'column', justifyContent: 'center', alignItems: 'center',
      backgroundOpacity: 0,
    });
    inert(this.ui);
    this.ui.position.z = 0.002;
    this.group.add(this.ui);
    this.label = new Text({
      text: '', color: COL.dim, fontWeight: 'semi-bold',
      fontSize: fontFor(W.TYPE.head, dist),
    });
    // The shelf shows the active work and the long tail goes to the list, so the
    // landmark is also where the count of what is NOT on the shelf lives.
    this.count = new Text({
      text: '', color: COL.faint, fontSize: fontFor(W.TYPE.meta, dist),
    });
    this.ui.add(this.label, this.count);
  }

  paint(doc, column) {
    const { overflow, total } = W.shelfCards(doc, column && column.id);
    this.label.setProperties({ text: safe((column && (column.title || column.id)) || '') });
    this.count.setProperties({ text: safe(total + (overflow ? ' cards - ' + overflow + ' more in the list' : ' cards')) });
  }
}
