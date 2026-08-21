# Where the collaboration work is, and what to pick up

Written across three sessions. The second ended with a large amount unverified,
because the docker runtime wedged before any of it could be run in a browser.
**The third session ran all of it.** The wedge turned out to have a mechanical
cause and is fixed; the four original scenarios still pass against the extracted
protocol; and the run found one real bug, which is written up as finding 5.

What is left unverified is now small and named, in *What is not verified*, and
the honest summary of the rest is the table in *Verified results*.

---

## Bringing the stack back up

```bash
docker compose -f samples/compose.yml down
docker compose -f samples/compose.yml up -d --build
npm install                                 # the ROOT one: vite.config needs it
cd samples/frontend && npm install && npm run dev
```

Both installs are needed from a fresh checkout. `samples/frontend/vite.config.ts`
imports the editor's build helper, which resolves out of the **checkout root's**
`node_modules` — without it `vite dev` dies with
`Cannot find package '@codingame/esbuild-import-meta-url-plugin'`, which reads
like a missing dependency of the sample and is not.

**The sample database is `tmpfs`.** It wipes on every `sample-db` restart, which
is deliberate — but see *the migration gap* below, because it bit once.

**`/rendezvous` is not reset for you.** Nothing in the suite calls
`DELETE /rendezvous`, so a re-run against a backend that is still up meets the
previous run's agreed workspace and entry ids and quietly tests nothing. Restart
`sample-backend`, or:

```bash
curl -X DELETE http://localhost:8099/rendezvous
```

**`git diff` hangs in this checkout.** `diff.external = difftastic` is
configured and does not return here, so a full patch blocks forever while
`git diff --stat` works fine. Use `git diff --no-ext-diff`. This cost real time
to work out, because it looks exactly like the wedge below.

### The docker wedge — found, and fixed

**It happened twice, and both times while the two browser-control containers
were being created at once.** That was not a coincidence and it was not bad
luck; it was the driver.

`generateReport` in `sweater-vest-suede/report/index.ts` prepared its browsers
with `await Promise.all(browsers.map(prepare))`, and `prepare` does not merely
start a container — **it builds the image**. So a two-browser run put two
`playwright install --with-deps` builds and then two `runc create`s in flight at
once, which is exactly the state the daemon died in. `prepare` is now a serial
loop, with the reasoning recorded beside it. **About twenty container creates
across the third session, no wedge.**

**The advice that used to be here — warm the containers one at a time so the
two-browser run can attach — was half wrong, and worth knowing why.** The
`finally` block removes both containers on every run, so `skipIfRunning` never
fires across invocations and a warmed container never survives. What warming
actually buys is the **image**, which is cached and is the expensive part. So
warming one browser at a time is still right for a first-ever run, and it is
the images you are protecting, not the containers.

**How to recognise it, if it ever comes back.** Every docker client hangs,
including `docker ps`, and `timeout` and `kill -9` do nothing to them — check
`ps` and you will see them in state **`D`**, uninterruptible sleep. `dockerd`
and `containerd` are both still alive; a raw `curl --unix-socket
/var/run/docker.sock http://localhost/_ping` hangs too, and that is the cheapest
endpoint there is. It is not resource exhaustion: disk and inodes were at 9% and
4%, and 34G of memory was free. Load average climbs anyway, because `D`-state
processes count towards it. **There is no recovery from inside the
devcontainer** — the daemon has to be restarted from outside.

**Still don't poll `docker ps` while a browser run is starting.** It tells you
nothing the run's own output does not, and each poll leaves another unkillable
process behind if the daemon is already gone.

**Don't pipe a run through `tail`.** `npm run test:browser ... | tail -80` shows
nothing at all until the run ends, so a run that hangs is indistinguishable from
a run that is working. Redirect to a file and read it.

### `--silence` is the flag you will actually need

**The default silence window is 120s, and it is too short for this suite.** The
window is time since *any* browser last said anything, and the report gives up
with `Report server timed out` — which reads exactly like a hang and is not one.
A single cascading failure can burn well over 120s of quiet, and that is how the
third session's first two full runs died having proved nothing.

```bash
npm run test:browser -- --component Shared --browser chromium --browser firefox --silence 180
```

### Run the scenarios one at a time

This is the single most useful change to how the suite is driven. The cascade
described under *Known problems* is real — one test dying desynchronises the
pair and the partner times out on a barrier a test later — and it makes a full
run's output nearly unreadable. `--test` takes a regex, and a paired single
scenario runs in **four to eight seconds**:

