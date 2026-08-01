// surface.js — a panel in the room: a canvas, drawn by us, on a plane you can
// take hold of.
//
// Inside an immersive session the browser stops drawing HTML, so nothing the
// board already has — the kanban, the chat, a card — comes across. Every
// surface in the room has to be painted here. This is the paint kit: a canvas
// sized in world metres, a small stack of text and box primitives, and the
// grab / move / resize / close that makes it a window rather than a picture.
//
// It knows nothing about cards or lieutenants. What goes ON a surface is the
// business of whoever made it.

import * as THREE from '../../vendor/three/three.module.min.js';
import { arcDeg, texelsPerMetre, TYPE, BUILD } from './room.js';
import { face } from './faces.js';

export const FONT = 'ui-monospace, "DejaVu Sans Mono", "Courier New", monospace';
export const UI = 'system-ui, -apple-system, "Segoe UI", sans-serif';

// A canvas has pixels and the eye has degrees, and the conversion between them
// runs through the distance the panel stands at — so a Surface is told that
// distance and everything painted on it is asked for in degrees. `px(deg)` is
// the only way sizes get onto this canvas; a number of pixels chosen directly
// is a number nobody has checked against an eye.
const MAX_TEXELS = 2048;

export const COL = {
  bg: '#0d1117',
  bgUp: '#141b24',        // the panel standing in the front
  edge: '#1f2b3a',
  text: '#c8d2e0',
  dim: '#7d8ea6',
  faint: '#4a5a70',
  accent: '#4cc2ff',
  warn: '#f0a45a',
  good: '#4ad07a',
};

// wrap(ctx, text, maxWidth) -> lines. Measured, not guessed: a card title is
// prose and a monospace estimate is wrong often enough to look broken.
export function wrap(ctx, text, maxWidth) {
  const out = [];
  for (const para of String(text == null ? '' : text).split('\n')) {
    if (!para) { out.push(''); continue; }
    let line = '';
    for (const word of para.split(/(\s+)/)) {
      const next = line + word;
      if (line && ctx.measureText(next).width > maxWidth) { out.push(line.trimEnd()); line = word.trimStart(); }
      else line = next;
    }
    out.push(line.trimEnd());
  }
  return out;
}

export class Surface {
  // widthM / heightM are world metres; distanceM is how far from the eye it
  // stands, and it is what turns every degree below into canvas pixels.
  constructor({ widthM = 1.0, heightM = 0.7, distanceM = 1.5, title = '', closable = true } = {}) {
    this.widthM = widthM;
    this.heightM = heightM;
    this.distanceM = distanceM;
    this.title = title;
    this.closable = closable;
    this.front = false;
    this.dirty = true;

    this.canvas = document.createElement('canvas');
    this.ctx = this.canvas.getContext('2d', { alpha: false });
    this._cut();

    this.texture = new THREE.CanvasTexture(this.canvas);
    this.texture.colorSpace = THREE.SRGBColorSpace;
    this.texture.minFilter = THREE.LinearFilter;
    this.texture.magFilter = THREE.LinearFilter;
    this.texture.generateMipmaps = false;

    this.mesh = new THREE.Mesh(
      new THREE.PlaneGeometry(1, 1),
      new THREE.MeshBasicMaterial({ map: this.texture, toneMapped: false }),
    );
    this.mesh.userData.surface = this;

    this.frame = new THREE.LineSegments(
      new THREE.EdgesGeometry(new THREE.PlaneGeometry(1, 1)),
      new THREE.LineBasicMaterial({ color: new THREE.Color(COL.edge) }),
    );
    // A millimetre off the plate: two coplanar surfaces shimmer against each
    // other, and a shimmering border is felt as eyestrain rather than seen.
    this.frame.position.z = 0.001;

    this.group = new THREE.Group();
    this.group.add(this.mesh, this.frame);
    this.group.userData.surface = this;
    this._applySize();
  }

  // The canvas is cut to the panel's own arc: enough texels for PPD of them per
  // degree at the distance it stands, capped at what a texture can hold. When it
  // is capped the arc of everything on it is unchanged — the sheet just gets
  // softer, which is the failure you want of the two.
  _cut() {
    const scale = Math.min(
      texelsPerMetre(this.distanceM),
      MAX_TEXELS / Math.max(this.widthM, this.heightM),
    );
    this.canvas.width = Math.max(64, Math.round(this.widthM * scale));
    this.canvas.height = Math.max(64, Math.round(this.heightM * scale));
    this.pxPerDeg = this.canvas.width / arcDeg(this.widthM, this.distanceM);
  }

  // px(deg) — degrees of the captain's visual field, in canvas pixels, using the
  // panel's AVERAGE density. Good enough for type, which is never at the floor:
  // body text comes out 1.10° of cap in the middle and 0.85° in the far corner,
  // both clear of 0.7°. Not good enough for a target, which is measured against
  // the floor exactly — those use the pair below.
  px(deg) { return deg * this.pxPerDeg; }

