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
| Project | A repo registered in the workspace: `{name, path, source}`. No delivery mode — how finished work leaves the worktree is the CARD's playbook, per card |
| Playbook | A markdown file in `<workspace>/.bridge-commander/playbooks/`, one file per playbook, the file name being its id — the repeatable procedure a card is run by, rendered into the worker's Brief at `card.start`. The USER owns them: editing one changes the next card started on it, no restart, no release. The packaged set (this repo's `playbooks/`) seeds a fresh workspace and is the fallback — a workspace file of the same name always wins. Placeholders: `{{CARD_ID}}`, `{{CARD_TITLE}}`, `{{TASK}}`, `{{THREAD}}`, `{{PROJECT}}`, `{{PROJECT_PATH}}`, `{{WORKTREE}}`, `{{BRANCH}}`, `{{WORKSPACE}}`, `{{CLI}}`, `{{REPORT_FILE}}`, `{{ATTR_<NAME>}}`; an unknown one is left as-is, so a typo shows up in the brief instead of vanishing. A playbook MAY open with a frontmatter block — `harness`, `model`, `requires` (attribute names the playbook cannot work without), `branch` (`false` = no branch cut), `keep_worktree` (`true` = the worktree is never released automatically, for a card reworked in place), `teardown` (a shell command run in the worktree just before the release, to stop what the run started) — all optional, hand-parsed (`key: value`, `key: [a, b, c]`, `true`/`false`) and NOT yaml: anything else in the block is an error naming its line, since a guess there silently starts the wrong worker |
| Lieutenant | Durable orchestrator: `name` (display, emoji welcome), `color`, `avatar` (optional index 0-63 into the sprite sheet; absent = colored-dot fallback), `voice` (optional TTS-engine voice id; absent = the board's voice speaks for it), plus the pair that mints its cards' ids: `prefix` (defaults to the first three letters of the name, editable, and never shared with another lieutenant) and `cardSeq` (its own counter — incremented at creation, never reissued, never rolled back). Its `id` and any derived session name come from the ASCII slug of the name — emoji never reach tmux. It lives in the `lt` **window** of that session — the worker windows it starts cohabit the session with it — and that session is an incarnation, not the entity. Its charter is NOT board state: it is `lieutenants/<id>/README.md` in the workspace — the standing memory file the agent is launched on, and the only copy. Converses with the captain; proactive inside its mission (creates cards, starts them); never writes to projects |
| Card | Unit of work, owned by one lieutenant. Its `id` is minted by its owner as `<PREFIX>-<n>` (`MON-14`) and is the only name it has — nothing is hung beside it. Cards born before ids were minted keep their hand-written slugs (`pane-interactive`), and no operation tells the two apart. `type`: `plan` 🧠 \| `implementation` 🔥 \| `investigation` 🕵️. `playbook` = the id of the playbook `card.start` renders (a POINTER, never text — a card with none does not start). `body` = the deliverable, always rewritten to current state. `labels` (tags from the board registry). Work attributes live in an open `attributes{}` map, keys by convention: `repo`, `branch`, `worktree`, `session`, `prs {url, state}`, `artifacts {uri, label}` |
| CardStatus | Live status hung on a card, UI's real-time signal. Worker lease: `absent \| idle \| working \| needs-you`, written ONLY by `card.status` (worker-side), decayed server-side by TTL — and, on the SINGLE-card read only, filled in from the session itself when no lease was ever written (`derived: true`), so a worker that leases nothing still reads alive; plus server-derived `owed` (latest DELIVERED captain message not yet acked — queue truth, not thread order) with `owedState` `queued \| seen` (boundary: the drained cursor), and `unread` |
| Worker | Implementation agent bound 1:1 to a Working card: tmux **window** (`w-<card-id>`) inside its lieutenant's session + isolated worktree. Its standing duties are the `bridge-commander-worker` skill (shipped here, symlinked into the user's skills dir at `workspace.init`); the card's playbook opens by ordering it loaded, and that line is the user's to delete. Ephemeral — dies with the card's Working state; the session coupling (the lieutenant's SESSION dying takes its worker windows with it — its own `lt` window dying does not) is accepted design |
| Event | Card timeline entry: `text`, `level` (1 = bell, 2 = timeline only), `actor`, `kind` (open token; the board's kinds registry maps kind → emoji + default level) |
| Message | Chat utterance. `target`: a lieutenant's main chat or a card thread. May carry `attachments [{id, name, mime, path}]` (captain uploads); attachments ride the QueueItem to the lieutenant with absolute paths. A card thread is a **context folder**: the interlocutor is always the owning lieutenant, never the worker |
| QueueItem | One durable delivery to a lieutenant. Kinds: captain `message`, `line-passed`, `start-order`, `rework-order`, `card-created` / `card-moved` (captain acts echoed to the owner), `worker-signal`, `worker-said` (a non-owner posted on the card thread), `worker-stopped`, `worker-died`, `worker-stalled`, `worker done`, `pr-merged`, `pr-closed`. `seq`-ordered, at-least-once. A `message` may carry `via: "line"` — the channel lives in the ENVELOPE, never appended to the captain's text. (`worker-paused` is an event kind only — pausing is the lieutenant's own act, it never queues) |
| Line | The captain's voice channel: ONE holder at a time, held board-side (`board.line`) because the phone is not the only client. `chat.say` accepts the target `line` meaning "whoever holds it". It follows the last lieutenant to speak in a main chat, or is handed over by `line.pass`; a board that never had a conversation defaults to the founding lieutenant, and only a board with no lieutenant has nobody on the line |
| Archive | Append-only frozen card snapshots with `reason`; `card.restore` resurrects with full state and a loud level-1 event (a snapshot frozen in Working restores to Backlog — only `card.start` may enter Working) |
| Label | Board-level tag registry: name + color, palette auto-assigned; cards carry label names |