```bash
npm run test:browser -- --component Shared --test "holds a store" \
    --browser chromium --browser firefox --silence 180
```

`curl -X DELETE http://localhost:8099/rendezvous` between runs. Every result in
the table below was produced this way.

---

## What was built

### Backend — `samples/backend/app.py`

Two new routes on the sample host (not on `release/`):

- **`GET /liveblocks/token?rooms=...`** — mints a per-user Liveblocks token
  server-side from `LIVEBLOCKS_SECRET_KEY`. The secret never reaches a browser.
  Wired through `samples/compose.yml`, whose value is the placeholder the
  developer's proxy swaps on the way out.
- **`PUT|GET /rendezvous/{key}`, `DELETE /rendezvous`** — test scaffolding.
  Set-if-absent; first proposal wins and everybody gets it. This is the only
  channel the two browsers use to agree on anything, because every other channel
  between them is the thing under test. Entries age out after 600s; `DELETE`
  makes it deterministic and the suite calls it before each run.

`vite.config.ts` proxies both.

**Verified:** token endpoint returns a real 779-byte JWT through the proxy, from
the host and from inside the backend container.

### Frontend — `samples/frontend/src/lib/collab/`

- **`collaboration.ts`** — which browser this is (read off the report driver's
  `?reportServer=<url>/<browser>` param), which part it plays, and the
  rendezvous primitives. Chromium plays Ada, Firefox plays Grace. Two stable
  users only, for the MAU cap.
- **`room.svelte.ts`** — **the protocol itself, and the thing to read first.**
  One `Room` per file: the shared document, the provider under it, `Standing`
  kept in the document, the seeding election, confirming a verdict against the
  file, and the repair. `Rooms` is the per-workspace registry, with ONE stream
  subscription feeding every room.
- **`collaborator.ts`** — now a thin harness over `Rooms`: an identity to
  connect as, a network that can be taken away and given back, and the
  snapshot/reconstruction round trip. It no longer contains a protocol of its
  own.
- **`Reach.test.svelte`** — can a browser reach Liveblocks at all. Kept separate
  so that hop fails loudly and by itself rather than as nine timeouts.
- **`Shared.test.svelte`** — the scenarios.

**The second session's central move was extracting `room.svelte.ts`.** Before
it there were two implementations of the protocol: the one the suite proved and
a second, subtly different one inside `Workspace.svelte` — and the second was
the only one a user ever touched. They are now the same code, so the
two-browser suite proves what ships.

### Frontend — `Workspace.svelte`, wired at last

`SharedTextFile` is now built on a `Room`. What that changed:

- **Bound only after the document has arrived.** It used to assign
  `file.sourceSync` on the Liveblocks room saying `"connected"`, which is the
  SOCKET being up — a strictly earlier moment than the Yjs provider having the
  document. `MonacoBinding` makes the model say whatever the `Y.Text` says the
  instant it is constructed, so binding an unsynchronised document does not
  show an empty file, **it makes one**, and the next store writes that over the
  real content. `Rooms.open` does not resolve until synced *and* reconciled.
- **`put` refuses until the room is ready.** The `ready` check that was
  commented out in the door (with a note saying add it back if the design needs
  it) is back. It was right; what was missing was something that could answer
  it, and `Room.ready` — synced AND reconciled — is that.
- **`FileOverride.replaced` has a consumer.** Bytes over an open text file are
  TAKEN by the door, because taking them is the only way to learn the token the
  bytes landed at, which is what the room has to be told. The write still
  lands; the room stands down; `FileView` swaps the editor for the preview and
  says what happened.
- **`store` can answer that it did not.** See finding 4. A held write leaves
  the file `dirty`, which is exactly true.
- **Typing is wired to storing.** `dirty` was never set to `true` anywhere and
  `typingDebouncer` was armed nowhere, so nothing autosaved. `UserEdits.edited`
  now sets `dirty` and enqueues a debounced store — and it is `UserEdits`
  rather than `onDidChangeModelContent` precisely so a peer's keystroke
  arriving through y-monaco is not stored as this person's work.

### Release — `release/frontend/`

- **`rooms.ts`** — a fourth finding recorded in the docstring, and `speaking`
  added beside `settled`.
