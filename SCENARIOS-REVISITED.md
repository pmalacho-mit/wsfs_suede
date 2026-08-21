# Scenarios, revisited once drafts exist

`SCENARIOS.md` is the enumeration and stands unchanged. This is what drafts
change about its conclusions, plus the scenarios drafts introduce that did not
exist when it was written.

Read that one first. This one only records decisions and additions.

---

## The idea that changes the answers

A **draft** is a write the client submits with a label saying *"store this, but
I know it has not reached anyone else, so do not make it the file's current
content."*

The client can know this locally and for free. If its room connection is down —
or was down at any point since its last checkpoint — its work definitively has
not propagated. No round trip is needed to establish that.

The check does not need to be exact, only **conservative**, because the costs
are asymmetric:

- wrongly labelled a draft when it had in fact synced → a redundant row,
  superseded moments later. Cheap.
- wrongly labelled current when it had not synced → the failure this whole
  design exists to prevent.

So: when uncertain, draft.

**A draft is never merged from.** It is a photograph, not a branch. Merging
always happens through Yjs updates. If a draft's text is ever diffed back into a
document, the doubling problem returns immediately.

---

## Revised decisions

### C1 — what a client that is *ahead* does with work it cannot store

**Resolved: drafts.** The original three options collapse, because the premise
was wrong. The rule was never "you may not store"; it is **"you may not store
*as the file*"**. The work goes to the server immediately, is durable and
recoverable, and asserts nothing about shared state.

This also dissolves *"a held store is never retried"* from the known problems.
Nothing needs retrying to be safe.

And it is load-bearing beyond failure handling: a snapshot is only
reconstructable server-side when every token in it exists on the server. Today,
a user with unsynced typing who asks the assistant a question produces a
snapshot that cannot be resolved. Drafts make it resolvable, which is the normal
case rather than an edge case.

### C2 — how old local-only work can be before returning it surprises the user

**Resolved: always merge, no threshold.** Old local work always syncs.

The reasoning is that the previous version is always stored, so the state before
the merge is recoverable. The user can get back. That makes silent merging the
right default: it is never destructive, only occasionally surprising, and the
undo path exists.

This removes the product decision the original document deferred.

### C4 — closing the gap between shared and stored

**Unchanged recommendation: store on open** if the room's document holds work
the stored version does not. Nearly free, no timers, no server job.

With load-time replay from local persistence, the only remaining way to lose
rung-3 work is D5 — the room evicted *and* nobody holding it locally ever
returns — which is irreducible.

### C5 — one user in two tabs

**Resolved: explicitly supported, and tested as such.** Two tabs are treated as
two clients and must behave exactly like two browsers. Nothing may assume it is
the only client on this machine.

**The gotcha to test for:** local state is shared per origin, so the outbox and
the local document store are *not* private to one tab. Nothing may assume an
entry in the outbox was written by the tab that finds it. This is believed to
hold already, but it has never been exercised and must not be assumed.

### C6 — who carries an outside write into a room

**Resolved: the server, once.** Clients stop reacting to content changes for
entries they have open.

**Built, and it taught one thing worth keeping.** Moving the work to the server
did not move finding 3 with it: the server decided from one read of the room
and built its update from a later one, so a room that caught up in between was
handed what it already held. The rule survives the move -- *the content is the
authority, and it must be consulted against the read being acted on, not an
earlier one.* Whoever carries, carries under that rule.

### C7 — an open room whose file is deleted

**Resolved: the room stands down**, with a restore affordance — *and a draft is
written first.* No work that has not been stored may be lost to a deletion the
user did not make. The same rule applies to a file becoming binary.

### C3 — who stores, and how often

**Still open.** Deferred; it is history noise, not correctness.

---

## New scenarios that drafts introduce

| # | situation | resolution | |
|---|---|---|---|
| J1 | client is ahead and stores | write is labelled draft; file's current content unchanged; other clients unaffected | **obvious** |
| J2 | that client reconnects; its work merges; it stores again | the second write is current content. The draft is **cleared** | **obvious** |
| J3 | client is ahead, drafts, and never returns | draft remains uncleared forever — it is the only copy of that work | **obvious, and the reason drafts exist** |
| J4 | client drafts, reconnects, its work merges, and a *collaborator deletes that text* before anyone stores | the draft is **cleared**. The work reached people and was deliberately removed; that is editing, not loss | **obvious once the clearing condition is propagation rather than content** |
| J5 | client drafts repeatedly during one long disconnection | each draft supersedes the previous one *from the same client for the same entry* — the newer strictly contains the older's intent. Bounds the storage of a long offline session | **obvious**; the one safe use of supersession |
| J6 | two clients are both ahead and both draft | two independent drafts. Neither clears the other; they are different work | **obvious** |
| J7 | a draft is referenced by a snapshot sent to the assistant | resolvable, because the token is on the server. This is the main reason drafts are common rather than rare | **obvious** |
| J8 | the machine that made an uncleared draft never comes back | only the server can report this. The client's local draft list dies with the machine, so **the server owns the cleared flag** | **obvious** |
| J9 | client drafts, then the debounce fires again with no change | deduped by digest; no row written | **obvious** |

### The clearing condition

> A draft is created because this client's updates had not reached the room.
> It is cleared when they have.

Creation and clearing are the same predicate, flipped, and both are decidable
locally. Clearing is **not** "a later stored version contains this text" — see
J4, where that test would strand a draft that was never actually lost.

---

## Writes that did not come from a Yjs editor

`SCENARIOS.md` group F, made explicit, because this is where the transport rule
earns its keep.

The distinction that matters is not text-versus-binary. It is **whether a second
copy of this content exists in somebody's document.** Content from a script or a
kernel has no second copy, so diffing it in cannot double it. Content from an
editor always has one.

| # | situation | resolution |
|---|---|---|
| K1 | Python writes **text**, file open in nobody's room | commit the version. Nothing else. The next open finds the room behind and the server carries the gap in |
| K2 | Python writes **text**, file open in a live room | server commits, then carries the change into the room once, and advances `base`. Members receive it as an ordinary update. **No client computes anything** |
| K3 | Python writes **bytes**, file open in a live room | every open client writes a **draft of its current text first**, then the room stands down. The editor becomes a preview. No merge is attempted |
| K4 | Python writes **bytes**, file open in nobody's room | commit the version. Nothing else |
| K5 | Python **reads** a file that has unstored work in a room | it reads the stored version, which lacks that work. The client must checkpoint before handing a file to a kernel — this is what `dirty` is for. If the client is ahead and cannot checkpoint as current, an in-browser kernel should read the *document*, not the server |
| K6 | Python writes text to a file that a client is ahead on | both survive: the server's change lands in the room, the client's local work merges when it reconnects. Neither overwrites the other |

### How K2 is carried, precisely

Two requirements that are easy to conflate and both mandatory:

1. **What the diff is between.** Compute it between the two *stored versions* —
   the one the room records as its base, and the newly written one. Never
   between the room's live text and the new version: that would describe the
   users' unstored work as text to delete, and applying it would delete it.
2. **What the update is causally based on.** Apply those edits to the room's
   **live** document, and send the resulting incremental update. An update
   computed against a stale snapshot is dropped silently by Yjs — no error, no
   effect.

Because the room's live text has drifted from the base version, the diff's
positions no longer line up. Apply the change as a **patch with fuzzy
matching** (`fast_diff_match_patch` is already a dependency) against the live
text, then apply the minimal difference between the live text and the patched
result as document edits. Misplacement is possible in pathological cases;
loss is not, and duplication is not, because this content has no second copy.
