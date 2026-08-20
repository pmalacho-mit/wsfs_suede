# HANDOFF

Written 2026-08-19, at the end of the session that gave the sample its shell.
Everything below is either a command that works or a fact that took a while to
learn.

`docs/ARCHITECTURE.md` is the design and `TODO.md` is what it does not do yet.
This file is neither: it is what a fresh session needs before touching either.

---

## 1. Where things stand

| | |
|---|---|
| backend | `release/backend` — 140 tests, 0 pyright diagnostics |
| client | `release/frontend` — 41 logical + 12 live vitest, `tsc` clean |
| sample host | `samples/backend` — a worked example of mounting wsfs |
| sample app | `samples/frontend` — SvelteKit, 0 svelte-check errors, builds |
| browser tests | `samples/frontend/src/lib/Sample.test.svelte` — 14 passing |

Last three commits: `Merge branch 'review'`, the file-tree context menu, and
the browser tests moving onto a trustworthy origin.

---

## 2. Running everything

Nothing runs from a bare checkout without the sample stack up, because the
live client tests and every browser test talk to a real backend.

```sh
# the sample host: postgres + one uvicorn worker, on :8099
docker compose -f samples/compose.yml up -d --build

./tests/run.sh                      # 140 backend tests, own throwaway postgres
npx tsc -p tsconfig.json            # the client
npx vitest run                      # 41 logical; the 12 live ones skip
WSFS_BACKEND=http://localhost:8099 npx vitest run     # all 53
npx basedpyright release/backend    # expect 0 / 0 / 0

cd samples/frontend
npx svelte-check --tsconfig ./tsconfig.json   # 0 errors; 20 warnings are not ours
npm run dev                                   # :5173, needed by the line below
npm run test:browser                          # 14 browser tests, in a container
```

`--test <pattern>` and `--component <pattern>` narrow a browser run to the
tests whose name or file matches, which is the only fast way to iterate:

```sh
../../sweater-vest-suede/report.sh --server http://localhost:5173 \
  --closet /tests --forward 5173 --test "shell"
```

The captures land base64-inline in `fashion-show.md`. To look at them, decode
every `data:image/png;base64,` line in that file into its own `.png`.

`./tests/run.sh --keep` leaves the database up, which makes re-runs much
faster. `./tests/run.sh -k <pattern>` passes through to pytest.

### Measuring

The performance file is measurements, not assertions — it prints a table and
asserts only that nothing hung.

```sh
WSFS_BACKEND=http://localhost:8099 npx vitest run tests/frontend/performance.test.ts
```

To compare against another revision, point the mount at a second checkout and
restart. Same image, same database, so only the code differs:

```sh
git worktree add .worktrees/baseline <rev>
cd samples && docker compose down -v
WSFS_RELEASE=/workspaces/pmalacho-mit/wsfs_suede/.worktrees/baseline/release \
  docker compose up -d
```

Depth is the axis that moves. A flat workspace exercises almost none of the
query work, so measure `create x25 at depth 12` and its siblings, not
`create x50`.

---

## 3. Environment, and six things that will waste an hour each

**The devcontainer intercepts TLS.** Every image build needs a base that
trusts the proxy CA. For compose, `/desolate-ca/trust-proxy-in-builds.sh
--service <name> --image <image>` writes a gitignored `compose.override.yml`
beside the compose file — run it from that directory, and note that
`docker compose -f path/to/compose.yml` **suppresses** the override, because
an explicit `-f` turns off adjacent-file discovery. Always `cd` to the
compose file's directory instead.

**The browser image is built by dockerode, not compose, so a build-context
override cannot reach it.** Its Dockerfile runs `npm install` from a stock
`node:22-bookworm-slim`, which fails with `UNABLE_TO_VERIFY_LEAF_SIGNATURE`.
The fix is to shadow the base image — retag the CA-trusting derivative under
the upstream name, so every `FROM node:22-bookworm-slim` in this daemon gets
it, whoever is driving the build. `.devcontainer/devcontainer.json` declares
it, so a rebuild reapplies it:

```jsonc
"customizations": { "desolate": { "shadowImages": ["node:22-bookworm-slim"] } }
```

NOT YET VERIFIED FROM A CLEAN DEVCONTAINER — the shadow was in place by hand
when this was written, so a rebuild is the first thing that will prove it. The
symptom if it did not take is the certificate error above, on the first
`npm run test:browser`. The recovery, which is also what the declaration
automates:

