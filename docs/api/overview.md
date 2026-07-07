# Bridge Command — Conceptual API (DNA)

> This IS the spec the implementation follows. A disagreement between this document and
> the code is a bug in one of them — change deliberately, never let them drift.

Bridge Command is an agent-orchestration **harness** whose control surface is a kanban board.
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
`.bridge-command/`, config, shared memory, and cloned projects). Fixed column frame:

📋 Backlog → 🔨 Working → 👀 Your review → 🤝 Peer review

No Done: cards leave by archive (merge = `merged`; dismissal = `killed`).
Working is not a label — it is a fact: a card is in Working **iff** a live worker session
exists for it. Lieutenant lane sits above the columns; each lieutenant has a color, and
its cards carry that color stripe.

## Entities

| Entity | Description |
|---|---|
| Workspace | The deployment unit: board state, config (port), shared memory, project clones. Independent of every other workspace |
| Project | A repo registered in the workspace, with a delivery mode: `no-mistakes` (default) \| `direct-PR` \| `local-only` |
| Lieutenant | Durable orchestrator: `name`, `color`, `charter` (mission). Its tmux session is an incarnation, not the entity. Converses with the captain; proactive inside its mission (creates cards, starts them); never writes to projects |
| Card | Unit of work, owned by one lieutenant. `type`: `plan` 🧠 \| `implementation` 🔥 \| `investigation` 🕵️. `body` = the deliverable, always rewritten to current state. Work attributes live here: `repo`, `branch`, `worktree`, `session`, `prs {url, state}`, `artifacts {uri, label}` |
| Worker | Implementation agent bound 1:1 to a Working card: tmux session + isolated worktree (+ delivery pipeline per project mode). Ephemeral — dies with the card's Working state |
| Event | Card timeline entry: `text`, `level` (1 = bell, 2 = timeline only), `actor` |
| Message | Chat utterance. `target`: a lieutenant's main chat or a card thread. A card thread is a **context folder**: the interlocutor is always the owning lieutenant, never the worker |
| QueueItem | One durable delivery to a lieutenant: captain message, drag-order, or worker event. `seq`-ordered, at-least-once |
| Archive | Append-only frozen card snapshots with `reason`; `card.restore` resurrects with full state and a loud level-1 event |

## Value objects

| Name | Used by | Description |
|---|---|---|
| Charter | lieutenant.create | Name, color, mission text, projects of interest |
| Brief | card.start | Task description + acceptance criteria handed to the worker |
| HarnessRef | harness port | Opaque address of a live agent session (tmux target + resume id) |

## Operations

### workspace
- `workspace.init(dir) → workspace` — must run inside tmux (refuses outside, with instruction); creates `.bridge-command/`, boots the server, registers the calling agent as the first lieutenant (the "teleport")
- `workspace.addProject(url | path, mode) → project`

### lieutenant
- `lieutenant.create(charter) → lieutenant` — server spawns its tmux session (harness port) with the doctrine + charter as launch prompt
- `lieutenant.retire(lieutenant)` — explicit only; cards must be archived or reassigned first

### card
- `card.create(lieutenant, title, type, attrs) → card` — captain (via UI) or lieutenant (proactive); born in Backlog
- `card.start(card) → worker` — lieutenant act, or execution of a captain drag-order. ONE atomic operation: spawn worker session + worktree, bind to card, card → Working. `plan` cards can never start
- `card.move(card, column)` — captain drags are **orders** (see side effects); lieutenants move only → Your review (the handoff); the system moves only on objective facts (start, merge)
- `card.patch(card, {title?, body?, attrs?})`
- `card.archive(card, reason)` / `card.restore(card)`

### chat
- `chat.say(target: lieutenant-main | card, text)` — both directions; captain → always write-ahead to the queue, then wake

### feed (lieutenant side)
- `feed.drain(lieutenant) → QueueItem[]` — first act of every lieutenant turn
- `feed.ack(seq)` — an item leaves the queue only on ack; unacked re-offers

### worker (server ↔ worker, mechanical)
- `worker.signal(card, text)` — status milestones from the worker, become card events + queue items
- `worker.end(card, outcome)` — turn-end/exit detected by the server via harness hooks

### harness port (internal seam — the multi-harness contract)
- `harness.spawn(cwd, prompt) → HarnessRef` · `harness.send(ref, text)` · `harness.alive(ref)` · `harness.resume(ref) → HarnessRef` · `harness.onTurnEnd(ref, hook)`

The server speaks ONLY this port. v0 ships the `claude` implementation; adding a harness is
implementing these five verbs, nothing else.

## Invariants

1. **Board is truth.** No shadow files, no mirror: cards + charters + queues in `.bridge-command/` ARE the state. Agent conversation memory is a cache; restart of any session is a non-event.
2. **Lieutenants never write to projects.** Every change reaches a project through a worker in an isolated worktree, shipped by the project's delivery mode.
3. **Working ⇔ live worker.** Entering Working and spawning the worker are one atomic act; the worker ending takes the card out (handoff or back). No stale Working cards, ever.
4. **One owner.** Every card belongs to exactly one lieutenant; the captain converses only with lieutenants (card threads included). `tmux attach` on a predictable session name (`bc-*`) is the escape hatch, not a channel.
5. **Territory.** Peer review is the captain's shelf: nothing but a merge-archive touches it.
6. **No merge without the captain's word** (v0: no yolo).
7. **Write-ahead delivery.** Queue write precedes the send-keys wake; at-least-once; only ack removes. A dead session loses nothing.
8. **Supervision is infrastructure.** The server watches sessions, turn-ends, and PRs; lieutenants are purely reactive to their queue — no agent-armed watcher, no poll, no turn ending blind.
9. **Delegation over subagents.** Work that deserves representation gets a card + worker, not an invisible subagent.

## Side effects

| Trigger | Effect |
|---|---|
| captain drags Backlog → Working | start-order QueueItem to the owning lieutenant → it briefs and runs `card.start` |
| captain drags Your review → Backlog | rework-order QueueItem carrying the captain's thread comment |
| `card.start` | worker spawned (worktree + session), card → Working, level-2 event |
| `chat.say` by captain | QueueItem (write-ahead) + `harness.send` wake to the owning lieutenant |
| worker signal / turn-end | level-2 event on card + QueueItem to the owning lieutenant |
| worker done + lieutenant review | lieutenant rewrites body, moves → Your review — the level-1 handoff |
| PR merged (server watch) | card archived (`merged`), worktree released, level-1 event |
| lieutenant session dies | server auto-respawn (resume when possible; else charter + cards + queue), level-1 event on its lane card |
| level-1 event / owed reply | captain's bell (derived unseen set, cleared by reading — bridge semantics) |

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
