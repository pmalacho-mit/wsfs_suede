# Workspace Filesystem & Sync Architecture

A browser-based, collaborative filesystem backing a Python-in-the-browser
platform. Design goals, in priority order: **a user never loses work** (and
when loss is possible, it is surfaced, never silent); robust to momentary
network lapses; live collaborative editing of text; efficient storage of both
text and binary content; boring, auditable failure recovery.

This document is the map: every system at play, the vocabulary, the state
machines, the flows, and the invariants that hold it together. The
authoritative wire contract lives in `filesystem-sync-contract.ts`; the
client reference implementation sketch in `workspace-fs.ts`.

---

## 1. The two planes

The single largest architectural fact: there are **two sync planes**, and
they are deliberately kept apart.

**The collaboration plane (yjs / Liveblocks).** Character-level, multi-writer,
CRDT-merged live editing of open text files. One `Y.Doc` per open file, one
Liveblocks room per open file, persisted locally via y-indexeddb, attached
lazily (refcounted) only while an editor holds the file open. CRDTs are used
here and *only* here, because this is the only place writes are genuinely
concurrent and peer-shaped.

**The authority plane (this protocol).** Server-authoritative,
single-ordered-stream sync of the tree (names, parents, deletions) and of
content commits. Postgres is the source of truth; clients submit transactions,
the server adjudicates them, and all state flows to clients through exactly
one ordered channel.

The planes meet at exactly two seams, and the design's health depends on the
seam staying this thin:

1. The **read flow priority** (§6.1): a live yjs doc outranks everything.
2. The **write-failure policy**: a content-write failure is ignored when a
   live editor is open, because the doc is the truth there.

---

## 2. Vocabulary

**Entry** — a node in the tree: `{id, version, name, parent?, deleted?}`,
type `file` or `folder`. Metadata is deliberately *pure namespace*: it carries
no content descriptor. Server-assigned ids; clients never mint entry ids.

**Version** — an opaque id naming one state of an entry. Comparable by
*equality only*; it is a CAS (Central Authentication Service) token, not a counter. Every stream event carries
the entry's new version, which is what the client must present on its next
mutation of that entry.

**Content plane** — kind (`text` | `binary`), mime, size, hash. Revealed by
`Content` fetches, cached client-side per entry id, invalidated by stream
signals. Never present in entry metadata.

**Blob** — immutable bytes named by their sha256 hash. Content-addressing
gives dedup, integrity checking, free retry-idempotency, and "old versions
cost only distinct bytes."

**Transaction** — one client-initiated mutation, identified by
`${client}:${counter}`. Globally unique (client is a GUID), and
order-encoding (counter is strictly increasing per client).

**Client** — one browser tab's instance of the system, identified by a GUID
minted at page load. One client = one transaction counter = one outbox queue
= one sync loop.

**Session** — a GUID minted per page load, stamped on outbox entries and
drafts to distinguish "this session already rendered this optimistically"
from "survived a reload, definitely not reflected in the UI."

**Position** — the server-internal, per-workspace, monotonic stream position.
Orders the event stream and anchors tokens. *Never client-visible.*

**Token** — a single-use, ~60s-TTL credential minted by `Initialize`, bound
to `{user, workspace, position}`. Connecting the stream claims it atomically;
the stream replays events after its position before going live.

**Draft** — parked content with no server-side home: an intent
(`create` at a path / `write` to a now-deleted entry) plus a hash pointer to
bytes. Carries no version, cannot conflict, lives outside the sync machinery.

---

## 3. System inventory

### Client-side

**Confirmed map** (memory) — `Map<id, Entry.Metadata>`; the client's replica
of server truth. Mutated *only* by `Initialize` snapshots (replace-all) and
stream events. Never by request responses.

**Outbox** (IndexedDB) — the persistent queue of in-flight/offline
transactions, keyed `user → workspace → client → ordered list`. Plus a
content-addressed bytes store (hash → bytes) holding write/store payloads so
the queue itself stays rows-of-pointers.

**Effective view** (derived, never stored) —
`effective(id) = outbox.replayOver(confirmed)`. What the UI and the Pyodide
filesystem actually read. Optimistic updates are *derived*, not applied;
failure rollback is recomputation, not an operation.

**Content cache** (IndexedDB) — per-entry-id cache of `Content` responses
(bytes + kind/mime/size + version). Invalidated by `write`/`delete` stream
signals. Blob-kind bytes are additionally cacheable by hash, forever.

