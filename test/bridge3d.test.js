// The room, measured. Not "the constants say 6°" — the constants saying 6° is
// exactly what cannot fail when the box built from them arrives at 4.7°, and
// that is what shipped once already.
//
// So everything below builds the room's real geometry, puts the four corners of
// every responsive region into world coordinates, and re-derives the arc from
// the angle between direction vectors out of the eye — acos of a dot product,
// which is a different formula from the atan construction under test. A
// measurement taken with the code under test is not a measurement.
//
// The floors themselves live in the `vr-design` skill and are not restated here
// beyond the names world.js gives them.

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.join(__dirname, '..');
const UI = path.join(ROOT, 'ui', 'js', 'bridge3d');
const load = (f) => import(path.join(UI, f));

const DEG = 180 / Math.PI;
const sub = (a, b) => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
const dot = (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const len = (a) => Math.hypot(a[0], a[1], a[2]);
const between = (a, b) => Math.acos(Math.max(-1, Math.min(1, dot(a, b) / (len(a) * len(b))))) * DEG;
const mid = (a, b) => [(a[0] + b[0]) / 2, (a[1] + b[1]) / 2, (a[2] + b[2]) / 2];

// ---- the room, built ------------------------------------------------------
//
// Every responsive region in the standing world, as four world-space corners
// plus the eye it is seen from. `kind` is only for the failure message.

async function room() {
  const W = await load('world.js');
  const eye = [0, W.EYE, 0];
  const out = [];

  // The slots. A cell lies ON its shelf plane, so its corners come from the
  // plane's own two axes rather than from a rectangle facing the eye.
  for (let s = 0; s < W.SHELF.azimuths.length; s++) {
    const plane = W.shelfPlane(s);
    const o = [plane.centre.x, plane.centre.y, plane.centre.z];
    const on = (u, v) => [
      o[0] + u * plane.right[0] + v * plane.up[0],
      o[1] + u * plane.right[1] + v * plane.up[1],
      o[2] + u * plane.right[2] + v * plane.up[2],
    ];
    for (let row = 0; row < W.SLOT.rows; row++) {
      for (let col = 0; col < W.SLOT.cols; col++) {
        const r = W.slotRegion(s, col, row);
        const f = W.cardFace(s, col, row);
        out.push({
          kind: `slot ${s}.${col}.${row}`, eye, hit: true,
          corners: [on(r.u - r.w / 2, r.v + r.h / 2), on(r.u + r.w / 2, r.v + r.h / 2),
            on(r.u - r.w / 2, r.v - r.h / 2), on(r.u + r.w / 2, r.v - r.h / 2)],
          mark: [on(f.u - f.w / 2, f.v + f.h / 2), on(f.u + f.w / 2, f.v + f.h / 2),
            on(f.u - f.w / 2, f.v - f.h / 2), on(f.u + f.w / 2, f.v - f.h / 2)],
        });
      }
    }
  }

  // The lieutenants. A sphere's region is a sphere: it subtends 2·asin(r/d) in
  // every direction at once, so it is described by its own angular radius
  // rather than by four corners that would only ever approximate one.
  for (let i = 0; i < W.AGENT.slots; i++) {
    const a = W.agentAt(i);
    const c = [a.pos.x, a.pos.y, a.pos.z];
    const d = len(sub(c, eye));
    const half = (R) => 2 * Math.asin(R / d) * DEG;
    out.push({
      kind: `lieutenant ${i}`, eye, hit: true, sphere: true, centre: c, dist: d,
      arc: half(W.sphereForArc(W.BUILD.hit, a.dist)),
      markArc: half(W.AGENT.diaM / 2),
    });
  }

  // The plate that opens the list, lying flat on the floor.
  const p = W.plate();
  const pc = [p.pos.x, p.pos.y, p.pos.z];
  out.push({
    kind: 'list plate', eye, hit: true, floor: true,
    corners: [[pc[0] - p.widthM / 2, 0, pc[2] - p.depthM / 2], [pc[0] + p.widthM / 2, 0, pc[2] - p.depthM / 2],
      [pc[0] - p.widthM / 2, 0, pc[2] + p.depthM / 2], [pc[0] + p.widthM / 2, 0, pc[2] + p.depthM / 2]],
  });
  return { W, eye, regions: out };
}

// The region's arc, from the angle between the directions to the midpoints of
// its opposite edges — top-left/top-right/bottom-left/bottom-right order. This
// is acos of a dot product, which is a different derivation from the atan
// construction under test, which is the whole point of doing it here.
function arcOf(r, which) {
  if (r.sphere) { const a = which === 'mark' ? r.markArc : r.arc; return { w: a, h: a }; }
  const [tl, tr, bl, br] = which === 'mark' ? r.mark : r.corners;
  const l = sub(mid(tl, bl), r.eye), rt = sub(mid(tr, br), r.eye);
  const t = sub(mid(tl, tr), r.eye), b = sub(mid(bl, br), r.eye);
  return { w: between(l, rt), h: between(t, b) };
}

const hasMark = (r) => (r.sphere ? r.markArc != null : !!r.mark);

// Where a region sits, as a box in azimuth and elevation, plus how far away it
// is. Two targets have to be 1.6° of ARC apart, and a degree of azimuth is only
// cos(elevation) of a degree of arc — so the horizontal gap is converted where
// it is compared, further down.
function extent(r) {
  if (r.sphere) {
    const v = sub(r.centre, r.eye);
    const flat = Math.hypot(v[0], v[2]);
    const el = Math.atan2(v[1], flat) * DEG;
    const az = Math.atan2(v[0], -v[2]) * DEG;
    const halfAz = r.arc / 2 / Math.cos(el * Math.PI / 180);
    return {
      l: az - halfAz, r: az + halfAz, b: el - r.arc / 2, t: el + r.arc / 2,
      near: r.dist, far: r.dist, mid: r.dist, el,
    };
  }
  const az = [], el = [], d = [];
  for (const c of r.corners) {
    const v = sub(c, r.eye);
    const flat = Math.hypot(v[0], v[2]);
    az.push(Math.atan2(v[0], -v[2]) * DEG);
    el.push(Math.atan2(v[1], flat) * DEG);
    d.push(len(v));
  }
  return {
    l: Math.min(...az), r: Math.max(...az), b: Math.min(...el), t: Math.max(...el),
    near: Math.min(...d), far: Math.max(...d), mid: (Math.min(...d) + Math.max(...d)) / 2,
    el: (Math.min(...el) + Math.max(...el)) / 2,
  };
}

// A region's boundary, as world points all the way round it — enough of them
// that the smallest gap between two regions is found where it really is rather
// than only at the four corners.
const STEPS = 8;
function outline(r) {
  const out = [];
  if (r.sphere) {
    // A sphere's outline is its silhouette circle, drawn on the plane facing the
    // eye at the radius that actually subtends its arc.
    const v = sub(r.centre, r.eye);
    const R = r.dist * Math.sin(r.arc / 2 * Math.PI / 180);
    const right = [-v[2], 0, v[0]];
    const rl = len(right);
    const rn = [right[0] / rl, 0, right[2] / rl];
    const up = [rn[1] * v[2] - rn[2] * v[1], rn[2] * v[0] - rn[0] * v[2], rn[0] * v[1] - rn[1] * v[0]];
    const ul = len(up);
    const un = [up[0] / ul, up[1] / ul, up[2] / ul];
    for (let k = 0; k < 4 * STEPS; k++) {
      const t = (k / (4 * STEPS)) * Math.PI * 2;
      out.push([
        r.centre[0] + R * (Math.cos(t) * rn[0] + Math.sin(t) * un[0]),
        r.centre[1] + R * Math.sin(t) * un[1],
        r.centre[2] + R * (Math.cos(t) * rn[2] + Math.sin(t) * un[2]),
      ]);
    }
    return out;
  }
  const [tl, tr, bl, br] = r.corners;
  const walk = (a, b) => {
    for (let k = 0; k < STEPS; k++) {
      const t = k / STEPS;
      out.push([a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t, a[2] + (b[2] - a[2]) * t]);
    }
  };
  walk(tl, tr); walk(tr, br); walk(br, bl); walk(bl, tl);
  return out;
}

// ---- the floors -----------------------------------------------------------

test('every responsive region is 6° where it sits — the padded hit box, not the mark', async () => {
  const { W, regions } = await room();
  assert.ok(regions.length >= 40, `only ${regions.length} regions in the room`);
  for (const r of regions) {
    const a = arcOf(r, 'hit');
    assert.ok(a.w >= W.HIT, `${r.kind}: ${a.w.toFixed(2)}° wide, floor is ${W.HIT}°`);
    assert.ok(a.h >= W.HIT, `${r.kind}: ${a.h.toFixed(2)}° tall, floor is ${W.HIT}°`);
  }
});

test('and the mark drawn inside it still clears the 3° floor', async () => {
  const { W, regions } = await room();
  for (const r of regions) {
    if (!hasMark(r)) continue;
    const a = arcOf(r, 'mark');
    assert.ok(a.w >= W.MARK, `${r.kind}: the drawn mark is ${a.w.toFixed(2)}° wide, floor is ${W.MARK}°`);
    assert.ok(a.h >= W.MARK, `${r.kind}: the drawn mark is ${a.h.toFixed(2)}° tall, floor is ${W.MARK}°`);
    // ...and the padding is real padding: the region has to be bigger than what
    // it is padding, or "pad the hit box, not the drawing" has become a slogan.
    const hit = arcOf(r, 'hit');
    assert.ok(hit.w > a.w && hit.h > a.h, `${r.kind}: the region is not larger than the mark inside it`);
  }
});

test('no two of them are closer than 1.6° of clear air', async () => {
  const { W, regions } = await room();
  // Measured as the smallest angle between the two OUTLINES, sampled all the way
  // round each of them. Not between their bounding boxes: a cell lying on a
  // plane tilted away from the eye is a keystone in the eye's own angles rather
  // than a rectangle, two cells on one shelf lean the same way, and comparing
  // the bottom corner of one against the top corner of the other measures a
  // distance between two points that are nowhere near each other.
  const outlines = regions.map((r) => ({ kind: r.kind, pts: outline(r) }));
  for (let i = 0; i < outlines.length; i++) {
    for (let j = i + 1; j < outlines.length; j++) {
      const a = outlines[i], b = outlines[j];
      let apart = Infinity;
      for (const p of a.pts) for (const q of b.pts) {
        const d = between(sub(p, regions[i].eye), sub(q, regions[j].eye));
        if (d < apart) apart = d;
      }
      assert.ok(apart >= W.GAP,
        `${a.kind} and ${b.kind} are ${apart.toFixed(2)}° apart, floor is ${W.GAP}°`);
    }
  }
});

test('nothing is over the horizon, behind him, or past the shoulders', async () => {
  const { W, regions } = await room();
  for (const r of regions) {
    const e = extent(r);
    assert.ok(e.t <= W.RISE, `${r.kind} reaches ${e.t.toFixed(1)}° up — looking up is a sore neck`);
    assert.ok(Math.abs(e.l) <= 45 && Math.abs(e.r) <= 45,
      `${r.kind} runs to ${Math.max(Math.abs(e.l), Math.abs(e.r)).toFixed(1)}° off centre, past the ±45° bound`);
    // The floor is where floors are: a landmark lying on it cannot be raised into
    // the reading band, and it is glanced at rather than read.
    const floorOf = r.floor ? W.FLOOR_LOOK : W.SINK;
    assert.ok(e.b >= -floorOf, `${r.kind} runs down to ${e.b.toFixed(1)}°, past −${floorOf}°`);
  }
});

test('everything he stands in front of is inside the comfort band', async () => {
  const { W, regions } = await room();
  for (const r of regions) {
    const e = extent(r);
    assert.ok(e.near >= W.NEAR, `${r.kind} comes to ${e.near.toFixed(2)} m — too near the face`);
    assert.ok(e.mid <= W.FAR + 1e-9, `${r.kind} stands at ${e.mid.toFixed(2)} m — past the comfort band`);
  }
});

test('the shelves are centred where the eyes rest', async () => {
  const W = await load('world.js');
  const centre = -W.shelfCentreElev();
  assert.ok(centre >= W.DROP[0] && centre <= W.DROP[1],
    `the shelves are centred ${centre.toFixed(1)}° below the horizon, not ${W.DROP.join('–')}°`);
});

// ---- the type -------------------------------------------------------------

test('the smallest type in the room clears the 0.7° cap-height floor everywhere it is used', async () => {
  const W = await load('world.js');
  for (const [name, em] of Object.entries(W.TYPE)) {
    assert.ok(em * W.CAP >= 0.7, `${name} type is ${(em * W.CAP).toFixed(2)}° of cap height — under the floor`);
  }
  assert.ok(W.TYPE.body >= 1.4, 'body text should be ~1.5° of em box');
  assert.ok(W.TYPE.head > W.TYPE.body && W.TYPE.body > W.TYPE.meta, 'the ladder is head > body > meta');
});

test('a font asked for in degrees comes out that many degrees at the distance it stands', async () => {
  const K = await import(path.join(UI, 'kit.js')).catch(() => null);
  // kit.js pulls three and uikit through the page's import map, which node has
  // no business resolving — so the one pure function on it is re-derived here
  // from its own source rather than imported.
  void K;
  const src = fs.readFileSync(path.join(UI, 'kit.js'), 'utf8');
  assert.match(src, /export const PIXEL = 0\.01/, 'a uikit unit is a centimetre');
  assert.match(src, /export function fontFor\(deg, distM\)/, 'type is authored in degrees at a distance');
  const W = await load('world.js');
  // fontFor(deg, d) is sizeForArc(deg, d) in centimetres; check the identity the
  // room relies on rather than the spelling.
  for (const d of [1.2, 1.75, 1.97, 2.0]) {
    const cm = 2 * d * Math.tan(W.TYPE.body * Math.PI / 360) / 0.01;
    assert.ok(Math.abs(cm - W.sizeForArc(W.TYPE.body, d) * 100) < 1e-9);
    assert.ok(cm > 2.5, `body text at ${d} m would be ${cm.toFixed(1)} cm — check the unit`);
  }
});

test('arc and metres convert both ways', async () => {
  const { arcDeg, sizeForArc } = await load('world.js');
  for (const [size, dist] of [[0.12, 1.75], [0.18, 2.0], [0.8, 1.2]]) {
    assert.ok(Math.abs(sizeForArc(arcDeg(size, dist), dist) - size) < 1e-12, 'round trip');
  }
  assert.ok(Math.abs(arcDeg(0.12, 1.75) - 57.3 * 0.12 / 1.75) < 0.01, 'the small-angle rule of thumb');
});

// ---- the discipline -------------------------------------------------------

test('a shelf is a flat bounded plane, not a slice of a cylinder', async () => {
  const W = await load('world.js');
  const planes = W.SHELF.azimuths.map((_, i) => W.shelfPlane(i));
  // Every slot on a shelf lies exactly on that shelf's plane — which is what
  // makes it a surface objects are constrained to rather than a free volume.
  for (let i = 0; i < planes.length; i++) {
    const p = planes[i];
    for (const s of W.slots(i)) {
      const off = (s.pos.x - p.centre.x) * p.normal[0] + (s.pos.y - p.centre.y) * p.normal[1]
        + (s.pos.z - p.centre.z) * p.normal[2];
      assert.ok(Math.abs(off) < 1e-9, `slot ${i}.${s.col}.${s.row} is ${off.toFixed(4)} m off its own shelf`);
    }
    // Tilted 25° back from vertical: the normal rises by exactly that much.
    const rise = Math.asin(p.normal[1]) * DEG;
    assert.ok(Math.abs(rise - W.SHELF.tiltDeg) < 1e-9, `shelf ${i} is tilted ${rise.toFixed(2)}°, not ${W.SHELF.tiltDeg}°`);
  }
  // And they are four distinct planes with air between them, not one surface:
  // adjacent shelves face measurably different directions.
  for (let i = 1; i < planes.length; i++) {
    const turn = between(planes[i - 1].normal, planes[i].normal);
    assert.ok(turn > 15, `shelves ${i - 1} and ${i} face within ${turn.toFixed(1)}° of each other — that is a cylinder`);
    const gap = (W.SHELF.azimuths[i] - W.SHELF.azimuths[i - 1])
      - W.shelfHalfAngle(i - 1) - W.shelfHalfAngle(i);
    assert.ok(gap > 1, `shelves ${i - 1} and ${i} have ${gap.toFixed(2)}° between their plates`);
  }
});

test('depth into the shelf encodes nothing', async () => {
  const W = await load('world.js');
  const now = Date.UTC(2026, 7, 1);
  const day = 86400000;
  // Every card in a slot stands off its shelf by the same amount, whatever the
  // card is: the third axis is deliberately left unspent, and the thickness that
  // does vary grows forward from a common plane rather than sinking in.
  assert.ok(W.CARD.standM > 0, 'a slab stands off the shelf');
  const thin = W.slabThickness({ updated: new Date(now).toISOString() }, now);
  const old = W.slabThickness({ updated: new Date(now - 90 * day).toISOString() }, now);
  const mids = W.slabThickness({ updated: new Date(now - 7 * day).toISOString() }, now);
  assert.ok(Math.abs(thin - W.CARD.thinM) < 1e-9, 'a brand new card is the thin end of the scale');
  assert.ok(Math.abs(old - W.CARD.thickM) < 1e-9, 'and an ancient one is clamped to the thick end');
  assert.ok(mids > thin && mids < old, 'age reads as thickness in between');
});

test('the lieutenants sit in fixed berths that never sort or reflow', async () => {
  const W = await load('world.js');
  const seen = new Set();
  for (let i = 0; i < W.AGENT.slots; i++) {
    const slot = W.agentSlotFor(i);
    assert.ok(slot >= 0 && slot < W.AGENT.slots, `roster place ${i} has no berth`);
    assert.ok(!seen.has(slot), `two lieutenants share berth ${slot}`);
    seen.add(slot);
  }
  assert.strictEqual(W.agentSlotFor(W.AGENT.slots), -1, 'a ninth lieutenant has nowhere to stand, and says so');
  // Adding one never moves one that is already there.
  const before = [0, 1, 2, 3].map(W.agentSlotFor);
  const after = [0, 1, 2, 3, 4].map(W.agentSlotFor).slice(0, 4);
  assert.deepStrictEqual(after, before, 'a lieutenant joining reflowed the arc');
  // And the half-crewed board is still centred rather than piled against a wall.
  const az = before.map((s) => W.agentSlotAzimuth(s));
  assert.ok(Math.abs(az.reduce((a, b) => a + b, 0)) < 1e-9, 'four lieutenants are not centred on the arc');
});

test('the arc of lieutenants is 8 × 18 cm at 2 m, 11.25° apart, and never above +5°', async () => {
  const W = await load('world.js');
  assert.strictEqual(W.AGENT.slots, 8);
  assert.ok(Math.abs(W.AGENT.diaM - 0.18) < 1e-9);
  assert.ok(Math.abs(W.AGENT.distM - 2.0) < 1e-9);
  for (let i = 0; i < W.AGENT.slots; i++) {
    const a = W.agentAt(i);
    assert.ok(a.el >= 0 && a.el <= W.AGENT.riseDeg + 1e-9, `lieutenant ${i} sits at ${a.el.toFixed(2)}°`);
    if (i) {
      const step = a.az - W.agentAt(i - 1).az;
      assert.ok(Math.abs(step - W.AGENT.pitchDeg) < 1e-9, `berths ${i - 1} and ${i} are ${step.toFixed(2)}° apart`);
    }
  }
});

test('full white is clamped, and colour never travels alone', async () => {
  const W = await load('world.js');
  assert.strictEqual(W.agentColour('#ffffff'), '#ebebeb');
  assert.strictEqual(W.agentColour('#7c5cff'), '#7c5ceb');
  assert.strictEqual(W.agentColour(null), '#8aa0bb');
  // The second channel on a lieutenant is the name under it, and on a card it is
  // the label glyphs beside the owner's band. Both are drawn, in agents.js and
  // in shelves.js, and neither is optional.
  assert.match(fs.readFileSync(path.join(UI, 'agents.js'), 'utf8'), /label\.setProperties\(\{ text: safe\(lt\.name/);
  assert.deepStrictEqual(W.glyphsFor({ labels: ['infra', 'ui', 'perf', 'extra'] }), ['IN', 'UI', 'PE']);
  assert.deepStrictEqual(W.glyphsFor({}), []);
});

test('a shelf shows the active work and the tail goes to the list, in the board’s own order', async () => {
  const W = await load('world.js');
  const cards = Array.from({ length: 13 }, (_, i) => ({ id: 'c' + i, column: 'working' }));
  const doc = { cards: [...cards, { id: 'x', column: 'review' }] };
  const { visible, overflow, total } = W.shelfCards(doc, 'working');
  assert.strictEqual(visible.length, W.PER_SHELF);
  assert.strictEqual(overflow, 13 - W.PER_SHELF);
  assert.strictEqual(total, 13);
  assert.deepStrictEqual(visible.map((c) => c.id), cards.slice(0, W.PER_SHELF).map((c) => c.id),
    'the room re-sorted the shelf, which is the one thing it must never do');
  assert.strictEqual(W.PER_SHELF, W.SLOT.cols * W.SLOT.rows);
});

test('the escape hatch exists, is flat, and stands where a panel is read', async () => {
  const W = await load('world.js');
  const p = W.listPanel();
  assert.ok(p.distM >= 1.0 && p.distM <= W.FAR, `the list stands at ${p.distM} m`);
  const centre = -p.centreElevDeg;
  assert.ok(centre >= 10 && centre <= 20, `the list is centred ${centre}° below the horizon`);
  assert.ok(p.heightDeg / 2 - centre <= W.RISE, 'the list runs up over the horizon');
  // Its rows are read, not pressed — so the only thing on it held to the hit
  // floor is its own controls, and those are sized from the distance it stands.
  const row = W.listRow();
  assert.ok(Math.abs(row.heightM - W.sizeForArc(W.BUILD.hit, p.distM)) < 1e-12);
  const src = fs.readFileSync(path.join(UI, 'list.js'), 'utf8');
  assert.match(src, /new Input\(/, 'the list is searchable');
  assert.match(src, /overflow: 'scroll'/, 'every card, which means it scrolls');
});

// ---- the six states -------------------------------------------------------

test('every interactive thing has six states and a spotlight that closes', async () => {
  const W = await load('world.js');
  assert.deepStrictEqual(W.STATE,
    ['idle', 'hovered-far', 'hovered-near', 'contact', 'held', 'released'],
    'six states, not three — there is no haptic channel to carry the affordance');
  const far = W.spotlight(W.REACH_M[1]);
  const near = W.spotlight(W.REACH_M[0]);
  assert.ok(far > near, 'the spotlight has to SHRINK as the pointer comes in');
  assert.ok(near <= 0.15, 'and converge to something like a dot on contact');
  for (const d of [0, 0.1, 5, 50]) {
    const k = W.spotlight(d);
    assert.ok(k >= 0.14 && k <= 1, `spotlight(${d}) is ${k}`);
  }
  assert.ok(W.ACK_MS <= 300 && W.STEP > 1 && W.STEP < 1.1, 'a ~5% step, acknowledged fast');
  const src = fs.readFileSync(path.join(UI, 'hover.js'), 'utf8');
  for (const s of W.STATE) assert.ok(src.includes(`'${s}'`), `hover.js never enters "${s}"`);
});

test('the ray is the vendored pointer library, not a hand-rolled rectangle', async () => {
  const src = fs.readFileSync(path.join(UI, 'hover.js'), 'utf8');
  assert.match(src, /vendor\/pointer-events\/pointer\/ray\.js/, 'the controller ray comes from @pmndrs/pointer-events');
  assert.match(src, /vendor\/pointer-events\/forward\.js/, 'and so does the mouse at a desk — one interaction model');
  // A ray that passes through its target reports nothing about depth.
  assert.match(src, /decor\.line\.scale\.z = reach/, 'the ray has to stop at what it hits');
  for (const f of fs.readdirSync(UI)) {
    if (!f.endsWith('.js')) continue;
    const s = fs.readFileSync(path.join(UI, f), 'utf8');
    assert.ok(!/new THREE\.Raycaster\(/.test(s), `${f} raycasts by hand instead of using the pointer library`);
  }
});

// ---- the old room is gone --------------------------------------------------

test('the canvas-painted room is gone, not left standing beside the new one', async () => {
  for (const f of ['surface.js', 'panels.js', 'room.js', 'faces.js']) {
    assert.ok(!fs.existsSync(path.join(UI, f)), `${f} is still here — there is meant to be one room`);
  }
  for (const f of fs.readdirSync(UI)) {
    if (!f.endsWith('.js')) continue;
    const src = fs.readFileSync(path.join(UI, f), 'utf8');
    assert.ok(!/getContext\(['"]2d['"]\)/.test(src), `${f} still paints a canvas by hand`);
    assert.ok(!/CanvasTexture/.test(src), `${f} still hangs a hand-painted canvas on a plane`);
  }
});

// ---- the stack -------------------------------------------------------------

function importMap() {
  const html = fs.readFileSync(path.join(ROOT, 'ui', 'bridge3d.html'), 'utf8');
  const m = /<script type="importmap">([\s\S]*?)<\/script>/.exec(html);
  assert.ok(m, 'the page has no import map');
  return JSON.parse(m[1]).imports;
}

test('every bare specifier the room reaches for is in the import map, and resolves to a file', async () => {
  const imports = importMap();
  const seen = new Set();
  const missing = [];
  const resolve = (spec) => {
    if (imports[spec]) return path.join(ROOT, 'ui', imports[spec]);
    for (const k of Object.keys(imports)) {
      if (k.endsWith('/') && spec.startsWith(k)) return path.join(ROOT, 'ui', imports[k], spec.slice(k.length));
    }
    return null;
  };
  const walk = (file, from) => {
    if (!fs.existsSync(file)) return missing.push(`${file} (from ${from})`);
    if (seen.has(file) || path.basename(file) === 'three.module.min.js') { seen.add(file); return; }
    seen.add(file);
    const src = fs.readFileSync(file, 'utf8');
    const specs = [];
    for (const m of src.matchAll(/(?:^|[\s;}])(?:import|export)\s*(?:[\w*{}\s,]*?\s*from\s*)?['"]([^'"]+)['"]/gm)) specs.push(m[1]);
    for (const m of src.matchAll(/import\s*\(\s*['"]([^'"]+)['"]/g)) specs.push(m[1]);
    for (const s of specs) {
      if (s.startsWith('.') || s.startsWith('/')) { walk(path.resolve(path.dirname(file), s), file); continue; }
      const r = resolve(s);
      if (!r) missing.push(`unmapped bare specifier "${s}" (from ${file})`);
      else walk(r, file);
    }
  };
  walk(path.join(UI, 'main.js'), 'the page');
  assert.deepStrictEqual(missing, [], 'the room reaches for something the page cannot give it');
  assert.ok(seen.size > 150, `only ${seen.size} modules reachable — the vendored stack is not wired up`);
  // No CDN, no bundler, no build step: every target is a file in this repo.
  for (const [spec, target] of Object.entries(imports)) {
    assert.ok(/^\.\//.test(target), `"${spec}" points at ${target}, which is not in this repo`);
    assert.ok(fs.existsSync(path.join(ROOT, 'ui', target)), `"${spec}" points at a file that is not there`);
  }
});

test('kit components are imported one at a time, never the package barrel', async () => {
  for (const f of fs.readdirSync(UI)) {
    if (!f.endsWith('.js')) continue;
    const src = fs.readFileSync(path.join(UI, f), 'utf8');
    for (const m of src.matchAll(/from\s*['"]([^'"]*vendor\/uikit[^'"]*)['"]/g)) {
      assert.ok(!/vendor\/uikit\/index\.js$/.test(m[1]) && !/components\/index\.js$/.test(m[1]),
        `${f} imports the uikit barrel (${m[1]}) — that drags in an icon set and an addon we do not vendor`);
    }
  }
});

test('the room the captain opens never loads the dev loop', async () => {
  // The flags are OFF by default, and "off" has to mean not fetched rather than
  // merely not used: the emulator is reachable only through a dynamic import
  // behind the query parameter.
  for (const f of fs.readdirSync(UI)) {
    if (!f.endsWith('.js') || f === 'devxr.js') continue;
    const src = fs.readFileSync(path.join(UI, f), 'utf8');
    for (const m of src.matchAll(/^\s*import\s[^;]*?from\s*['"]([^'"]+)['"]/gm)) {
      assert.ok(!/devxr|iwer/i.test(m[1]), `${f} imports ${m[1]} at the top level`);
    }
  }
  const main = fs.readFileSync(path.join(UI, 'main.js'), 'utf8');
  assert.match(main, /preserveDrawingBuffer:\s*DEV\.has\(['"]capture['"]\)/,
    'preserveDrawingBuffer should be on only when ?capture is');
  // three.js ships foveation at maximum, which blurs the two shelves this room
  // parks past 30° on purpose.
  assert.match(main, /setFoveation\(0\)/, 'foveation has to be turned down or the far shelves go soft');
});

// ---- the dev loop ----------------------------------------------------------

test('every viewpoint is aimed at something the room really stands there', async () => {
  const { VIEWPOINTS, places } = await load('viewpoints.js');
  const where = places();
  assert.ok(VIEWPOINTS.length >= 6, 'a loop with two viewpoints is a loop with four blind sides');
  const near = (a, b) => Math.abs(a - b) < 1e-9;
  for (const v of VIEWPOINTS) {
    const at = v.frames.at;
    assert.ok(where.some((p) => near(p.x || 0, at.x || 0) && near(p.y, at.y) && near(p.z, at.z)),
      `${v.name} frames (${at.x}, ${at.y}, ${at.z}) and nothing stands there`);
    assert.ok(['world', 'list'].includes(v.scene), `${v.name} wants an unknown scene`);
    assert.ok(v.why && v.why.length > 20, `${v.name} does not say what it is for`);
  }
  assert.ok(VIEWPOINTS.some((v) => v.scene === 'list'), 'nothing photographs the escape hatch');
  assert.ok(VIEWPOINTS.some((v) => v.floor), 'nothing photographs the landmarks, which is the thing most likely to be missing');
});

test('no viewpoint asks for a turn of the head the room does not', async () => {
  const { VIEWPOINTS, aimAt, gazeDistance } = await load('viewpoints.js');
  const W = await load('world.js');
  for (const v of VIEWPOINTS) {
    const a = aimAt(v.eye, v.look);
    assert.ok(Math.abs(a.yaw) <= 45, `${v.name} turns the head ${a.yaw.toFixed(1)}° off centre`);
    assert.ok(a.pitch <= W.RISE, `${v.name} looks ${a.pitch.toFixed(1)}° up`);
    const down = v.floor ? W.FLOOR_LOOK : 45;
    assert.ok(a.pitch >= -down, `${v.name} looks ${a.pitch.toFixed(1)}° down — that is a neck, not a glance`);
    const d = gazeDistance(v);
    assert.ok(d >= W.NEAR && d <= W.FAR + 1e-9, `${v.name} looks ${d.toFixed(2)} m out, outside ${W.NEAR}–${W.FAR} m`);
  }
});

test('what a shot is named after fits inside the shot, in arc', async () => {
  const { VIEWPOINTS, aimAt, FOVY } = await load('viewpoints.js');
  const W = await load('world.js');
  const MARGIN = 5;
  for (const v of VIEWPOINTS) {
    const gaze = aimAt(v.eye, v.look);
    const at = v.frames.at;
    const centre = aimAt(v.eye, [at.x || 0, at.y, at.z]);
    const d = W.eyeDistance(at);
    const half = FOVY / 2 - MARGIN;
    const across = Math.abs(gaze.yaw - centre.yaw) + W.arcDeg(v.frames.panel.widthM, d) / 2;
    const down = Math.abs(gaze.pitch - centre.pitch) + W.arcDeg(v.frames.panel.heightM, d) / 2;
    assert.ok(across <= half, `${v.name}: what it frames runs ${across.toFixed(1)}° across, past the ${half}° edge`);
    assert.ok(down <= half, `${v.name}: what it frames runs ${down.toFixed(1)}° up/down, past the ${half}° edge`);
  }
});

test('aiming the head at a point really does point it at that point', async () => {
  const { aimAt } = await load('viewpoints.js');
  const D = Math.PI / 180;
  // The independent derivation: rebuild the forward vector from the yaw and
  // pitch aimAt handed back — WebXR's own convention, forward at -Z — and check
  // it lands back on the target. A sign flip here is a whole run of screenshots
  // pointed at the opposite wall, and it is the one bug a PNG cannot report
  // because the PNG looks perfectly fine.
  const W = await load('world.js');
  const cases = [
    [[0, W.EYE, 0], [0, 1.15, -1.55]],
    [[0, W.EYE, 0], Object.values(W.shelfPlane(0).centre)],
    [[0, W.EYE, 0], Object.values(W.shelfPlane(3).centre)],
    [[0, W.EYE, 0], Object.values(W.agentAt(7).pos)],
    [[0.2, 1.5, 0.3], [-1.0, 2.0, -2.0]],
  ];
  for (const [eye, target] of cases) {
    const { yaw, pitch } = aimAt(eye, target);
    const fwd = [
      -Math.sin(yaw * D) * Math.cos(pitch * D),
      Math.sin(pitch * D),
      -Math.cos(yaw * D) * Math.cos(pitch * D),
    ];
    const to = sub(target, eye);
    const l = len(to);
    for (let i = 0; i < 3; i++) {
      assert.ok(Math.abs(fwd[i] - to[i] / l) < 1e-9, `aimAt(${eye}, ${target}) points at ${fwd}`);
    }
  }
});

test('world.js says where things go and knows nothing about how they are drawn', async () => {
  const src = fs.readFileSync(path.join(UI, 'world.js'), 'utf8');
  assert.ok(!/from ['"]three['"]/.test(src), 'world.js imports three — it is meant to be arguable without a GPU');
  assert.ok(!/document\./.test(src), 'world.js touches the DOM');
  const vp = fs.readFileSync(path.join(UI, 'viewpoints.js'), 'utf8');
  assert.ok(!/from ['"]three['"]/.test(vp), 'viewpoints.js imports three');
});