- **`workspace.ts`** — `at(entry, version)`: what one file held at one version.
  A reconciling consumer needs two of these at once, both older than anything
  it is showing, and `read` only answers for a file as it stands. Without it
  the component would have needed a transport plumbed through ten call sites.
- **`contract.ts`** — `Versions`, `Reconstructed`, `ReconstructionRequest`,
  `ReconstructionResponse` named, so the reconstruction round trip is typed
  from the generated schema rather than by hand.

### What the third session changed

Small, and all of it in service of running what was already there.

- **`room.svelte.ts`** — `#settling`, and `reattach` waiting before it
  reconciles. Finding 5. `send` grew a third `why`.
- **`sweater-vest-suede/report/index.ts`** — browsers are prepared **serially**.
  This is the docker wedge fix, and it is one line plus the reason for it.
- **`Shared.test.svelte`** — `until` takes an optional `seen()` and puts what it
  actually observed into the timeout message. Both intermittent scenarios were
  unreadable without it: "waited 30000ms for the stream to carry the store" says
  only that a condition stayed false, and `saw token=… wanted=…` is what turned
  that into a finding. Scenario 6's two final assertions now throw with the
  verdict log and the text attached, for the same reason.

## Verified results

All of the following was run in the third session, against the stack described
at the top of this file.

### The two-browser suite

Each scenario run as its own paired chromium+firefox run, per *Run the scenarios
one at a time*. Both browsers must pass for a row to be green.

| # | scenario | result |
|---|----------|--------|
| 1 | converges when both type into one open file | **pass** |
| 2 | shows a late joiner what was typed before they opened it | **pass** |
| 3 | notices when somebody writes around the room | **pass** |
| 4 | does not call it a conflict when both store from the same room | **pass** |
| 5 | merges an unnoticed lapse without doubling what was typed during it | **pass** |
| 6 | holds a store while the room is not reaching anybody | **pass** — 0/4 before finding 5 was fixed, 6/7 after |
| 7 | both lapse at once, both type, and both come back | **pass** |
| 8 | a write that is not text takes the file away from the room | **pass** |
| 9 | rebuilds what a client was looking at after the file has moved on | **pass** |

**The four original scenarios pass against the extracted protocol.** That was
the first question the second session left open, and the answer is that
`room.svelte.ts` is not a regression.

**Scenarios 5 and 7 pass, which is the offline-merge design working.** A member
can lose the room, type, and come back — alone or at the same time as the other
— and each line arrives exactly once.

**Scenario 6 is finding 4 observed rather than reasoned.** Ada detaches, types,
and *is* refused the store; she comes back and the store lands; `ada while away`
appears exactly once and no repair is recorded. It also found finding 5 on the
way — see below.

**All nine pass, in both browsers.** Scenarios 8 and 9 were intermittent (4/6
and 3/6) until the fourth session found what they had in common; see *The view
could be rewound by its own queued create* below. Each has since run 10 of 10.

### Everything else

- `./tests/run.sh` — **193 passed** in 97s.
- `npx vitest run` — **113 passed, 16 skipped**.
- `cd samples/frontend && npm run check` — **1821 files, 0 errors**, 20 warnings,
  all pre-existing and none in the collaboration code.
- `npm run test:browser -- --component Reach` — **2 passed** in chromium and
  **2 passed** in firefox, separately. A browser container mints a token through
  the proxy and opens a websocket to a real Liveblocks room.
- `GET /liveblocks/token` returns a real JWT from the host, with
  `X-User-Email` — which is **required**, and a request without it is a 422.
- `npm run test:browser -- --component Sample --browser chromium` —
  **15 passed, 3 failed**. See *The sample shell has three failures* below.

## What is not verified

Short now, and named.

- **`Workspace.svelte` in front of a real Liveblocks room.** Everything under
  *Workspace.svelte, wired at last* is exercised by `Sample`, which uses the
  `solo()` fake room — and in the third session three of those tests fail. The
  component has still never been driven against a real provider by anything
  other than a person.
- **The retry-a-held-store gap**, which is still unimplemented rather than
  unverified. See *Known problems*.
- **`Runner.test.svelte`**, recorded two sessions ago as mid-edit. `npm run
  check` reports 0 errors across 1821 files, so it is either fixed or outside
  the check's scope; still worth one look.

## Five findings

None of the first three would have shown up in one browser. The fourth would
not have shown up in one *session*. The fifth would not have shown up without
running the fourth's test.

