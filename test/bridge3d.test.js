// The room's policy — where a window stands, and what standing in front means —
// and, at the bottom, what the panels actually PAINT, measured in arc.
//
// The rules under test are the captain's, stated by him: the lieutenants are
// always in front, the board is where he decides what to look at next, the
// windows are the work, and nothing is ever put behind his head.
//
// A room only needs a head for the parts that are a head: the renderer and the
// session. The painting is a 2D canvas, and a 2D canvas can be faked, which is
// how the region arithmetic gets checked here rather than by wearing it. A test
// that only asserts the CONSTANTS say 3° cannot fail when the box drawn from
// them arrives at 2.58°, and that is exactly what shipped once.

const test = require('node:test');
const assert = require('node:assert');
const path = require('node:path');

const UI = path.join(__dirname, '..', 'ui', 'js', 'bridge3d');
const load = (f) => import(path.join(UI, f));

test('every window stands in front of him — never behind, never inside him', async () => {
  const { placeWindow, EYE } = await load('room.js');
  for (let count = 1; count <= 12; count++) {
    for (let i = 0; i < count; i++) {
      const p = placeWindow(i, count);
      assert.ok(p.z < -0.6, `window ${i}/${count} is not in front (z=${p.z})`);
      const d = Math.hypot(p.x, p.z);
      assert.ok(d > 0.8 && d < 4, `window ${i}/${count} is at a silly distance (${d})`);
      assert.ok(Math.abs(p.y - EYE) < 1.2, `window ${i}/${count} is off over the horizon`);
      // Past the shoulders is a neck movement, and the whole point is that
      // reaching a window costs a glance.
      const deg = Math.abs(Math.atan2(p.x, -p.z) * 180 / Math.PI);
      assert.ok(deg < 60, `window ${i}/${count} sits ${deg.toFixed(0)}° off centre`);
    }
  }
});

test('windows do not land on top of each other', async () => {
  const { placeWindow } = await load('room.js');
  // Past nine they crowd into the last row rather than starting a fourth, so
  // this walks well beyond the rows to catch the crowding turning into a pile.
  for (let count = 1; count <= 12; count++) {
    const seen = [];
    for (let i = 0; i < count; i++) {
      const p = placeWindow(i, count);
      for (const q of seen) {
        assert.ok(Math.hypot(p.x - q.x, p.y - q.y, p.z - q.z) > 0.25,
          `two of ${count} windows in the same place`);
      }
      seen.push(p);
    }
  }
});

test('the background is further away, not over his shoulder', async () => {
  const { FRONT, BACK } = await load('room.js');
  assert.ok(BACK.z < FRONT.z, 'the back is further away');
  assert.ok(BACK.z < 0, 'the back is still in front of him — swapping costs a button, not a neck');
  assert.ok(BACK.dim < FRONT.dim, 'and it goes quiet');
});

test('opening a card takes the front; closing it hands the front back', async () => {
  const { nextFront, openWindows } = await load('room.js');
  let s = { open: [], front: 'board' };
  s.open = openWindows(s.open, 'card:a');
  s.front = nextFront(s, { kind: 'open', id: 'card:a' });
  assert.strictEqual(s.front, 'card:a', 'opening it IS the decision to work on it');

  s.open = openWindows(s.open, 'lt:monica');
  s.front = nextFront(s, { kind: 'open', id: 'lt:monica' });
  assert.strictEqual(s.front, 'lt:monica');

  s.front = nextFront(s, { kind: 'close', id: 'lt:monica' });
  s.open = s.open.filter((x) => x !== 'lt:monica');
  assert.strictEqual(s.front, 'card:a', 'the front falls back to what is still open');

  s.front = nextFront(s, { kind: 'close', id: 'card:a' });
  assert.strictEqual(s.front, 'board', 'and never to nothing — the room is not left empty in his hands');
});

test('closing something that was not in front leaves the front alone', async () => {
  const { nextFront } = await load('room.js');
  const s = { open: ['card:a', 'card:b'], front: 'card:b' };
  assert.strictEqual(nextFront(s, { kind: 'close', id: 'card:a' }), 'card:b');
});

