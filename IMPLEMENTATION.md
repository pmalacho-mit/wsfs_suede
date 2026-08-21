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

## Step 0 — The dropped stream event

**Independent of everything else, and still first**, because it is the only bug
in the current tree where a user loses something today.

**Now.** A write is accepted over HTTP — the response says not-rejected — and
its confirming stream event sometimes never arrives. The entry's
`content_version` never advances. Nothing retries and nothing notices, because a
dropped event is indistinguishable from a write that never happened. Observed
from both ends: the storing client's own write (scenario 9) and another
client's write (scenario 8).

**Wanted.** Either the event always arrives, or a client can detect the gap and
ask for it.

**Confirm.** Scenarios 8 and 9 in the browser suite pass 10 runs out of 10.
They currently pass 4/6 and 3/6.

> Do not skip this on the grounds that the redesign changes the write path. The
> redesign makes the stream *less* load-bearing but does not remove it, and an
> unreliable feed under a new protocol is harder to debug, not easier.

---

## Step 1 — Stop diffing client work

The highest-value change in the plan, available now, and independent of drafts,
persistence and the server work.

**Now.** When a client hears that an entry it has open moved to a version its
room did not produce, it fetches that entry's text at two versions, diffs them,
and types the difference into its own document. Each client does this
independently. Typing text into a Yjs document creates new characters, so when
the original author's edits arrive over the room channel carrying their own
identity, both copies survive.

**Wanted.** Clients stop reacting to content changes for entries they have open.
Content authored in a document reaches other documents only as Yjs updates.

**Delete.** The verdict/repair path in `room.svelte.ts` — hearing a stream event
for an open entry, confirming a verdict against the file, and mending by diff.
With it goes `#settling` and the seeding timer's correctness role, and most of
`rooms.ts` (`emitting`, `refused`, `carried`, `opening`). `speaking` stays.

**Confirm.**
- Scenario 3 (*notices when somebody writes around the room*) still passes —
  after step 2 it is the server carrying it, so run these two together if step 1
  lands first behind a flag.
- **Scenario 6 passes with the 600ms timers removed.** This is the real proof:
  it is the test that caught the doubling, and it must go green because the
  transport changed, not because a wait got longer.
- A new scenario: both browsers hold a file open, a third party writes text to
  it, and each browser asserts the new text appears **exactly once** and that it
  recorded no repair of its own.
- Run each scenario 5 times. This class of bug is intermittent by nature.

---

## Step 2 — The server owns rooms and `base`

**Now.** No room is ever created server-side. Clients elect a seeder among
themselves with a 600ms convergence wait, and clients write `base` into the
shared document. The backend talks to Liveblocks only to mint a token, by hand,
with `httpx`.

**Wanted.**

- A `room` table: one row per entry, recording that its Liveblocks room has been
  created. One `create_room(idempotent=True)` per entry, ever — the table is a
  cache of *creation*, never of content.
- `ensure_room(entry)` — idempotent, under a per-entry advisory lock:
  create if absent; if the room's document is empty, seed it with the file's
  text and `base`; if the room's recorded base is behind the entry's current
  version, carry the gap in. Called on file creation (the fast path — the user
  made the file, the server has the content) and on cold open.
- On every accepted write, the server sets `base` in the room. For a write that
  came from a room member it sets **only** `base` — the text is already there,
  and writing it again is the doubling bug.
- Adopt the Python SDK for both this and the existing token mint.

**Build with.** `pycrdt` 0.14.3 for constructing updates; verified installing
cleanly on ARM64 / Python 3.12 with a prebuilt wheel, and verified producing
updates that JS `yjs` reads correctly with the shared-type names the client
already uses. The Liveblocks Python SDK has `create_room`,
`get_yjs_document_as_binary_update` and `send_yjs_binary_update`.

**Delete.** The client-side seeding election, the claim slot, and the
`CONVERGING` wait.

**Confirm.**
- Open a file whose room has never existed → content appears with no client
  having seeded it.
- Delete the room through the Liveblocks API and reopen → self-heals.
- **Two browsers open a never-before-opened file at the same instant** → the
  content appears exactly once. This is the old concurrent-seeding double, and
  after this step it should be structurally impossible rather than raced.
- Change a file on the server while nobody has it open, then open it → the
  room reflects the change.

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

## Step 4 — The client declares its own sync state

**Now.** A client decides whether it may store from `attached && !behind`, plus a
600ms wait after reconnecting.

**Wanted.** A locally computed answer to *"could my work already have reached
anyone?"*, biased to no. If the room connection is down, or was down at any
point since the last checkpoint, the answer is no. The store carries that label.

The exact form is `Y.encodeStateAsUpdate(doc, roomStateVector)` being non-empty —
verified to separate *ahead* (32 bytes outstanding) from merely *behind* (2
bytes, an empty update) exactly. Check whether the provider exposes the remote
state vector from its last sync; if not, tracking connection state across edits
is sufficient for a conservative answer.

**Delete.** Both 600ms timers, for good.

**Confirm.**
- Scenario 6 passes with no timers anywhere.
- **No store is ever refused outright** — every store either lands as content or
  lands as a draft. Assert this across the whole suite.
- Deliberately mislabel in a test build: force a draft label while fully
  connected and confirm the only consequence is a redundant, promptly cleared
  row.

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
