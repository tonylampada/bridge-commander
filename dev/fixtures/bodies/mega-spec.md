# Unified event pipeline v2 — the mega spec

> This is the deliberately-giant fixture card: a wall of markdown to stress the
> detail panel, scrolling, and md renderer. Everything below is fake.

## Why

The board's event stream grew organically: board-level events, card events,
thread messages, queue items, and notification derivations each have their own
shape and their own consumers. Five shapes, one concept. This spec unifies them
into a single append-only **pipeline** with typed projections.

## Goals

1. One append-only log, one global `seq`.
2. Every current consumer (bell, timeline, chat, queue drain) becomes a pure
   projection over the log.
3. Replayable: a fresh server rebuilds all projections from the log alone.
4. Zero new dependencies — node built-ins only, as always.

## Non-goals

- No external brokers. No sqlite. No worker threads.
- No wire-format change for the UI in phase 1 (the SSE payload stays).

## The record

```js
// one Record — everything is one of these
{
  seq: 8123,                 // global, monotonic, gapless
  ts: '2026-07-21T12:00:00Z',
  stream: 'card:oauth-token-refresh',   // or 'board', 'lieutenant:monica'
  kind: 'thread-message',    // open token, kinds registry decides emoji/level
  actor: 'monica',
  payload: { /* kind-specific */ },
}
```

## Projections

| projection | source kinds | replaces |
|---|---|---|
| timeline | `*` minus `thread-message` | `card.events`, `board.events` |
| chat | `thread-message` | `card.thread`, `lt.chat` |
| bell | level-1 kinds ∪ unseen replies | `notificationItems()` |
| queue | `delivery` | `queue/*.jsonl` |
| reads | `read-marker` | `board.reads` |

## Migration plan

### Phase 0 — shadow writes

Every existing write path additionally appends a Record. The old shapes stay
canonical. A `bc-axi debug pipeline-diff` command diffs projections against the
legacy fields on every boot.

### Phase 1 — projections become truth

- `GET /api/board` serializes from projections.
- The legacy fields become derived (kept for one release for old CLIs).
- The queue files become a projection checkpoint + tail replay.

### Phase 2 — delete the legacy fields

Flag day. `board.json` shrinks to `{meta, log-checkpoint}`.

## Failure modes considered

- **Torn append**: the log is a single `appendFileSync` of one JSON line;
  a torn last line is truncated on boot (same policy as the queue today).
- **Seq collision after hand-edit**: boot re-seqs the tail if a duplicate is
  found, and logs loudly.
- **Giant log**: checkpoint every 5k records; boot = load checkpoint + tail.
- **Clock skew**: `ts` is display-only; ordering is `seq` alone.

## Open questions

- [ ] Do read-markers really belong in the log, or are they per-user state?
- [ ] Should `delivery` records carry the full message or a `seq` pointer?
- [ ] Compaction: do we ever rewrite history, or checkpoint-and-truncate only?
- [x] Keep the SSE full-board push for v2 (decided: yes, simplicity wins).

## Appendix A — kind census (today)

`created` `moved` `ordered` `handoff` `landed` `killed` `resurrected`
`question` `started` `signal` `worker-done` `worker-died` `hook-ran`
`hook-failed` `worker-stopped` `worker-stalled` `worker-paused` `parked`
`respawned` `needs-captain` — plus board-registered customs.

## Appendix B — sizing napkin

```
records/day (busy board):   ~1.2k
bytes/record (avg):         ~240
log growth/day:             ~290 KB
checkpoint every 5k:        ~1.2 MB snapshot
boot replay (worst case):   5k records ≈ 40 ms
```

## Appendix C — one more table for scroll weight

| day | records | checkpoints | boot ms |
|---|---|---|---|
| 1 | 1,204 | 0 | 9 |
| 2 | 2,731 | 0 | 21 |
| 3 | 4,988 | 0 | 38 |
| 4 | 6,412 | 1 | 11 |
| 5 | 8,020 | 1 | 24 |
| 6 | 9,644 | 1 | 37 |
| 7 | 11,302 | 2 | 12 |
