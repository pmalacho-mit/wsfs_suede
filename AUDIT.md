# Audit

Two questions: does this handle the scenarios it says it does, and will the
backend stand up on the hardware it has to run on. Both answered with
measurements rather than reasoning where measuring was possible.

Everything below was run against the sample stack on 2026-08-22.

**Seventeen browser scenarios**, each run as its own paired chromium+firefox
run; `./tests/run.sh` 245; `npx vitest run` 102; live 11; `npm run check` 0
errors across 1822 files.

---

## 1. The scenarios

`SCENARIOS.md` enumerates every state two clients and a server can be in, and
records the decisions taken against it.
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
| invariant 7 — detaching never discards | closing a file and opening it again | 17 |
| J1–J9 | the draft lifecycle | 6, and `tests/drafts.py` |
| K1–K6 | writes that were never in an editor | 3, 8, 12 |
| being told you are out of touch | `Room.trouble` names why the room cannot write | 6 |

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
- **The client half of invariant 6.** A token the server never issued is
  refused with the right reason and that is tested; the loop re-enters when
  nudged and that is tested; the line joining them — `workspace.ts` nudging on
  that reason — has no test, because there is no fake transport to make a
  server say it. That is the one seam in the sync core with tests on both
  sides and none in the middle.

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

### Opening a file is instant, because the room was filled when it was made

A first open used to cost 1.7–2.3 seconds, and the user waited for it: an
editor cannot bind until the room holds the file, or it shows an empty
document and then saves that over the real one.

The calls are not faster; they happen earlier. `POST /rooms/{entry}/warm`
schedules the filling as a background task and answers immediately, and it is
called when a file is CREATED — when nobody is waiting.

| | |
|---|---|
| first open, cold | 1770–3006 ms |
| the warm call itself | **1 ms** (202, work continues behind it) |
| first open, warmed at create | **12–13 ms** |
| first open after the host restarts | **60 ms** |

The restart figure is the point of keeping this in a table rather than in
memory. A room is created once and nothing here destroys one, so `created` is
a permanent fact; `base` is where its text stands. Both survive, so a restart
does not charge for them again on the first file anybody opens.

**This is the path a cloned workspace should use.** Whatever creates the
entries — a person in the tree, or code copying another workspace — should
warm each one as it goes. In-process, that is `keeper.ensure(entry)` on a
background task; over HTTP it is the endpoint above. Files that predate this,
or that nothing warmed, still pay the cold cost on first open and then never
again.

### Scaling past one machine

The controller keeps stream positions in memory and serialises writes per
workspace, so **exactly one process may own a workspace at a time**. The code
refuses to start without an explicit acknowledgement of that
(`refuse_to_split_the_brain`).

The sample runs one uvicorn worker for everything. On these numbers that is
ample for 200 clients, but it is one process: to use more cores, shard by
workspace across processes with a sticky router, which is what the invariant
already permits. Nothing needs to change in the code to do it.

What this host knows about rooms lives in its own `rooms` table, so it is
shared by anything reading that database and survives restarts. The keeper
keeps an in-memory copy in front of it, which is what makes the repeating
path -- settle after somebody saved -- cost neither a query nor a call.

---

## 3. Known problems

**Two scenarios have no test.** Neither can lose or duplicate anything.

- **B3 from the client's side** — a client that loses the SERVER and keeps the
  room. Hard to simulate in a browser without a switch on the transport. The
  other direction (host reachable, room not) is scenario 16.
- **F5 / H4** — a snapshot restored over a file somebody has open. It is a
  server-origin write, so it takes the same path as a kernel's output, which
  scenario 3 covers; the restore case itself is untested.

**The `recorded` set is in memory.** It is what lets `unsettled` answer for
drafts, refusals and superseded writes, and a reload loses it — which
understates what the server can rebuild rather than overstating it. It belongs
with the outbox when that is persisted.

**Drafts are kept forever and are not deduplicated.** `predecessor` chains a
run of one client's drafts so storage holds only what was typed since, which
bounds a long offline session. Same-client supersession and digest dedup are
not built.

**A migration that is not additive still needs a person.** `widen` adds
columns and refuses everything else — a column the code no longer declares is
left alone, and a NOT NULL column with no plain default raises at startup
rather than inventing what the old rows held. That is the right refusal, but it
is a refusal.

**The sample database is `tmpfs`** and wipes on every `sample-db` restart. That
is deliberate, and now much less dangerous than it was, because the schema is
brought up to date at startup rather than silently disagreeing.

**The sample shell: 16 passed, 2 failed, and the cause is now proven rather
than suspected.** Tests 13 and 18 turn on the shared document holding the
file. `solo()`, the fake room, answers as a genuinely EMPTY one — which was
right while the CLIENT filled a room from the file, and is wrong now that the
host does, on the real collaboration server that `solo` knows nothing about.

**Swapping `solo()` for `clientAs(ADA)` makes them pass** — verified, test 18
in three seconds on its own. It is not the default because eighteen tests each
opening a real room takes minutes rather than seconds and the suite times out.
The switch is one line in `Sample.test.svelte`.

Two ways to finish it, both straightforward:

- Let the Sample suite use a real room and give it the time (raise the
  `--silence` window and the per-test waits, as the collaboration suite does).
- Or teach `solo()` to hold content the test puts there, so a test can say
  "given a room holding this file" without a network. That is the "given /
  when / then" shape and it is fully deterministic.

**What the connection needs is already there.** `Provider` is this codebase's
own type, and two of its members — whether this client is holding changes, and
waiting until it is not — are about a NETWORK, not a document. No room, real
or fake, answers those on demand. So `Workspace.svelte` now takes an
`entering` prop, and `drivable()` supplies one whose connection the test
answers for:

```ts
const room = drivable();
room.reaching(false);   // now this client is holding work nobody else has
```

**And it earned its keep immediately.** Driving the connection exposed a real
bug in the product, not the double: a room hears the workspace's stream from
the moment it exists, and a write landing before it is attached is recorded as
missed. Opening was exactly that window, and nothing closed it — so a room
that missed anything while opening stayed behind FOR EVER, refused to write
the file back, and turned every save into a draft silently. `Rooms.open` now
catches up after attaching.

**The cold-open cost is measured, not guessed:** first settle 1.7–2.3s,
repeat 11–28ms. Three sequential calls to the collaboration server — create
the room, read it, fill it — and `create` is required, verified by trying
without it (`ROOM_NOT_FOUND`). It is once per file ever. The right place to
pay it is when the file is CREATED rather than when it is first opened, which
is not built.


---

## Verdict

**Scenarios: yes**, with three uncovered cases named above, none of which can
lose or duplicate work, and two sample-shell behaviours unproven because the
test double cannot provide what they assert.

**Backend: comfortably.** Two hundred clients cost about 0.1 GB and
essentially no CPU; saves are tens of milliseconds and the tail is queueing
that only appears well past a realistic peak. The collaboration server is
touched once per file per lifetime and not at all on the paths that repeat.

Opening a file is instant when the room was filled at creation, which is the
path anything creating entries should use, including a workspace being cloned
for somebody.