**1. `Standing` has to be held in structures that merge.** `produced` started as
a list in one `Y.Map` slot, which is last-writer-wins. Two clients storing at the
same moment each wrote their own one-element list; one survived; the client whose
entry was lost then treated the other's write as a stranger's and asked for a
repair. Now it is a key per transaction. Recorded in `rooms.ts`.

**2. Concurrent seeding doubles the file.** "The document is empty" is true for
*both* clients opening together, and a CRDT merges two inserts rather than
noticing they say the same thing. Now claimed first and acted on second: one
last-writer-wins slot, a wait for the room to converge, and only the winner
writes. **The wait is a 600ms guess** (`CONVERGING` in `room.svelte.ts`) — it
wants to hang off an acknowledgement instead, and that is still the single
piece of this most worth replacing.

**3. A verdict is a hypothesis, not a fact.** The bookkeeping travels between
clients through the *shared document*; the write it is about travels through the
*server*; nothing orders those two. A member can be told a write landed before
being told its own room made it, and will call its own text a stranger's — and
repairing against text you already hold does not conflict, it duplicates. So
every non-`current` verdict is confirmed by reading the file at that token, and
nothing is done if the document already says it. Bookkeeping makes the common
case free; the comparison is what makes it correct. Recorded in `rooms.ts`.

Reading the file is also how a room finds out it is **over**: nothing in a token
says whether it names text or bytes, so that read is the first moment anybody
can know the file stopped being text. That is where `replaced` comes from.

**4. A room nobody can hear must not write around itself.** The second
session's finding, and the one hardest to reason your way to. A member that
loses the room keeps its document — that is what a CRDT is for — and it keeps
its connection to the *server* as well, so storing still works. It must not.
The text it would store is text the others have not been given, so they repair
towards it; then the lapse ends, the documents merge, and the same text arrives
a second time as edits nothing can deduplicate. Nobody did anything wrong and
the file says everything twice.

The rule is that the two channels are used together or not at all, and it has
two halves, because the trap has two directions:

- **A detached room does not act on the stream.** It records that it missed
  something and nothing else — not even advancing `base`, which is one
  last-writer-wins slot in a document that has not merged for a while, so a
  detached client's guess at it would win over what the room agreed while it
  was away.
- **A detached room does not write to the server.** `store` answers
  `{ held: true, why }` instead. Nothing is lost: the work stays in the
  document and goes when the room comes back.

On reattach the room asks `rooms.opening` once, which covers a lapse of any
length. Recorded in `rooms.ts`, expressed as `rooms.speaking`, and covered by
the scenario *holds a store while the room is not reaching anybody* — which
**has never been run**, so finding 4 is reasoned rather than observed. It is the
first thing to check when docker is back.

**5. Coming back is not the same as having been heard.** The third session's
finding, and the half of finding 4 that was missing.

Finding 4 says a room that cannot reach anybody must not write to the server.
True, and **not sufficient**. The symmetric case is the moment it comes *back*:
`provider.synced` is the provider saying **this client has received the room**,
and it says nothing whatever about whether the room has received this client.
A room that stored in that window sent, through the SERVER, text whose only
other copy was still in flight through the DOCUMENT. The others met a token
they had no bookkeeping for, carrying text they did not hold, and did the one
thing that is correct on the evidence available: they repaired towards it. Then
the merge landed and said the same thing again.

It is finding 4's own doubling, reached from the other direction, and by
exactly the members who did nothing wrong.

**Observed, not reasoned.** `holds a store while the room is not reaching
anybody` failed **four times out of four** on the member who stayed — three
times as a repair that should not have happened, and once, decisively, as

```
said=2  verdicts=["seed","repair"]  text="kept\nada while away\nada while away\n"
```

Note what the three non-doubling failures mean: `#act` records the verdict from
one comparison and `#mend` re-reads before acting, so when the merge lands
between the two the repair is contemplated and then declined. The file is
right; the verdict log records a repair that never happened. That is the same
race, caught by the guard rather than by luck — which is why asserting on the
verdict log, and not only on the text, is what made this visible at all.

The fix is `#settling` in `room.svelte.ts`: a room that has just reattached
does not speak until what it holds has had a chance to go out, and `send`
answers `{ held: true, why: "the room has not finished handing over what it
holds" }` until then. Scenario 6 went from **0 of 4** to **6 of 7**, and the
doubling is gone. The one remaining failure is a different shape — the member
who stayed never received the line at all — which belongs to *The stream
sometimes does not carry a write* rather than to this.

