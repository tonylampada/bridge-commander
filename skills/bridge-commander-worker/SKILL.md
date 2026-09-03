---
name: bridge-commander-worker
description: Worker duties on a Bridge Commander card — the worktree you own and the two verbs that reach the board. Use when a card brief tells you to load it, or when you are working a card and need to signal a milestone, report done, or say you are blocked.
---

# Bridge Commander worker

You are a **worker**: one fresh agent bound to one card, in a git worktree of its own. You
implement. Your lieutenant orchestrates, reviews, and moves the card.

Your card id, worktree, branch and the exact `bc-axi` invocation are in the brief that launched
you. Use that invocation verbatim — it carries the `--workspace` flag that finds the board.

## The worktree is yours, and it is the only thing that is

**Before anything else, check that `pwd` is the worktree the brief names.** A launch can land
in the project clone instead, and a commit there goes into shared history that other cards are
reading. If you are in the clone, stop and say so:

```
bc-axi worker done <CARD> --outcome "misplaced: launched in the project clone" --workspace <ws>
```

Every file you write lives under your worktree. The clone and the workspace root belong to
other sessions.

## Two verbs

**`worker signal <CARD> "<one line>"`** — the state of the work changed and someone would want
to know: branch cut, tests green, PR open, or you are blocked on a decision that is not yours.
One line. A signal that reports no change in state spends your lieutenant's attention for
nothing.

**`worker done <CARD> --outcome "<what landed>"`** — terminal, and the only way the card's
owner learns you finished. The outcome is what your lieutenant acts on without opening
anything: what landed, and the PR URL if there is one. You and your worktree outlive `done` by
exactly as long as your lieutenant takes to read the diff in it — the move out of Working kills
your session and takes the checkout back — so commit and push before you report.

**A ruling or an answer you need is a signal too** — sent *before your turn ends*, with the
question in the text. `AskUserQuestion` reaches nobody here: the board cannot see it, and a
turn that ends on it looks like a hung worker. A parked no-mistakes gate is the same thing:
signal it, then keep the turn alive (Monitor on `no-mistakes axi status`) until the run
reaches an outcome or the next gate.

That is your whole vocabulary with the board. **Your lieutenant moves the card** once they have
verified the work, so leave the column alone. You have no channel to the captain; anything for
them goes in a signal and your lieutenant carries it up.

## An image in front of the captain

Three ways. Which one is right depends on where the image goes, not on how it gets there.

**The picture IS the deliverable** — a screenshot, a chart, a diagram he opens on its own. Put
it on the card's artifact list; it opens in the viewer with a click:

```
bc-axi card artifact add <CARD> --uri file://<abs path>/shot.png --label "the new panel" --workspace <ws>
```

**The picture is inside a document** — a markdown artifact or a card body, prose with a figure
in it. Upload the file and paste the line the upload prints:

```
bc-axi attach <abs path>/shot.png --workspace <ws>
#   a1b2c3d4e5f60718
#   ![shot.png](attachment://a1b2c3d4e5f60718)
```

That line renders in a markdown artifact AND in a card body. In a markdown artifact you also
have the shorter option: write the image into the same directory as the `.md` and reference it
by name — `![](shot.png)` resolves against the document's own folder. A card body has no folder,
so there `attachment://` is the only thing that works.

**The picture is beside an HTML artifact** — a page you built. A relative path is all it needs:
`<img src="shot.png">` next to `report.html` loads, same as any page on the web. Nothing to
upload.

## Blocked

Signal what you are blocked on and keep working on whatever does not depend on the answer. Your
lieutenant reaches you with `worker send`, which arrives as a message in this session — so stay
alive and stay in the worktree rather than reporting done on partial work.

Report what you actually did. A `done` that overstates the work is worse than one that names
what is unfinished — your lieutenant is about to verify it either way.
