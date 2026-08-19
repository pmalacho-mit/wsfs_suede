# HANDOFF

Written 2026-08-19, at the end of the session that merged `review`. Everything
below is either a command that works or a fact that took a while to learn.

`docs/ARCHITECTURE.md` is the design and `TODO.md` is what it does not do yet.
This file is neither: it is what a fresh session needs before touching either.

---

## 1. Where things stand

| | |
|---|---|
| backend | `release/backend` — 140 tests, 0 pyright diagnostics |
| client | `release/frontend` — 29 logical + 12 live vitest, `tsc` clean |
| sample host | `samples/backend` — a worked example of mounting wsfs |
| sample app | `samples/frontend` — SvelteKit, 0 svelte-check errors, builds |
| browser tests | `samples/frontend/src/lib/*.test.svelte` — 5 passing |

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
npx vitest run                      # 29 logical; the 12 live ones skip
WSFS_BACKEND=http://localhost:8099 npx vitest run     # all 41
npx basedpyright release/backend    # expect 0 / 0 / 0

cd samples/frontend
npx svelte-check --tsconfig ./tsconfig.json   # 0 errors; 20 warnings are not ours
npm run dev                                   # :5173, needed by the line below
npm run test:browser                          # 5 browser tests, in a container
```

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

## 3. Environment, and five things that will waste an hour each

**The devcontainer intercepts TLS.** Every image build needs a base that
trusts the proxy CA. For compose, `/desolate-ca/trust-proxy-in-builds.sh
--service <name> --image <image>` writes a gitignored `compose.override.yml`
beside the compose file — run it from that directory, and note that
`docker compose -f path/to/compose.yml` **suppresses** the override, because
an explicit `-f` turns off adjacent-file discovery. Always `cd` to the
compose file's directory instead.

**The browser image is built by dockerode, not compose, so the override does
not reach it.** Its Dockerfile runs `npm install` from a stock
`node:22-bookworm-slim` and fails with `UNABLE_TO_VERIFY_LEAF_SIGNATURE`.
What makes it build here is a local retag, which is a fact about this docker
daemon and not about the repo:

```sh
mkdir -p ~/ca-scratch && cd ~/ca-scratch
printf 'services:\n  browser:\n    image: node:22-bookworm-slim\n' > compose.yml
/desolate-ca/trust-proxy-in-builds.sh --service browser --image node:22-bookworm-slim
docker tag desolate-ca/node:22-bookworm-slim node:22-bookworm-slim
```

The build does not `--pull`, so it takes the local image. If
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

**The tree draws inside an open shadow root, and draws each filename twice**
(once visible, once for measuring truncation), so `textContent` matching finds
nothing that looks right. Rows are identified by `data-item-path`; the helpers
in `samples/frontend/src/lib/testing.ts` walk shadow roots and use it.

---

## 4. What this session changed, and why it matters

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
5. `DockView.svelte` reads seven props outside a closure
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