test('the swap button goes both ways', async () => {
  const { nextFront } = await load('room.js');
  const s = { open: ['card:a'], front: 'board' };
  const away = nextFront(s, { kind: 'swap' });
  assert.strictEqual(away, 'card:a');
  assert.strictEqual(nextFront({ open: ['card:a'], front: away }, { kind: 'swap' }), 'board');
  // With nothing open there is nothing to swap to, and the board stays.
  assert.strictEqual(nextFront({ open: [], front: 'board' }, { kind: 'swap' }), 'board');
});

test('the same card twice is one window, brought forward', async () => {
  const { openWindows } = await load('room.js');
  const once = openWindows([], 'card:a');
  assert.deepStrictEqual(openWindows(once, 'card:a'), ['card:a']);
  // But a lieutenant beside a card is two windows — he asked for several chats
  // at once, with different agents or the same one twice.
  assert.deepStrictEqual(openWindows(once, 'lt:monica'), ['card:a', 'lt:monica']);
});

// ---- arc: the floors every size in the room is measured against -------------
//
// The room's sizes used to be canvas pixels, and canvas pixels cannot tell 1.55 m
// from 3.1 m — which is how the board came to paint 0.35° body text nobody could
// read. Every size is now a number of DEGREES converted at the panel's own
// distance, so these tests check the degrees and the distances, and the pixels
// take care of themselves.

// Everywhere a panel actually stands: name -> {size, placement}.
async function places() {
  const R = await load('room.js');
  const { PANEL, BAR, FRONT, BACK, placeWindow, EYE } = R;
  const out = [
    { name: 'lieutenant bar', panel: PANEL.bar, at: BAR },
    // The bar grows with the lieutenants; the widest it goes is a panel too.
    { name: 'lieutenant bar, full', at: BAR,
      panel: { widthM: R.barWidth(R.BAR_LIMIT, R.eyeDistance(BAR)), heightM: PANEL.bar.heightM } },
    { name: 'board, in front', panel: PANEL.board, at: FRONT, primary: true },
    { name: 'board, pushed back', panel: PANEL.board, at: BACK },
  ];
  for (let count = 1; count <= 12; count++) {
    for (let i = 0; i < count; i++) {
      const at = placeWindow(i, count);
      out.push({ name: `card window ${i}/${count}`, panel: PANEL.card, at });
      out.push({ name: `chat window ${i}/${count}`, panel: PANEL.chat, at });
    }
  }
  return { R, EYE, out };
}

test('the smallest type in the room still clears the 0.7° cap-height floor', async () => {
  const { TYPE, CAP } = await load('room.js');
  for (const [name, em] of Object.entries(TYPE)) {
    const cap = em * CAP;
    assert.ok(cap >= 0.7, `${name} type is ${cap.toFixed(2)}° of cap height — under the floor`);
  }
  // Body text is not merely legible, it is read without leaning: 1.5° of em box
  // is the aim and 1.4 is the nearest the dense board will carry.
  assert.ok(TYPE.body >= 1.4, 'body text should be ~1.5° of em box');
  assert.ok(TYPE.head > TYPE.body && TYPE.body > TYPE.meta, 'the ladder is head > body > meta');
});

test('a target is 3° and two of them are 1.6° apart', async () => {
  const { HIT } = await load('room.js');
  assert.ok(HIT.min >= 3.0, `hit boxes are ${HIT.min}° — a target you stab at`);
  assert.ok(HIT.gap >= 1.6, `${HIT.gap}° between two targets is one target`);
});

test('everything he reads stands inside the comfort band', async () => {
  const { R, out } = await places();
  for (const p of out) {
    const d = R.eyeDistance(p.at);
    assert.ok(d >= R.NEAR, `${p.name} is ${d.toFixed(2)} m away — too near the face`);
    assert.ok(d <= R.FAR, `${p.name} is ${d.toFixed(2)} m away — past the comfort band`);
  }
});