**It is a timer, and it should not be.** `#settling` waits `CONVERGING` — the
same 600ms guess seeding uses. Both callers are asking the same question from
opposite ends: *has this document been round the room yet?* Neither can ask it,
so both guess. This is now the second place where correctness rests on a
duration, which makes replacing it with a real acknowledgement the most
valuable change left in the protocol rather than merely the tidiest.

## Known problems

**The view could be rewound by its own queued create — FIXED.** This was
recorded here as *"the stream sometimes does not carry a write"*, which was a
guess from the symptom and was wrong. No event was ever lost.

A queued create leaves the outbox when the STREAM carries it, not when the
response acknowledges it -- deliberate, so an entry is never in neither place.
That leaves a window in which the server has confirmed the create AND writes
after it while the create is still queued locally. `effective.of` laid that
queued create back over the entry with `proposed()`, which sets ALL FOUR of an
entry's versions to the create's own transaction. Right for an entry that
exists nowhere else; a rewind for one the server has moved on. Only the stream
drains the outbox, so it stayed rewound rather than righting itself.

`proposed`'s docstring already said *"a queued create has no confirmed entry to
lay over"*. That was a precondition and nothing checked it. It does now, and
`tests/frontend/view.test.ts` holds a deterministic reproduction.

**Two intermittent failures with unrelated symptoms turned out to be one bug.**
Scenario 9 was a token that would not advance; scenario 8 was a room never told
its file had turned binary -- because it asked for its entry's version, got the
create's, and computed the wrong gap. Worth remembering as the normal shape of
this rather than a coincidence.

**The sample shell has three failures.** `--component Sample --browser chromium`
is 15 passed, 3 failed:

- *test 10* — `the shell creates a file the way a person does, and says nothing
  in the console` fails because something logs `room <id> did not open`. That is
  `Workspace.svelte`'s own catch, so **a room genuinely failed to open**, and it
  failed fast rather than timing out — which points at the provider constructor
  throwing rather than a sync that never came.
- *test 13* — `an open buffer is what a reader gets, and what reaches the
  server` times out waiting for the other client to have the typing.
- *test 18* — `a snapshot resolves what the user has not stored, in one pass`
  times out waiting for the file to go dirty. **This is the test the second
  session flagged as unknown, and the answer is that it still fails.**

`solo()` in `samples/frontend/src/lib/liveblocks.ts` is the first suspect and
its own docstring names this outcome: it is written against `kInternal` and the
ydoc message shape, neither of which Liveblocks considers public, and it warns
that an upgrade will look like "a constructor throwing or a file that never
opens". Worth checking before anything else, because if `solo()` is broken then
all three failures have one cause and none of them is about `Workspace.svelte`.

Against that: `UserEdits` sets `dirty` from `onDidChangeModelContent` and does
not need a shared text to do it, so test 18 is not *obviously* downstream of a
missing room. Do not assume the single cause without checking that one.

**The suite is flaky in a full run, and much less so one scenario at a time.**
4 of 7 full runs in the first session were fully green. Running scenarios
singly (see *Run the scenarios one at a time*) removes the cascade below
entirely and leaves only the stream problem above. Two distinct shapes:

- *Cascade.* The browsers run these in the same order, so scenario N pairs with
  scenario N. One test hanging desynchronises the pair and the partner times out
  on a barrier one test later. Read the first failure, not the loudest.
- *Unexplained.* `converges when both type into one open file` sometimes ends
  with every line twice — captured evidence:
  `"start\nada was here\ngrace was here\nada was here\ngrace was here\n"`, with
  the two browsers not yet agreeing at assertion time. **It passes 4/4 in
  isolation and only fails in the full run**, so it is interference, not the
  scenario.

  **A specific hypothesis, and the instrument for it.** `Sweater.svelte` reloads
  the page by itself — `tryReload()`, guarded only by a `reload-after-test-change`
  URL param, fired when `testHasChanged(props, index)` sees a negative index,
  which happens when more `onMount` subtractions land than there were additions.
  A reload re-runs every scenario **on rooms that already hold the first run's
  text**, and each browser would then append its line a second time. That
  produces exactly the captured string, in exactly that interleaved order.

  The counter that was here before could not have seen it: `bodies` lived in the
  *instance* script, so a reloaded page starts it again at zero and reports
  `bodies=1` either way. It is now at **module** scope alongside `loads`, a
  `sessionStorage` counter that survives a reload, and both are stamped into the
  failure message by `provenance()`. **`loads>1` in a failure message confirms
  the hypothesis outright.** Leave the instrumentation until it is understood.

