# From what exists to what we want

Every change, what it replaces, and how to confirm it. Ordered so each step is
independently shippable and each has something that can fail if it is wrong.

`SCENARIOS.md` is the enumeration; `SCENARIOS-REVISITED.md` is the decisions.
This is the work.

---

## The three rules everything below serves

1. **Content that came out of an editor moves as a Yjs update, never as text.**
   Only content that was never in an editor is diffed in.
2. **The server is the only writer of a room's `base`, and the only party that
   carries text into a room.**
3. **A client may not store *as the file* work that has not reached anyone
   else — it stores it as a draft instead.**

---

## Step 0 — The "dropped stream event" — FOUND AND FIXED

**It was never a dropped event.** Naming it that was a guess from the symptom,
and the guess was wrong.

**What was actually happening.** A queued create leaves the outbox when the
STREAM carries it, not when the response acknowledges it — a deliberate choice,
so an entry is never in neither the outbox nor the confirmed map. That leaves a
real window in which the server has confirmed the create *and* writes after it,
while the create is still sitting in the local outbox.

`effective.of` laid that queued create back over the entry with `proposed()`,
which sets **all four** of an entry's versions to the create's own transaction.
For an entry that exists nowhere else that is exactly right. For one the server
has moved on, it is a rewind: `content_version` snaps back to the create and
every write since is hidden. And because only the stream drains the outbox, it
stayed hidden rather than correcting a moment later.

`proposed`'s own docstring said it: *"a queued create has no confirmed entry to
lay over"*. That was a precondition, and nothing checked it.

**How it was found.** Not by reading. The backend was cleared first — 40 direct
stream writes and 60 through the Vite proxy, zero missed events — which ruled
out delivery and the proxy. Then the failing assertion was made to report
`unsettled`, which reads the CONFIRMED map, alongside `token`, which reads the
EFFECTIVE view. Catching one failure with both showed `unsettled=[]` — the
transaction *had* landed and *had* left the outbox — while the view still
reported the older version. Two readings of the same state disagreeing is a
much smaller search than "somewhere an event went missing".

**The fix.** `effective.of` contributes a queued create only when the confirmed
map has no entry for it. One condition, in `release/frontend/effective.ts`.

**Confirmed.** A unit test in `tests/frontend/view.test.ts` reproduces it
deterministically — it fails before the change and passes after, so the
intermittent browser flake is now a one-line regression test. Unit suite 114
passing, up from 113.

In the browser, across twenty paired runs:

| scenario | before | after |
|---|---|---|
| 9 — *rebuilds what a client was looking at* | 3 of 6 | **10 of 10** |
| 8 — *a write that is not text takes the file away* | 4 of 6 | **10 of 10** |

The full nine-scenario suite then passed in both browsers — **the first time
the collaboration suite has been entirely green.**

**One condition cleared both**, which is the part worth remembering. They
looked like different bugs — one a token that would not advance, the other a
room never told its file had turned binary — and both were the same rewound
view. Scenario 8's room asked for its entry's version, got the create's, and
computed the wrong gap. Two intermittent failures with unrelated symptoms and a
single cause is the normal shape of this, not the exception.

### What this does not close

The outbox still has no way to ask *"did this transaction ever land?"* independent
of asking the server to land it. That distinction is worth keeping:

- **resend** — dangerous on its own; a write that already landed could mint a
  second version.
- **ask** — idempotent and safe.

`Initialize` already *is* the safe ask: it takes the outbox and returns which
transactions applied and which were rejected, and every reconnect runs it. So
the missing piece is only a trigger — an entry that has sat in the outbox for
longer than some threshold should cause a re-adjudication.

**A trap to note for whoever builds it:** `Loop.nudge()` does not do this today.
It resets the backoff and wakes the loop out of its rest, but while a stream is
established the loop is inside `once()` and `wake` is undefined, so `nudge()` is
a no-op. Triggering a re-adjudication mid-stream means aborting the current
read so the loop re-enters, or adding a lighter ask that does not tear the
stream down.

## Steps 1 and 2 — Stop diffing client work; the server owns rooms — DONE

They had to land together: deleting the client's repair leaves nothing to carry
an outside write until the server does it.

**What went.** The client no longer reads its file at two versions, diffs them
and types the difference into its own document. With that went the seeding
election, the claim slot, one of the two 600ms timers, the verdict log, and
`emitting` / `refused` / `carried` / `opening` from `rooms.ts`. `speaking`
stays, because findings 4 and 5 are not about transport.

**What the client still reads a version for**, and the only reason: nothing in
a token says whether it names text or bytes, so reading is the first moment
anybody can know the file stopped being text. That is where `replaced` comes
from and it is all that read does now.