test('nothing is over the horizon, and the board he reads sits a glance below it', async () => {
  const { R, EYE, out } = await places();
  const deg = (opp, adj) => Math.atan2(opp, adj) * 180 / Math.PI;
  for (const p of out) {
    const flat = Math.hypot(p.at.x || 0, p.at.z || 0);
    const top = deg((p.at.y - EYE) + p.panel.heightM / 2, flat);
    assert.ok(top <= R.RISE, `${p.name} reaches ${top.toFixed(1)}° up — looking up is a sore neck`);
    if (!p.primary) continue;
    const centre = -deg(p.at.y - EYE, flat);
    assert.ok(centre >= R.DROP[0] && centre <= R.DROP[1],
      `${p.name} is centred ${centre.toFixed(1)}° below the horizon, not ${R.DROP.join('–')}°`);
  }
});

test('every panel is cut with enough texels for the arc it covers', async () => {
  const { R, out } = await places();
  const MAX = 2048;                              // what surface.js caps a sheet at
  for (const p of out) {
    const d = R.eyeDistance(p.at);
    const scale = Math.min(R.texelsPerMetre(d), MAX / Math.max(p.panel.widthM, p.panel.heightM));
    const perDeg = p.panel.widthM * scale / R.arcDeg(p.panel.widthM, d);
    assert.ok(perDeg >= 20, `${p.name} paints ${perDeg.toFixed(0)} texels per degree — soft`);
    assert.ok(p.panel.widthM * scale <= MAX && p.panel.heightM * scale <= MAX, `${p.name} overflows a texture`);
  }
});

test('body text on every panel, in degrees, at the distance it really sits', async () => {
  const { R, out } = await places();
  for (const p of out) {
    const d = R.eyeDistance(p.at);
    // What panels.js paints: px = deg × (canvas width / panel arc). Rearranged,
    // the arc of the type is the arc it was asked for, whatever the canvas — so
    // the figure to check is the one the surface was told to draw.
    const cap = R.TYPE.body * R.CAP;
    assert.ok(cap >= 0.7, `body text on ${p.name} at ${d.toFixed(2)} m is ${cap.toFixed(2)}° of cap`);
    // And the panel has to be able to hold a 3° target with 1.6° beside it.
    assert.ok(R.arcDeg(p.panel.heightM, d) >= R.HIT.min + R.HIT.gap,
      `${p.name} is too short to hold a target`);
  }
});

// A panel is turned to face the eye, so what it covers is its centre's angle
// give or take half its own arc — the figure that says whether two of them are
// on top of each other.
function span(R, EYE, p) {
  const flat = Math.hypot(p.at.x || 0, p.at.z || 0);
  const centre = Math.atan2(p.at.y - EYE, flat) * 180 / Math.PI;
  const half = R.arcDeg(p.panel.heightM, R.eyeDistance(p.at)) / 2;
  return { top: centre + half, bottom: centre - half };
}

test('the bar sits clear underneath: the lieutenants never cover the work', async () => {
  const { R, EYE, out } = await places();
  const bar = span(R, EYE, out.find((p) => p.name === 'lieutenant bar'));
  // The bar is the nearest thing in the room and it never moves, so anything it
  // overlaps is content he simply cannot see. Front row and board only — a
  // second row of windows is overflow, and he moves those himself.
  const front = out.filter((p) => p.name.startsWith('board') || /\b0\/[123]$/.test(p.name));
  for (const p of front) {
    const s = span(R, EYE, p);
    assert.ok(s.bottom >= bar.top,
      `${p.name} runs down to ${s.bottom.toFixed(1)}° and the bar starts at ${bar.top.toFixed(1)}° — it is covered`);
  }
});

test('type clears the floor at the far edge of a panel, not only in the middle', async () => {
  const { R, out } = await places();
  const MAX = 2048;
  for (const p of out) {
    const d = R.eyeDistance(p.at);
    const scale = Math.min(R.texelsPerMetre(d), MAX / Math.max(p.panel.widthM, p.panel.heightM));
    // A flat panel's pixels are not evenly spread across the eye: a degree at
    // the far edge is worth more pixels than a degree at the centre, so text
    // sized on the panel's average subtends LESS out there. That corner is
    // where the floor is closest, and it still has to clear it.
    const avg = p.panel.widthM * scale / R.arcDeg(p.panel.widthM, d);
    const x = p.panel.widthM / 2;
    const edge = scale * ((d * d + x * x) / d) * Math.PI / 180;
    const cap = R.TYPE.body * R.CAP * (avg / edge);
    assert.ok(cap >= 0.7, `body text in the corner of ${p.name} is ${cap.toFixed(2)}° of cap height`);
  }
});

