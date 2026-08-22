# Audit

Two questions: does this handle the scenarios it says it does, and will the
backend stand up on the hardware it has to run on. Both answered with
measurements rather than reasoning where measuring was possible.

Everything below was run against the sample stack on 2026-08-22.

---

## 1. The scenarios

`SCENARIOS.md` enumerates every state two clients and a server can be in.
Every row is either covered by a browser scenario or named here as uncovered.

### Covered, and how

| group | what it is | covered by |
|---|---|---|
| A1–A4 | both live, both typing, both storing | scenarios 1, 4 |
| B1, B2 | one client loses the room | 6 |
| B4, B5 | one client loses everything | 10 |
| C1, C2 | both lose the room | 5, 7 |
| D1 | clean handover between sessions | 2 |
| D2 | the morning/afternoon merge | 14 |
| D3 | shared but never stored | 13 |
| D4 | repeated separate sessions | 5, 7, 14 |
| D6 | returning to a file that is gone | 12 |
| E1–E4 | reload, crash, close | 10 |
| E5 | two tabs | 11 |
| E6 | reloading gets you out of being ahead | 10 |
| F1, F2 | a script writes text | 3 |
| F4 | a script writes bytes | 8 |
| G1–G5 | room lifecycle, seeding, eviction | the keeper's tests, and every scenario's first open |
| H1 | renamed while open | 15 |
| H2 | deleted while open | 12 |
| H3 | became binary | 8 |
| J1–J9 | the draft lifecycle | 6, and `tests/drafts.py` |
| K1–K6 | writes that were never in an editor | 3, 8, 12 |

And **B3 from the reachable side** — a client that can reach the host but not
the collaboration server — is scenario 16, which was not in the original
enumeration because the answer to it did not exist yet.

**Every scenario also asks the second question**: can this client still be
handed what it was looking at. Snapshots are taken mid-scenario, including
while a client can reach nobody, and every one is rebuilt from the server at
the end.

### Not covered

Three, and none of them can lose or duplicate work.

- **B3 from the other side** — a client that loses the SERVER and keeps the
  room. Simulating it needs a switch on the transport that does not exist.
  What it would show is already known: the client cannot store, its work
  reaches the others through the room, and their next store carries it.
- **F5 / H4** — a snapshot restored over a file somebody has open. It takes
  the same path as a script's write, which scenario 3 covers, but the restore
  itself is untested.
- **F3** — a client with a document writing without joining the room. The
  design requires it not to; nothing enforces it. Worth a guard, not just a
  convention.

### Where the design is genuinely weak

**A room with nobody in it cannot be told anything.** `solo()`, the fake used
by the sample shell, never acknowledges an update, so a provider over it
reports itself as still synchronizing and the client correctly refuses to
write the file back. Two sample-shell tests assert typing reaches the server
and therefore fail. This is a test-double limitation, not a product one, but
it means the shell a user actually touches has two of its eighteen behaviours
unproven.

**Draft retention is unbounded.** Kept forever by design, chained by
`predecessor` so a long offline session stores only what was typed since. No
supersession within one client's lineage, no digest dedup.

**A migration that is not additive still needs a person.** `widen` adds
columns and refuses everything else, loudly, at startup.

---

## 2. The backend, on the hardware it has to run on

Target: 4GB, a handful of cores, also serving a static frontend and streaming
LLM responses. At least 200 connected clients.

Measured against the sample stack. **The numbers below were taken on a machine
with 8 cores and 40GB, so read the CPU and memory figures as ratios rather
than absolutes** — the point is that both are one to two orders of magnitude
below the budget, which survives a much smaller machine.

### 200 clients connected at once

| | |
|---|---|
| streams opened | **200 of 200 in 3.0s** |
| backend CPU while all 200 held, 50 of them writing | **0.94%** |
| backend memory, same | **102 MiB** |

**It is not CPU-bound and it is not memory-bound.** At roughly 0.5 MiB per
connected client, 200 clients cost about a tenth of a gigabyte, and the
process was effectively idle. The headroom for the LLM streams and the static
frontend is the whole machine.