```sh
/desolate-ca/trust-proxy-in-builds.sh --image node:22-bookworm-slim --shadow
```

Two ways to lose it once it is there: `docker pull node:22-bookworm-slim`
silently puts the untrusting upstream back, and so does a `docker image prune`
that collects the tag. Neither says anything, and the next build fails with a
certificate error that points nowhere near here — so suspect a pull first.
`--unshadow` puts the pristine base back deliberately.

The build does not `--pull`, so it takes whatever is local. If
`browser-control-chromium:latest` already exists the layer cache covers it.

**The sample stack is on no network of its own, deliberately.** The report
driver identifies the devcontainer's network by elimination, so a second
bridge makes it ambiguous and it refuses to start before running anything.
`samples/compose.yml` publishes postgres on the default bridge and puts the
backend in the host's namespace. Do not "tidy" that into a named network
without also solving this.

**Browser tests must be served on `localhost`, via `--forward`.** The client
hashes every queued payload with `crypto.subtle`, which browsers withhold
from insecure origins — and a containerised browser reaching the page at the
devcontainer's address has one. `npm run test:browser` carries
`--server http://localhost:5173 --forward 5173`. The first test asserts
`isSecureContext` so the failure has a name.

The dev server binds every interface (`server.host` in `vite.config.ts`) for
the same reason: `--forward` points the browser's localhost at THIS machine's
address, which vite's default localhost-only bind does not answer.

**The tree draws inside an open shadow root, and draws each filename twice**
(once visible, once for measuring truncation), so `textContent` matching finds
nothing that looks right. Rows are identified by `data-item-path`; the helpers
in `samples/frontend/src/lib/testing.ts` walk shadow roots and use it.

**Every browser test lives in ONE file, under ONE category, and names files
nothing else names.** All three rules exist because those tests share a page
and a keyboard, and none of them is enforced anywhere:

- The report driver opens a tab per test *component* and runs them together.
  Only one tab is focused, so a second `.test.svelte` turns every keystroke in
  the first into a race — and a rename input that loses focus mid-word fails
  somewhere else entirely, several tests later.
- A `config` Sweater's `mode="serial"` is *one container's* queue. Two config
  Sweaters in one file is two queues running alongside each other, which is
  the same problem inside a single tab.
- The editor registers a workspace's paths in a filesystem global to the page,
  so two tests naming `anchor.md` collide there — `file '…/anchor.md/' already
  exists`, thrown from monaco, in whichever test was unlucky.

One more, learned the same way: **a page holding TWO workspace clients while
monaco boots stops receiving stream events**, for as long as the test is
willing to wait. It is why the shell's creation test asserts on its own client
rather than on a second one; the round trip to the server is covered by the
file-tree tests, which hold two clients and no editor. Unexplained, and §6 has
it.

And `harness.onAbort` runs when a test is CANCELLED, not when it finishes.
Every test that registers its teardown only there leaks a workspace client,
each holding a stream open; a browser lends one origin six connections, so the
seventh test's second client waits for a socket that never frees and times out
having seen nothing at all. `testing.ts` hands back the previous test's
clients when the next one calls `opened()`, which is why that helper — and not
the test body — is where a workspace is opened.

---

## 4. What this session changed, and why it matters

### The client says WHAT changed, and hands back the id before it says it

`watch` used to be `() => void`. A consumer that wanted to know what had moved
had one option -- re-derive the whole view and compare -- and the file tree
resetting itself on every keystroke was exactly that, with the user's
selection, expansion and half-typed rename thrown away each time.

`watch` now carries `readonly Change[]`: one entry, one thing about it, the
values either side, and the transaction responsible for what it says now.
Consumers that only need to know THAT something moved still ignore the
argument, so nothing broke.

**Changes are derived, not announced.** `recomputed` diffs the effective view
against the one that was showing, so an event that merely confirms this
client's own queued work produces nothing at all -- the overlay's removal and
the confirmed value cancel, which `effective.ts` always claimed and now
demonstrably does. A refusal produces the change that takes it back, and
nobody had to model undo.

**Attribution needed somewhere new to live.** An overlay cannot advance a
version token -- the token it presents has to stay the one the server issued,
or the next request compares against something that never existed -- so the
tokens cannot say who is responsible for an optimistic value. `effective.of`
now returns `{view, overlaid, queued}` alongside, and `overlaid` is what says
it.

