# Where the collaboration work is, and what to pick up

Written across four sessions. The design is settled and built; every scenario
in `SCENARIOS.md` is either covered by a test or named here as uncovered, and
the two that are uncovered cannot lose or duplicate anything.

**Read `SCENARIOS.md` first** if you want to know what the system is supposed
to do, `SCENARIOS-REVISITED.md` for the decisions taken against it,
`IMPLEMENTATION.md` for how each step went, and this for where things stand.

### Where it stands

| suite | |
|---|---|
| browser scenarios, two browsers | **16 of 16** |
| `./tests/run.sh` | **247** |
| `npx vitest run` | 101 |
| live, against a real backend | 11 |
| `npm run check` | 1822 files, 0 errors |

Every scenario asks two questions, not one: **did the file end up right**, and
**can this client still be handed what it was looking at**. They fail
independently, and the second one is the failure a user meets as *the assistant
cannot see my screen*.

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

## What the design is now

Four documents, and this is the one that says where things stand. `SCENARIOS.md`
enumerates every state two clients and a server can be in;
`SCENARIOS-REVISITED.md` records the decisions taken against it;
`IMPLEMENTATION.md` is the work, step by step, including what each step turned
up.

### Three rules everything rests on

1. **Content that came out of an editor moves as a Yjs update, never as text.**
   Typing text into a document creates NEW characters, so the same work
   arriving twice survives twice. Updates carry identity and merge once. Only
   content that was never in an editor — a kernel's output, an upload, a
   restore — is diffed in, and that is safe precisely because no second copy
   of it exists anywhere.
2. **The server is the only writer of a room's `base`, and the only party that
   carries text into a room.** Clients type and store; they never reconcile.
3. **A client whose text has reached nobody does not store it as the file.** It
   keeps it as a draft instead — durable, addressable, and asserting nothing
   about what anybody is looking at.

### The four rungs a keystroke climbs

| rung | where | survives | visible to |
|---|---|---|---|
| typed | browser memory | nothing | nobody |
| kept | `y-indexeddb` | tab close, crash, reboot | nobody |
| shared | the Liveblocks room | this client leaving | the room |
| stored | a version in wsfs | everything | everyone, forever |

### Backend — `samples/backend/`

- **`rooms.py`** — what a room owes its file, as a pure decision: seed, rebase,
  carry, or nothing. No network, so all of it is tested directly.
- **`keeper.py`** — the same decision, executed. One `asyncio` lock per entry,
  which is what settles the seeding race the browsers used to run among
  themselves and could not win.
- **`hosting.py`** — Liveblocks over plain `httpx`, as the token mint already
  reaches it. Not through the published SDK: it asserts the shape of the secret
  before sending anything, and this host is handed a placeholder its egress
  proxy swaps on the way out.
- **`POST /rooms/{entry}`** fills a room from the file; **`POST
  /rooms/{entry}/updates`** puts a client's own update into the room for it.

### Backend — `release/backend/`

- **Drafts** live in the refusal store, with reason `NOT_SHARED`. One table for
  everything submitted and not adopted, so reconstruction resolves a draft with
  no new code — which is the whole point of them.
- **`cleared`**, owned by the server, and `GET /workspaces/{id}/drafts` for what
  is still only where it was typed.
- **`migrate.py`** — adds columns the code declares and the database lacks,
  nullable then filled then constrained, and refuses the rest.

### Frontend

- **`room.svelte.ts`** — the provider, local persistence, the rule about when
  this client may write the file back, and the one thing only a reader can find
  out: that the file stopped being text. Everything else went.
- **`rooms.ts`** in the release is now one rule, `speaking`. What it used to
  hold is described in its own docstring.
- **`workspace.ts`** — `keep` beside `write`, and `unsettled` answering for
  everything the server has recorded rather than only what each entry is at now.

## Verified results

Each scenario is run as its own paired chromium+firefox run — see *Run the
scenarios one at a time*, which is also how the cascade in a full run is
avoided.

