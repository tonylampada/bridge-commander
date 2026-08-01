// The room's policy — where a window stands, and what standing in front means.
// Everything else in bridge3d needs a WebGL context and a head, and is checked
// by wearing it.
//
// The rules under test are the captain's, stated by him: the lieutenants are
// always in front, the board is where he decides what to look at next, the
// windows are the work, and nothing is ever put behind his head.

const test = require('node:test');
const assert = require('node:assert');
const path = require('node:path');

const UI = path.join(__dirname, '..', 'ui', 'js', 'bridge3d');
const load = (f) => import(path.join(UI, f));

test('every window stands in front of him — never behind, never inside him', async () => {
  const { placeWindow, EYE } = await load('room.js');
  for (let count = 1; count <= 9; count++) {
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
  const seen = [];
  for (let i = 0; i < 6; i++) {
    const p = placeWindow(i, 6);
    for (const q of seen) {
      assert.ok(Math.hypot(p.x - q.x, p.y - q.y, p.z - q.z) > 0.25, 'two windows in the same place');
    }
    seen.push(p);
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
    { name: 'board, in front', panel: PANEL.board, at: FRONT, primary: true },
    { name: 'board, pushed back', panel: PANEL.board, at: BACK },
  ];
  for (let count = 1; count <= 9; count++) {
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