test('arc and metres convert both ways', async () => {
  const { arcDeg, sizeForArc } = await load('room.js');
  for (const [size, dist] of [[0.04, 1.5], [1.9, 1.58], [0.16, 1.15]]) {
    assert.ok(Math.abs(sizeForArc(arcDeg(size, dist), dist) - size) < 1e-9, 'round trip');
  }
  // The small-angle rule of thumb the skill quotes: 57.3 × size / distance.
  assert.ok(Math.abs(arcDeg(0.04, 1.5) - 57.3 * 0.04 / 1.5) < 0.01);
});

// ---- what the panels actually paint -----------------------------------------
//
// Everything above reasons about the room from its constants. This part builds
// the real panels, paints them with a real board, and measures the regions they
// declared — with atan, from the region's own edges, no average and no
// small-angle shortcut. It is the only kind of check that can tell 3.0° asked
// for from 2.58° delivered.

// A 2D context with no pixels in it, which WRITES DOWN what it was asked to
// draw. Regions come out of arithmetic and can be checked on their own; a
// painted string cannot — the only record of where a glyph landed is the call
// that put it there. So every mark is kept, clipped the way the real context
// would clip it, and checked against the box it is supposed to be inside.
function fakeCanvas() {
  const canvas = { width: 300, height: 150, marks: [] };
  const clipped = [];
  let clip = null, pending = null, at = null;
  const size = () => { const m = /([\d.]+)px/.exec(ctx.font); return m ? +m[1] : 10; };
  const cut = (a, b) => {
    if (!b) return a;
    const x = Math.max(a.x, b.x), y = Math.max(a.y, b.y);
    const r = Math.min(a.x + a.w, b.x + b.w), t = Math.min(a.y + a.h, b.y + b.h);
    return r <= x || t <= y ? null : { x, y, w: r - x, h: t - y, line: a.line, what: a.what };
  };
  const put = (what, x, y, w, h, line) => {
    const m = cut({ x: Math.min(x, x + w), y: Math.min(y, y + h), w: Math.abs(w), h: Math.abs(h), line, what }, clip);
    if (m) canvas.marks.push(m);
  };
  const ctx = {
    canvas, font: '10px x', textAlign: 'left', textBaseline: 'alphabetic',
    fillStyle: '', strokeStyle: '', lineWidth: 1,
    measureText(t) { return { width: String(t).length * size() * 0.52 }; },
    fillText(t, x, y) {
      const s = size(), w = ctx.measureText(t).width;
      if (!String(t).length) return;
      const left = ctx.textAlign === 'center' ? x - w / 2 : (ctx.textAlign === 'right' ? x - w : x);
      put(String(t), left, y - s * 0.75, w, s);           // baseline to em box
    },
    fillRect: (x, y, w, h) => put('rect', x, y, w, h),
    arc: (cx, cy, r) => put('arc', cx - r, cy - r, r * 2, r * 2),
    drawImage: (img, sx, sy, sw, sh, dx, dy, dw, dh) => put('image', dx, dy, dw, dh),
    moveTo: (x, y) => { at = [x, y]; },
    lineTo(x, y) { if (at) put('line', at[0], at[1], x - at[0], y - at[1], true); at = [x, y]; },
    rect: (x, y, w, h) => { pending = { x, y, w, h }; },
    beginPath() { pending = null; at = null; },
    clip() { if (pending) clip = cut(pending, clip); },
    save() { clipped.push(clip); },
    restore() { clip = clipped.length ? clipped.pop() : null; },
  };
  for (const m of ['clearRect', 'strokeText', 'closePath', 'fill', 'stroke']) ctx[m] = () => {};
  canvas.getContext = () => ctx;
  return canvas;
}

