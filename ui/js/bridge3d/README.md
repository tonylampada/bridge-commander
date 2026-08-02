# The room, and how to look at it without a headset

`ui/bridge3d.html` is the board as a room you stand inside. This file is how you
*run* it. What is **correct** — the arc a target has to cover, how far a panel
stands, how big the type is, what earns being an object rather than a panel —
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
dev/shots/manifest.json       yaw, pitch, why the shot exists, frame statistics
```

No display, no headset, no `npm install` — Node built-ins and whatever Chrome is
on the machine. It exits non-zero if any frame came back blank.

```
--out DIR      somewhere else to write (default dev/shots/)
--size WxH     browser window, and so the shape of the frame (default 1280x960)
--url URL      photograph a real server instead of the fixture playground,
               e.g. --url https://bc.pensamais.com.br
--keep         leave the throwaway Chrome profile behind, for poking at
CHROME=/path   which browser to drive, if it is not google-chrome on PATH
```

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
- **click** — pulls the trigger. The ray rides the head, so what a click opens
  is whatever is under the dot in the middle of the view; a plain mouse click
  reaches nobody inside a session, which is why it is wired to `selectstart`

From a console, `window.__xr` gives you `look('board')`, `aim(yaw, pitch)`,
`press('trigger')`, `frames(n)`, `frameStats()` and the live `device`.
`window.__bridge` gives you the room itself — `open('card:x')`, `close(id)`,
`state`. Note that a click through the exact centre of the board lands in the
gutter *between* two cards, which is the 1.6° of clear air doing its job.

The `?capture=1` is only needed if you intend to screenshot; the emulated
session works on its own.

IWER also ships a full emulator panel (`@iwer/devui`, sliders for every joint).
It is 850 KB — four times the runtime — for controls a mouse already gives, so
it is deliberately not vendored. Add it if hand-driving ever stops being enough.

## The viewpoints

`viewpoints.js` — a place to stand and a thing to look at, never a raw
quaternion, and every target read out of `room.js` so a panel that moves drags
its photograph along with it. Each carries the scene it needs: `empty` is the
room as it opens, `working` is three windows up (which is also what pushes the
board back). Add one and it is photographed and measured on the next run.

## What a photograph is not

Screenshots catch *it went blank*. They never catch *that button is 2.58°*, and
exact-pixel comparison across drivers is flaky enough to train you to ignore it.
So the only image assertion the capture script makes is structural — colour
count and lit fraction, enough to fail an empty room.

Everything else is measured in **`test/bridge3d.test.js`**, in true arc, painted
into a recording 2D context and re-derived with `atan` from each region's own
edges rather than asked of the code under test. That is where a target that
arrives at 2.58° instead of 3° gets caught. It runs in the ordinary suite:

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
| `main.js` | the room: renderer, session, controllers, keyboard, the desk fallback |
| `room.js` | where things stand and what standing there means — pure, no three.js |
| `panels.js` / `surface.js` | what each surface paints, and the canvas it paints on |
| `faces.js` | the lieutenant avatar sheet |
| `viewpoints.js` | the places the room is photographed from — pure |
| `devxr.js` | the emulated headset, behind `?xr=emulate` |
| `../../vendor/iwer/` | IWER, vendored unmodified — see `ui/vendor/README.md` |
| `../../../dev/room-shots.js` | the capture script |
