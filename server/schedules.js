'use strict';
// schedules — the board's own clock. Node built-ins only.
//
// A schedule is a board object, like a card: a name, an owner, a life in
// board.json (which travels with the repository), and a visible last fire and
// next fire. It exists because the only clock this workspace had was host cron —
// invisible to the board, gone when the machine is reimaged, living outside the
// repo that carries everything else we own.
//
// A schedule fires A HOOK, and nothing else. That is the whole simplification
// the named-hooks shape buys: the clock does not need to know about commands,
// cards or wakes — the hook is bash with `bc-axi` on its PATH and decides for
// itself. `hook run` is the one door, and the clock gets no private one.
//
// This module is the PURE half — when a window is due, and what a `when` string
// means. It holds no state, reads no disk and starts no timers; the tick, the
// firing and the persistence live in server.js, which is where the board is.
//
//   when      a cron expression (5 fields, LOCAL time) or an interval (`5m`)
//   overlap   skip (default) | queue | restart — the policy over `hook run`'s
//             refusal of a second run of a name already in flight
//   catch-up  latest (default) | all | none — what a laptop that slept over the
//             weekend does with the sixty windows it missed
//
// The cursor a schedule keeps is `lastWindow`: the DUE TIME of the last window
// it handled, never "when it last ran". That is what makes a restart neither
// lose a window nor double-fire one — the windows are a function of the cursor
// and the clock, not of when the process happened to be awake.

// A schedule name, and the shape every id on this board has.
const NAME_RE = /^[\w][\w.-]*$/;
const OVERLAP = ['skip', 'queue', 'restart'];
const CATCHUP = ['latest', 'all', 'none'];

// A cron walk is minute-by-minute. Two bounds keep that honest: how far ahead
// `next fire` will look for a window that may not exist (Feb 31 never comes),
// and how far BACK a catch-up will enumerate — a board that was off for a year
// must not spend a second counting minutes it is about to collapse to one fire.
const NEXT_HORIZON_MS = 4 * 366 * 24 * 60 * 60 * 1000;
const CATCHUP_HORIZON_MS = 400 * 24 * 60 * 60 * 1000;
const MINUTE = 60000;
// How many windows one catch-up will ever fire. `all` on a board that slept for
// a week is the case this exists for: the cap is reported, never silent.
const CATCHUP_CAP = 50;

const UNITS = { s: 1000, m: 60000, h: 3600000, d: 86400000 };
const MONTHS = ['jan', 'feb', 'mar', 'apr', 'may', 'jun', 'jul', 'aug', 'sep', 'oct', 'nov', 'dec'];
const DAYS = ['sun', 'mon', 'tue', 'wed', 'thu', 'fri', 'sat'];

function bad(text, why) {
  const e = new Error('bad schedule expression "' + text + '": ' + why
    + ' — a `when` is either an interval (30s, 5m, 2h, 1d) or a 5-field cron expression'
    + ' (minute hour day-of-month month day-of-week), in local time');
  e.code = 'EBADWHEN';
  return e;
}

// parseCronField(text, min, max, names) -> a sorted array of allowed values.
// Accepts `*`, `*/n`, `a`, `a-b`, `a-b/n`, `*/n`, and comma lists of those.
// Names (jan, mon) are accepted wherever the field has them.
function parseCronField(whole, text, min, max, names) {
  const out = new Set();
  for (const part of String(text).split(',')) {
    const piece = part.trim();
    if (!piece) throw bad(whole, 'empty item in "' + text + '"');
    const slash = piece.split('/');
    if (slash.length > 2) throw bad(whole, 'more than one / in "' + piece + '"');
    const step = slash.length === 2 ? Number(slash[1]) : 1;
    if (!Number.isInteger(step) || step < 1) throw bad(whole, 'bad step in "' + piece + '"');
    const range = slash[0].trim();
    let lo;
    let hi;
    if (range === '*') { lo = min; hi = max; }
    else {
      const ends = range.split('-');
      if (ends.length > 2) throw bad(whole, 'bad range "' + range + '"');
      lo = fieldValue(whole, ends[0], min, max, names);
      hi = ends.length === 2 ? fieldValue(whole, ends[1], min, max, names) : lo;
      if (hi < lo) throw bad(whole, 'range "' + range + '" runs backwards');
    }
    for (let v = lo; v <= hi; v += step) out.add(v);
  }
  return [...out].sort((a, b) => a - b);
}