  // ---- degrees where the thing actually sits -------------------------------
  //
  // A flat panel does not spread its pixels evenly across the eye. At a lateral
  // offset u from its centre, a metre of canvas is worth d/(d² + u²) radians
  // instead of 1/d, so a degree in the corner costs MORE pixels than a degree in
  // the middle — and a fixed pixel count out there subtends less arc than it was
  // asked for. That is not a rounding error at the edge of a wide panel: on a
  // 1.5 m window at 1.37 m the corner runs 0.84 of the average, which is how a
  // close button drawn at "3°" arrived at 2.58° of him.
  //
  // The close button is at the far edge BY CONSTRUCTION — chrome() pins it to the
  // right-hand corner of every window there will ever be — so hit geometry is
  // converted with atan at the position it occupies, in both axes, and no
  // small-angle average is involved anywhere in it.

  _u(x) { return (x / this.canvas.width - 0.5) * this.widthM; }      // m right of centre
  _v(y) { return (0.5 - y / this.canvas.height) * this.heightM; }    // m above centre

  // The true arc between two canvas coordinates.
  degX(x1, x2) {
    const d = this.distanceM;
    return (Math.atan(this._u(x2) / d) - Math.atan(this._u(x1) / d)) * 180 / Math.PI;
  }
  degY(y1, y2) {
    const d = this.distanceM;
    return (Math.atan(this._v(y1) / d) - Math.atan(this._v(y2) / d)) * 180 / Math.PI;
  }

  // The canvas coordinate exactly deg away from another — right/down for a
  // positive deg, left/up for a negative one. This is how a 3° box gets built
  // from the corner it is pinned to rather than from an average of the panel.
  atDegX(x, deg) {
    const d = this.distanceM;
    const u = d * Math.tan(Math.atan(this._u(x) / d) + deg * Math.PI / 180);
    return (u / this.widthM + 0.5) * this.canvas.width;
  }
  atDegY(y, deg) {
    const d = this.distanceM;
    const v = d * Math.tan(Math.atan(this._v(y) / d) - deg * Math.PI / 180);
    return (0.5 - v / this.heightM) * this.canvas.height;
  }

  // font(deg) — a font whose EM BOX is deg wide. Cap height is ~0.72 of that,
  // which is the number the 0.7° floor is about. Regular and bold only: lighter
  // strokes vibrate at this size and read as blur.
  font(deg, weight) { return (weight ? weight + ' ' : '') + Math.round(this.px(deg)) + 'px ' + UI; }
  line(deg) { return Math.round(this.px(deg) * 1.3); }

  _applySize() {
    this.mesh.scale.set(this.widthM, this.heightM, 1);
    this.frame.scale.set(this.widthM, this.heightM, 1);
  }

  _retexture() {
    this.texture.dispose();
    this.texture = new THREE.CanvasTexture(this.canvas);
    this.texture.colorSpace = THREE.SRGBColorSpace;
    this.texture.minFilter = THREE.LinearFilter;
    this.texture.magFilter = THREE.LinearFilter;
    this.texture.generateMipmaps = false;
    this.mesh.material.map = this.texture;
    this.mesh.material.needsUpdate = true;
    this.dirty = true;
  }

  // resize(w, h) — re-cut the canvas rather than stretching the plane, so text
  // is the same sharpness at every size the captain drags it to. The type keeps
  // its arc: a bigger panel shows MORE, it does not show the same thing bigger.
  resize(widthM, heightM) {
    this.widthM = Math.max(0.25, Math.min(4, widthM));
    this.heightM = Math.max(0.2, Math.min(3, heightM));
    this._cut();
    this._applySize();
    this._retexture();
  }

  // setDistance(m) — he carried it nearer or further, so the type is re-derived
  // at where it now stands. A panel that knows its own distance sizes its own
  // text; that is the whole reason the distance is stored on it.
  setDistance(distanceM) {
    if (!(distanceM > 0) || Math.abs(distanceM - this.distanceM) < 0.02) return false;
    this.distanceM = distanceM;
    this._cut();
    this._retexture();
    return true;
  }


  // Depth is the only thing that says which panel is being worked and which is
  // merely available: the front one is brighter and nearer, the rest fall back
  // and go quiet. No panel is ever moved behind the captain — swapping has to
  // cost a button press, never a neck movement.
  setFront(on) {
    if (on === this.front) return;
    this.front = on;
    this.frame.material.color.set(on ? COL.accent : COL.edge);
    this.mesh.material.color.setScalar(on ? 1 : 0.55);
    this.dirty = true;
  }

  // ---- painting ----------------------------------------------------------
  // Coordinates given to these are CANVAS pixels; helpers below take metres
  // where that reads better.

  begin() {
    const g = this.ctx;
    g.fillStyle = this.front ? COL.bgUp : COL.bg;
    g.fillRect(0, 0, this.canvas.width, this.canvas.height);
    g.textBaseline = 'alphabetic';
    this.hits = [];
    return g;
  }

