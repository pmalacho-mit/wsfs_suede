# Where the collaboration work is, and what to pick up

Written across two sessions. Everything below is either verified or explicitly
marked as not — and the second session ends with **a large amount unverified**,
because the docker runtime wedged before any of it could be run in a browser.
Read *What is not verified* before trusting anything in *What was built*.

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

### The docker wedge — what it looks like and how to avoid it

**It has now happened twice, and both times while the two browser-control
containers were being created at once.** First time: mid-`tests/run.sh`, with
the sample stack, chromium, firefox and pytest all at once. Second time: the
sample stack plus a first-ever `npm run test:browser -- --browser chromium
--browser firefox`, about a minute in, with both containers mid-`runc create`.

**How to recognise it.** Every docker client hangs, including `docker ps`, and
`timeout` and `kill -9` do nothing to them — check `ps` and you will see them in
state **`D`**, uninterruptible sleep. `dockerd` and `containerd` are both still
alive; a raw `curl --unix-socket /var/run/docker.sock http://localhost/_ping`
hangs too, and that is the cheapest endpoint there is. It is not resource
exhaustion: disk and inodes were at 9% and 4%, and 34G of memory was free. Load
average climbs anyway, because `D`-state processes count towards it.

**There is no recovery from inside the devcontainer.** The stuck clients cannot
be killed, so the daemon has to be restarted from outside.

**So do not do these:**

- **Do not poll `docker ps` while a browser run is starting.** It will not tell
  you anything a wedge has not already decided, and each poll leaves another
  unkillable process behind. Read the run's own output instead. (The polls did
  not cause the second wedge — the first one was already stuck — but they made
  it much harder to see what had.)
- **Do not create both browser containers for the first time in one go.** They
  are named by devcontainer id specifically so they are **reused** across runs
  (`report/index.ts`, `namer`), so the expensive create is a one-off. Pay it
  once per browser, separately, and the two-browser run then only has to attach:

  ```bash
  npm run test:browser -- --component Reach --browser chromium
  npm run test:browser -- --component Reach --browser firefox
  npm run test:browser -- --component Shared --browser chromium --browser firefox
  ```

  `Reach` is the right thing to warm with: it is one test, it is the reachability
  check, and if it fails you have learnt something worth knowing before spending
  ten minutes on the full suite.
- **Do not pipe a run through `tail`.** `npm run test:browser ... | tail -80`
  shows nothing at all until the run ends, so a run that hangs is
  indistinguishable from a run that is working. Redirect to a file and read it.

**A full run is slow.** Budget ten minutes-plus for four scenarios across two
browsers, and more the first time, when the browser images are being built.

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

## Verified results

### From the first session (browser-verified, before the refactor)

`npm run test:browser -- --component "Shared" --browser chromium --browser firefox`

Four scenarios, both browsers, **8 passed** on 4 of 7 full runs:

1. **converges when both type into one open file**
2. **shows a late joiner what was typed before they opened it**
3. **notices when somebody writes around the room** — this is the case `rooms.ts`
   exists for, and it works: Grace writes outside the room, Ada's room is told it
   fell behind, and the outside write reaches her document.
4. **does not call it a conflict when both store from the same room**

**These results predate the `room.svelte.ts` extraction.** The scenarios are
unchanged in substance, but the code under them was rewritten, so they are
evidence about the design and not about the current tree.

### From the second session (everything that could be checked without docker)

- `npx vitest run` — **113 passed, 16 skipped**, including
  `tests/frontend/rooms.test.ts` at **17** (was 14; three cover `speaking`).
- `cd samples/frontend && npm run check` — **1821 files, 0 errors**, covering
  `room.svelte.ts`, `collaborator.ts`, `Shared.test.svelte`, `Workspace.svelte`
  and `FileView.svelte`.
- `npm run typecheck` at the root — 24 errors, **all pre-existing and all in
  `wsfs_suede.python-web-kernel-suede`**; none in `release/`, `tests/` or
  `samples/`.