async function paintKit() {
  globalThis.document = { createElement: () => fakeCanvas() };
  globalThis.Image = class { };            // the sheet never lands: faces fall back to dots
  const P = await load('panels.js');
  const R = await load('room.js');
  const lts = [
    { id: 'monica', name: 'Monica', color: '#7c5cff', avatar: 12, chatOwed: true, chat: [{ author: 'user', text: 'status on the oauth card?', ts: new Date().toISOString() }, { author: 'monica', text: 'worker is mid-flight, PR up as a draft', ts: new Date().toISOString() }] },
    { id: 'rex', name: 'Rex', color: '#2aa876', avatar: 33, chat: [] },
    { id: 'ada', name: 'Ada', color: '#d8a03c', avatar: null, chat: [] },
    { id: 'quill', name: 'Quill', color: '#e05c78', avatar: 21, chat: [] },
  ];
  const columns = [{ id: 'backlog', title: '📋 Backlog' }, { id: 'working', title: '🔨 Working' },
    { id: 'review', title: '👀 Your review' }, { id: 'peer', title: '🤝 Peer review' }];
  const cards = [];
  for (let i = 0; i < 18; i++) {
    cards.push({
      id: 'c' + i, column: columns[i % 3].id, owner: lts[i % 4].id, type: 'implementation',
      title: i % 3 ? 'a short one' : 'a card title long enough to wrap onto a second line and then some',
      body: '# Repro\n1. sign in\n2. wait\n\n- [ ] a plan line', labels: ['infra'],
      status: i % 2 ? { owed: true } : { worker: { state: 'live' } },
      thread: [{ author: 'user', text: 'how is it going', ts: new Date().toISOString() }],
    });
  }
  return { P, R, doc: { title: 'Fake Environment', columns, cards, lieutenants: lts } };
}

// The region's true arc, from its own edges. Deliberately re-derived here rather
// than asked of the surface: a measurement taken with the code under test is not
// a measurement.
function trueArc(s, r) {
  const D = 180 / Math.PI, d = s.distanceM;
  const u = (x) => (x / s.canvas.width - 0.5) * s.widthM;
  const v = (y) => (0.5 - y / s.canvas.height) * s.heightM;
  return {
    w: (Math.atan(u(r.x + r.w) / d) - Math.atan(u(r.x) / d)) * D,
    h: (Math.atan(v(r.y) / d) - Math.atan(v(r.y + r.h) / d)) * D,
  };
}

// Every panel the room can put in front of him, painted where it really stands.
async function paintedPanels() {
  const { P, R, doc } = await paintKit();
  const out = [];
  // The bar, at every number of lieutenants it claims to hold. This is where a
  // fixed-width bar used to keep its 3° plates by eating the air between them.
  for (let n = 1; n <= R.BAR_LIMIT; n++) {
    const many = Array.from({ length: n }, (_, i) => ({
      id: 'lt' + i, color: '#7c5cff', avatar: i % 2 ? i : null, chatOwed: i % 4 === 0,
      name: i % 3 ? 'Lt' + i : 'a rather long lieutenant name',
    }));
    const bar = new P.LieutenantBar();
    bar.canvas.marks = [];
    bar.paint({ ...doc, lieutenants: many });
    out.push({ name: `lieutenant bar, ${n} of them`, s: bar });
  }
  const bar = new P.LieutenantBar(); bar.canvas.marks = []; bar.paint(doc);
  out.push({ name: 'lieutenant bar', s: bar });
  for (const [where, at] of [['front', R.FRONT], ['pushed back', R.BACK]]) {
    const board = new P.BoardPanel();
    board.setDistance(R.eyeDistance({ x: 0, y: at.y, z: at.z }));
    board.canvas.marks = [];
    board.paint(doc);
    out.push({ name: 'board, ' + where, s: board, doc });
  }
  for (let count = 1; count <= 12; count++) {
    for (let i = 0; i < count; i++) {
      const d = R.eyeDistance(R.placeWindow(i, count));
      const card = new P.CardWindow('c3');
      card.setDistance(d); card.canvas.marks = []; card.paint(doc);
      out.push({ name: `card window ${i}/${count}`, s: card });
      const chat = new P.ChatWindow('monica');
      chat.setDistance(d); chat.canvas.marks = []; chat.paint(doc);
      out.push({ name: `chat window ${i}/${count}`, s: chat });
    }
  }
  return { out, R };
}