**Drafts store** (IndexedDB) — the parking lot (§5.3).

**Yjs doc registry** (memory + y-indexeddb) — refcounted `Y.Doc` +
Liveblocks room per *open* text file; "detach" means leave the room, never
forget unsynced work (teardown waits for flush).

**Sync loop** — one per client per workspace; the single driver of
Initialize → evict/replace → stream → backoff → repeat (§6.4).

**Pyodide bridge** — the sync-over-async seam: the worker's synchronous FS
calls are served by the main thread against the effective view + content
cache, with hard deadlines so a hung fetch can never wedge the
Atomics-blocked worker.

### Server-side

**Postgres, tables of record** — entries + hierarchy (your
`FileSystem`/`FileHierarchy` schema), per-entry version history, and:

- **Transaction record** — one table, three roles: audit log, dedup table,
  and the answer source for `Initialize`'s `applied`/`rejected`. Payloads
  content-addressed. Retention must exceed maximum tolerated client offline
  age; older presented transactions are answered "cannot reconcile", never
  guessed.
- **Event buffer** — stream events by position. Retention: *minutes* —
  resume never spans more than the Initialize→connect gap plus blips.
- **Token table** — `{token, user, workspace, position, expires}`, claimed
  by `DELETE ... RETURNING` on stream connect.

**The choke point** — the one code path every mutation flows through:
apply mutation → bump position → write transaction record + event row, all
in one database transaction, serialized per workspace by the controller.
The event log is generated *from* the truth, so it cannot drift from it.
(The row lock on the workspace stays as split-brain insurance.)

**Workspace controller + registry** — one controller per workspace per
process (the actor pattern). All writes — transactional requests AND
Initialize — flow through its serialized `submit()`, which fans committed
events out to subscribed streams after commit. Initialize's one-consistent-
view guarantee comes from this exclusion, not isolation levels. Reads
(Content, blobs) bypass it. Lifecycle: streams refcount it, mutations are
transient visitors, release is grace-delayed (~30s) so reconnect churn
doesn't thrash it, and one registry lock guards get-or-create AND release
(re-checking the count inside the lock) against the release/acquire race.
Controller memory is rebuildable-from-zero: Postgres remains the truth.

**SSE handler** — claim token → subscribe → replay events after the token's
position → follow live, with comment heartbeats (~15s).

**Blob store** — object storage keyed by hash; `PUT /blobs/{hash}` verifies
the hash and no-ops on duplicates.

### Third-party

**Liveblocks** — rooms, yjs sync protocol, presence — for open text files
only. Its footprint in the system is exactly the multi-writer surface.

---

## 4. State machines

### 4.1 Transaction lifecycle

| State | Meaning | Transitions out |
|---|---|---|
| **captured** | Persisted to outbox *before* the request is sent | → in-flight (sent) |
| **in-flight** | Sent, no response yet | → applied / rejected (response or stream echo or Initialize verdict); → captured (timeout: remains queued) |
| **applied** | Server committed it | → evicted (confirmed change and overlay removal cancel exactly; no flicker) |
| **rejected** | Typed failure | → evicted, routed to failure policy (§7); content-bearing rejections may also → draft |
| **evicted** | Removed from outbox | terminal |

Eviction triggers, any one suffices: response received; own transaction id
echoed on the stream; reported in `Initialize.applied`/`rejected`.

### 4.2 Entry lifecycle

