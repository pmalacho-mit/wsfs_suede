# Plan: executions kept, shown, and attached

Two halves that meet at one new idea: **a snapshot is a thing the server
knows about**, and an execution happened against one.

## The idea

Today a snapshot is a client-side act — `Workspace.svelte` takes one, resolves
what is unstored, and hands a list of paths to the assistant. Nothing durable
records *which versions* that was. An execution is worth keeping precisely
because it is evidence about a state of the workspace, so it needs that state
named.

So: **snapshot** becomes a transaction naming entries at versions, and
**execution** becomes a transaction naming a snapshot, an entry within it, and
what came out.

Both are transactions like any other, which means both go through the outbox
and survive being offline — which is the whole reason to make them transactions
rather than side-channel writes.

## Backend

### Two tables

`SnapshotRow` — one row per entry in a snapshot, many per snapshot:

| column | why |
|---|---|
| `snapshot` (indexed) | the snapshot's transaction id |
| `entry_id` | which entry |
| `name_version`, `parent_version`, `deleted_version`, `content_version` | the four tokens that ARE the entry, exactly as `Seen` and `reconstruction` already use |
| `workspace_id`, `user_id`, `timestamp` | who and when |

One row per entry rather than a JSON blob because the interesting query is
"which snapshots named this version", and that is an index on a column.

`ExecutionRow`:

| column | why |
|---|---|
| `id` | the transaction |
| `snapshot` | which state of the workspace it ran against |
| `entry_id` | which file was run |
| `outputs` (JSONB) | what came out, as the kernel produced it |
| `ok` | whether it ended without raising, so "show me failures" is not a JSON scan |
| `workspace_id`, `user_id`, `timestamp` | |

### Two verbs

`Operation.SNAPSHOT` and `Operation.EXECUTE`, joining the six. Both are
`Transacted`, so dedup, `utc_offset` and the outbox all work unchanged.

They are **not** entry-property mutations, which has consequences worth being
explicit about:

- They are not in `Models.logs`, so they are not in the event stream and not in
  the delta chain. Nothing about an entry's current state changes.
- They therefore need no CAS token and cannot conflict. Their refusals are only
  "that entry is not here" and "that snapshot is not here".
- `_writes` must know them, or dedup would think their ids unspent.

A snapshot naming a version that no longer exists is still refused: it is a
claim about a state, and a claim about a state that never was is not worth
keeping.

### Endpoints

Both go through the existing `/transactions` door — that is the point of making
them transactions. Reading them back:

```
GET /workspaces/{id}/snapshots/{transaction}          → the entries and versions
GET /workspaces/{id}/entries/{entry}/executions?limit= → newest first
```

## Client

- `contract.ts` regenerates from the backend's OpenAPI, so `Snapshot` and
  `Execute` arrive typed.
- `Workspace.snapshot(entries)` mints a snapshot transaction from the four
  tokens it already reads for `unsettled`.
- `Workspace.executed(snapshot, entry, outputs, ok)` records one.
- Both are ordinary `submit` calls: queued, persisted, replayed.

## Runner

- `outputs` moves off the component and onto `SharedTextFile` as
  `executions: Execution[]`, where `Execution = { at, outputs, ok, failure? }`.
  It has to live there because the assistant asks the file, not the panel, and
  because closing the panel must not lose them.
- `Run` fires `onRun?.({ entry, started, result })` with the `Promise` in the
  payload, so a caller can await the run without owning it.
- The output view renders every execution, oldest at top, each under a small
  header saying when it ran and whether it raised. It **sticks to the bottom**
  unless the user has scrolled up — a log that yanks you away from what you are
  reading is worse than one that does not follow.
- `Clear` empties `shared.executions`, which is what the assistant is watching.

## Assistant

`AttachedFiles` shows a count per file: *`main.py` · 3 runs*. Reactive, because
`executions` is `$state` on `SharedTextFile` and the snapshot taker reads it.

`Snapshot.Held` gains `executions: number`, so the thing that decides what goes
with a question and the thing that displays it read one value.

## Tests

- **Backend** (`tests/executions.py`): a snapshot round-trips its entries and
  versions; an execution is refused when its snapshot is unknown; both dedup on
  replay; neither appears in the event stream.
- **Client**: both queue and replay through the outbox while offline.
- **Browser, and this is the half that has to be seen** (`Runner.test.svelte`,
  extended): two runs leave two delineated outputs with the newest at the
  bottom; Clear empties them; the attached-files badge counts them and updates
  when they are cleared. Real kernel, real DOM.

## Order of work

1. Backend tables, verbs, endpoints, tests.
2. Regenerate the client contract.
3. `Workspace.snapshot` / `.executed`, client tests.
4. Runner and `SharedTextFile.executions`, browser tests.
5. Assistant count, browser test.

## Not in this

- Replaying an execution, or diffing two.
- Pruning executions. They accumulate; a retention rule is a policy decision.
- Attaching outputs to the assistant's message body. The count is the claim;
  what it sends is a separate question.
