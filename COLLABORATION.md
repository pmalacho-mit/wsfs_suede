# Where the collaboration work is, and what to pick up

Written at the end of the session that built the two-browser suite. Everything
below is either verified or explicitly marked as not.

---

## Bringing the stack back up

The docker runtime wedged at the end of this session, mid-`tests/run.sh`. It
had been running: the sample stack, two browser-control containers (chromium
and firefox), and the pytest container, all at once.

```bash
docker compose -f samples/compose.yml down
docker compose -f samples/compose.yml up -d --build
cd samples/frontend && npm run dev          # needs to be running for browser tests
```

**The sample database is `tmpfs`.** It wipes on every `sample-db` restart, which
is deliberate — but see *the migration gap* below, because it bit once.

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
- **`collaborator.ts`** — the design under test, embodied: one shared document
  per file, the workspace underneath, and `rooms` deciding whether one still
  speaks for the other. Deliberately *not* `Workspace.svelte` — the claims are
  about what happens between two clients, and a monaco instance in the middle
  makes failures harder to place.
- **`Reach.test.svelte`** — can a browser reach Liveblocks at all. Kept separate
  so that hop fails loudly and by itself rather than as nine timeouts.
- **`Shared.test.svelte`** — the scenarios.

### Release — `release/frontend/rooms.ts`

Only the module docstring changed, but the content is load-bearing: two of the
three findings below are now recorded there.

---

## Verified results

`npm run test:browser -- --component "Shared" --browser chromium --browser firefox`

Four scenarios, both browsers, **8 passed** on 4 of 7 full runs:

1. **converges when both type into one open file**
2. **shows a late joiner what was typed before they opened it**
3. **notices when somebody writes around the room** — this is the case `rooms.ts`
   exists for, and it works: Grace writes outside the room, Ada's room is told it
   fell behind, and the outside write reaches her document.
4. **does not call it a conflict when both store from the same room**

Also green and unaffected: backend **193**, node frontend **110**, `rooms.ts`
unit tests **14**.

---

## Three findings that came out of this, all fixed

None of these would have shown up in one browser.

**1. `Standing` has to be held in structures that merge.** `produced` started as
a list in one `Y.Map` slot, which is last-writer-wins. Two clients storing at the
same moment each wrote their own one-element list; one survived; the client whose
entry was lost then treated the other's write as a stranger's and asked for a
repair. Now it is a key per transaction. Recorded in `rooms.ts`.

**2. Concurrent seeding doubles the file.** "The document is empty" is true for
*both* clients opening together, and a CRDT merges two inserts rather than
noticing they say the same thing. Now claimed first and acted on second: one
last-writer-wins slot, a wait for the room to converge, and only the winner
writes. **The wait is a 600ms guess** — whoever wires this into a real client
should hang it off an acknowledgement instead.

**3. A verdict is a hypothesis, not a fact.** The most important one. The
bookkeeping travels between clients through the *shared document*; the write it
is about travels through the *server*; nothing orders those two. A member can be
told a write landed before being told its own room made it, and will call its own
text a stranger's — and repairing against text you already hold does not
conflict, it duplicates. So `collaborator.ts` now confirms every non-`current`
verdict by reading the file at that token and doing nothing if the document
already says it. Bookkeeping makes the common case free; the comparison is what
makes it correct. Recorded in `rooms.ts`.

---

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
  scenario. `Shared.test.svelte` still carries a `bodies` counter and a verbose
  failure message added to chase this; the hypothesis to test first is that the
  Sweater body runs twice on the same page, which would make both clients append
  their line a second time into the same room. Leave the instrumentation until
  it is understood.

**The migration gap.** `create_all` creates missing tables; it does not add
columns to tables that already exist. When `workspace_id` was added to the
`wsfs_refused_*` tables, the long-running sample database still had the old
shape and every refused transaction 500'd with `column "workspace_id" of
relation "wsfs_refused_deletions" does not exist`. Recreating `sample-db` fixed
it because it is tmpfs. **There is no migration story at all**, and the next
schema change will do this again somewhere that cannot just be wiped.

**`samples/frontend/src/lib/Runner.test.svelte`** is mid-edit and does not
compile (`Type '{}' is missing … kernelPool, shared`). Not mine, not touched.

---

## What to pick up

**Four scenarios still unwritten.** `collaborator.ts` already has
`goOffline(entry)` / `comeBack(entry)` — it tears down only the provider and
keeps the `Y.Doc`, so the document goes on accepting edits and syncs everything
when a provider is attached again. That is a faithful unnoticed-lapse
simulation and needs no `y-indexeddb`.

3. A offline, types, reconnects — merge, no doubling.
4. Both offline, both type, both reconnect. *(Expect trouble here: this is where
   seeding order and the doubling guard get their real test.)*
5. Binary write over a file A has open as text. `FileOverride.replaced` exists
   in `release/frontend/adapters/index.ts` for exactly this and has no consumer
   yet. The design decision already taken: the write lands, the room is told the
   file stopped being the text it is showing — it does **not** fail.
6. A snapshots while offline; both reconnect; snapshot rebuilt through
   `POST /workspaces/{id}/reconstruction` and compared. This closes the loop
   with the backend work and is the one I would write next.

**Wiring `rooms.ts` into `Workspace.svelte`.** Still not done — the protocol is
proven in `collaborator.ts` but the real component does not use it. That is the
step that makes any of this reach a user. Note that `Workspace.svelte` binds
`file.sourceSync = doc.getText("content")` on `"connected"` with no seeding
election, so finding 2 applies to it directly.

**`y-indexeddb`.** Not installed, not wired. It is for surviving a *tab close*,
which is a different thing from the network lapse the offline scenarios
simulate. When it lands: there are then **two** `synced` events, and "the
document is empty" is only a fact after both.

---

## Costs

Two Liveblocks users total (`ada@example.com`, `grace@example.com`), stable
across runs, plus one `wsfs-probe-1` from an early reachability check. Nothing
generates ids per run. Rooms are keyed by entry id and are therefore fresh every
run, which is free but does mean room count grows.
