# Bridge Commander — Conceptual API (DNA)

> This IS the spec the implementation follows. A disagreement between this document and
> the code is a bug in one of them — change deliberately, never let them drift.

Bridge Commander is an agent-orchestration **harness** whose control surface is a kanban board.
The captain pilots N **lieutenants** — orchestrator agents, one tmux session each, shown as a
horizontal lane above the columns — and every unit of work is a card owned by exactly one
lieutenant. Lieutenants never implement; they delegate each started card to a **worker**
(one fresh agent, one tmux window, one isolated worktree). The server is not a mirror of
anything: it IS the harness — it spawns sessions, delivers messages, supervises workers,
watches PRs. Board state on disk is the canonical state of the world.

Lineage: UI and board mechanics evolve from [bridge](https://github.com/tonylampada/claudegoodies);
orchestration doctrine distills firstmate. New project — inspiration, not reuse.

**Altitude.** This document describes what the system DOES — capabilities a PM would name.
Presentation (how things are shown: viewers, panes, bars, colors, board title/meta), transport
and plumbing (polling, hooks, sidecars, state-dir layout, migrations), per-user read markers,
and tuning knobs (TTLs, intervals, TTS voices) live BELOW the conceptual line: they change
freely without a DNA mutation. The test: if a PM describing the product wouldn't say it, it's
below the line.

**Structure.** This project keeps its DNA deliberately single-file: no `entities.md` Level 2
until the entity detail genuinely hurts at this altitude. Implementation-side record fields
(worker lifecycle flags and the like) stay below the line.

## The board

One board per **workspace** (the directory where the skill was initialized; holds state in
`.bridge-commander/`, config, shared memory, and cloned projects). Fixed column frame:

📋 Backlog → 🔨 Working → 👀 Your review → 🤝 Peer review

No Done: cards leave by archive (merge = `merged`; dismissal = `killed`).
Working means the task is unfinished and SHOULD have a live worker on it; the doors in are
`card.start`, which spawns that worker atomically, and `worker.send` reopening a done-but-alive
worker for a new turn. Lieutenant lane sits above the columns; each lieutenant has a color,
and its cards carry that color stripe.

## Entities

| Entity | Description |
|---|---|
| Workspace | The deployment unit: board state, config (port), shared memory, project clones. Independent of every other workspace |
| Project | A repo registered in the workspace, with a delivery mode: `no-mistakes` (default) \| `direct-PR` \| `local-only` |
| Lieutenant | Durable orchestrator: `name` (display, emoji welcome), `color`, `avatar` (optional index 0-63 into the sprite sheet; absent = colored-dot fallback), `charter` (mission). Its `id` and any derived session name come from the ASCII slug of the name — emoji never reach tmux. Its tmux session is an incarnation, not the entity. Converses with the captain; proactive inside its mission (creates cards, starts them); never writes to projects |
| Card | Unit of work, owned by one lieutenant. `type`: `plan` 🧠 \| `implementation` 🔥 \| `investigation` 🕵️. `body` = the deliverable, always rewritten to current state. `labels` (tags from the board registry). Work attributes live in an open `attributes{}` map, keys by convention: `repo`, `branch`, `worktree`, `session`, `prs {url, state}`, `artifacts {uri, label}`, plus `harness` and `model` (new-card hints consumed by `card.start`) |
| CardStatus | Live status hung on a card, UI's real-time signal. Worker lease: `absent \| idle \| working \| needs-you`, written ONLY by `card.status` (worker-side), decayed server-side by TTL; plus server-derived `owed` (latest DELIVERED captain message not yet acked — queue truth, not thread order) with `owedState` `queued \| seen` (boundary: the drained cursor), and `unread` |
| Worker | Implementation agent bound 1:1 to a Working card: tmux **window** (`w-<card-id>`) inside its lieutenant's session + isolated worktree (+ delivery pipeline per project mode). Ephemeral — dies with the card's Working state; the lieutenant-session coupling (lieutenant dies → its worker windows die) is accepted design |
| Event | Card timeline entry: `text`, `level` (1 = bell, 2 = timeline only), `actor`, `kind` (open token; the board's kinds registry maps kind → emoji + default level) |
| Message | Chat utterance. `target`: a lieutenant's main chat or a card thread. May carry `attachments [{id, name, mime, path}]` (captain uploads); attachments ride the QueueItem to the lieutenant with absolute paths. A card thread is a **context folder**: the interlocutor is always the owning lieutenant, never the worker |
| QueueItem | One durable delivery to a lieutenant. Kinds: captain `message`, `start-order`, `rework-order`, `card-created` / `card-moved` (captain acts echoed to the owner), `worker-signal`, `worker-said` (a non-owner posted on the card thread), `worker-stopped`, `worker-died`, `worker-stalled`, `worker done`, `pr-merged`, `pr-closed`. `seq`-ordered, at-least-once. (`worker-paused` is an event kind only — pausing is the lieutenant's own act, it never queues) |
| Archive | Append-only frozen card snapshots with `reason`; `card.restore` resurrects with full state and a loud level-1 event (a snapshot frozen in Working restores to Backlog — only `card.start` may enter Working) |
| Label | Board-level tag registry: name + color, palette auto-assigned; cards carry label names |

## Value objects

| Name | Used by | Description |
|---|---|---|
| Charter | lieutenant.create | Name, color, avatar?, mission text (one free-text blob; projects of interest are prose convention) |
| Brief | card.start | Task description + acceptance criteria handed to the worker |
| HarnessRef | harness port | Opaque address of a live agent session (tmux target + resume id) |

## Operations

Callers · mechanisms: 🤠 captain (UI click/drag) · ⚓ lieutenant (CLI) · 🛠️ worker (CLI/hook) · ⚙️ server (automatic — no agent turn involved)

Trust model (v0): the server binds loopback (or a private mesh address) and has no app auth;
actor strings are honor-system. The network boundary is the auth boundary.

### workspace & lieutenant

| Operation | Signature | Who | When |
|---|---|---|---|
| `workspace.init` | `dir → workspace` | ⚓ (the founding agent) | skill invoked in a fresh dir, **inside tmux** (refuses outside, with instruction); creates `.bridge-commander/`, boots the server, registers the caller as the first lieutenant — the "teleport" |
| `workspace.open` | `dir → workspace` | ⚓ · 🤠 (CLI) | boot or attach to the board WITHOUT the teleport: bootstraps `.bridge-commander/` in cwd if absent, starts the server when down, prints the URL; no founding lieutenant involved |
| `workspace.addProject` | `url \| path, mode → project` | ⚓ | captain asks to bring a repo into the workspace |
| `lieutenant.create` | `charter → lieutenant` | 🤠 lane button · ⚓ on captain's ask | a new mission/domain deserves its own commander; server spawns its tmux session via the harness port, doctrine + charter as launch prompt |
| `lieutenant.patch` | `color?, avatar?, name?, charter?, ref? → lieutenant` | 🤠 (⋯ → appearance) · ⚙️ (ref re-registration on init idempotency) | cosmetics + charter; `name` changes the display only — `id` and the derived session name stay immutable; `avatar: null` clears back to the colored-dot fallback |
| `lieutenant.retire` | `lieutenant` | 🤠 | explicit only; refused while the lieutenant owns non-archived cards (archive or finish them first); kills its session, removes it and its queue, loud level-1 event |

### card

| Operation | Signature | Who | When |
|---|---|---|---|
| `card.create` | `lieutenant, title, type, attrs → card` | 🤠 · ⚓ (proactive) | an idea/task is worth tracking; born in Backlog, nowhere else |
| `card.start` | `card, {brief?, resume?, harness?, model?, effort?} → worker` | ⚓ (own judgment, or executing a captain drag-order) | ready to work: ONE atomic op — spawn worker window + worktree, bind to card, card → Working. Harness/model resolve: explicit arg → card attribute hint → config default. The brief is auto-attached as a card artifact (label `brief`, idempotent across resumes); `--resume` reincarnates the recorded worker instead (refuses a brief — steer with `worker.send`). Implementation cards get branch `bc/<card-id>`; investigations get NO branch — their deliverable is the report. `plan` cards never start |
| `card.move` | `card, column` | 🤠 drag = **order** · ⚓ only → Your review (the handoff) · ⚙️ only on objective facts (start, merge) | see side effects for drag semantics |
| `card.patch` | `card, {title?, body?, type?, attrs?, labels?, owner?}` | ⚓ · ⚙️ (mechanical attrs: prs, session) | body rewritten to current state before every handoff. `owner` is patchable ONLY while no worker record is bound (see invariant 4) |
| `card.park` | `card → ()` | ⚓ | the narrow lieutenant door out of Working back to Backlog — legal only when the card's worker is absent or dead (liveness re-checked server-side) |
| `card.status` | `card, worker-state` | 🛠️ writes · ⚙️ TTL-decays | the live lease behind CardStatus; single-writer |
| `card.artifact.add` | `card, uri, label? → ()` | ⚓ · 🤠 (📌 on a chat attachment) | promote a file to card artifact — a DELIBERATE act; a chat upload alone never lands here. Idempotent by uri |
| `card.artifact.remove` | `card, uri → ()` | ⚓ · 🤠 | unlist an artifact (the file itself is untouched) |
| `card.archive` | `card, reason` | ⚙️ on merge · ⚓/🤠 otherwise | work landed, died, or was dismissed |
| `card.restore` | `card` | ⚓ · ⚙️ (live evidence for an archived card) | a kill was a mistake; full frozen state + loud level-1 event; Working snapshots land in Backlog |
| `card.list_archived` | `limit?, offset? → [record], total` | 🤠 (the 🧊 archived mode) · ⚓ (CLI `archive`) | browse the frozen snapshots newest-first — a paginated window over the append-only archive log, never mixed into the live board |

### conversation & delivery

| Operation | Signature | Who | When |
|---|---|---|---|
| `chat.say` | `target: lieutenant-main \| card, text, attachments?` | 🤠 ↔ ⚓ | any time; captain-side is write-ahead: queue first, then `harness.send` wake. Author defaults to the CALLER's identity (session-resolved), never inferred from the target |
| `feed.drain` | `lieutenant → QueueItem[]` | ⚓ | first act of every lieutenant turn; the caller self-identifies by its tmux session and drains ONLY its own queue |
| `feed.ack` | `seq` | ⚓ | after handling; only ack removes — unacked re-offers. Identity-scoped: a lieutenant can only commit seqs in its own queue |
| `event.append` | `card \| board, text, kind, level` | ⚓ · 🛠️ | agent-authored timeline entry (card) or board-level notice |
| `kinds.register` | `kind → emoji, level` | ⚓ | extend the event vocabulary; built-ins stay |
| `label.manage` | `create \| rename \| recolor \| delete` | 🤠 | curate the board's label registry; rename/delete propagate across every card carrying the label |

### worker plumbing

| Operation | Signature | Who | When |
|---|---|---|---|
| `worker.signal` | `card, text` | 🛠️ | real milestones (branch, tests green, PR open) → level-2 event + QueueItem to the owner |
| `worker.done` | `card, outcome` | 🛠️ | worker finished: event + QueueItem wake the owner; the card stays Working until the lieutenant verifies and hands off. PR URLs in the outcome populate the card's `prs` (the PR watch takes it from there); an investigation's report (`.bridge-commander/reports/<card>.md` by convention) is attached as an artifact |
| `worker.pause` | `card → ()` | ⚓ | deliberately kill the worker's session with NO died alarm; the card stays Working, the record + worktree survive for `card.start --resume`; supervision skips a paused worker. Composes with `card.park` |
| worker stop | — | ⚙️ turn-end | a worker turn-end IS the stop signal: card still Working and no `done` → immediate `worker-stopped` QueueItem to the owner + level-2 event (coalesced — one per stop, not per turn). After `done`, turn-ends only update counters |
| worker death | — | ⚙️ supervision loop | a worker ref dead without `done` → `worker-died` QueueItem to the owner + level-2 event; the card stays Working, flagged — the owner resumes (`card.start --resume`) or parks it |
| worker stall | — | ⚙️ supervision loop | a worker alive but silent too long (no signal/turn-end) → `worker-stalled` level-1 event + QueueItem to the owner; re-armed by real activity |
| `sysload.watch` | `() → stream of samples` | 🤠 | on-demand monitoring (⚙️ → machine load): machine CPU/RAM/disk + per-worker/per-lieutenant process-tree load + container count, over a dedicated stream. A pure, side-effect-free read — samples exist only while someone watches (first subscriber starts the sampler, last disconnect stops it); nothing lands on the board |

### harness port (internal seam — the multi-harness contract)

| Verb | Signature | Called by | Purpose |
|---|---|---|---|
| `harness.spawn` | `cwd, prompt, opts → HarnessRef` | ⚙️ | birth a lieutenant session or a worker WINDOW inside its lieutenant's session (`opts`: session name, window name — non-numeric, `w-<card-id>` —, state dir, turn-end callback URL, hook install mode) |
| `harness.send` | `ref, text` | ⚙️ | type into a session (the wake half of delivery) |
| `harness.alive` | `ref → bool` | ⚙️ | liveness check for supervision |
| `harness.resumable` | `ref → bool` | ⚙️ | introspection: would `resume` restore memory? The server picks resume vs relaunch-with-charter on it |
| `harness.resume` | `ref, opts → HarnessRef` | ⚙️ | reincarnate a dead session with memory when possible |
| `harness.kill` | `ref` | ⚙️ | end a session for good (idempotent): merged-PR cleanup, card archive, lieutenant.retire |
| `harness.onTurnEnd` | `ref, hook` | embedders | turn-boundary detection for port consumers; the SERVER's channel is the spawn-time callback URL — a Stop hook in the session POSTs each turn end (with its tmux session for exact attribution) |

The server speaks ONLY this port. Builtins: `claude`, `codex` (OpenAI Codex CLI), and a
file-backed `fake` for tests; adding a harness is implementing these seven verbs, nothing else.
Harness working state (session ids, prompts, turn-end logs) lives in the workspace's
`.bridge-commander/harness/` — never global; spawned session names are unique per workspace.

**Optional capability verbs.** Beyond the seven REQUIRED verbs a harness MAY expose extra
verbs for features not every harness can honor. The port never validates them (requiring
one would force every harness, `fake` included, to implement it); the server
capability-checks at the call site (`typeof impl.openPane === 'function'`) and degrades
gracefully when the verb is absent. Current optional verbs (pane viewing, slash commands,
session status):

| Verb | Signature | Called by | Purpose |
|---|---|---|---|
| `harness.openPane` | `ref, {onFrame, intervalMs?, lines?} → {close()}` | ⚙️ pane hub | stream the pane's rendered screen as change-detected frames (strings, MAY carry ANSI SGR) — served to the captain over a dedicated per-target SSE (`GET /api/cards/:id/pane/stream`, `GET /api/lieutenants/:id/pane/stream`), ref-counted so N viewers share ONE feed and the last disconnect releases it; harness lacks the verb → `unsupported`, nothing to watch → `no-pane`, concurrent-pane cap → `busy` (all clean SSE events, never an HTTP error) |
| `harness.paneSnapshot` | `ref, {lines?} → string` | ⚙️ pane hub | one-shot capture for the stream's initial paint |
| `harness.commands` | `ref → [{name, description}]` | ⚙️ | list the slash commands this session honors (drives the UI's command palette) |
| `harness.runCommand` | `ref, line → string` | ⚙️ | run one slash-command line in the session (pass-through or emulated per harness) and return the reply text |
| `harness.status` | `ref → {model, contextUsed, contextWindow, rateLimits?}` | ⚙️ | session vitals; the server caches the result at each turn-end and serves it on the board payload (the lane/card context bars) |

## Invariants

1. **Board is truth.** No shadow files, no mirror: cards + charters + queues in `.bridge-commander/` ARE the state. Agent conversation memory is a cache; restart of any session is a non-event.
2. **Lieutenants never write to projects.** Every change reaches a project through a worker in an isolated worktree, shipped by the project's delivery mode.
3. **Working ⇔ unfinished task, which SHOULD have a live worker.** The way into Working is `card.start`, spawning the worker atomically (or `worker.send` reopening a done-but-alive worker). A Working card may lose its worker only by accident (process died, machine rebooted) — the server flags it and queues the owner; a wound to heal — or by `worker.pause`, the ONE deliberate stop, marked so supervision never reads it as a wound.
4. **One owner while work is bound.** Every card belongs to exactly one lieutenant. Reassignment is legal ONLY for a card with no worker record; mid-work handovers stay forbidden (archive + recreate). The captain converses only with lieutenants (card threads included). `tmux attach` on a predictable session name (`bc-*`; the founding lieutenant keeps its own session name) is the escape hatch, not a channel.
5. **Territory.** Peer review is the captain's shelf: nothing but a merge-archive touches it.
6. **No merge without the captain's word.** A standing per-project authorization (yolo) IS the captain's word; absent it, PRs wait.
7. **Write-ahead delivery.** Queue write precedes the send-keys wake; at-least-once; only ack removes. A dead session loses nothing.
8. **Supervision is infrastructure.** The server watches sessions, turn-ends, and PRs; lieutenants are purely reactive to their queue — no agent-armed watcher, no poll, no turn ending blind.
9. **Delegation over subagents.** Work that deserves representation gets a card + worker, not an invisible subagent.

## Side effects

| Trigger | Effect |
|---|---|
| captain drags any column → Working | start-order QueueItem to the owning lieutenant → it briefs and runs `card.start`; the card does not move until then (it carries a visible `pendingOrder` marker, cleared by any applied move) |
| captain drags Your review → Backlog | rework-order QueueItem carrying the captain's thread comment; same `pendingOrder` marker |
| captain creates / moves a card | `card-created` / `card-moved` QueueItem to the owner (awareness, not an order) |
| `card.start` | worker spawned (worktree + window), card → Working, level-2 event, brief auto-attached as an artifact |
| `chat.say` by captain | QueueItem (write-ahead, attachments riding along) + `harness.send` wake to the owning lieutenant |
| `chat.say` starting with `/` | routed to `harness.runCommand`, reply lands in-thread — NO QueueItem, no wake, no owed. On a card target the command addresses the WORKER session (unlike say, which always talks to the owner) |
| `chat.say` on a card thread by anyone but the owning lieutenant (its worker, a peer, unidentified tooling) | `worker-said` QueueItem waking the owner — the thread alone notifies nobody |
| `worker.send` by the lieutenant | text typed into the card's live worker session (harness `send`, verified submission) + level-2 event; on a done-but-alive worker it REOPENS the turn (record reset, card → Working) — send = "more work for this worker"; loud error without a live worker. `card.start --resume` refuses a brief and points here |
| worker signal | level-2 event on card + QueueItem to the owning lieutenant |
| worker turn-end without `done` (card still Working) | `worker-stopped` QueueItem to the owner + level-2 event, immediately — a stopped worker is never invisible |
| worker alive but silent past the stall window | `worker-stalled` level-1 event + QueueItem to the owner |
| worker done + lieutenant review | lieutenant rewrites body, moves → Your review — the level-1 handoff |
| PR merged (server watch) | card archived (`merged`), worktree released (only when clean), lingering worker session killed, level-1 event, `pr-merged` QueueItem to the owner |
| PR closed unmerged (server watch) | `pr-closed` QueueItem to the owner — a decision, not an archive |
| card archived (any reason) | any worker session still bound to the card is killed (an archived card has neither Working nor worker) |
| worker session dies without `done` | `worker-died` QueueItem to the owner + level-2 event; card stays Working, flagged |
| lieutenant session dies | server auto-respawn (resume when possible; else relaunch with charter + owned cards + pending queue as the prompt), level-1 event, drain nudge; 3 failed attempts → level-1 needs-captain |
| level-1 event / owed reply | captain's bell: unseen = level-1 events ∪ unseen lieutenant thread replies, per user, cleared by reading — bridge semantics |
| `worker.done` · worker death · card archived | lifecycle hooks: the workspace's own executable scripts in `.bridge-commander/hooks/<event>/` run (see below) |

### Lifecycle hooks

The workspace owns deterministic teardown: every executable file in
`.bridge-commander/hooks/<event>/` runs on that lifecycle event — alphabetical, sequential,
cwd = workspace root, context via env (`BC_EVENT`, `BC_CARD`, `BC_REPO`, `BC_WORKTREE`,
`BC_BRANCH`; empty when N/A). Events v1: `worker-done`, `worker-died`, `card-archived`.
Missing dir = no-op; non-executables are skipped.

Hooks are fire-and-forget — they never block or fail the lifecycle outcome they observe
(per-hook timeout ~120s, `BC_HOOK_TIMEOUT_MS` overrides, then kill; output captured and
capped). The ONE ordering guarantee: `card-archived` hooks finish (or time out) BEFORE the
worktree release, so a hook can still reach paths inside `$BC_WORKTREE`. Each run lands on
the timeline: `hook-ran` level 2 per success, `hook-failed` level 1 (the captain's bell) with
filename + exit detail + trimmed output; an archived card's events land on the board stream
with a card reference, and failures also queue to the owner.

## Memory

| Knowledge | Home |
|---|---|
| Factory doctrine (roles, columns, delegation, etiquette — ~1 page) | the skill |
| Captain preferences | workspace `captain.md` (seedable from a global default) |
| Per-project engineering learnings | workspace memory, proactively maintained by lieutenants |
| Project-intrinsic knowledge | the project's own `AGENTS.md`, written by workers via delivery |
| Card-scoped state | the card: body, thread, events, attributes |

The workspace `AGENTS.md` is the lieutenants' shared memory; its first instruction loads the
skill, and the skill loads `captain.md` + learnings.