## Value objects

| Name | Used by | Description |
|---|---|---|
| Charter | the lieutenant's launch prompt | The lieutenant's standing mission prose — NOT a `lieutenant.create` argument and not board state: it is the memory file `lieutenants/<id>/README.md` (see Lieutenant), read at every launch. `--charter-file` on `init`/`lieutenant create` writes it when absent and never replaces it; editing the file is how a charter changes |
| Brief | card.start | The card's Playbook rendered against the card: the task description + acceptance criteria handed to the worker |
| HarnessRef | harness port | Opaque address of a live agent session (tmux target + resume id) |

## Operations

Callers · mechanisms: 🤠 captain (UI click/drag) · ⚓ lieutenant (CLI) · 🛠️ worker (CLI/hook) · ⚙️ server (automatic — no agent turn involved) · 🙋 the user's own agent (CLI, first run only — it is not on the board)

Trust model (v0): the server binds loopback (or a private mesh address) and has no app auth;
actor strings are honor-system. The network boundary is the auth boundary.

### workspace & lieutenant

| Operation | Signature | Who | When |
|---|---|---|---|
| `workspace.init` | `dir → workspace` | ⚓ (the founding agent) | skill invoked in a fresh dir, **inside tmux** (refuses outside, with instruction); creates `.bridge-commander/`, boots the server, registers the caller as the first lieutenant — the "teleport" |
| `workspace.onboard` | `dir → workspace, lieutenant` | 🙋 (the user's OWN agent, not a lieutenant) | the FIRST run, from a session that is not in tmux: refuses a dir holding a code project (naming what it found) and continues one already holding `.bridge-commander/`; then everything `workspace.init` does, except the founding lieutenant is **Bridget** — chartered from `onboarding/bridget.md`, spawned into her own tmux session, with a welcome message seeded on her thread before the person has said anything, and `board.onboarding` recording the step. Installs nothing; every part is idempotent, so a re-run resumes a half-finished first run |
| `workspace.onboardingStep` | `step → onboarding` | ⚓ (Bridget) | the first-run conversation's memory, on the board so it survives the session having it: `board-up → tools → project → checklist → done` |
| `workspace.open` | `dir → workspace` | ⚓ · 🤠 (CLI) | boot or attach to the board WITHOUT the teleport: bootstraps `.bridge-commander/` in cwd if absent, starts the server when down, prints the URL; no founding lieutenant involved |
| `workspace.addProject` | `url \| path → project` | ⚓ | captain asks to bring a repo into the workspace |
| `workspace.playbooks` | `→ [playbookId]` | ⚓ · 🤠 (the new-card dropdown, and the ✎ picker on a **Backlog** card's playbook chip — a started card rendered its brief already, so its chip shows the pointer and offers no editor) | list the playbooks a card can point at; read off disk on every call |
| `lieutenant.create` | `name, color?, avatar?, voice?, prefix? → lieutenant` | 🤠 lane button · ⚓ on captain's ask | a new mission/domain deserves its own commander; a defaulted `prefix` is nudged aside when taken, an explicit one that clashes is refused; server spawns its tmux session via the harness port, doctrine + the charter read from `lieutenants/<id>/README.md` as launch prompt |
| `lieutenant.patch` | `color?, avatar?, voice?, name?, prefix?, ref? → lieutenant` | 🤠 (⋯ → settings) · ⚙️ (ref re-registration on init idempotency) | cosmetics + voice + the card-id `prefix` (refused when another lieutenant already holds it; already-minted ids never change — a new prefix is about what comes next); `name` changes the display only — `id` and the derived session name stay immutable; `avatar: null` clears back to the colored-dot fallback; `voice: ""`/`null` clears back to the board's voice |
| `lieutenant.retire` | `lieutenant` | 🤠 | explicit only; refused while the lieutenant owns non-archived cards (archive or finish them first); kills its session, removes it, its queue and its chat log, loud level-1 event; the memory file `lieutenants/<id>/README.md` belongs to the role, not the instance — it stays, and the response names its path |

### card

| Operation | Signature | Who | When |
|---|---|---|---|
| `card.create` | `lieutenant, title, type, playbook?, attrs, id? → card` | 🤠 · ⚓ (proactive) | an idea/task is worth tracking; born in Backlog, nowhere else. The owner mints the id from its `prefix` + `cardSeq` (`MON-14`) and the counter advances only when the card is actually born. `id` is API-only: a caller on the wire may pass one, and the CLI refuses it outright — there the owner mints, which is the whole point of the counter. A duplicate id — the mint's included, which a prefix outliving its lieutenant can produce — is REFUSED with a message naming the fix the caller actually has: an explicit free id over the API, a free prefix on the lieutenant from the CLI. No suffix, no retry, no next-free-number: the guarantee is that a collision can never be created silently, not that it can never be attempted |
| `card.start` | `card, {brief?, resume?, harness?, model?, effort?} → worker` | ⚓ (own judgment, or executing a captain drag-order) | ready to work: ONE atomic op — spawn worker window + worktree, bind to card, card → Working. The card's `playbook` is resolved and rendered HERE and only here — title, body, thread and attributes as they stand at this instant, since all four keep changing until then; a card with no playbook is REFUSED, with the available playbooks named (no fallback, no default picked on the card's behalf). Harness/model resolve: explicit arg → the playbook's frontmatter → config default (`harness` only — there is no configured default model, the harness picks its own); a playbook's `requires` is checked BEFORE anything is provisioned, so a card missing an attribute is refused with the attribute named rather than spawning a worker to discover it. The rendered brief is auto-attached as a card artifact (label `brief`, idempotent across resumes); `--resume` reincarnates the recorded worker instead (refuses a brief — steer with `worker.send`; refuses too when that worker's worktree was released at the handoff — there is nothing to reincarnate into, and a fresh start is the way back: it is the one live session ever spawned over, precisely because a done worker with no worktree has nothing left to steer). Every start reads the playbook — there is no second way for a card to begin. Whether a branch is cut is the playbook's call (`branch:` in its frontmatter), falling back to the card type when the block does not say. Implementation cards get branch `bc/<card-id>` — `bc/MON-14`, the id and nothing else, deliberately: the captain reads branch names and wants them aligned with the card, and the PR carries a title for anyone who wants prose. Investigations get NO branch — their deliverable is the report. A restart over a finished, dead worker releases that worker's worktree first, running the PREVIOUS run's `teardown` (60s, awaited) in it immediately before — the restart is the moment that checkout is actually destroyed, and it is the one release point a `keep_worktree` playbook ever reaches; a release that refuses still 409s the start. `plan` cards never start |
| `card.move` | `card, column` | 🤠 drag = **order** · ⚓ only → Your review (the handoff) · ⚙️ only on objective facts (start, merge) | see side effects for drag semantics. A move OUT of Working ends the work, so it releases the worker's worktree — the lieutenant has read the diff by then, and a finished card otherwise held a full checkout until someone archived it. Not released: a playbook with `keep_worktree: true` (a card reworked in place), a worker that never reported done (that checkout may be the only copy), or a worktree still holding work |
| `card.patch` | `card, {title?, body?, type?, playbook?, attrs?, labels?, owner?}` | ⚓ · ⚙️ (mechanical attrs: prs, session) | body rewritten to current state before every handoff. `owner` is patchable ONLY while no worker record is bound (see invariant 4) |
| `card.park` | `card → ()` | ⚓ | the narrow lieutenant door out of Working back to Backlog — legal only when the card's worker is absent or dead (liveness re-checked server-side). NOT a release: parking shelves a card to be resumed in the same worktree, so the checkout survives (unlike `card.move`) |
| `card.status` | `card, worker-state` | 🛠️ writes · ⚙️ TTL-decays | the live lease behind CardStatus; single-writer |
| `card.artifact.add` | `card, uri, label? → ()` | ⚓ · 🤠 (📌 on a chat attachment) | promote a file to card artifact — a DELIBERATE act; a chat upload alone never lands here. Idempotent by uri |
| `card.artifact.remove` | `card, uri → ()` | ⚓ · 🤠 | unlist an artifact (the file itself is untouched) |
| `card.artifact.write` | `uri, content, version → version` | 🤠 (the board's file editor) | write a text artifact back to disk. Only a uri ALREADY listed on some card, or one of the workspace-owned files the same screen edits — a workspace playbook, a lieutenant's charter, a hook (see `hook.edit`) — whose path the SERVER builds and compares for equality rather than taking from the client. Only `file://`, never through a `..` or a symlink; anything else is refused, and there is no flag that widens it. `version` is the sha256 the read handed out; if disk moved since, nothing is written and the answer carries what is there now (409), so a lost edit is never silent. Atomic (temp file + rename). **A board-owned file that is not written yet reads as the empty document at version `""`, whatever kind it is** — a charter, a hook — and `""` is exactly what the write reads as "I expect no file", so the first save creates it (and a file that turned up meanwhile is still a 409). A card artifact is not board-owned: its path came from the card, so a missing one is genuinely unreadable |
| `card.archive` | `card, reason` | ⚙️ on merge · ⚓/🤠 otherwise | work landed, died, or was dismissed |
| `card.restore` | `card` | ⚓ · ⚙️ (live evidence for an archived card) | a kill was a mistake; full frozen state + loud level-1 event; Working snapshots land in Backlog |
| `card.list_archived` | `limit?, offset? → [record], total` | 🤠 (the 🧊 archived mode) · ⚓ (CLI `archive`) | browse the frozen snapshots newest-first — a paginated window over the append-only archive log, never mixed into the live board |

### conversation & delivery

| Operation | Signature | Who | When |
|---|---|---|---|
| `chat.say` | `target: lieutenant-main \| card \| line, text, attachments?` | 🤠 ↔ ⚓ | any time; captain-side is write-ahead: queue first, then `harness.send` wake. Author defaults to the CALLER's identity (session-resolved), never inferred from the target. Captain-side `line` resolves to the holder's main chat and stamps the QueueItem `via: "line"` |
| `chat.page` | `target: lieutenant-main, before?, limit? → [Message]` | 🤠 (scrolling up) · ⚓ (CLI `thread`) | a main chat is an append-only log of its own (`chat/<lieutenant>.jsonl`) and the board payload carries only its newest slice, so older history is paged backwards from the oldest message on screen — oldest-first, EMPTY past the beginning (running out of conversation is not an error). A card thread has nothing to page: it rides the board and dies with its card |
| `line.who` | `() → lieutenant, source: held \| default \| none` | ⚓ · 🤠 | before answering: which voice the captain expects. Never answered from local state |
| `line.pass` | `lieutenant, note → ()` | ⚓ (on the captain's ask) | the work is someone else's territory: moves the line AND queues a `line-passed` delivery carrying the note, so the receiver is woken and greets him in one line |
| `feed.drain` | `lieutenant → QueueItem[]` | ⚓ | first act of every lieutenant turn; the caller self-identifies by its tmux session and drains ONLY its own queue |
| `feed.ack` | `seq` | ⚓ | after handling; only ack removes — unacked re-offers. Identity-scoped: a lieutenant can only commit seqs in its own queue |
| `event.append` | `card \| board, text, kind, level, wakeOwner?, key?, source?` | ⚓ · 🛠️ | agent-authored timeline entry (card) or board-level notice. `wakeOwner` also queues a `card-event` item to the owner — the door an outside process (a workflow, a cron, a hook) wakes a lieutenant through. `key` makes it at-most-once for THAT card: a repeat of that key writes nothing and wakes nobody, answers 200 saying `duplicate` (a poller reporting the same fact is not in error), and keys are kept 7 days — so a five-minute hook watching one red check wakes its lieutenant ONCE instead of sixty times. `source` names the caller on BOTH the timeline entry and the queue item, so a drain at 2am says who woke you |
| `kinds.register` | `kind → emoji, level` | ⚓ | extend the event vocabulary; built-ins stay |
| `label.manage` | `create \| rename \| recolor \| delete` | 🤠 | curate the board's label registry; rename/delete propagate across every card carrying the label |

### worker plumbing

| Operation | Signature | Who | When |
|---|---|---|---|
| `worker.signal` | `card, text` | 🛠️ | real milestones (branch, tests green, PR open) → level-2 event + QueueItem to the owner |
| `worker.done` | `card, outcome` | 🛠️ | worker finished: event + QueueItem wake the owner; the card stays Working until the lieutenant verifies and hands off. PR URLs in the outcome populate the card's `prs` (the PR watch takes it from there); an investigation's report (`.bridge-commander/reports/<card>.md` by convention) is attached as an artifact. The worktree STAYS: `done` starts the lieutenant's half, and verifying the work means reading the diff in it |
| `worker.pause` | `card → ()` | ⚓ | deliberately kill the worker's session with NO died alarm; the card stays Working, the record + worktree survive for `card.start --resume`; supervision skips a paused worker. Composes with `card.park`. `--expect-exit` is the other deliberate stop — the session is ending BY ITSELF and the caller is inside it (a worker holding on a gate), so NOTHING is killed and `--reason` replaces the resume hint. That stop is recorded on the worker, and `card.start --resume` then REFUSES it (409, quoting the reason): resuming starts a second run over the one still in flight |
| worker stop | — | ⚙️ turn-end | a worker turn-end IS the stop signal: card still Working and no `done` → immediate `worker-stopped` QueueItem to the owner + level-2 event (coalesced — one per stop, not per turn). After `done`, turn-ends only update counters |
| worker death | — | ⚙️ supervision loop | a worker ref dead without `done` → `worker-died` QueueItem to the owner + level-2 event; the card stays Working, flagged — the owner resumes (`card.start --resume`) or parks it |
| worker stall | — | ⚙️ supervision loop | a worker alive but silent too long (no signal/turn-end) → `worker-stalled` level-1 event + QueueItem to the owner; re-armed by real activity |
| `sysload.watch` | `() → stream of samples` | 🤠 | on-demand monitoring (⚙️ → machine load): machine CPU/RAM/disk + per-worker/per-lieutenant process-tree load + container count, over a dedicated stream. A pure, side-effect-free read — samples exist only while someone watches (first subscriber starts the sampler, last disconnect stops it); nothing lands on the board |

### hook

| Operation | Signature | Who | When |
|---|---|---|---|
| `hook.list` | `() → [{name, event, file, last, running}]` | 🤠 (the config screen's hooks tab) · ⚓ | what this workspace can run and how each one last ended. Read off disk every call, never cached — a hook dropped in a second ago is in the next answer |
| `hook.run` | `name, card?, trigger? → run` | ⚓/🛠️ (CLI) · 🤠 (the tab's ▶) · ⚙️ (a schedule) | run a NAMED hook. ONE code path for all three callers, and the trace line differs only by `trigger`. Deliberately not an HTTP door for outside callers: an external trigger runs on this machine and speaks CLI. `card` fills the card env; a second run of a name already in flight is REFUSED (409) naming the one going; a name that is not an executable file in `hooks/` is a 404 naming the directory. A hook's own outcome — non-zero exit, timeout — is a RESULT, never an error: it lands on the trace and the caller lives |
| `hook.runs` | `hook?, limit? → [run]` | ⚓ · 🤠 | the trace, newest first, read from the TAIL of `hookruns.jsonl` |
| `hook.edit` | — | 🤠 · ⚓ | a hook is a FILE, so editing one is `card.artifact.write` and the file screen: the same 💾, the same version check, the same 409. The gate widens by exactly one shape — an executable file under `.bridge-commander/hooks/`, one level deep or two, no symlink, the path built server-side and compared for equality. A hook nobody has written yet reads as the empty document at version `""` (see `card.artifact.write`), so `bc-axi artifact read` then `write --version ""` is how a lieutenant writes one with nothing but the CLI. A hook created there is born executable, and `hooks/` itself is created on the first write (a fixed name the board owns, like a lieutenant's memory folder) so a workspace with no hooks yet is not the one place a lieutenant cannot write the first one. An EVENT directory is never created: a directory invented from a typo is a hook that silently never fires, so a write into a missing one is refused with the event named and the ones the board fires listed — a legal path whose tree is missing gets that answer, not "unknown artifact" |

### harness port (internal seam — the multi-harness contract)

| Verb | Signature | Called by | Purpose |
|---|---|---|---|
| `harness.spawn` | `cwd, prompt, opts → HarnessRef` | ⚙️ | birth an agent in a named WINDOW of a session (`opts`: session name, window name — non-numeric: `lt` for the lieutenant, `w-<card-id>` for its workers, which share that session —, state dir, turn-end callback URL, hook install mode); no window name = the agent owns the whole session |
| `harness.send` | `ref, text` | ⚙️ | type into a session (the wake half of delivery) |
| `harness.alive` | `ref → bool` | ⚙️ | liveness check for supervision |
| `harness.resumable` | `ref → bool` | ⚙️ | introspection: would `resume` restore memory? The server picks resume vs relaunch-with-charter on it |
| `harness.resume` | `ref, opts → HarnessRef` | ⚙️ | reincarnate a dead session with memory when possible |
| `harness.kill` | `ref` | ⚙️ | end a session for good (idempotent): merged-PR cleanup, card archive, lieutenant.retire |
| `harness.onTurnEnd` | `ref, hook` | embedders | turn-boundary detection for port consumers; the SERVER's channel is the spawn-time callback URL — a Stop hook in the session POSTs each turn end (with its tmux session for exact attribution) |

The server speaks ONLY this port. Builtins: `claude`, `codex` (OpenAI Codex CLI) and a
file-backed `fake` for tests; adding a harness is implementing these seven verbs, nothing
else. A verb a harness cannot honor THROWS with the reason — never silently succeeds.
Harness working state (session ids, prompts, turn-end logs) lives in the workspace's
`.bridge-commander/harness/` — never global; spawned session names are unique per workspace.

**Optional capability verbs.** Beyond the seven REQUIRED verbs a harness MAY expose extra
verbs for features not every harness can honor. The port never validates them (requiring
one would force every harness, `fake` included, to implement it); the server
capability-checks at the call site (`typeof impl.openPane === 'function'`) and degrades
gracefully when the verb is absent. Current optional verbs (pane viewing, slash commands,
session status, window adoption):

| Verb | Signature | Called by | Purpose |
|---|---|---|---|
| `harness.openPane` | `ref, {onFrame, intervalMs?, lines?} → {close()}` | ⚙️ pane hub | stream the pane's rendered screen as change-detected frames (strings, MAY carry ANSI SGR) — served to the captain over a dedicated per-target SSE (`GET /api/cards/:id/pane/stream`, `GET /api/lieutenants/:id/pane/stream`), ref-counted so N viewers share ONE feed and the last disconnect releases it; harness lacks the verb → `unsupported`, nothing to watch → `no-pane`, concurrent-pane cap → `busy` (all clean SSE events, never an HTTP error) |
| `harness.paneSnapshot` | `ref, {lines?} → string` | ⚙️ pane hub | one-shot capture for the stream's initial paint |
| `harness.paneInput` | `ref, {text?\|key?} → void` | ⌨️ pane input | forward RAW input to the pane — `text` typed literally (multi-line rides a bracketed paste), `key` one tmux key name (`Enter`, `BSpace`, `Up`, `BTab`, `C-c`, …); served over `POST /api/cards/:id/pane/input` and `POST /api/lieutenants/:id/pane/input` (same ref resolution as the streams: 404 nothing to type into, 501 harness lacks the verb, 502 the harness refused). Deliberately **not** `send` — no type→settle→Enter and no composer verification, which are right for a brief and wrong for an arrow key. Payload rules (key XOR text, the key grammar, the byte-counted text cap) come from the SHARED `validatePaneInput()` in `port.js`, so no harness can be laxer than another. Also bursts the open pane feed to ~120ms for ~1.5s so the echo does not sit behind the 1s poll |
| `harness.commands` | `ref → [{name, description}]` | ⚙️ | list the slash commands this session honors (drives the UI's command palette) |
| `harness.runCommand` | `ref, line → string` | ⚙️ | run one slash-command line in the session (pass-through or emulated per harness) and return the reply text |
| `harness.status` | `ref → {model, contextUsed, contextWindow, rateLimits?}` | ⚙️ | session vitals; the server caches the result at each turn-end and serves it on the board payload (the lane/card context bars) |
| `harness.adoptWindow` | `ref, window, taken? → HarnessRef\|null` | ⚙️ supervision | migrate a session-granular ref to window granularity without restarting the agent (the lieutenants registered before their ref carried a window) — `taken` names windows that belong to someone else and must never be adopted; `null` = the agent's window cannot be identified, keep the old ref |

## Invariants

1. **Board is truth.** No shadow files, no mirror: cards + queues in `.bridge-commander/` ARE the state. Agent conversation memory is a cache; restart of any session is a non-event. Unbounded logs are append-only files beside the board and are the truth for what they hold — the archive, the delivery queues, and a lieutenant's main chat — never copied back into `board.json`, which would be two truths and a rewrite of everything on every write.
2. **Lieutenants never write to projects.** Every change reaches a project through a worker in an isolated worktree, shipped the way the card's playbook says.
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
| `worker.send` by the lieutenant | text typed into the card's live worker session (harness `send`, verified submission) + level-2 event; on a done-but-alive worker it REOPENS the turn (record reset, card → Working) — send = "more work for this worker" — unless the handoff already released its worktree, which leaves the reopened turn nowhere to write and refuses, pointing at a fresh start; loud error without a live worker. `card.start --resume` refuses a brief and points here |
| worker signal | level-2 event on card + QueueItem to the owning lieutenant |
| worker turn-end without `done` (card still Working) | `worker-stopped` QueueItem to the owner + level-2 event, immediately — a stopped worker is never invisible |
| worker alive but silent past the stall window | `worker-stalled` level-1 event + QueueItem to the owner |
| worker done + lieutenant review | lieutenant rewrites body, moves → Your review — the level-1 handoff |
| PR merged (server watch) | card archived (`merged`), worktree released (the archive rules below — usually already released at the handoff; a refusal rides the archive note as well as the timeline), lingering worker session killed, level-1 event, `pr-merged` QueueItem to the owner |
| PR closed unmerged (server watch) | `pr-closed` QueueItem to the owner — a decision, not an archive |
| card leaves Working (`card.move`) | the worker's worktree is released — the handoff is the end of the work (`keep_worktree: true`, a worker that never reported done, and a worktree still holding work are the exceptions); a playbook's `teardown` runs in the worktree immediately before the release, best effort, 5 min; a level-2 event names the path, and names the reason when the release is refused. A released worktree drops the card's `worktree` attribute — no reader is left pointed at a directory that is gone |
| card archived (any reason) | any worker session still bound to the card is killed (an archived card has neither Working nor worker); the worktree is released after the `card-archived` hooks — always, `keep_worktree` included, since nothing is left to rework. Already released at the handoff = a no-op, and the playbook's `teardown` does not run again either — it had its turn there. A handoff release that was REFUSED leaves the checkout standing, and that is the case where this release point gets a second attempt at a `teardown` that failed |
| rework restart (`card.start` over a finished, dead worker) | the previous worker's worktree is released before the new one is cut, and the PREVIOUS run's recorded `teardown` runs in it first (60s, awaited) — the restart is the moment that checkout is actually destroyed, so it is where a `keep_worktree` playbook's container is finally stopped. The teardown's outcome never steers the release: a refusal still 409s the start, exactly as it did before |
| worker session dies without `done` | `worker-died` QueueItem to the owner + level-2 event; card stays Working, flagged |
| lieutenant session dies | server auto-respawn (resume when possible; else relaunch with charter + owned cards + pending queue as the prompt), level-1 event, drain nudge; 3 failed attempts → level-1 needs-captain |
| level-1 event / owed reply | captain's bell: unseen = level-1 events ∪ unseen lieutenant thread replies, per user, cleared by reading — bridge semantics |
| `worker.done` · worker death · card archived | lifecycle hooks: the workspace's own executable scripts in `.bridge-commander/hooks/<event>/` run (see below) |

### Hooks

A hook is an executable file the workspace owns, spawned directly with `BC_*` in its env,
cwd = the workspace root. The namespace says which kind it is, and that is the whole rule:

| path | kind | what fires it |
| --- | --- | --- |
| `.bridge-commander/hooks/<event>/<name>` | **lifecycle** | that lifecycle event |
| `.bridge-commander/hooks/<name>` | **named** | nothing — a caller does, through `hook.run` |

**Directory means event, file means name**, so the two share one directory and never collide.
Missing dir = no-op; non-executables and dotfiles are skipped.

There is no hook API and there must not be one: a hook is bash with `bc-axi` on its `PATH`
(the runner APPENDS the CLI's directory — the guarantee is *reachable*, not *mine*, so a
`bc-axi` the operator put earlier on `PATH` still wins), so the board's whole vocabulary is
already reachable from a shell script — including `bc-axi event <card> --wake-owner`, which is how a hook wakes a lieutenant.
It is the same door every other caller uses; there is no second one.

**Lifecycle hooks** run on their event — alphabetical, sequential, context via env
(`BC_EVENT`, `BC_CARD`, `BC_REPO`, `BC_WORKTREE`, `BC_BRANCH`; empty when N/A). Events v1:
`worker-done`, `worker-died`, `card-archived`.

**Named hooks** run through `hook.run` and only through it. `BC_EVENT` carries the hook's own
name; `BC_CARD` / `BC_WORKTREE` / `BC_BRANCH` are empty unless the caller supplied a card.
**One run per hook name at a time**, board-wide: a second `hook.run` while the first is in
flight is refused, naming what is already running, so a five-minute poll and an impatient ▶ do
not overlap. A name that is not an executable file in `hooks/` is an error naming the
directory, never a silent success.

### The trace — `hookruns.jsonl`

Every run of either kind appends one line to `.bridge-commander/hookruns.jsonl`:
`{hook, trigger, card, started, ms, code, ok, timedOut, output}` — append-only, the same shape
as `archive.jsonl` and the delivery queues. It is written by the RUNNER, so lifecycle hooks
land in it too. `trigger` is the lifecycle event for a lifecycle hook and whatever the caller
named itself for a named one (`cli`, `board`, a schedule). `hook.runs` reads it from the TAIL,
never whole.

Hooks are fire-and-forget — they never block or fail the lifecycle outcome they observe
(per-hook timeout ~120s, `BC_HOOK_TIMEOUT_MS` overrides, then kill; output captured and
capped). The ONE ordering guarantee: `card-archived` hooks finish (or time out) BEFORE the
worktree release, so a hook can still reach paths inside `$BC_WORKTREE` — but only when there
is one left: the handoff (`card.move` out of Working) usually released it already, and a
released worktree is never named again, so `BC_WORKTREE` is empty for those. Each run lands on
the timeline: `hook-ran` level 2 per success, `hook-failed` level 1 (the captain's bell) with
filename + exit detail + trimmed output; an archived card's events land on the board stream
with a card reference, and failures also queue to the owner.

### Playbook teardown

The per-playbook counterpart of a hook: `teardown: <shell command>` in the frontmatter stops
what THAT playbook's run started (a devcontainer, a compose stack) — a container that outlives
its worktree is the same bug as a worktree that outlives its work, one layer down. It runs at
every release — the handoff, archive, and the rework restart — immediately before the worktree
goes, cwd = the worktree, same `BC_*` env (`BC_EVENT=teardown`). `keep_worktree: true` runs
neither it nor the release AT THE HANDOFF, since the container is part of what is being kept —
but the RESTART, the moment that kept checkout is actually destroyed, does run it. A worktree
already released runs neither again, and a run that SUCCEEDED is never repeated for the same
worker; one that failed stays retryable at the next release point.

Every run lands on the timeline — `hook-ran` / `hook-failed`, text = the command, exit detail,
duration and the TAIL of its output — because a teardown that worked has to be as visible as
one that failed. Best effort: a non-zero exit or a timeout (then the whole process group is
killed) lands its event, queues to the owner, and the release goes ahead exactly as if no
teardown had been configured. Nothing is lost by carrying on — a container still holding the
checkout makes the release refuse on its own, and say why.

The budget is **5 min** at the handoff and at archive, where the command is fired un-awaited
and nobody is on the line, and **60s at the restart**, which is awaited inside the `card start`
request ahead of provisioning and a spawn. `BC_TEARDOWN_TIMEOUT_MS` overrides both.

## Memory

| Knowledge | Home |
|---|---|
| Factory doctrine (roles, columns, delegation, etiquette — ~1 page) | the skill |
| Captain preferences | workspace `captain.md` (seedable from a global default) |
| A lieutenant's own charter (its standing mission, hand-editable) | workspace `lieutenants/<id>/README.md` — read into every launch prompt, kept when the lieutenant retires |
| Per-project engineering learnings | workspace memory, proactively maintained by lieutenants |
| Project-intrinsic knowledge | the project's own `AGENTS.md`, written by workers via delivery |
| Card-scoped state | the card: body, thread, events, attributes |

The workspace `AGENTS.md` is the lieutenants' shared memory; its first instruction loads the
skill, and the skill loads `captain.md` + learnings.