| # | scenario |
|---|---|
| 1 | converges when both type into one open file |
| 2 | shows a late joiner what was typed before they opened it |
| 3 | notices when somebody writes around the room |
| 4 | does not call it a conflict when both store from the same room |
| 5 | merges an unnoticed lapse without doubling what was typed during it |
| 6 | holds a store while the room is not reaching anybody |
| 7 | both lapse at once, both type, and both come back |
| 8 | a write that is not text takes the file away from the room |
| 9 | rebuilds what a client was looking at after the file has moved on |
| 10 | keeps what was typed when the tab holding it goes away |
| 11 | treats two tabs of one browser as two clients |
| 12 | keeps what was on screen when the file is deleted underneath it |
| 13 | stores work that reached the room and never reached the file |
| 14 | merges work from a session that ended before the file moved on |
| 15 | keeps the room when the file is renamed underneath it |
| 16 | reaches the others through the host when the room cannot be reached |

## Six findings

**Read these as history with one live rule in them.** Findings 1, 2, 3 and 6
are about machinery that no longer exists: the client-side verdicts, the
bookkeeping about whose write was whose, and the repair-by-diff they drove. All
of it went when the server took over carrying text into rooms. They are kept
because each one is a way of getting this wrong that looked reasonable at the
time, and because finding 6 is the reason to expect them to come back in new
clothes.

**Findings 4 and 5 are still rules.** A client that cannot reach the others
must not store as the file, coming or going. What changed is the consequence:
the work is kept as a draft and handed to the host, so being unable to reach
the room costs the direct route and nothing else.

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

**6. Moving a rule's execution does not move the rule.** The fourth session's,
and the shortest to state.

Finding 3 says a verdict is a hypothesis and the content is the authority. When
the server took over carrying text into rooms, that lesson did not travel with
the work: the keeper read the room to DECIDE what it owed, and read it again to
BUILD the update it sent. A room that caught up in between was handed what it
already held, and a CRDT cannot notice two inserts say the same thing.

The first full browser run after the change doubled whole changes for whichever
member arrived second -- `"written before grace ever looked\n"` twice, and a
lapse scenario reading `"shared start\nada was alone\ngrace was alone\nada was
alone\ngrace was alone\n"`.

The fix is finding 3's own: ask again, against the read being acted on, where
the answer cannot go stale. Reproduced deterministically by letting a fake
answer a read and only then change the room, so the deciding read and the
building read see different states.

Worth remembering when the remaining steps move more work to the server: every
guard that exists on the client is a candidate to be needed again on the other
side, and the reasons are written down where the old code was, not where the
new code is going.

## Known problems

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

**`Room.attached` and `Room.replaced` are `$state` so a banner can exist, and
none does.** A user whose typing is not reaching anybody should be told,
particularly now that `send` returns a sentence saying exactly why.

**The sample shell.** `--component Sample --browser chromium` was 15 passed, 3
failed when it was last run in full, all three plausibly one cause: `solo()`,
the fake Liveblocks room, is written against internals its own docstring warns
may move. Worth checking before trusting anything it says.

## What to pick up

**The two untested scenarios above**, which is the smallest honest gap.

**The sample shell's three failures**, since `Workspace.svelte` is the consumer
a user actually touches and its collaboration path has no automated coverage
until they pass.

**An affordance for being out of touch.** Everything needed is already
reactive; nothing renders it.

**Persist the outbox and the `recorded` set**, at which point the two-tab rule
starts to matter for real: *nothing may assume an entry in the outbox was
written by the tab that finds it.*

**Draft retention.** They are forever by design. Supersession within one
client's own lineage and digest dedup are the two bounded wins.

## Costs

Two Liveblocks users total (`ada@example.com`, `grace@example.com`), stable
across runs, plus one `wsfs-probe-1` from an early reachability check. Nothing
generates ids per run. Rooms are keyed by entry id and are therefore fresh every
run, which is free but does mean room count grows.
