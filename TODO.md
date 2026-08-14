# TODO — from SQLite scaffold to real Postgres (controller edition)

The scaffold now uses the per-workspace controller (actor) architecture:
all writes serialize through an in-process controller per workspace, which
fans committed events out to its streams. That choice replaced the
LISTEN/NOTIFY dispatcher plan and removed an isolation-level subtlety — but
it introduced ARCHITECTURE.md invariant 11 (**one process per workspace**),
and most of what's Postgres-specific below exists to *enforce* that
invariant rather than to move data. The test suites are the acceptance
criteria — all must pass unmodified (plus §7's new ones) before and after
every step.

---

## 1. Engine & sessions: keep sync SQLModel

Unchanged decision from before: handlers stay sync (`def fn()` running in
`asyncio.to_thread` under the controller lock), SQLModel `Session`
throughout, no `AsyncSession` migration. The controller already provides
the async seam; the ORM doesn't need one.

```
[ ] create_engine(DATABASE_URL, pool_size=..., pool_pre_ping=True)
[ ] remove the sqlite StaticPool special-casing from create_app
[ ] pool sizing note: each submit() briefly holds one pooled connection
    inside a worker thread; concurrency is bounded by workspaces actively
    writing, not by request count — default pool sizes are fine for a while
```

Trap: SQLite ignored `with_for_update()`; Postgres honors it. Keep it —
under a healthy single controller it's redundant by design, and that is
exactly why it stays: it converts an accidental second instance from
*silent corruption* into *merely degraded* (lock contention, consistent
data). Do not let anyone remove it as an optimization.

## 2. Datetimes & payloads

```
[ ] DateTime(timezone=True) on every datetime column (models.py) via
    sa_column=Column(DateTime(timezone=True))
[ ] delete the tzinfo normalization hack in the stream endpoint
[ ] EventRow.payload -> JSONB; drop json.dumps/loads at the boundaries
```

## 3. Enforcing the topology invariant (the real §3)

The controller gives correctness only if exactly one process serves a
workspace. Three layers, cheapest first:

### 3a. Deployment: one instance, stated loudly

```
[ ] serve with a SINGLE worker; put the invariant in a comment ON the CMD
    line of the Dockerfile (the commented-out --workers 4 line is one
    keystroke from silent split-brain)
[ ] refuse to start if WEB_CONCURRENCY / --workers > 1 unless an env flag
    acknowledging sticky routing is set (a 5-line startup check)
[ ] Knative/Cloud Run: autoscaling max-instances = 1. Do NOT use session
    affinity as the fix — it is best-effort, and sticky routing that may
    fail is indistinguishable from none for correctness purposes
[ ] platform streaming timeouts will periodically kill healthy SSE
    connections; the client sync loop absorbs this — set the platform
    timeout as high as allowed and budget for reconnect churn (the
    controller's grace period exists for exactly this)
```

### 3b. Advisory lock: make the second instance fail loudly

A controller, on instantiation, takes a **session-level Postgres advisory
lock** keyed on the workspace id, on a dedicated connection it holds for
its lifetime. A second process's controller then blocks/fails at
acquisition instead of silently coexisting.

```python
# sketch: in ControllerRegistry._get_or_create (Postgres mode only)
conn = engine.raw_connection()          # dedicated, held for controller life
locked = conn.cursor().execute(
    "SELECT pg_try_advisory_lock(hashtext('wsfs:' || %s))", [workspace_id])
# not locked -> raise; log screams "another instance owns this workspace"
```

```
[ ] advisory lock acquire in registry get-or-create; release (and close the
    dedicated connection) in the grace-expiry teardown and in shutdown()
[ ] these connections live OUTSIDE the pool (session-level locks pin their
    connection; pooling would silently drop the lock on recycle)
[ ] failure mode decision: raise 503 "workspace served elsewhere" — do not
    wait on the lock (waiting hides the misconfiguration §3a should catch)
[ ] cap: dedicated connections scale with LIVE controllers; if workspace
    count per process grows large, revisit (transaction-level advisory
    locks inside submit() are the fallback shape)
```

### 3c. The upgrade path when one process is no longer enough

Posture (c) from the design discussion: controllers stay as the local
serialization + fan-out layer, backed by a cross-process bus. Pleasingly,
the previously shelved LISTEN/NOTIFY plan returns as that bus:
`pg_notify('wsfs_events', ws:position)` inside `service._commit`, one
listener connection per process feeding `controller.submit`-adjacent
fan-out for workspaces whose streams live elsewhere. The client contract,
the splice, and the frontend do not change at all.

```
[ ] park until measured; write the one-pager when the first capacity alarm
    fires, not before
```

## 4. Token claim

```
[ ] replace get-then-delete with one statement:
    DELETE FROM streamtoken WHERE token = :t AND expires > now()
    RETURNING position
    (atomic single-use under concurrency: two racing connects, exactly one wins)
```

(The old REPEATABLE-READ-for-Initialize item is gone: Initialize now runs
inside the controller's serialization — consistency by exclusion.)

## 5. Retention jobs

```
[ ] EventRow: DELETE WHERE created_at < now() - interval '15 minutes'
    (resume never spans more than Initialize->connect + blips)
[ ] TransactionRecord: retention >= max tolerated client offline age
    (start: 30 days). On a presented txn older than the low-water mark,
    Initialize must answer "cannot reconcile automatically" — add that
    branch + a Rejection reason; it does not exist yet
[ ] scheduler: an asyncio task under a pg advisory lock (you now have the
    advisory-lock plumbing from §3b anyway), or cron + management command
```

## 6. Schema, blobs — unchanged from before

```
[ ] swap inline Entry.parent_id for the real FileSystem/FileHierarchy
    schema; touchpoints: service._get_live, _name_taken, _meta, snapshot,
    reparent handler
[ ] partial unique index on (parent, name) WHERE NOT deleted;
    FileHierarchy.child_id UNIQUE
[ ] alembic init; autogenerate from SQLModel.metadata; create_all becomes
    tests-only
[ ] blobs to S3-compatible storage (stream + hash while streaming, don't
    buffer); Content binary -> presigned redirect; GC parked
```

## 7. Testing against the real thing

```
[ ] conftest: WSFS_TEST_DATABASE_URL (CI: postgres service container);
    throwaway schema per session; parametrize fixtures over
    [sqlite, postgres] — sqlite stays for the fast inner loop
[ ] new: advisory-lock test — two app instances, one database, second
    instance's controller for the same workspace gets a loud 503, and the
    data stays consistent throughout (the row lock earning its keep)
[ ] new: token claim race — two simultaneous connects, one token:
    exactly one 200, one 401
[ ] new: controller crash-rebuild — kill the process mid-session, restart,
    client loop reconnects through Initialize with zero loss (invariant:
    controller memory is rebuildable-from-zero)
[ ] later: port the frontend torture faults into a backend chaos test
```

## 8. Delete list (scaffold things Postgres makes wrong)

```
[ ] StaticPool / check_same_thread sqlite plumbing in create_app   (§1)
[ ] the datetime tzinfo hack in the stream endpoint                (§2)
[ ] get-then-delete token claim                                    (§4)
```

---

Order: §1–2 (mechanical), §7's conftest (so everything after runs against
Postgres), §3a immediately (it's configuration, not code), §3b, §4–5, then
§6 as separate PRs. §3c stays parked. Every section leaves the suites
passing; if one doesn't, that's the section teaching you something — write
the test before the fix, per house rules.
