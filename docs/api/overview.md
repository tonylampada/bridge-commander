# Bridge Commander — Conceptual API (DNA)

> This IS the spec the implementation follows. A disagreement between this document and
> the code is a bug in one of them — change deliberately, never let them drift.

Bridge Commander is an agent-orchestration **harness** whose control surface is a kanban board.
The captain pilots N **lieutenants** — orchestrator agents, one tmux session each, shown as a
horizontal lane above the columns — and every unit of work is a card owned by exactly one
lieutenant. Lieutenants never implement; they delegate each started card to a **worker**
(one fresh agent, one tmux session, one isolated worktree). The server is not a mirror of
anything: it IS the harness — it spawns sessions, delivers messages, supervises workers,
watches PRs. Board state on disk is the canonical state of the world.

Lineage: UI and board mechanics evolve from [bridge](https://github.com/tonylampada/claudegoodies);
orchestration doctrine distills firstmate. New project — inspiration, not reuse.

## The board

One board per **workspace** (the directory where the skill was initialized; holds state in
`.bridge-commander/`, config, shared memory, and cloned projects). Fixed column frame:

📋 Backlog → 🔨 Working → 👀 Your review → 🤝 Peer review

No Done: cards leave by archive (merge = `merged`; dismissal = `killed`).
Working means the task is unfinished and SHOULD have a live worker on it; the only door in
is `card.start`, which spawns that worker atomically. Lieutenant lane sits above the
columns; each lieutenant has a color, and its cards carry that color stripe.

## Entities

| Entity | Description |
|---|---|
| Workspace | The deployment unit: board state, config (port), shared memory, project clones. Independent of every other workspace |
| Project | A repo registered in the workspace, with a delivery mode: `no-mistakes` (default) \| `direct-PR` \| `local-only` |
| Lieutenant | Durable orchestrator: `name` (display, emoji welcome), `color`, `avatar` (optional index 0-63 into the sprite sheet; absent = colored-dot fallback), `charter` (mission). Its `id` and any derived session name come from the ASCII slug of the name — emoji never reach tmux. Its tmux session is an incarnation, not the entity. Converses with the captain; proactive inside its mission (creates cards, starts them); never writes to projects |
| Card | Unit of work, owned by one lieutenant. `type`: `plan` 🧠 \| `implementation` 🔥 \| `investigation` 🕵️. `body` = the deliverable, always rewritten to current state. `labels` (tags from the board registry). Work attributes live in an open `attributes{}` map, keys by convention: `repo`, `branch`, `worktree`, `session`, `prs {url, state}`, `artifacts {uri, label}` |
| CardStatus | Live status hung on a card, UI's real-time signal. Worker lease: `absent \| idle \| working \| needs-you`, written ONLY by `card.status` (worker-side), decayed server-side by TTL; plus server-derived `owed` (captain's last thread message unanswered) and `unread` |
| Worker | Implementation agent bound 1:1 to a Working card: tmux session + isolated worktree (+ delivery pipeline per project mode). Ephemeral — dies with the card's Working state |
| Event | Card timeline entry: `text`, `level` (1 = bell, 2 = timeline only), `actor`, `kind` (open token; the board's kinds registry maps kind → emoji + default level) |
| Message | Chat utterance. `target`: a lieutenant's main chat or a card thread. A card thread is a **context folder**: the interlocutor is always the owning lieutenant, never the worker |
| QueueItem | One durable delivery to a lieutenant. Kinds: captain `message`, `start-order`, `rework-order`, `card-created` / `card-moved` (captain acts echoed to the owner), `worker-signal`, `worker-said` (a non-owner posted on the card thread), `worker-stopped`, `worker-died`, `worker done`, `pr-merged`, `pr-closed`. `seq`-ordered, at-least-once |
| Archive | Append-only frozen card snapshots with `reason`; `card.restore` resurrects with full state and a loud level-1 event (a snapshot frozen in Working restores to Backlog — only `card.start` may enter Working) |
| Label | Board-level tag registry: name + color, palette auto-assigned; cards carry label names |

## Value objects

| Name | Used by | Description |
|---|---|---|
| Charter | lieutenant.create | Name, color, mission text (one free-text blob; projects of interest are prose convention) |
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
| `workspace.addProject` | `url \| path, mode → project` | ⚓ | captain asks to bring a repo into the workspace |
| `lieutenant.create` | `charter → lieutenant` | 🤠 lane button · ⚓ on captain's ask | a new mission/domain deserves its own commander; server spawns its tmux session via the harness port, doctrine + charter as launch prompt |
| `lieutenant.update` | `color?, avatar? → lieutenant` | 🤠 (⋯ → appearance) | cosmetic only — name/id stay immutable; `avatar: null` clears back to the colored-dot fallback |
| `lieutenant.retire` | `lieutenant` | 🤠 | explicit only; refused while the lieutenant owns non-archived cards (archive or finish them first — never reassign); kills its session, removes it and its queue, loud level-1 event |

### card

| Operation | Signature | Who | When |
|---|---|---|---|
| `card.create` | `lieutenant, title, type, attrs → card` | 🤠 · ⚓ (proactive) | an idea/task is worth tracking; born in Backlog, nowhere else |
| `card.start` | `card → worker` | ⚓ (own judgment, or executing a captain drag-order) | ready to work: ONE atomic op — spawn worker session + worktree, bind to card, card → Working. The brief is auto-attached as a card artifact (label `brief`, idempotent across resumes). `plan` cards never start. The ONLY operation that enters Working |
| `card.move` | `card, column` | 🤠 drag = **order** · ⚓ only → Your review (the handoff) · ⚙️ only on objective facts (start, merge) | see side effects for drag semantics |
| `card.patch` | `card, {title?, body?, type?, attrs?, labels?}` | ⚓ · ⚙️ (mechanical attrs: prs, session) | body rewritten to current state before every handoff. Owner is NOT patchable (see invariant 4) |
| `card.status` | `card, worker-state` | 🛠️ writes · ⚙️ TTL-decays | the live lease behind CardStatus; single-writer |
| `card.archive` | `card, reason` | ⚙️ on merge · ⚓/🤠 otherwise | work landed, died, or was dismissed |
| `card.restore` | `card` | ⚓ · ⚙️ (live evidence for an archived card) | a kill was a mistake; full frozen state + loud level-1 event; Working snapshots land in Backlog |

### conversation & delivery

| Operation | Signature | Who | When |
|---|---|---|---|
| `chat.say` | `target: lieutenant-main \| card, text` | 🤠 ↔ ⚓ | any time; captain-side is write-ahead: queue first, then `harness.send` wake. Author defaults to the CALLER's identity (session-resolved), never inferred from the target |
| `feed.drain` | `lieutenant → QueueItem[]` | ⚓ | first act of every lieutenant turn; the caller self-identifies by its tmux session and drains ONLY its own queue |
| `feed.ack` | `seq` | ⚓ | after handling; only ack removes — unacked re-offers. Identity-scoped: a lieutenant can only commit seqs in its own queue |
| `event.append` | `card \| board, text, kind, level` | ⚓ · 🛠️ | agent-authored timeline entry (card) or board-level notice |
| `kinds.register` | `kind → emoji, level` | ⚓ | extend the event vocabulary; built-ins stay |

### worker plumbing

| Operation | Signature | Who | When |
|---|---|---|---|
| `worker.signal` | `card, text` | 🛠️ | real milestones (branch, tests green, PR open) → level-2 event + QueueItem to the owner |
| `worker.done` | `card, outcome` | 🛠️ | worker finished: event + QueueItem wake the owner; the card stays Working until the lieutenant verifies and hands off. PR URLs in the outcome populate the card's `prs` (the PR watch takes it from there); an investigation's report (`.bridge-commander/reports/<card>.md` by convention) is attached as an artifact |
| worker stop | — | ⚙️ turn-end | a worker turn-end IS the stop signal: card still Working and no `done` → immediate `worker-stopped` QueueItem to the owner + level-2 event (coalesced — one per stop, not per turn). After `done`, turn-ends only update counters |
| worker death | — | ⚙️ supervision loop | a worker ref dead without `done` → `worker-died` QueueItem to the owner + level-2 event; the card stays Working, flagged — the owner resumes (`card.start --resume`) or moves it back |

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

The server speaks ONLY this port. v0 ships the `claude` implementation (plus a file-backed
`fake` for tests); adding a harness is implementing these seven verbs, nothing else.
Harness working state (session ids, prompts, turn-end logs) lives in the workspace's
`.bridge-commander/harness/` — never global; spawned session names are unique per workspace.

**Optional capability verbs.** Beyond the seven REQUIRED verbs a harness MAY expose extra
verbs for features not every harness can honor. The port never validates them (requiring
one would force every harness, `fake` included, to implement it); the server
capability-checks at the call site (`typeof impl.openPane === 'function'`) and degrades
gracefully when the verb is absent. Current optional verbs (pane viewing — the UI's 👁 peek):

| Verb | Signature | Called by | Purpose |
|---|---|---|---|
| `harness.openPane` | `ref, {onFrame, intervalMs?, lines?} → {close()}` | ⚙️ pane hub | stream the pane's rendered screen as change-detected frames (strings, MAY carry ANSI SGR) — served to the captain over a dedicated per-target SSE (`GET /api/cards/:id/pane/stream`, `GET /api/lieutenants/:id/pane/stream`), ref-counted so N viewers share ONE feed and the last disconnect releases it; harness lacks the verb → `unsupported`, nothing to watch → `no-pane`, concurrent-pane cap → `busy` (all clean SSE events, never an HTTP error) |
| `harness.paneSnapshot` | `ref, {lines?} → string` | ⚙️ pane hub | one-shot capture for the stream's initial paint |

## Invariants

1. **Board is truth.** No shadow files, no mirror: cards + charters + queues in `.bridge-commander/` ARE the state. Agent conversation memory is a cache; restart of any session is a non-event.
2. **Lieutenants never write to projects.** Every change reaches a project through a worker in an isolated worktree, shipped by the project's delivery mode.
3. **Working ⇔ unfinished task, which SHOULD have a live worker.** The only way into Working is `card.start`, spawning the worker atomically. A Working card may lose its worker only by accident (process died, machine rebooted) — the server flags it and queues the owner; a wound to heal, never a state to create deliberately.
4. **One owner, for life.** Every card belongs to exactly one lieutenant, fixed at birth — no reassignment; moving work between lieutenants = archive + recreate. The captain converses only with lieutenants (card threads included). `tmux attach` on a predictable session name (`bc-*`; the founding lieutenant keeps its own session name) is the escape hatch, not a channel.
5. **Territory.** Peer review is the captain's shelf: nothing but a merge-archive touches it.
6. **No merge without the captain's word** (v0: no yolo).
7. **Write-ahead delivery.** Queue write precedes the send-keys wake; at-least-once; only ack removes. A dead session loses nothing.
8. **Supervision is infrastructure.** The server watches sessions, turn-ends, and PRs; lieutenants are purely reactive to their queue — no agent-armed watcher, no poll, no turn ending blind.
9. **Delegation over subagents.** Work that deserves representation gets a card + worker, not an invisible subagent.

## Side effects

| Trigger | Effect |
|---|---|
| captain drags any column → Working | start-order QueueItem to the owning lieutenant → it briefs and runs `card.start`; the card does not move until then (it carries a visible `pendingOrder` marker, cleared by any applied move) |
| captain drags Your review → Backlog | rework-order QueueItem carrying the captain's thread comment; same `pendingOrder` marker |
| captain creates / moves a card | `card-created` / `card-moved` QueueItem to the owner (awareness, not an order) |
| `card.start` | worker spawned (worktree + session), card → Working, level-2 event, brief auto-attached as an artifact |
| `chat.say` by captain | QueueItem (write-ahead) + `harness.send` wake to the owning lieutenant |
| `chat.say` on a card thread by anyone but the owning lieutenant (its worker, a peer, unidentified tooling) | `worker-said` QueueItem waking the owner — the thread alone notifies nobody |
| `worker.send` by the lieutenant | text typed into the card's live worker session (harness `send`, verified submission) + level-2 event; loud error without a live worker. `card.start --resume` refuses a brief and points here |
| worker signal | level-2 event on card + QueueItem to the owning lieutenant |
| worker turn-end without `done` (card still Working) | `worker-stopped` QueueItem to the owner + level-2 event, immediately — a stopped worker is never invisible |
| worker done + lieutenant review | lieutenant rewrites body, moves → Your review — the level-1 handoff |
| PR merged (server watch) | card archived (`merged`), worktree released (only when clean), lingering worker session killed, level-1 event, `pr-merged` QueueItem to the owner |
| PR closed unmerged (server watch) | `pr-closed` QueueItem to the owner — a decision, not an archive |
| card archived (any reason) | any worker session still bound to the card is killed (an archived card has neither Working nor worker) |
| worker session dies without `done` | `worker-died` QueueItem to the owner + level-2 event; card stays Working, flagged |
| lieutenant session dies | server auto-respawn (resume when possible; else relaunch with charter + owned cards + pending queue as the prompt), level-1 event, drain nudge; 3 failed attempts → level-1 needs-captain |
| level-1 event / owed reply | captain's bell: unseen = level-1 events ∪ unseen lieutenant thread replies, per user, cleared by reading — bridge semantics |

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
