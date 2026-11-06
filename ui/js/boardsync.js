// boardsync — when the board tab fetches /api/board.
//
// The server announces each change as `board-changed {rev, boot}` and never
// pushes the board itself; the tab fetches it, gzipped. This decides what a
// notice costs:
//  - a notice for what the tab already holds (same boot, rev at or below the
//    held one) costs nothing;
//  - otherwise a fetch starts at once, unless one is already running or the
//    last one began less than GAP_MS ago — then ONE is scheduled for when both
//    clear. A burst of notices costs the fetch in flight plus one after it.
//  - an answer still behind the newest notice is followed by another fetch.
// now() fetches whatever the revs say (connect, reconnect). A failed fetch
// forgets what it was chasing: the next notice, or the stream's own reconnect,
// asks again — a server that is down is not retried every GAP_MS forever.
// No DOM, no globals: main.js wires it, the tests drive it with fakes.
export const GAP_MS = 300;

export function boardSync({ fetchBoard, apply, held, gapMs = GAP_MS, clock = () => Date.now() }) {
  let want = null;          // the newest notice seen: {rev, boot}
  let force = false;        // now() asked: fetch regardless of revs
  let inFlight = false;
  let timer = null;
  let lastStart = -Infinity;

  function behind() {
    if (force) return true;
    if (!want) return false;
    const h = held();
    if (!h || h.boot !== want.boot) return true;
    return !(Number(h.rev) >= want.rev);
  }
  function pump() {
    if (inFlight || timer || !behind()) return;
    const wait = lastStart + gapMs - clock();
    if (wait > 0) {
      timer = setTimeout(() => { timer = null; pump(); }, wait);
      return;
    }
    inFlight = true;
    force = false;
    lastStart = clock();
    Promise.resolve()
      .then(fetchBoard)
      .then((doc) => apply(doc))
      .catch(() => { want = null; force = false; })
      .finally(() => { inFlight = false; pump(); });
  }
  return {
    notify(n) {
      if (!n || typeof n.rev !== 'number') return;
      if (!want || n.boot !== want.boot || n.rev > want.rev) want = { rev: n.rev, boot: n.boot };
      pump();
    },
    now() { force = true; pump(); },
  };
}
