# TODO — what the backend does not do yet

The scaffold is gone: the backend runs on Postgres, adjudicates every request
through one choke point, streams events derived from the version log, and is
covered by `tests/` running against a real database (`./tests/run.sh`).

What the earlier plan called for and this design removed rather than built:

- **Event buffer table** — deleted. One approved mutation appends exactly one
  `Version`, so the versions of a workspace in position order *are* its event
  stream. There is no second write to fail independently of the first, and no
  retention job, because the rows are the truth rather than a copy of it.
- **Transaction record table** — deleted. Applied transactions are recorded in
  the property table they changed (that IS the dedup key); refused ones are
  recorded nowhere, because a refusal changed nothing. `service.refusal()` is
  pure, so re-presenting a refused transaction recomputes its reason against
  the workspace as it stands. The "transaction older than retention → cannot
  reconcile" branch is therefore unreachable and unwritten.
- **REPEATABLE READ for Initialize** — replaced by the controller's exclusion.

Server tables beyond the domain schema: **1** (stream tokens).

---

## 1. Migrations

```
[ ] alembic init; autogenerate from SQLModel.metadata
    (create_all is already opt-in: create_app(create_tables=True), tests only)
```

## 2. Blobs to object storage

```
[ ] S3-compatible store behind the same `Blobs` seam (holds / read / store)
[ ] hash while streaming rather than buffering; the size budget then stops
    being a Content-Length check
[ ] Content for binary -> presigned redirect instead of proxied bytes
[ ] garbage collection: a blob is unreferenced when no BlobContent names it.
    Parked -- blobs are cheap and deletion is the one irreversible operation
```

## 3. Identity

```
[ ] real authentication: `main.authenticate` trusts an X-User-Email header
[ ] workspace membership: any authenticated user can reach any workspace
```

## 4. Scale, when measured and not before

```
[ ] cross-process bus: pg_notify at the choke point, one listener per process
    feeding controller fan-out for workspaces whose streams live elsewhere.
    The client contract, the splice and the frontend do not change at all
[ ] backpressure: a stream queue is unbounded, so a client that stops reading
    grows one. Bound it and drop the connection instead -- the sync loop
    re-enters through Initialize, which is what it does after any failure
[ ] Content responses carry an ETag but honour no If-None-Match
```

## 5. Deployment

```
[ ] Dockerfile whose CMD runs ONE worker, with the reason on the line above it
    (the app already refuses to start with WEB_CONCURRENCY > 1)
[ ] platform streaming timeouts will kill healthy SSE connections periodically;
    set them as high as allowed and budget for reconnect churn
```

## 6. The client

```
[ ] everything in ARCHITECTURE.md §3 "Client-side" -- outbox, effective view,
    content cache, drafts, the sync loop, the Pyodide bridge
```