**Two things the tests found, not the design.** A write moves no value a
reader of the metadata can see, only a token, so "what a property says" is its
value for a name, a parent and a tombstone, and its responsible transaction
for content. And `by` alone cannot carry a refusal: the value a refusal
restores can be one this client asserted earlier and is still waiting on, so
skipping "anything I caused" would skip your own undo. `retracting` names the
transaction being taken back, and the consumer's rule is one line:

```ts
if (change.retracting === undefined && mine.has(change.by)) continue;
```

**Mutators return `{transaction, settled}`.** Queueing a request recomputes and
announces before the request is sent, so a transaction id that only arrived
with the response arrived after the caller had been told about its own work.
The id is synchronous now; `settled` is the server's answer and does not
reject on a refusal, because a refusal is taken back by the same
recomputation that showed it.

`tests/frontend/changes.test.ts` drives all of this against a transport it
answers by hand -- the first tests that exercise a whole workspace without a
server. Its second half is the consumer this exists for: a mirror holding
entry ids against paths, applying one change at a time, rebuilding nothing,
and staying equal to `workspace.index()` through local work, a folder somebody
else renames, and a refusal.

### `mirror` is gone, and the tree wires itself

The adapter is deleted. `FileTree.svelte` now receives changes and issues
gestures in the same place, which is where it belongs while the design is
still moving -- the two directions constrain each other, and splitting them
across a package boundary hid that.

It keeps `Placed`, an entry-id-to-path table, and never resets. Somebody
else's folder rename arrives as ONE change and moves a whole subtree, because
the tree is holding ids rather than re-deriving every path and comparing.

**Two guards, for two different loops.** `mine` stops the tree re-applying its
own work. It does NOT stop the other loop: applying a remote change makes the
tree emit the same mutation a user's gesture does, which would go straight
back to the workspace as a fresh transaction -- somebody else's rename
becoming ours, becoming an event, becoming another rename. `applying` is what
stops that, and nothing else can: the work is not ours to recognise.

**And a rule that took a failing test to find.** `mine` cannot catch the FIRST
echo of a gesture. Submitting recomputes the workspace and announces the
change *before the call that submitted it has returned*, so there is no moment
at which to write the transaction down first. What covers it is squaring the
registry with the tree BEFORE telling the workspace -- then the echo describes
a world the registry already agrees with, and there is nothing to do.

Getting that backwards is not a cosmetic bug. The echo tried to remove a row
the user had already removed, `@pierre/trees` throws rather than shrugging,
and the exception unwound through the recompute and out of `submit` -- so the
request never reached the server, and the only symptom was a delete that
silently did not happen.

### The open document plane is gone

`edit`, `close`, `documents.ts`, `liveblocks.ts` and the flush debouncer have
been deleted. The client cannot know that a buffer exists, and it was bending
its read path around the possibility -- `content.read` had a first step for a
CRDT it could only reach through a registry the consumer had to install.

Whether a half-typed line beats the last accepted write is a question only
whoever put the editor on the screen can answer. The sample answers it in
`src/lib/documents.ts`: a `Y.Doc` per open path, flushed on a debounce, and
consulted ahead of the workspace by the kernel. `MappedDebouncer` is exported
now, because that consumer needs it.

### Two things the editor's filesystem was getting wrong

Both latent, both surfaced by a test that put a file inside a folder:

- `provider` offered every path, folders included, and an editor's filesystem
  refuses to hold a directory that was registered as a file. It offers files
  only now; a folder is implied by what lives in it.
- The editor keeps ONE filesystem for the page, and `Open` registered with it
  unconditionally -- so a second workspace open at the same time raced the
  first to register the same paths. `new Open(id, user, { provides: false })`
  is how the tests' second client stays out of the way.

### Before that, in the same session

The sample app got the shape it was always meant to have, and creating a file
in it got the shape a person expects. Four bugs came out from under the two.

**A new entry is a DRAFT until it is named.** `entries.add` used to put
`untitled` in the tree, which the tree announced, which the workspace created
-- so a placeholder nobody chose was a real file on the server before the user
had typed anything, the rename that followed was a move, and a panel opened
for a path that was about to stop existing. `Model.draft` holds the row in the
tree alone: no `added`, no `moved`, no `removed` leaves the model while one is
open, the rename box starts EMPTY rather than seeded with a name, and exactly
one thing is announced at the end -- `added` under the name the user chose, or
`rename refused` with the reason and the row already gone. Blank and taken
names are the tree's own rules; this only makes sure nothing was created
first. A reset arriving mid-draft is held and applied afterwards, which also
retires the `Source path does not exist` noise from the last handoff.