**What arrived.** `POST /rooms/{entry}` — idempotent, and the only way a room
is ever filled. `Rooms.open` settles before it attaches, so by the time a
provider syncs, an empty document means an empty file rather than one that has
not arrived yet.

### The bug this turned up, which is the interesting part

The first full run after the change doubled whole changes for the second party
to arrive:

```
scenario 2:  "written before grace ever looked\n"  twice
scenario 7:  "shared start\n" once, then both lines twice
```

The keeper read the room to DECIDE, and read it again to BUILD the update. A
room that caught up in between already held what the carry was about to insert,
and a CRDT cannot notice that two inserts say the same thing.

It is finding 3 again — *a verdict is a hypothesis, and the content is the
authority* — arriving on the server the moment the server took the job over.
Moving work does not move that lesson with it, and the fix is the same shape:
the question is asked once more against the read the update is actually built
on, where the answer cannot go stale.

Reproduced deterministically first, by letting a fake answer a read and only
then change the room, so the deciding read and the building read see different
states. That test fails without the guard and passes with it.

**Confirm.** All nine browser scenarios pass in both browsers. Unit 114,
backend 224, svelte-check 0 errors.

### Not done, and deliberately

`#settling` is still a 600ms wait, and still the last guess in the system. The
transport change does not remove finding 5: a room just back still holds text
the others have not been given, and storing it still makes the server tell them
about a write whose content is in flight. That is step 4.

---

## Step 3 — Drafts

**Now.** A write is either accepted as the file's current content or refused,
with refusals kept in `wsfs_refused_*`. A client that cannot legitimately store
is told the store was held, and nothing retries it.

**Wanted.**

- **One table for content submitted and not adopted as current**, replacing the
  refused-writes tables, with a disposition column: `refused` (the server said
  no) or `draft` (the client said not-yet). One retention story, one storage
  mechanism, and one uniform path for reconstruction to resolve any submitted
  transaction whatever became of it.
- **Retained forever.** Delta-encoded against the version the draft is based on,
  and **never chained** — every chain stays length one, so reconstruction is
  O(1) while storage collapses. Deduped by digest before writing.
- A draft records the entry, the submitting client/session, the base version,
  and a **cleared** flag **owned by the server**. The client's local list is a
  convenience; the stranded case is exactly the one where that machine never
  comes back.
- Same-client supersession for the same entry, to bound a long offline session.

**Keep separate in the UI.** *The system rejected this* and *this is yours and
will land shortly* share a table and must never share a presentation.

**Confirm.**
- Take one browser's room connection away, type, store → a draft row exists, the
  file's current content is unchanged, and the other browser is unaffected.
- Give the connection back → the work merges once, an ordinary store lands, and
  **the draft is marked cleared.**
- The draft's content is byte-identical to what was typed.
- The clearing condition is propagation, not content: let the collaborator delete
  that text before anyone stores, and the draft must **still** clear (J4).
- Storage: type continuously for several minutes offline and confirm the drafts
  are deltas against one base, not full copies and not a chain.
- A snapshot naming a draft resolves through the reconstruction endpoint —
  extend scenario 9, which today asserts nothing unsettled remains.

---

## Step 4 — The client declares its own sync state — DONE, and simpler than planned

**The plan here was wrong in a useful way.** It proposed computing
`Y.encodeStateAsUpdate(doc, roomStateVector)` and, when the provider would not
give up a fresh room state vector, asking the server for one. Liveblocks
answers the question directly:

```
provider.getStatus()            "loading" | "synchronizing" | "synchronized"
client.getSyncStatus()          "synchronizing" | "synchronized"   (all rooms)
client.events.syncStatus        an Observable to subscribe to
```

`synchronizing` means *this client is holding changes the server has not
confirmed* -- which is `ahead` exactly, and says nothing about being behind.

**Why that bar is the right one.** It is about reaching LIVEBLOCKS, not about
other browsers having applied anything. The host reads a room through the same
REST API, so once Liveblocks has the changes, the keeper's read will see them.
The thing being guarded against is the keeper carrying in text that is still in
flight.

**Verified before being relied on.** A browser test disconnects the provider,
types, and asserts the status reports `synchronizing`; reconnects and asserts
it returns to `synchronized`. Note that the status does NOT flip synchronously
on a local edit while connected -- the first version of that test asserted it
did and failed -- so the signal is only meaningful as "has it settled", which
is how it is used.

**What went.** `#settling`, `SETTLING`, and the last duration correctness ever
rested on. `reattach` now waits on `handedOver()` -- a subscription to
`client.events.syncStatus`, not a poll and not a timer -- before asking the
server to bring the room up to date.