test('every painted region is a 3° target, measured in true arc where it sits', async () => {
  const { out, R } = await paintedPanels();
  let checked = 0;
  for (const { name, s } of out) {
    assert.ok(s.hits.length, `${name} painted nothing to point at`);
    for (const r of s.hits) {
      const a = trueArc(s, r);
      checked++;
      assert.ok(a.w >= R.HIT.min, `${name}: ${r.action.kind} is ${a.w.toFixed(2)}° wide, floor is ${R.HIT.min}°`);
      assert.ok(a.h >= R.HIT.min, `${name}: ${r.action.kind} is ${a.h.toFixed(2)}° tall, floor is ${R.HIT.min}°`);
    }
  }
  assert.ok(checked > 180, `only ${checked} regions measured — the walk is not covering the room`);
});

test('and no two of them are closer than 1.6°, nor on top of each other', async () => {
  const { out, R } = await paintedPanels();
  for (const { name, s } of out) {
    const D = 180 / Math.PI, d = s.distanceM;
    const u = (x) => Math.atan((x / s.canvas.width - 0.5) * s.widthM / d) * D;
    const v = (y) => Math.atan((0.5 - y / s.canvas.height) * s.heightM / d) * D;
    const box = (r) => ({ l: u(r.x), r: u(r.x + r.w), t: v(r.y), b: v(r.y + r.h), kind: r.action.kind });
    const boxes = s.hits.map(box);
    for (let i = 0; i < boxes.length; i++) {
      for (let j = i + 1; j < boxes.length; j++) {
        const a = boxes[i], b = boxes[j];
        // Clear air between them on each axis; null where they overlap on it.
        const gapX = a.r <= b.l ? b.l - a.r : (b.r <= a.l ? a.l - b.r : null);
        const gapY = a.b >= b.t ? a.b - b.t : (b.b >= a.t ? b.b - a.t : null);
        const apart = Math.max(gapX == null ? -Infinity : gapX, gapY == null ? -Infinity : gapY);
        assert.ok(gapX != null || gapY != null,
          `${name}: ${a.kind} and ${b.kind} are on top of each other`);
        assert.ok(apart >= R.HIT.gap,
          `${name}: ${a.kind} and ${b.kind} are ${apart.toFixed(2)}° apart, floor is ${R.HIT.gap}°`);
      }
    }
  }
});

// A mark and a region can relate three ways: the mark is inside the region, the
// mark contains it (a panel background, the chrome bar), or they are strangers.
// Anything else is a mark hanging half off the box it belongs to.
const overlaps = (m, r) => m.x < r.x + r.w && r.x < m.x + m.w && m.y < r.y + r.h && r.y < m.y + m.h;
const inside = (m, r, e = 0.5) => m.x >= r.x - e && m.y >= r.y - e
  && m.x + m.w <= r.x + r.w + e && m.y + m.h <= r.y + r.h + e;

test('nothing is painted half on and half off the box it belongs to', async () => {
  const { out } = await paintedPanels();
  for (const { name, s } of out) {
    for (const m of s.canvas.marks) {
      for (const r of s.hits) {
        if (!overlaps(m, r) || inside(m, r) || inside(r, m)) continue;
        assert.fail(`${name}: "${m.what}" at x ${m.x.toFixed(1)}–${(m.x + m.w).toFixed(1)} hangs off `
          + `the ${r.action.kind} box at ${r.x.toFixed(1)}–${(r.x + r.w).toFixed(1)}`);
      }
    }
  }
});

test('what a card paints lands on that card, not in the gutter beside it', async () => {
  const { out, R } = await paintedPanels();
  for (const { name, s } of out) {
    const half = s.px(R.HIT.gap) / 2;
    for (const r of s.hits) {
      for (const m of s.canvas.marks) {
        if (m.line || inside(r, m)) continue;          // lines and backgrounds are not content
        const my = m.y + m.h / 2;
        if (my < r.y || my > r.y + r.h) continue;      // not on this row at all
        const near = m.x + m.w > r.x - half && m.x < r.x + r.w + half;
        if (!near) continue;                           // somebody else's business
        assert.ok(inside(m, r),
          `${name}: "${m.what}" at x ${m.x.toFixed(1)}–${(m.x + m.w).toFixed(1)} is not on its own `
          + `${r.action.kind} box at ${r.x.toFixed(1)}–${(r.x + r.w).toFixed(1)}`);
      }
    }
  }
});