| State | Meaning | Transitions |
|---|---|---|
| **absent** | No such id | → live (Create; the ack yields the id — identity, not state; the entry enters the confirmed map only via the stream's `create` event) |
| **live** | In the tree | → live (rename / reparent / write, each advancing `version`); → tombstoned (delete) |
| **tombstoned** | `deleted: true`; remains in snapshots | terminal (a "restore" is a fresh Create) |

Tombstones are load-bearing: reconciliation cannot distinguish "deleted"
from "unchanged" without them.

### 4.3 Draft lifecycle

| State | Meaning | Transitions |
|---|---|---|
| **parked** | Intent + hash pointer persisted (always *before* the error is raised to the caller) | → recovering (user accepts, online) / dismissed (explicit) |
| **recovering** | Replaying Create → Store → Write online | → evicted (success) / parked (failure — never silently dropped) |
| **dismissed / evicted** | User chose, or recovery succeeded | terminal |

### 4.4 Sync-loop connection states

| State | Meaning | Enters via | Leaves via |
|---|---|---|---|
| **cold** | No confirmed state | page load | cached (IDB tree loads) or live (Initialize succeeds) |
| **cached** | Serving last-known-good; possibly stale | stream failure, offline start | live (loop re-enters successfully) |
| **live** | Snapshot applied, stream established, heartbeats flowing | successful cycle | cached (error event or watchdog expiry) |
| **degraded** | Acks succeed but stream can't establish (proxy eats SSE) | watchdog + successful POSTs | live (stream recovers); loop degrades into polling meanwhile |

Cold start, reconnect, and recovery are the *same* path: every disruption
re-enters the loop at Initialize.

### 4.5 Yjs doc lifecycle (per text file, per client)

closed → **attaching** (y-indexeddb loads first — instant local state — then
the room connects; CRDT merge reconciles) → **open** (refcounted) →
**flushing** (last reference released while unsynced changes exist: stay in
the room until the server has everything) → **closed** (local state kept as
warm cache) or **evicted** (file deleted: local state wiped, so stale CRDT
state can never resurrect).

---

## 5. Content model

Content is per-version and typed at write time: a `Write` is `text`
(inline string) or `binary` (hash + size + mime, bytes previously `Store`d).
A write of the other type *is* the kind transition — there is no separate
transition machinery in this design; the next `Content` fetch reveals the
new kind and the client re-routes accordingly.

Reads route on the *cached* kind; the `write` stream signal invalidates both
content and kind, so a stale route self-corrects on the next fetch. Offline
with a cold cache, kind is honestly UNKNOWN and the UI says so.

Live-editability is a client-side determination (text kind + within size
budget + editor opened), not a server-side state.

---

## 6. Data flows

### 6.1 Read (`readFile`, called by the Pyodide bridge or a viewer)

1. Live yjs doc open for this file on this client → serve the doc.
2. Content open in an *active* non-yjs editor (visible/dirty this session,
   not merely mounted) → serve that buffer.
3. Content cache hit for this id → serve it.
4. Fetch `Content` (deadline-bounded), populate cache, serve.
5. Offline/failed → clean filesystem error through the bridge. Never a hang.

### 6.2 Write (`writeFile`)

Route on cached kind. Text + live doc → apply as a minimal yjs diff (one
delete + one insert around the common prefix/suffix) so concurrent human
edits merge instead of being clobbered. Otherwise → capture transaction to
outbox → (binary: `Store` bytes by hash first) → submit `Write` with the
entry's current version (CAS). Failure routes per §7.

### 6.3 Create (online-only)

Send `Create` → ack returns the server-assigned id → dependent operations may
proceed against that id → the stream's `create` event populates the confirmed
map. Lost ack: retry with the *same* transaction id (the server dedupes —
this is the one place a duplicate would mint a duplicate entry). Offline: the
call fails loudly and any content parks as a draft.

### 6.4 The sync loop

```
loop:
  POST Initialize(workspace, outbox transaction ids)
    → server, in ONE repeatable-read transaction: adjudicate outbox in
      order (unseen ones applied now), snapshot entries, read position,
      mint token
  evict applied/rejected; replace confirmed map   // same server tx → no gap, no flicker
  connect EventSource with token                   // single-use; claims atomically
    → server replays events after token.position, then follows live
  consume events until error / watchdog expiry
  jittered exponential backoff (reset only on an established stream); re-enter
```

Never rely on EventSource auto-reconnect (it replays a spent token). Also
re-enter on `visibilitychange`-to-visible and `online` — Initialize with an
empty outbox is a cheap no-op.

### 6.5 Blob transfer

Upload: `PUT /blobs/{hash}` with raw bytes; server verifies sha256; duplicate
hash → immediate ack (retry-safe by construction). Download: raw bytes with
`Content-Type` and `ETag: {version}` (or redirect to object storage).

---

## 7. Failure policy (client's decision, by design)

| Failure | Policy |
|---|---|
| Content write conflict, live editor open | Ignore — the yjs doc is the truth; all text mutations flow through it |
| Text write conflict, no live editor | Diff editor: fetch `Content` at the conflicting version for the other side |
| Write to a deleted entry | Evict transaction; park content as a draft |
| Create offline | Fail loudly; park content as a draft; UI disables creation while disconnected |
| Move / rename / delete rejected | Evict; effective view snaps back automatically |
| Store hash mismatch / too large | Surface; do not retry blindly (the bytes are wrong or oversized, not the network) |
| Content fetch offline, cold cache | Clean filesystem error (deadline-bounded), never a wedge |

---

## 8. Invariants — the rules that must never be broken

1. **One door for state.** The confirmed map changes only via Initialize
   snapshots and stream events. Responses only adjudicate the outbox. The
   sole exception is Create's ack carrying the new *id* — identity, not
   state.
2. **Initialize is one database transaction.** Adjudication, snapshot, and
   token position together, or the no-flicker/no-gap guarantees silently die.
   Do not let anyone "optimize" it apart.
3. **Event log generated from the truth.** Position bump, mutation,
   transaction record, and event row commit atomically at the choke point.
   There is no publish step that can fail independently.
4. **Capture before send; park before raise.** A transaction is persisted to
   the outbox before its request is sent; a draft is persisted before the
   error is returned to the caller. Ordering is what saves the bytes.
5. **Order is sacred in the outbox.** Counter order in, counter order out;
   coalescing is per-entry, writes-only, boring, and unit-tested.
6. **Versions are equality-only CAS tokens.** No client-side "newer than"
   reasoning exists; staleness is resolved by re-entering the loop.
7. **Detach never discards.** A yjs doc with unsynced changes stays attached
   in the background until flushed; eviction (deletion) is the only path
   that wipes, and it always wipes.
8. **Deadlines everywhere the worker blocks.** A hung network call surfaces
   as a filesystem error; the Atomics-blocked kernel never wedges.
9. **Conflicts are never silent.** Rejected work is surfaced (diff, snap-back,
   draft); concurrent blob commits fail CAS rather than last-write-wins.
10. **Blobs are immutable; hashes are forever.** A cached blob by hash can
    never be wrong — only pointers go stale.
11. **One process per workspace.** "One controller per workspace" is only
    true within a process: exactly one process may serve a workspace's
    writes and streams. This is the first invariant a deployment engineer
    can violate without touching code (`--workers 4`, an autoscaler's
    max-instances > 1). Guard it: pin instances to one, keep the row lock
    as split-brain insurance, add the per-workspace advisory lock so a
    second instance fails loudly — and treat a cross-process bus behind
    the controllers as the upgrade path when scale demands it.

---

## 9. The honest accounting

| Concern | Count |
|---|---|
| Request types | 7 (Create, Delete, Rename, Reparent, Store, Write, Content) + Initialize |
| Stream event types | 5 (create, write, delete, name, parent) |
| Client loops | 1 per client per workspace |
| Server tables beyond the domain schema | 3 (transactions, event buffer, tokens) |
| Client persistent stores | 4 (outbox + bytes-by-hash, content cache, drafts, y-indexeddb per open doc) |
| Derived client state | 2 (confirmed map, effective view) |
| Third-party dependencies in the sync core | 0 (Liveblocks serves only the collaboration plane) |
| Seams between the two planes | 2 (read-flow priority; live-editor write policy) |

Everything in the sync core survives the subtraction test: remove any piece
and a named goal breaks (outbox → lost work; CAS → silently destroyed
collaborators' work; one-door → response/stream races; Initialize → stranded
outboxes; token position → silent stream gaps; drafts → your Pyodide
offline-create example loses its bytes).

## 10. Deliberately not built (yet)

- **Multi-tab leader election.** Multiple tabs are *correct* today (one
  client each, converging via the stream, server dedup by transaction id) —
  just wasteful. Web Locks election + BroadcastChannel fan-out is a
  contained optimization. Orphaned outbox queues are already adoptable.
- **A precise definition of "active" for non-yjs editor buffers** — a
  product decision (visible? dirty? this session?) pending real UX.
- **Stream resume via cursor.** The single-use-token design makes every
  reconnect a fresh snapshot. If resnapshot-per-blip ever gets expensive
  (mobile), a resume cursor can be added server-side without breaking this
  contract.
- **Kind-transition automation** (size-based demotion of huge text files
  from live editability) — the content model (§5) already accommodates it;
  the trigger machinery can come later.

The design is at the stage where the threat is no longer a flaw in it, but
feature pressure gradually un-simplifying it. Each addition should be asked
the same question this document answers: which goal breaks without you?