**The editor had never worked in this sample.** Three things were missing at
once, each hidden behind the one before it: `connect` was given no `open`, so
`workspace.edit` threw; `vite.config.ts` never applied the editor package's
own config, so monaco failed on `PYTHON_MONACO_BASE`; and `server.fs.allow`
did not cover the checkout, so its themes were served as Forbidden.
`src/lib/documents.ts` is the missing seam -- a `Y.Doc` that never leaves the
tab, which is all a single client needs, and which the shipped `liveblocks`
adapter replaces in one line.

**A client could not read back what it had just written.** `content.read`
asked the open document, then the cache, then the server -- and a file created
offline is in none of them, so reading it 404ed and the panel said "no such
file". The queued write now seeds the cache under its own transaction id,
which is the token the server will record, so the line is right before the
create is confirmed and stays right after.

**The shell is a grid of three regions, not a dock of two panels.** The
filesystem down the left, open files in the middle, the assistant down the
right — VS Code's arrangement, and `kat-tax/vslite`'s `Dock.tsx` mapped onto
the svelte port. `GridView` owns the three; only the middle one is a
`DockView`, so a file can be split and stacked all it likes and can never be
dragged over the explorer, and `proportionalLayout={false}` plus
`LayoutPriority.High` on the middle keeps the two sides at the width they
were given when the window resizes. The middle region hands its dock api
upward through a params callback, because nothing can open a file until it
exists. `Assistant.svelte` is deliberately empty: the region has to exist
before the conversation in it does, so adding one is a change to one file.

**The file tree fills its region**, which is what makes the empty space under
the last entry worth right-clicking. The tree's own menu belongs to an entry,
so a click that hits no row got nothing — and that is most of the panel. That
click now opens the same surface (`ContextMenu.Component`, so the styling
cannot drift) anchored to the pointer, offering the two of the four standard
actions that do not need an entry: Add file and Add folder, at the root. Both
are `entries.add` with the root spelled as the directory it is, so the library
does the work.

**`stop()` left the stream's connection open.** The loop stops by setting a
flag and waking the sleep — but a loop parked on `follow` is not sleeping, and
nothing cancelled the fetch. Same hole when the watchdog won the race: the
subscription was closed on failure only, so a server happy to hold the
connection held it forever. `Cycle.follow` now takes an `AbortSignal` the loop
aborts on both paths. It matters beyond tests, because a shell that opens and
closes workspaces leaks one connection each time and a browser lends an origin
six. Two tests pin it, both verified to fail without the fix.

### Before that, from the session that merged `review`

The `review` branch answered a code review; all of it was an improvement and
was merged as-is. Three defects were found on top of it, each now pinned by a
test that was verified to fail without the fix.

**Dedup was one-directional.** `_already_applied` only looked in the logs the
request would *write*, so an id spent on a rename and presented again as a
write found nothing, looked fresh, and applied — different tables, so no
primary key stopped it. It now asks all five logs in one `union_all`, which is
cheaper than the one-to-four `session.get`s it replaces.

**The stream replay tore transactions in half.** `_between` reads five logs in
five statements, and read committed gives each its own snapshot, so a
transaction committing mid-replay was visible in some logs and not others. A
folder create torn one way arrives as `{parent, deletion}` and kills the
stream; torn the other way it arrives as a bare `name` — a *legal* event for
an entry the client has never heard of, which applies nothing and loses the
entry silently. `stream.since` now takes all five reads at one snapshot. This
reproduced in roughly half of deep-tree runs, and is what dropping the
`Version` table cost.

**The client dropped acknowledged work too early.** `submit` evicted from the
outbox on the response, but the confirmed map only gains the entry when the
stream carries it, so a new file blinked out of the tree in between. Only
rejections self-evict now; the stream evicts everything else.

Performance, same harness and fresh database, pre-merge vs now:

| | before | after | |
|---|---|---|---|
| create ×50 (flat) | 19.13 ms | 18.42 ms | — |
| create ×25 at depth 12 | 122.25 ms | 44.76 ms | 2.7× |
| move ×15 to depth 12 | 170.48 ms | 41.98 ms | 4.1× |
| replay ×100 at depth 12 | 110.88 ms | 10.51 ms | 10.6× |

