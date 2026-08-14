# Wsfs Suede

This repo is a [suede dependency](https://github.com/pmalacho-mit/suede). 

To see the installable source code, please checkout the [release branch](https://github.com/pmalacho-mit/wsfs_suede/tree/release).

## Installation

```bash
bash <(curl -fsSL https://suede.sh/install/release) --repo pmalacho-mit/wsfs_suede
```

<details>
<summary>
See alternative to using <a href="https://github.com/pmalacho-mit/suede#suedesh">suede.sh</a> script proxy
</summary>

```bash
bash <(curl -fsSL https://raw.githubusercontent.com/pmalacho-mit/suede/refs/heads/main/scripts/install/release.sh) --repo pmalacho-mit/wsfs_suede
```

</details>

# wsfs — workspace filesystem sync scaffold

Runnable scaffold of the sync architecture (see `docs/ARCHITECTURE.md` for
the full system map, `docs/filesystem-sync-contract.ts` for the wire
contract). Backend: FastAPI + SQLModel. Frontend: framework-free TypeScript
(Vite-compatible) + Vitest.

## Layout

    backend/
      app/models.py     tables of record: entries + per-version history,
                        transaction record (audit/dedup/Initialize), event
                        buffer, tokens, blobs
      app/service.py    adjudication + the choke point (position bump, event
                        row, txn record — one db transaction)
      app/controller.py per-workspace controller + registry: serialized
                        submit, post-commit fan-out, refcounted stream
                        lifecycle with grace-period release
      app/main.py       Initialize handshake, SSE stream (token claim +
                        splice), blob PUT, content fetch
      tests/            behavior tests against a real uvicorn server
    frontend/
      src/state.ts      confirmed map, ordered outbox (+ write coalescing),
                        effective overlay, drafts
      src/client.ts     WorkspaceClient: actions, the sync loop, the pump;
                        HttpTransport for the browser
      tests/fake.ts     FakeServer (mirrors backend semantics) + seeded
                        fault-injecting transport
      tests/sync.test.ts unit tests + the torture suite

## Run

    cd backend  && pip install -e . pytest pytest-asyncio httpx && pytest
    cd frontend && npm install && npm test && npm run typecheck

Dev server: `uvicorn app.main:app --reload` (SQLite in-memory by default;
pass a Postgres URL to `create_app` for the real thing — the choke point's
`with_for_update()` is already the Postgres path). TOPOLOGY INVARIANT:
one process per workspace — serve with a single worker; see TODO §3
before scaling out.

## What the tests pin down (keyed to ARCHITECTURE.md invariants)

Backend: ack-carries-identity (create), CAS failures carry the current
version, write-to-deleted is typed for drafts routing, dedup returns the
recorded outcome on retry (one entry, ever), Initialize adjudicates the
outbox in order inside the same transaction as its snapshot, tokens are
single-use, and the stream splices replay-then-live with no gap (deduped by position
across the subscribe/replay overlap). Blob PUT verifies hashes and dedupes.
Controller tests pin the racy lifecycle: one controller per workspace,
submit serialization (no overlap, ever), ordered fan-out to all streams,
grace-period release with reconnect-cancel, the release/acquire race under
hammering, and visit-created controllers not leaking.

Frontend: outbox ordering + per-entry write coalescing, effective-view
snap-back (rollback is recomputation), stranded-transaction reconciliation
through Initialize, drafts capture on offline create and on
write-to-deleted, same-txn-id create retries never double-mint, and five
seeded torture runs: random request drops, response drops (after the server
applied — the nasty case), stream kills, and Initialize failures, followed
by healing and an assertion of field-level convergence between client
confirmed state and server truth with an empty outbox.

## What the torture test already found

The design as documented had a stranding gap: a request dropped while the
stream stays healthy was never resubmitted, because reconciliation only ran
on loop re-entry and a healthy stream never re-enters. The fix is the
submission pump in `client.ts` — periodic resubmission of queued
transactions, safe by construction because the server dedupes by transaction
id. Two torture seeds caught it before any human would have. Keep the suite;
extend it before extending the design.

## Deliberate scaffold simplifications

Parent is an inline column (production: your FileSystem/FileHierarchy
schema). Fan-out is in-process by design (the controller architecture);
enforcing its one-process-per-workspace invariant on real deployments is
TODO §3 (startup guard, advisory locks). Auth is an
`X-User` header stub. Binary write flow, content caching, drafts recovery
UI, the yjs plane, and the Pyodide bridge are represented in the contract
and architecture docs but not wired here.
