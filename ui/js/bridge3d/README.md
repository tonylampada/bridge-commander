# The room, and how to look at it without a headset

`ui/bridge3d.html` is the board as a world you stand inside. This file is how you
*run* it. What is **correct** — the arc a target has to cover, how far a thing
stands, what earns being an object rather than a panel, what to build it with —
lives in one place and it is not here: the **`vr-design` skill**, plus its
`world.md`, `building.md`, `testing.md` and `rendering.md`. Read that before
placing or sizing anything. Every number in this directory was derived from it,
and a second copy of those numbers is a copy that goes stale.

The division that matters: **the loop proves the room looks right and measures
right; the person wearing it says whether it feels right.** No screenshot and no
test detects fatigue, presence or scale. Headset time is not optional.

## One command

```bash
node dev/room-shots.js
```

Starts the frontend playground, drives a headless Chrome at the room, enters a
real immersive session through an emulated headset, poses the head at each named
viewpoint and writes:

```
dev/shots/<viewpoint>.png     one per viewpoint in viewpoints.js
dev/shots/manifest.json       yaw, pitch, why the shot exists, frame and draw statistics
```

Then it **points at things**. A photograph proves the room did not go blank; it
says nothing about whether the ray reaches anything, and the ways that break are
all invisible in a PNG. So the run finishes by aiming the head at one of each
kind of thing — a card slot, a lieutenant, the mat that opens the list — and
fails if any of them does not light up.

No display, no headset, no `npm install` — Node built-ins and whatever Chrome is
on the machine. It exits non-zero if a frame came back blank or the ray landed on
nothing.

```
--out DIR      somewhere else to write (default dev/shots/)
--size WxH     browser window, and so the shape of the frame (default 1280x960)
--url URL      photograph a real server instead of the fixture playground,
               e.g. --url https://bc.pensamais.com.br
--keep         leave the throwaway Chrome profile behind, for poking at
CHROME=/path   which browser to drive, if it is not google-chrome on PATH
```

The fixture board is small — ten cards, four lieutenants — so nothing on it ever
overflows a shelf. Point `--url` at the real board to photograph the room at real
density, which is the only place the overflow count and a crewed arc show up.

## The flags

Both are off unless the URL turns them on, and off means *not fetched* — a test
in `test/bridge3d.test.js` fails if the emulator ever creeps into a top-level
import.

| | |
|---|---|
| `?capture=1` | `preserveDrawingBuffer: true` on the renderer. Without it a screenshot of the canvas comes back empty, because the buffer is gone by the time anything asks for it. It costs frame time, which is why it is a flag. |
| `?xr=emulate` | Loads `devxr.js`, which installs [IWER](https://github.com/meta-quest/immersive-web-emulation-runtime) over `navigator.xr`. `requestSession('immersive-vr')` then returns a **genuine** session — the same WebXRManager path, reference space and input sources three.js takes in a real headset. That is the half that only ever broke in the headset. |

## Standing in it yourself

Open **`/ui/bridge3d.html?capture=1&xr=emulate`** in any desktop browser and
press *enter the bridge*. You are in an immersive session with an emulated Quest
3, one right-hand controller, and:

- **drag** — turn the head
- **arrow keys** — walk
- **click** — pulls the trigger. The ray rides the head, so what a click lands on
  is whatever is under the dot in the middle of the view; a plain mouse click
  reaches nobody inside a session, which is why it is wired to `selectstart`
- **l** — the flat list, the same thing the mat on the floor opens

The emulated hand is held below and to the right of the head and aimed at a
point 1.75 m out — the shelf radius — so it reproduces some of the scatter a real
hand has instead of firing a ray from the exact centre of the eye. That is what
the 6° colliders exist for, and a ray that started at the eye would never test
them.

From a console, `window.__xr` gives you `look('shelves')`, `aim(yaw, pitch)`,
`press('trigger')`, `frames(n)`, `frameStats()` and the live `device`.
`window.__bridge` gives you the room — `openList(true)`, `search('oauth')`,
`lit()` for whatever the ray is currently on, `stats()` for draw calls, roots and
target count, and the `shelves` / `agents` / `list` themselves.

The `?capture=1` is only needed if you intend to screenshot; the emulated session
works on its own.

IWER also ships a full emulator panel (`@iwer/devui`, sliders for every joint).
It is 850 KB — four times the runtime — for controls a mouse already gives, so
it is deliberately not vendored. Add it if hand-driving ever stops being enough.

## The viewpoints

`viewpoints.js` — a place to stand and a thing to look at, never a raw
quaternion, and every target read out of `world.js` so a thing that moves drags
its photograph along with it. Add one and it is photographed and measured on the
next run. The same file carries `PROBES`, which is the list of things the ray has
to be able to land on.

## What a photograph is not

Screenshots catch *it went blank*. They never catch *that target is 5.7°*, and
exact-pixel comparison across drivers is flaky enough to train you to ignore it.
So the only image assertion the capture script makes is structural — colour count
and lit fraction, enough to fail an empty room.

Everything else is measured in **`test/bridge3d.test.js`**, in true arc: the room
is built for real, the four corners of every responsive region are put into world
coordinates, and the angle is re-derived as `acos` of a dot product — a different
formula from the `atan` construction under test. Gaps are measured between the
two regions' whole outlines rather than between their bounding boxes, because a
rectangle lying on a plane tilted away from the eye is a keystone in the eye's
own angles and comparing its bottom corner against its neighbour's top corner
measures the distance between two points that are nowhere near each other. It
runs in the ordinary suite:

```bash
node --test test/*.test.js harness/test/*.test.js
```

## The real headset

The Quest browser accepts remote debugging, and it is the only way to see the
bugs that only exist in hardware:

1. On the headset: *Settings → System → Developer → USB Debugging* on, plug it
   in (or `adb connect <quest-ip>:5555` over Wi-Fi).
2. `adb devices` to confirm, then open `chrome://inspect#devices` on the
   desktop, or forward the port yourself:
   `adb forward tcp:9222 localabstract:chrome_devtools_remote`.
3. Open the room in the Quest browser, then **inspect** it from the desktop —
   console, network, and a live view of what is being worn.

Everything in `window.__xr` is absent there, because there is nothing to
emulate; `window.__bridge` is not, so the room can still be driven by hand.

## The files

| | |
|---|---|
| `world.js` | where everything stands and what standing there means — pure, no three.js, no DOM. Every angular figure in the room comes from here |
| `main.js` | the room: renderer, session, ground, lights, the loop, the desk fallback |
| `shelves.js` | the four bounded planes, their slots, the slabs standing in them, and the floor decals under them |
| `agents.js` | the eight fixed berths and the lieutenants in them |
| `list.js` | the flat list of every card, and the mat on the floor that opens it |
| `hover.js` | the ray, and the six states a thing goes through when it is pointed at |
| `kit.js` | uikit wired in once: layout, MSDF text, the palette, and what the font can actually draw |
| `viewpoints.js` | the places the room is photographed from, and the things the ray must reach — pure |
| `devxr.js` | the emulated headset, behind `?xr=emulate` |
| `../../vendor/` | three, uikit, pointer-events, IWER — all vendored unmodified, see `ui/vendor/README.md` |
| `../../../dev/room-shots.js` | the capture script |