The file tree gained creation and deletion through the package's own context
menu; move already worked, because a drag and a rename are the same event.
Two fixes fell out of wiring it: empty folders rendered as files (paths alone
cannot tell them apart, so the entry's `type` now marks folders with the
trailing separator the tree reads), and `mirror` reset the tree on *every*
workspace change including content writes — which costs the tree its
selection, its expansion, and any half-typed rename. It now resets only when
the path shape actually moved.

---

## 5. Invariants that are easy to break by accident

- **One process per workspace.** Nothing enforces it. The controller's
  position counter lives in memory, and the design leans on events being
  grouped by the transaction that wrote them rather than by position — which
  makes a second writer produce an ugly stream instead of a wrong one. See
  TODO.md §4 for the lease table that replaces this when it stops being true.
- **A refused transaction is stored nowhere.** `service.refusal` is pure, so
  re-presenting a refused transaction recomputes its reason against the
  workspace as it stands. Do not add a refusals table.
- **A transaction id is spent once, on one operation, against one entry.**
  The shape check in `_already_applied` is what makes "already happened" mean
  *this* change.
- **`approve` is the only thing that writes**, and it is what stamps the
  position. A row that reaches the database without it has `position = 0` and
  trips a CHECK constraint on purpose.
- **Reachability is the client's job**, and the contract says so. Deleting a
  folder tombstones the folder alone; its children keep their rows and lose
  their path. A snapshot therefore contains entries whose ancestry is
  interrupted. `paths.walked` is where the client handles it.
- **Square your own state before telling the workspace.** Submitting
  recomputes and announces before the mutator returns, so a consumer that
  updates its own bookkeeping afterwards is asked to act on a change
  describing a world it has already left. See §4.
- **Generated files are generated.** `release/frontend/*.generated.*` come
  from `python3 release/frontend/generate.py`, which ships a stub app so it
  never depends on `samples/`. Regenerate after any contract change rather
  than editing them.

---

## 6. Open, roughly in the order I would take them

1. `TODO.md` §1 — blobs stream rather than buffer, and splitting `main.py` so
   a host can import the units of work without a router.
2. An alembic baseline. `samples/backend/serve.py` calls `create_all`, which
   is a stand-in and says so.
3. A binary round trip in the browser tests — every browser test today is
   text, so `crypto.subtle` and the workspace-scoped blob routes are only
   covered by the python suite and the live vitest.
4. The torture harness in `TODO.md` §6: seeded fault injection converging on
   field-level equality with an empty outbox.
5. `FileTree.svelte` now holds the registry, both loop guards, the draft menu
   and the tree's own composition, which is a lot for one component. It is
   deliberate -- the design is still moving and the two directions constrain
   each other -- but `Placed` and the change application are the parts that
   would come out first, into the tree package or a module beside it.
6. Two workspace clients in one page stop receiving stream events once the
   editor is loading — both initialize, both open a stream, the transaction is
   accepted, and the second client's stream then delivers nothing for 30s. It
   reproduces only with a `Shell` mounted, never with the tree alone, so
   suspect the editor's own traffic against the browser's six connections per
   origin before suspecting the backend: restarting the backend changes
   nothing.
7. `tests/frontend/performance.test.ts` fails roughly one run in three when
   the whole vitest suite runs against a loaded backend, on the elapsed-time
   assertion. It predates this session — it reproduces on a stashed tree — and
   the file passes every time on its own.
8. The report driver forces §3's one-file rule: it opens a tab per test
   component and runs them concurrently, and containers within a file are not
   serialised against each other either. Running components one at a time,
   and awaiting one container before starting the next, would let the browser
   suite be organised by subject again. Both live in `sweater-vest-suede`,
   which is a subrepo.
9. `DockView.svelte` reads seven props outside a closure
   (`state_referenced_locally`), so they capture their initial value and will
   not react if a consumer changes them. It is 8 of svelte-check's 20
   warnings, and 8 more are the same bug in sweater-vest's own vendored copy
   of that package; the last 4 are in `Sweater.svelte` and `Runner.svelte`.
   None are in this repo's own files.

---

## 7. Ground rules from the operator

- **No pushing or pulling.** The human outside the devcontainer owns every
  git remote operation. Committing locally is fine.
- Files matching `*.generated.*` are build output; never hand-edit them.
- Prefer the relative import form for the vendored siblings
  (`from ...wsfs_suede__sqlmodel_utils_suede...`).
- The style the codebase is written in: short functions, names instead of
  comments, shape kept apart from judgement, predicates named, two spellings
  of one rule calling one function. Comments explain *why*, and are a
  liability when they explain *what*.