function fieldValue(whole, text, min, max, names) {
  const s = String(text).trim().toLowerCase();
  if (!s) throw bad(whole, 'empty value');
  let n;
  if (names && names.indexOf(s) !== -1) n = names.indexOf(s) + (names === MONTHS ? 1 : 0);
  else if (/^\d+$/.test(s)) n = Number(s);
  else throw bad(whole, '"' + text + '" is not a number' + (names ? ' or a name (' + names.join(' ') + ')' : ''));
  if (names === DAYS && n === 7) n = 0; // both spellings of Sunday
  if (n < min || n > max) throw bad(whole, '"' + text + '" is outside ' + min + '-' + max);
  return n;
}

// parseWhen(text) -> {kind:'interval', ms, text} | {kind:'cron', min,hour,dom,mon,dow, domStar, dowStar, text}
// Throws EBADWHEN naming the offending text — a schedule that never fires
// because of a typo is the one failure mode a clock must not have.
function parseWhen(text) {
  const s = String(text == null ? '' : text).trim();
  if (!s) throw bad(s, 'it is empty');
  const iv = /^(\d+)\s*(s|m|h|d)$/i.exec(s);
  if (iv) {
    const ms = Number(iv[1]) * UNITS[iv[2].toLowerCase()];
    if (!(ms >= 1000)) throw bad(s, 'an interval must be at least 1s');
    return { kind: 'interval', ms, text: s };
  }
  // Anything that is not an interval must be a cron expression, and a 5-field
  // count is the first thing to say when it is not — "*/5 * * *" is the typo
  // everyone makes, and "not a number" would be the wrong complaint.
  const f = s.split(/\s+/);
  if (f.length !== 5) {
    throw bad(s, 'a cron expression has 5 fields (this has ' + f.length + ')');
  }
  return {
    kind: 'cron',
    min: parseCronField(s, f[0], 0, 59, null),
    hour: parseCronField(s, f[1], 0, 23, null),
    dom: parseCronField(s, f[2], 1, 31, null),
    mon: parseCronField(s, f[3], 1, 12, MONTHS),
    dow: parseCronField(s, f[4], 0, 7, DAYS),
    domStar: f[2].trim() === '*',
    dowStar: f[4].trim() === '*',
    text: s,
  };
}

// cronMatches(when, ms) — the classic day rule: with BOTH day fields
// restricted, cron ORs them (`0 0 13 * fri` is the 13th *or* any Friday);
// with one a `*`, the other decides.
function cronMatches(when, ms) {
  const d = new Date(ms);
  if (when.min.indexOf(d.getMinutes()) === -1) return false;
  if (when.hour.indexOf(d.getHours()) === -1) return false;
  if (when.mon.indexOf(d.getMonth() + 1) === -1) return false;
  const domOk = when.dom.indexOf(d.getDate()) !== -1;
  const dowOk = when.dow.indexOf(d.getDay()) !== -1;
  if (when.domStar && when.dowStar) return true;
  if (when.domStar) return dowOk;
  if (when.dowStar) return domOk;
  return domOk || dowOk;
}

// An interval's windows are a FIXED GRID anchored at the schedule's creation —
// `anchor + k·ms` — never "the cursor plus one interval". Anchoring on the
// cursor would let every deferral (a queued overlap, a restart) shift the grid,
// so a 5m schedule would drift a little further from :00 :05 :10 every time
// something went wrong. The grid is also what lets a caller move the cursor
// back a millisecond to say "re-offer that window" without moving the window.
function gridAt(when, anchorMs, k) { return anchorMs + k * when.ms; }

// nextAfter(when, afterMs, anchorMs) -> the first window strictly after
// afterMs, or null when the expression names a time that never comes (Feb 31).
function nextAfter(when, afterMs, anchorMs) {
  if (when.kind === 'interval') {
    const anchor = anchorMs || 0;
    return gridAt(when, anchor, Math.floor((afterMs - anchor) / when.ms) + 1);
  }
  let t = Math.floor(afterMs / MINUTE) * MINUTE + MINUTE;
  const limit = afterMs + NEXT_HORIZON_MS;
  for (; t <= limit; t += MINUTE) if (cronMatches(when, t)) return t;
  return null;
}

