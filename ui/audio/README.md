# The keep-alive's loops

Five ambient loops. The keep-alive (`ui/js/keepalive.js`, `ui/js/music.js`) plays
one of them, on a loop, for as long as the switch is on — which is hours, on a
phone with its screen off, under whatever conversation is happening in the room.
That brief is why they are all slow, low and going nowhere: anything with a beat,
a melody line or a build is intolerable by the third pass.

## Where they came from

All five are **CC0** — public-domain dedication, no attribution required — which
is the only licence that can ship in a public repo without attribution theatre.
The authors are credited here anyway, because they did the work.

| file | source | author | licence |
|---|---|---|---|
| `warm.m4a` | https://opengameart.org/content/ambient-relaxing-loop | isaiah658 | CC0 |
| `drift.m4a` | https://opengameart.org/content/steller-dreams | Synth-thetic | CC0 |
| `void.m4a` | https://opengameart.org/content/claimed-by-the-void | vitalezzz | CC0 |
| `cavern.m4a` | https://opengameart.org/content/dark-cavern-ambient | Paul Wortmann | CC0 |
| `deep.m4a` | https://opengameart.org/content/searching | yd | CC0 |

Source files taken from those pages, in order:
`Ambient-Loop-isaiah658.wav`, `steller_dreams.flac`,
`claimed_by_the_void_loop.flac`, `dark_cavern_ambient_002.ogg` (the "continuous
loop" of the two the page offers), `Searching.ogg`.

## What was done to them

None of the five is shipped as it was downloaded. Each one is a window cut out
of the original and wrapped into a loop by `dev/build-loops.sh`, which is where
the reasoning lives; the short version is three decisions:

- **the wrap is a crossfade, not a butt joint**, so the last sample runs into
  the first by construction rather than by luck;
- **levelling is a measurement and then one constant gain** (all five sit at
  −20 LUFS), never `loudnorm`'s one-pass dynamic mode — a gain that moves across
  the file is a different gain at the end than at the start, and that difference
  lands exactly on the loop point;
- **the file is one period plus a second of the same loop at either end.** An
  AAC encoder has no signal before its first frame and none after its last and
  hands back tens of milliseconds of wrong samples at both ends. `music.js`
  loops the interior, which is also why any padding a decoder adds is harmless:
  the file is periodic over its whole length, so any window of exactly one
  period is a whole loop.

The exact commands are at the bottom of `dev/build-loops.sh`.

| file | loop | file length | size | character |
|---|---|---|---|---|
| `warm.m4a` | 18s | 20s | 166 KB | a held chord, warm and close |
| `drift.m4a` | 75s | 77s | 633 KB | slow synth drift, wide |
| `void.m4a` | 75s | 77s | 633 KB | airy, high, almost weather |
| `cavern.m4a` | 75s | 77s | 633 KB | a room with stone in it |
| `deep.m4a` | 70s | 72s | 597 KB | the low one; nearly all bass |

2.6 MB in total, and **none of it is on the page load path** — a track is fetched
the first time it is chosen, and only then. `silent`, the default, fetches
nothing ever.

## Auditioning one

They are served with a real `Content-Type`, so a browser plays them: open
`/ui/audio/void.m4a` on a running board. To hear the loop point, play a track
twice end to end — the join is at exactly one loop length in from the start, one
second after the file begins.