**`Room.ready` is not consulted by everything that should.** `put` waits on it;
the editor binds on it. But a room that goes on to be *replaced* or to fall out
of touch has no reactive consumer other than `FileView`'s preview swap — there
is no "you are offline" affordance anywhere, and `Room.attached` is `$state`
purely so that one can be added.

**A held store is never retried.** `store` answering `{ held: true }` leaves the
file `dirty`, correctly, but nothing re-arms the debouncer — so the work waits
for the next keystroke rather than for the room to come back. The clean fix is
an effect on `Room.speaks` that flushes when it turns true; it wants
`$effect.root` because `SharedTextFile` is a plain class, which is why it is not
done here.

**The migration gap.** `create_all` creates missing tables; it does not add
columns to tables that already exist. When `workspace_id` was added to the
`wsfs_refused_*` tables, the long-running sample database still had the old
shape and every refused transaction 500'd with `column "workspace_id" of
relation "wsfs_refused_deletions" does not exist`. Recreating `sample-db` fixed
it because it is tmpfs. **There is no migration story at all**, and the next
schema change will do this again somewhere that cannot just be wiped.

**`samples/frontend/src/lib/Runner.test.svelte`** was recorded last session as
mid-edit and not compiling (`Type '{}' is missing … kernelPool, shared`).
`npm run check` now reports **0 errors across 1821 files**, so either it was
fixed in between or it is outside the check's scope — worth one look rather
than trusting this note.

---

## What to pick up

In order. The first two are about the file being right; the rest is about not
frustrating anybody.

**1. Find out why a write sometimes never arrives as a stream event.** See *The
stream sometimes does not carry a write*. This is the only open problem where
the user loses something real: a client can hold a file it believes is stored,
or miss that a file stopped being text, and nothing anywhere retries or
notices. Everything else on this list is a delay or an affordance. Start from
`confirmed.ts` and the subscription in `Rooms`, and note that the storing
client's own write going missing rules out a good deal.

**2. Replace `CONVERGING` with an acknowledgement.** `room.svelte.ts`. It is
now load-bearing in **two** places — seeding, and `#settling` from finding 5 —
and both are asking the provider the same question it has no API for: *has this
document been round the room yet?* 600ms is a guess that happens to work on a
fast network between two containers on one machine. It is the single change
that would most improve how this behaves for a real user on a real connection,
because it is the only place where being slow turns into being wrong.

**3. Fix the sample shell's three failures**, and find out first whether
`solo()` is the single cause. See *The sample shell has three failures*. Until
this is green, `Workspace.svelte` — the only one of the two consumers a user
ever touches — has no automated coverage of its collaboration path at all.

**4. Retry a held store.** Unchanged and still the clearest user-facing gap: a
store refused because the room was out of touch leaves the file `dirty`,
correctly, but nothing re-arms the debouncer, so the work waits for the next
keystroke rather than for the room to come back. With finding 5 there is now a
second reason to be held — settling — which makes this more visible, not less.
The clean fix is an effect on `Room.speaks` that flushes when it turns true; it
wants `$effect.root` because `SharedTextFile` is a plain class.

**5. Give being out of touch an affordance.** `Room.attached` and
`Room.replaced` are `$state` precisely so a banner can exist, and none does.
A user whose typing is not going anywhere should be told, particularly now that
there are three distinct reasons a store can be held and `send` already
returns the right sentence for each.

**6. `y-indexeddb`.** Not installed, not wired. It is for surviving a *tab
close*, which is a different thing from the network lapse the offline scenarios
simulate. When it lands there are **two** `synced` events, and "the document is
empty" is only a fact after both — so `Room.attach` grows a second thing to
wait for, and `Rooms.open` is the only place that needs to change.

**7. A migration story.** Unchanged from two sessions ago and still nothing;
see *The migration gap*.

## Costs

Two Liveblocks users total (`ada@example.com`, `grace@example.com`), stable
across runs, plus one `wsfs-probe-1` from an early reachability check. Nothing
generates ids per run. Rooms are keyed by entry id and are therefore fresh every
run, which is free but does mean room count grows.