// dueWindows(when, fromMs, nowMs, anchorMs) -> {windows:[ms], truncated:n}
// every window in (fromMs, nowMs], oldest first. This is the whole timing
// model: a window is a function of the cursor and the clock, so the answer does
// not depend on when the process was awake — which is exactly why a restart
// neither loses one nor fires one twice.
//
// The backward horizon is a guard, not a policy: a board that was off for a
// year enumerates the last 400 days at most, and the catch-up policy collapses
// what comes out of here anyway.
//
// `truncated` is the windows this enumeration itself threw away before any
// policy saw them. It is reported rather than dropped because the number a
// catch-up log prints has to mean what it says: a board that slept for a week
// missed two thousand windows, not the fifty that survived the cap, and
// counting the array that comes back would say the reassuring thing.
function dueWindows(when, fromMs, nowMs, anchorMs) {
  const out = [];
  if (!(nowMs > fromMs)) return { windows: out, truncated: 0 };
  let from = fromMs;
  if (nowMs - from > CATCHUP_HORIZON_MS) from = nowMs - CATCHUP_HORIZON_MS;
  if (when.kind === 'interval') {
    const anchor = anchorMs || 0;
    const last = Math.floor((nowMs - anchor) / when.ms);
    const first = Math.floor((from - anchor) / when.ms) + 1;
    // One more than the cap is kept so a caller can still report what it lost.
    for (let k = Math.max(first, last - CATCHUP_CAP); k <= last; k++) {
      if (gridAt(when, anchor, k) > from) out.push(gridAt(when, anchor, k));
    }
    // Counted off the UNCLAMPED cursor: a grid is arithmetic, so the horizon
    // costs nothing to see past here.
    const total = Math.max(0, last - (Math.floor((fromMs - anchor) / when.ms) + 1) + 1);
    return { windows: out, truncated: Math.max(0, total - out.length) };
  }
  let total = 0;
  for (let t = Math.floor(from / MINUTE) * MINUTE + MINUTE; t <= nowMs; t += MINUTE) {
    if (cronMatches(when, t)) {
      total++;
      out.push(t);
      if (out.length > CATCHUP_CAP + 1) out.shift(); // the newest are what any policy keeps
    }
  }
  // Cron has no arithmetic to shortcut with, so this counts what the horizon
  // let it walk. The cap — the truncation a real board actually hits — is exact.
  return { windows: out, truncated: total - out.length };
}

// pickWindows(due, catchup, bootMs) -> {fire:[ms], dropped:n}
// `due` is what dueWindows() returned. The catch-up policy, applied to it:
//   latest  fire ONCE, for the newest window — the default, and the answer to
//           "the laptop slept over the weekend"
//   all     fire every one (capped; the cap is reported, never silent)
//   none    fire only what came due while the scheduler was WATCHING — a window
//           that passed while the server was down never happened
// Every policy still advances the cursor past what it dropped: a window nobody
// fired is finished with, or it would be due forever. `dropped` counts the
// windows the enumeration already truncated too, so one number answers "how
// many windows went unfired" end to end.
function pickWindows(due, catchup, bootMs) {
  const windows = due.windows;
  const truncated = due.truncated;
  if (!windows.length) return { fire: [], dropped: truncated };
  if (catchup === 'none') {
    const live = windows.filter((w) => w > bootMs);
    return { fire: live, dropped: truncated + windows.length - live.length };
  }
  if (catchup === 'all') {
    const fire = windows.slice(-CATCHUP_CAP);
    return { fire, dropped: truncated + windows.length - fire.length };
  }
  return { fire: [windows[windows.length - 1]], dropped: truncated + windows.length - 1 };
}

// describeWhen(when) — how `schedule list` says it out loud.
function describeWhen(when) {
  if (when.kind !== 'interval') return 'cron ' + when.text;
  const ms = when.ms;
  for (const [u, size] of [['d', UNITS.d], ['h', UNITS.h], ['m', UNITS.m], ['s', UNITS.s]]) {
    if (ms % size === 0 && ms >= size) return 'every ' + (ms / size) + u;
  }
  return 'every ' + Math.round(ms / 1000) + 's';
}

// normalizeSchedules(list) — what survives a hand-edited board.json. A schedule
// whose `when` no longer parses is KEPT, not dropped: it says so on the
// schedule (server-side), because a clock that silently loses an entry is the
// thing this whole card exists to stop.
function normalizeSchedules(list) {
  if (!Array.isArray(list)) return [];
  const seen = new Set();
  const out = [];
  for (const raw of list) {
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) continue;
    const name = String(raw.name || '');
    const hook = String(raw.hook || '');
    if (!NAME_RE.test(name) || !NAME_RE.test(hook) || seen.has(name)) continue;
    seen.add(name);
    out.push({
      name,
      hook,
      when: String(raw.when || ''),
      owner: String(raw.owner || ''),
      overlap: OVERLAP.includes(raw.overlap) ? raw.overlap : 'skip',
      catchup: CATCHUP.includes(raw.catchup) ? raw.catchup : 'latest',
      paused: !!raw.paused,
      created: String(raw.created || ''),
      lastWindow: String(raw.lastWindow || ''),
      problem: String(raw.problem || ''),
    });
  }
  return out;
}

module.exports = {
  parseWhen, nextAfter, dueWindows, pickWindows, describeWhen, cronMatches,
  normalizeSchedules, NAME_RE, OVERLAP, CATCHUP, CATCHUP_CAP,
};