## What is not verified

**Nothing in this session has been run in a browser.** The docker daemon wedged
during the first two-browser run of the session — see *The docker wedge* above
— and never came back, so the baseline run produced no result either. Concretely,
none of this has been executed anywhere:

- The four new scenarios (below). They typecheck; they have never run.
- `room.svelte.ts` at runtime, in either consumer.
- Every claim in *Workspace.svelte, wired at last*. The reasoning behind each is
  written down, and the `MonacoBinding` one in particular is a reading of
  y-monaco's constructor rather than something observed.
- Whether the four *old* scenarios still pass against the extracted protocol.
  **Run these first**, before the new ones: a failure there is a refactor
  regression, and a failure in the new ones is a finding.
- The typing-to-storing wiring. `Sample.test.svelte` has a test that waits for
  a file to go dirty, which nothing could have satisfied before this change —
  so that test was already failing, and whether it now passes is unknown.

The order to re-verify in, once docker is back (and warming the browser
containers one at a time first, per the wedge section):

```bash
npm run test:browser -- --component Reach   --browser chromium
npm run test:browser -- --component Reach   --browser firefox
npm run test:browser -- --component Shared  --browser chromium --browser firefox
npm run test:browser -- --component Sample  --browser chromium
./tests/run.sh                              # backend, 193
```

## Four findings, all fixed

None of the first three would have shown up in one browser. The fourth would
not have shown up in one *session*.

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

## Known problems

**The suite is flaky.** 4 of 7 full runs were fully green; the others failed 1–3
tests. Two distinct shapes:

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

**Run it.** Everything below is downstream of that; see *What is not verified*
for the order, and *The docker wedge* for how not to lose the daemon doing it.

**The four new scenarios, written and never executed.** In
`Shared.test.svelte`, after the original four:

3. *merges an unnoticed lapse without doubling what was typed during it* — Ada
   detaches, types, Grace types on, Ada reattaches; each line exactly once.
4. *holds a store while the room is not reaching anybody* — finding 4, made
   into a test. Ada detaches, types, and is **refused** a store; she comes back,
   the room speaks again, and the store lands with nothing doubled and no repair
   recorded anywhere. **If finding 4 is wrong, this is where it shows.**
5. *both lapse at once, both type, and both come back* — the seeding election
   and the doubling guard getting their real test, then a store that must not
   look like a conflict to the other.
6. *a write that is not text takes the file away from the room* — Grace writes a
   PNG over a file Ada has open; Ada's document is neither repaired nor
   corrupted, her room stops speaking, and her store is held.
7. *rebuilds what a client was looking at after the file has moved on* — Ada
   stores, snapshots four tokens, checks `unsettled` is empty, lets Grace move
   the file on, then `POST /workspaces/{id}/reconstruction` and asserts she gets
   back **what she was looking at**, not what the file says now.

**`CONVERGING` is still a 600ms guess.** `room.svelte.ts`. Hang it off a
provider acknowledgement. This is the highest-value single change left in the
protocol, because it is the only place where correctness rests on a duration.

**Retry a held store**, and give being out of touch an affordance — both under
*Known problems* above.

**`y-indexeddb`.** Not installed, not wired. It is for surviving a *tab close*,
which is a different thing from the network lapse the offline scenarios
simulate. When it lands: there are then **two** `synced` events, and "the
document is empty" is only a fact after both — so `Room.attach` grows a second
thing to wait for, and `Rooms.open` is the only place that needs to change.

**A migration story.** Unchanged from last session and still nothing; see
*The migration gap*.

---

## Costs

Two Liveblocks users total (`ada@example.com`, `grace@example.com`), stable
across runs, plus one `wsfs-probe-1` from an early reachability check. Nothing
generates ids per run. Rooms are keyed by entry id and are therefore fresh every
run, which is free but does mean room count grows.