### What a save costs, under that load

| shape | p50 | p95 | p99 |
|---|---|---|---|
| 200 clients over 20 workspaces, 20 writing | 93 ms | 280 ms | 292 ms |
| 200 clients in ONE workspace, 50 writing | 23 ms | 721 ms | 885 ms |
| one writer, no load (baseline) | 17 ms | — | — |

**The tail is queueing, not work.** Writes to one workspace are serialised on
purpose — one process per workspace is the invariant the controller rests on —
so fifty people saving into the same workspace at the same instant wait for
each other. That is the design working, and the p50 of 23ms shows the queue
draining fast. Spread over twenty workspaces the tail is a third of that.

Fifty simultaneous savers in a single workspace is well past a realistic peak:
saves are debounced at 500ms idle, so it means fifty people typing
continuously into one project.

### Large files do not block the server

| file | create | edit in the middle | worst unrelated request during that write |
|---|---|---|---|
| 64 KB | 19 ms | 13 ms | 3 ms |
| 256 KB | 45 ms | 17 ms | 14 ms |
| 1 MB | 90 ms | 41 ms | 9 ms |

This was the risk worth checking on a single-process async server: a CPU-heavy
diff would stall every other request on the loop. It does not — a megabyte
edits in 41ms and unrelated requests are served in single-digit milliseconds
while it happens.

### What it costs to run the collaboration server

This was the specific worry, and it was justified before the change:
`base` — which stored version a room's text descends from — lived in the shared
document, and advancing it is a write. **Every save cost a read and a write to
Liveblocks for every client that heard about it.** At 200 clients that is 400
round trips per save.

The document now holds the text and nothing else. Where it stands is
bookkeeping the host keeps for itself, and the client that saves tells the
host directly.

| what happens | calls to the collaboration server |
|---|---|
| a client saves | **0** |
| every other client hears about it and settles | **0** |
| a file is opened whose room is already warm | **0** |
| a file is opened for the first time ever | 3 — create, read, fill |
| a script writes a file somebody has open | 2 — read, carry |
| a cut-off client relays through the host | 1 |

Measured: a settle on a warm room takes **11–28 ms** and touches nothing; 50
settles after a member's save cost **zero** additional reads
(`tests/keeper.py`). A cold room costs **1.7–2.3 s** across three sequential
calls, once per file ever.

`create_room` really is required before a room can be written — verified by
trying without it and getting `ROOM_NOT_FOUND`.

### The one thing to fix before this is fast enough to feel right

**A file's first open costs 1.7–2.3 seconds**, and the user waits for it: the
editor cannot bind until the room holds the file, or it would show an empty
document and then save that over the real one.

The fix is not to make the calls faster, it is to make them earlier. **Fill
the room when the file is CREATED** rather than when it is first opened —
nobody is waiting then, and by the time anyone opens it the settle is the
11ms path. Files that predate this, or were made by a script, still pay on
first open.

That is the single highest-value performance change left, and it is not built.

### Scaling past one machine

The controller keeps stream positions in memory and serialises writes per
workspace, so **exactly one process may own a workspace at a time**. The code
refuses to start without an explicit acknowledgement of that
(`refuse_to_split_the_brain`).

The sample runs one uvicorn worker for everything. On these numbers that is
ample for 200 clients, but it is one process: to use more cores, shard by
workspace across processes with a sticky router, which is what the invariant
already permits. Nothing needs to change in the code to do it.

The room-standing cache is per-process and in memory, so a restart costs one
extra read per room the first time it is asked about, and nothing after.

---

## Verdict

**Scenarios: yes**, with three uncovered cases named above, none of which can
lose or duplicate work, and two sample-shell behaviours unproven because the
test double cannot provide what they assert.

**Backend: comfortably.** Two hundred clients cost about 0.1 GB and
essentially no CPU; saves are tens of milliseconds and the tail is queueing
that only appears well past a realistic peak. The collaboration server is
touched once per file per lifetime and not at all on the paths that repeat.

The honest caveat is the one above: opening a file for the first time takes
about two seconds, and that is a felt delay rather than a throughput problem.