  // A rectangle on the canvas that means something when it is pointed at. The
  // panel declares these AS it paints, so what is clickable is whatever is
  // actually drawn — the two cannot drift apart.
  //
  // Pad the hit box, not the drawing: the mark may be smaller than 3° of his
  // field, the thing that answers a ray may not be. Every region in the room
  // grows about its own centre to that floor here, once, rather than each
  // caller being trusted to remember it — and it is measured in true arc where
  // it sits, so a region near an edge grows by more pixels than one in the
  // middle to reach the same 3°.
  region(x, y, w, h, action) {
    const E = 1e-9;                    // already exactly at the floor is not under it
    if (this.degX(x, x + w) < BUILD.min - E) {
      const mid = x + w / 2;
      x = this.atDegX(mid, -BUILD.min / 2);
      w = this.atDegX(mid, BUILD.min / 2) - x;
    }
    if (this.degY(y, y + h) < BUILD.min - E) {
      const mid = y + h / 2;
      y = this.atDegY(mid, -BUILD.min / 2);
      h = this.atDegY(mid, BUILD.min / 2) - y;
    }
    // A region that grew off the edge of the canvas is a region whose last
    // degree cannot be hit — the ray's uv stops at the panel. Slide it back on.
    x = Math.max(0, Math.min(x, this.canvas.width - w));
    y = Math.max(0, Math.min(y, this.canvas.height - h));
    this.hits.push({ x, y, w, h, action });
  }

  // uv comes off the raycast with its origin at the bottom left, which is why y
  // is flipped exactly here and nowhere else in the room.
  hitTest(uv) {
    const x = uv.x * this.canvas.width;
    const y = (1 - uv.y) * this.canvas.height;
    for (let i = this.hits.length - 1; i >= 0; i--) {
      const r = this.hits[i];
      if (x >= r.x && x <= r.x + r.w && y >= r.y && y <= r.y + r.h) return r.action;
    }
    return null;
  }

  end() { this.texture.needsUpdate = true; this.dirty = false; }

  // A titled panel's chrome: the bar across the top, and the close mark the
  // controller ray can hit. Returns the y the content starts at.
  //
  // The bar is as tall as the close button has to be — 3° — because the close
  // button IS the bar's height, and at 62 × 54 canvas pixels it used to be 2.07°
  // of him: a target you aim at twice.
  chrome(g, subtitle, who) {
    const w = this.canvas.width;
    const pad = this.px(0.7);
    // Both of these are built by walking BACK from the right-hand edge in true
    // arc, because that corner is where they live and where a degree is dearest.
    const boxL = this.atDegX(w, -BUILD.min);      // left edge of the 3° close box
    const grabR = this.atDegX(boxL, -BUILD.gap);  // and 1.6° of clear air before it
    const box = w - boxL;
    const barH = Math.max(this.atDegY(0, BUILD.min), this.px(TYPE.head) * 1.7);
    g.fillStyle = this.front ? '#1b2531' : '#131a23';
    g.fillRect(0, 0, w, barH);

    // The title and its subtitle stop short of the close mark rather than
    // running under it — the 1.6° between them has to stay empty to be a gap.
    g.save();
    g.beginPath();
    g.rect(0, 0, grabR, barH);
    g.clip();
    let x = pad;
    // Who this conversation is with, where the 2D board puts it: the face first,
    // then the name. A lieutenant without one keeps the coloured dot.
    if (who) {
      const r = barH * 0.34;
      face(g, who.avatar, x + r, barH / 2, r, who.colour);
      x += r * 2 + pad;
    }
    const mid = barH / 2 + this.px(TYPE.head) * 0.36;
    g.fillStyle = this.front ? COL.accent : COL.dim;
    g.font = this.font(TYPE.head, 600);
    g.fillText(this.title, x, mid);
    // Measure the title in the TITLE's font, before switching to the smaller
    // one — measuring it in the subtitle's font puts the subtitle on top of it.
    const after = x + g.measureText(this.title).width + pad;
    if (subtitle) {
      g.fillStyle = COL.faint;
      g.font = this.font(TYPE.meta);
      g.fillText(subtitle, after, mid);
    }
    g.restore();

    if (this.closable) {
      g.strokeStyle = COL.faint;
      g.lineWidth = Math.max(2, this.px(0.09));
      const cx = w - box / 2, cy = barH / 2, r = this.px(0.5);
      g.beginPath();
      g.moveTo(cx - r, cy - r); g.lineTo(cx + r, cy + r);
      g.moveTo(cx + r, cy - r); g.lineTo(cx - r, cy + r);
      g.stroke();
      this.region(boxL, 0, box, barH, { kind: 'close' });
    }
    // The bar itself is the handle: point anywhere along it and squeeze to move
    // the window, which is the one gesture every window manager already taught
    // everybody. It ends a clear 1.6° before the close mark, so the gesture that
    // moves the window is never the gesture that throws it away.
    this.region(0, 0, grabR, barH, { kind: 'grab' });
    return barH;
  }

  dispose() {
    this.texture.dispose();
    this.mesh.geometry.dispose();
    this.mesh.material.dispose();
    this.frame.geometry.dispose();
    this.frame.material.dispose();
  }
}