**Measured first.** With the timer simply deleted and nothing put in its place,
the three reattach scenarios passed 12 of 12: the server-side guards already
covered it in practice. The race was narrow rather than closed, though, and
doubling is the one failure worth being ruthless about, so it was replaced
rather than dropped.

### Waiting is not the same as refusing, and the tests said so

The first wiring made `speaks` false while `synchronizing`, so a store in that
window was **refused**. Half the suite then failed the opposite way -- *"the
room would not store: the room has not finished handing over what it holds"*.

Typing and immediately storing is the ORDINARY case. A client always holds
what it just typed, so a rule that refuses in that state refuses everything.
The hazard is not that the client is holding something; it is that the SERVER
would see a write whose content the room does not have yet.

So `store` **waits** for the handover and then sends, and `send` -- which has
to stay synchronous, because a caller describing what the user is looking at
needs the transaction at the moment it asks -- keeps the refusal for the case
where waiting is not possible. By the time `store` calls it, there is nothing
left to wait for.

**Confirm.** The three reattach scenarios pass 9 of 9 on the real signal, and
the full suite twice over.

### The one timer left in the system

`attach` gives up after 30 seconds of a provider that never syncs. That is a
failure timeout, not a correctness guess -- it decides when to stop waiting,
not what is true. The typing debounce stays by design.

---

## Step 5 — Local durability and replay at load

**Now.** Nothing persists locally. A crash or a tab close loses anything typed
since the last successful store.

**Wanted.**

- `y-indexeddb`, so typing is durable the moment it happens.
- On page load, the client sends its outbox **and** Yjs updates for documents it
  knows are dirty — not every document. Most loads carry nothing.
- The server forwards those updates into the rooms and sets `base` from the
  resulting version. Forwarding is a passthrough; idempotency makes it safe
  whatever else is arriving.
- **Order within the load transaction:** adjudicate the outbox, then replay
  document updates, then set `base`. Replay is additive and idempotent, so this
  order is safe and the reverse is not.

**Note.** There are now **two** sync events — local store and remote room — and
"the document is empty" is only a fact after both.

**Confirm.**
- Type with the room connection down, close the tab, reopen → the work is there.
- Then let it reach the second browser after the first reloads. A reload is a
  way *out* of being ahead.
- Kill the tab mid-typing (not a clean close) and reopen.
- Confirm payload size: a clean session's load carries no document updates.

---

## Step 6 — Two tabs

**Now.** Untested and unreasoned-about. It probably works.

**Wanted.** Two tabs of one browser behave exactly as two separate clients.
Nothing assumes it is the only client on this machine — in particular, **nothing
may assume an entry in the local outbox was written by the tab that finds it**,
since local storage is shared per origin.

**Confirm.** Run the paired scenarios with two tabs of one browser in place of
two browsers. They should pass unchanged. Add one that is specifically about the
shared outbox: tab A queues a write, tab B loads and adjudicates, and neither
loses nor double-submits it.

---

## Step 7 — Standing down without losing work

**Now.** When a file becomes binary the room stands down. Whatever was typed and
not stored is simply gone from the file's perspective.

**Wanted.** Before standing down — for a file becoming binary *or* being deleted
— every client with the room open **writes a draft of its current text**. Then
the room stands down and the editor becomes a preview, with a restore
affordance. Multiple clients produce multiple drafts, deduped by digest.

**Confirm.** Extend the existing binary scenario: the client that had it open
asserts a draft exists whose content is what it was showing. Add the deletion
case, which has no coverage at all today.

---

## Order and dependencies

```
0  dropped stream event        independent — do first
1  stop diffing client work    independent — the big one
2  server owns rooms + base    needs 1 (or lands behind a flag with it)
3  drafts                      independent of 1 and 2
4  client declares sync state  needs 3
5  local durability + replay   needs 2 and 4
6  two tabs                    needs 5
7  stand down with a draft     needs 3
```

Steps 0, 1 and 3 can proceed in parallel; they touch different layers.

## What is gone when this is done

The verdict machinery and both of its timers; the client-side seeding election;
the repair-by-diff path; most of `rooms.ts`; and *"a held store is never
retried"*, which stops being a problem rather than getting a fix.

`speaking` survives, as the rule that decides draft from current.

## How we will know the whole thing works

Not by the steps passing individually, but by these holding together:

1. **No edit is ever applied twice.** Every scenario asserts its text appears
   exactly once. This is the invariant to be ruthless about — doubling reads as
   corruption in a way that a delay or a stale view never does.
2. **No store is ever refused.** Everything lands somewhere.
3. **Nothing typed is ever unrecoverable**, including through a crash, a
   deletion, a file turning binary, and a machine that never comes back.
4. **Every scenario in `SCENARIOS.md` has a test or an explicit note saying why
   it does not.** Several — E5, H2, D3 — have neither today.
