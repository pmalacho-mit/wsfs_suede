namespace Utility {
  export type Expand<T> = T extends infer O ? { [K in keyof O]: O[K] } : never;

  export type Typed<T extends string, Obj = {}> = Expand<Obj & {
    type: T
  }>;
}

export namespace Entry {
  export type Type = "file" | "folder";

  /**
   * Deliberately PURE NAMESPACE: no content descriptor (kind/mime/size/hash).
   * The content plane is revealed by Content fetches and cached client-side
   * (see Client.Content). Stream "write" events are pure invalidation signals.
   */
  export type Metadata = Utility.Typed<Type, {
    id: string;      // server-assigned; clients never mint entry ids
    version: string; // opaque version id — comparable by EQUALITY ONLY (CAS token)
    name: string;
    parent?: string; // absent = workspace root
    deleted?: boolean; // tombstone: deleted entries remain present in snapshots
  }>;

  export type Versioned = Utility.Expand<Pick<Entry.Metadata, "id" | "version">>;
}

export namespace Events {
  export type Transactioned<Obj = {}> = Utility.Expand<Obj & {
    /**
     * Transaction id, format `${client}:${counter}`:
     * - client: GUID minted per client instance (one browser tab = one client)
     * - counter: strictly increasing per client
     * Globally unique (the server dedupes on it), and it encodes submission
     * order — outbox persistence and replay MUST preserve counter order.
     */
    transaction: string
  }>;

  export type Reasoned<Reason extends string, Obj = {}> = Utility.Expand<Obj & {
    reason: Reason;
  }>;

  export type Responded<Rejected extends boolean, Obj = {}> = Utility.Expand<Obj & {
    rejected: Rejected
  }>;

  export type Acknowledged<Obj = {}> = Responded<false, Obj>;

  export type Failure<Reason extends string, Obj = {}> = Responded<true, Obj & Reasoned<Reason>>;

  /**
   * Assume that all client-sent requests (unless noted) are sent with an
   * authentication header, which encodes the user_id of the sender.
   *
   * ONE DOOR FOR STATE: responses never carry applicable state — the client's
   * confirmed map is mutated ONLY by ServerSent.Stream events (and Initialize
   * snapshots). Responses exist to evict/adjudicate outbox entries. The single
   * deliberate exception: Create's ack carries the server-assigned id, which
   * is IDENTITY, not state — it cannot race, regress, or conflict.
   */
  export namespace ClientSent {
    export namespace Create {
      /**
       * ONLINE-ONLY: creates are never queued in the outbox, and neither is
       * anything that depends on an unacknowledged create. Offline, creation
       * fails loudly (UI disables it; a Pyodide `open(path, "w")` on a new
       * path raises a clean filesystem error rather than half-working) —
       * but the CONTENT of the failed create is not discarded: it parks in
       * Client.Drafts for one-click recovery on reconnect.
       *
       * A lost ack is retried with the SAME transaction id; the server
       * dedupes creates on it (this is the one place a duplicate would
       * otherwise mint a duplicate entry).
       */
      export type Request = Transactioned<{
        type: Entry.Type;
        name: string;
        /** id only — the sole precondition is "parent not deleted", checked server-side */
        parent?: string;
      }>

      /**
       * Ack carries the new entry's id so dependent operations (the write
       * right after a create, the optimistic UI row) have something to
       * reference. The entry itself still enters the confirmed map only via
       * the stream's "create" event.
       */
      export type Response = Acknowledged<{ id: string }> | Failure<"parent was deleted">;
    }

    export namespace Delete {
      export type Request = Transactioned<Entry.Versioned>;
      export type Response = Acknowledged | Failure<`later versions modified the ${"content" | "name" | "content and name"} of the entry`>;
    }

    export namespace Reparent {
      export type Request = Transactioned<Entry.Versioned & {
        /**
         * Destination id only — no version. The only destination-related
         * failure is "it was deleted"; requiring its version would make
         * unrelated sibling activity spuriously invalidate this move.
         */
        parent?: string;
      }>;

      export type Response = Acknowledged | Failure<
        | "entry was deleted"
        | "the destination was deleted"
        | "entry with name already exists within destination"
        | "entry had already been moved"
      >;
    }

    export namespace Rename {
      export type Request = Transactioned<Entry.Versioned & {
        /** The new desired name */
        name: string;
      }>;

      export type Response = Acknowledged | Failure<
        | "entry was deleted"
        | "entry with name already exists within destination"
        | "entry was already renamed"
      >;
    }

    export namespace Store {
      /**
       * NOT a JSON request — this is a raw HTTP transfer:
       *
       *   PUT /blobs/{hash}
       *   Content-Type: {mime}
       *   Content-Length: {size}
       *   <bytes as the request body>
       *
       * The server verifies sha256(body) === hash before accepting.
       * Idempotent by construction: if the hash is already stored the server
       * acks immediately without reading the body — which is also the retry
       * story (retrying a Store can never double-store).
       *
       * Non-transactional, but remembered in the outbox so it can be retried
       * after a lost response. A Store must be acknowledged before any Write
       * referencing its hash is submitted.
       */
      export type Request = {
        hash: string;   // sha256 of the bytes; appears in the URL path
        mime: string;   // sent as Content-Type
        size: number;   // sent as Content-Length
        bytes: Blob | Uint8Array | ReadableStream<Uint8Array>; // request body
      }

      export type Response = Acknowledged | Failure<"hash mismatch" | "too large" | "server out of memory">;
    }

    export namespace Write {
      export type Text = Utility.Typed<"text", {
        content: string;
      }>;

      export type Binary = Utility.Typed<"binary", Pick<Store.Request, "hash" | "size" | "mime">>;

      export type Request = Transactioned<Entry.Versioned & (Text | Binary)>;

      export type Response =
        | Acknowledged
        | Failure<"content was already updated", {
            // The newer version id that the request is conflicting with —
            // fetch Content by (id, version) to drive the diff-editor UX.
            version: string;
          }>
        // The target was deleted out from under the write (e.g. remotely,
        // while this client was offline). The transaction is evicted like
        // any typed failure, but the CONTENT routes to Client.Drafts rather
        // than evaporating with it.
        | Failure<"entry was deleted">;
    }

    export namespace Content {
      /**
       * Non-transactional content fetch: GET /entries/{id}/content[?version=]
       * Omitting version requests the latest.
       *
       * ROUTING SEMANTICS: the `type` in the response is what tells the
       * client how to treat this entry (collaborative text editor vs. blob
       * viewer, which cache) — there is deliberately no kind field in
       * Entry.Metadata, so kind is revealed here and cached (Client.Content).
       *
       * For "text" on a live-editable file, the returned content is a
       * pre-sync placeholder that may lag the live yjs room by the
       * persistence debounce: attach the doc and prefer it.
       */
      export type Request = Entry.Versioned | {
        // Only providing an id indicates a request for the latest version
        id: string;
      };

      /**
       * Text is returned as JSON. Binary is returned as raw bytes with
       * Content-Type: {mime} and ETag: {version} (or a short-lived redirect
       * to object storage) — the Binary shape below describes the *parsed*
       * result, not a JSON body carrying bytes.
       */
      type Binary = Utility.Typed<"binary", Omit<Store.Request, "bytes"> & { bytes: Blob }>;
      type Text = Write.Text;

      export type Response = (Binary | Text) & {
        version: string;
      };
    }

    export namespace Initialize {
      /**
       * POST — the reconciliation handshake. Cold start, reconnect, and
       * recovery are all THIS SAME CALL; every stream failure re-enters here.
       */
      export type Request = {
        workspace: string; // ID of the workspace filesystem of interest
        /**
         * The FULL outbox requests (not bare ids — the server cannot apply
         * an unseen transaction from an id alone), in counter order. May
         * include requests minted by OTHER client instances (orphan adoption
         * after a tab closes — ids embed their originating client, so the
         * server can adjudicate them no matter who presents them).
         */
        outbox: Array<
          | Delete.Request
          | Rename.Request
          | Reparent.Request
          | Write.Request
        >;
      }

      export type Rejection = {
        transaction: string;
        /** The typed reason recorded at adjudication time */
        reason: string;
        /** Current version of the affected entry, when applicable — the
         *  material the conflict UX (diff editor, undo) needs NOW, not the
         *  state at the historical moment of rejection. */
        version?: string;
      };

      /**
       * All fields are produced inside ONE repeatable-read database
       * transaction: outbox adjudication (unseen transactions are applied
       * in order as part of this call), snapshot, and the stream position
       * bound into the token. This is what guarantees evict + replace on the
       * client cancel exactly, with no flicker and no gap.
       */
      export type Response = {
        /**
         * Single-use stream token:
         * - random 128-bit value, TTL ~60s (only needs to outlive the gap
         *   between this response and the EventSource connect)
         * - bound server-side to {user, workspace, position}, where position
         *   is the internal stream position of this snapshot
         * - claimed (consumed) atomically when the stream connects; the
         *   stream then replays events after `position` before going live,
         *   so the first streamed event is exactly the first change after
         *   `entries`
         * - NEVER reused: every stream failure re-runs Initialize
         */
        token: string;
        entries: Entry.Metadata[];
        applied: Request["outbox"];
        rejected: Rejection[];
      }
    }
  }

  export namespace ServerSent {
    export type Traceable = {
      /** Absent for server-originated changes (retention jobs, admin
       *  operations, future automatic content-kind transitions). Clients
       *  must not assume every change traces to a client transaction. */
      user?: string;
      /** Preserved from the originating request when one exists. Seeing a
       *  transaction id you own = evict that outbox entry. */
      transaction?: string;
    }

    type Valued<T, Obj = {}> = Obj & { value: T };

    export namespace Stream {
      /**
       * GET /stream?token=...   (Content-Type: text/event-stream)
       *
       * Client rules:
       * - NEVER rely on EventSource's native auto-reconnect: it replays the
       *   same URL, i.e. a spent token. On the first error event: close(),
       *   re-run Initialize, connect with the fresh token (jittered backoff;
       *   reset backoff only once the stream is established).
       * - Server sends comment heartbeats (~15s). Client arms a watchdog
       *   (~45s, reset on any traffic) and treats expiry as a failure.
       *   Acks succeeding while the watchdog fires = a proxy is eating SSE;
       *   surface "live updates unavailable" — the Initialize loop then
       *   degrades gracefully into polling.
       */
      export type Request = {
        token: ClientSent.Initialize.Response["token"];
      }

      /**
       * Every event carries the entry's NEW version (Entry.Versioned) — the
       * CAS token the client must present on its next mutation of the entry.
       *
       * "write" is a PURE INVALIDATION SIGNAL: it carries no payload by
       * design. It means "cached content and content-metadata (including
       * kind) for this id are stale"; the next Content fetch reveals the
       * rest. "create" is the one upsert-shaped event, since a new entry
       * must arrive whole.
       */
      export type Response = Utility.Expand<Entry.Versioned & Traceable & (
        | Utility.Typed<"create", Entry.Metadata>
        | Utility.Typed<"write">
        | Utility.Typed<"delete", Valued<boolean>>
        | Utility.Typed<"name", Valued<string>>
        | Utility.Typed<"parent", Valued<string | undefined>> // undefined = moved to workspace root
      )>
    }
  }
}

export namespace Client {
  export namespace Outbox {
    export type Entry = {
      /**
       * GUID generated on page load that enables determining if an outbox
       * entry was added in the current session or not. An entry added this
       * session already triggered an optimistic UI change; entries surviving
       * a reload are guaranteed NOT to be reflected in the UI, since the UI
       * initializes from the Initialize snapshot (which cannot include
       * un-applied transactions) plus a replay of the persisted outbox.
       */
      session: string;
      /** ISO 8601 UTC with explicit Z, e.g. "2026-07-04T21:15:00.000Z" —
       *  string-sortable and unambiguous. (Ordering authority is the
       *  transaction counter, not this; the timestamp is for humans.) */
      timestamp: string;
      /**
       * NOTE: Create is deliberately NOT in this union — creates are
       * online-only and never queued (see ClientSent.Create). Store entries
       * keep only {hash, mime, size} here; the bytes live in a separate
       * IndexedDB store keyed by hash. Large Write.Text payloads may use the
       * same trick (store by hash, reference here) so the log never balloons.
       * Successive Writes to the same entry coalesce (the later supersedes).
       */
      request:
      | Events.ClientSent.Delete.Request
      | Events.ClientSent.Rename.Request
      | Events.ClientSent.Reparent.Request
      | Events.ClientSent.Write.Request
      | Omit<Events.ClientSent.Store.Request, "bytes">
    }

    /**
     * What actually gets persisted to the browser's storage (IndexedDB —
     * localStorage cannot hold blob payloads and has no cross-tab locking
     * story). Three-level keying: user, then workspace, then client instance.
     *
     * Entries are ORDERED (counter order) — replay depends on it. `Map` and
     * arrays here express semantics; the storage encoding may differ.
     *
     * MULTI-TAB: one tab = one client = one queue = one sync loop. This is
     * correct by construction (tabs converge through the same stream; the
     * server dedupes by transaction id) — merely wasteful. A tab may adopt an
     * orphaned client queue (its tab closed with pending entries) by taking a
     * Web Locks lock named for that client id and presenting its transaction
     * ids in the next Initialize. Leader election (one loop for all tabs,
     * fan-out via BroadcastChannel) is a later optimization, not a
     * correctness requirement.
     */
    export type Log =
      Map<
        NonNullable<Events.ServerSent.Traceable["user"]>,
        Map<
          Events.ClientSent.Initialize.Request["workspace"],
          Map<
            string, // client instance GUID
            Entry[] // ordered by transaction counter
          >
        >
      >
  }

  export namespace Content {
    /**
     * Per-entry content cache, populated by Content fetches, invalidated by
     * "write" and "delete" stream events for that id. This is where the
     * content plane (kind/mime/size) lives client-side — Entry.Metadata
     * stays pure namespace.
     */
    export type Cache = Map<
      Entry.Metadata["id"],
      Events.ClientSent.Content.Response
    >;

    /**
     * Read flow for an entry's content (e.g. a Pyodide read):
     * 1. yjs doc open for this file on this client -> use the doc's content
     * 2. content open in an ACTIVE non-yjs editor -> use that buffer.
     *    "Active" must mean visible/dirty in the current session, not merely
     *    mounted — a forgotten background tab's stale buffer must not shadow
     *    fresher server content indefinitely.
     * 3. cache hit -> use it
     * 4. fetch Content (with a deadline), populate the cache
     * 5. fetch fails/offline -> clean filesystem error through the bridge;
     *    a hung fetch must never wedge the Atomics-blocked worker
     *
     * Accepted tradeoff: the first open of an unfetched file needs one fetch
     * before the client knows how to present it (kind is revealed by
     * Content, not Metadata). Offline with a cold cache, kind is UNKNOWN —
     * represent that honestly in the UI rather than guessing.
     */
  }

  export namespace Drafts {
    /**
     * The parking lot — deliberately NOT sync machinery. A draft has no
     * version, cannot conflict, and never touches the stream: it exists
     * precisely because its content has nowhere to live server-side yet.
     * Its job is the last mile of "a user never loses work": when the sync
     * design must fail an operation loudly, the BYTES survive the failure.
     *
     * A draft is captured when:
     * - a Create cannot complete (offline / no ack): e.g. Pyodide finishing
     *   a twenty-minute computation and writing the result to a new path
     *   with no connectivity — the call fails cleanly, the content lands here
     * - a Write fails with "entry was deleted": the typed failure evicts the
     *   transaction as usual, but the content routes here instead of
     *   evaporating with it
     *
     * On reconnect (the sync loop re-entering Initialize is the natural
     * hook), surface pending drafts ("2 files couldn't be saved while
     * offline") with one-click recovery: replay Create -> Store (a no-op if
     * the hash is already stored) -> Write, in order, online. Evict a draft
     * only on successful recovery or explicit user dismissal — never
     * silently.
     */
    export type Draft = {
      id: string;        // GUID for the draft itself
      /** Page-load session GUID — same semantics as Outbox.Entry.session */
      session: string;
      /** ISO 8601 UTC with explicit Z */
      timestamp: string;
      workspace: string;
      intent:
      | {
        kind: "create";
        /** Intended path at capture time (e.g. "/results/out.csv") —
         *  recorded as a path, since no entry id ever existed */
        path: string;
        type: Entry.Type;
      }
      | {
        kind: "write";
        /** The entry that was deleted out from under the write */
        entry: Entry.Metadata["id"];
        /** Path at capture time, for display and for re-creation
         *  (recovery of this case is a Create — the original id is a
         *  tombstone and stays one) */
        path: string;
      };
      /**
       * Absent for folder creates. Bytes live in the same content-addressed
       * IndexedDB store the outbox uses (keyed by hash) — a draft row is a
       * pointer, so drafts stay cheap regardless of content size.
       */
      content?: {
        hash: string;
        size: number;
        mime: string;
      };
    };

    export type Store = Map<Draft["id"], Draft>;
  }
}

export namespace Server {
  /**
   * Authoritative-side sketch. Everything here is INTERNAL — none of it
   * leaks into the client contract above.
   */

  /**
   * Durable record of every adjudicated transaction (the audit log, the
   * dedup table, and the source of Initialize's applied/rejected — one
   * table, three roles). Write payloads are stored content-addressed
   * (hash -> blob store) so this stays rows-of-pointers, never ballooning.
   * Retention must exceed the maximum tolerated client offline age; a
   * presented transaction older than retention is answered "cannot
   * reconcile", never guessed at.
   */
  export type Transaction = {
    id: string;        // the client transaction id (globally unique by construction)
    user: string;
    workspace: string;
    outcome: { rejected: false } | { rejected: true; reason: string };
    position: number;  // internal stream position at which it applied (if applied)
  };

  /**
   * Internal per-workspace monotonic stream position:
   * - assigned under a per-workspace lock, in the SAME database transaction
   *   as the mutation, the Transaction record, and the stream event row —
   *   the event log is generated from the truth, so it cannot drift from it
   * - orders the SSE stream and anchors tokens
   * - retention of event rows: MINUTES, not days — a resume never spans more
   *   than the Initialize->connect gap plus reconnect blips; anything longer
   *   re-enters through Initialize and gets a fresh snapshot
   * - never client-visible: clients reason only via Initialize + the stream
   */
  export type Token = {
    token: string;     // 128-bit random
    user: string;
    workspace: string;
    position: number;  // stream position of the Initialize snapshot
    expires: string;   // ~60s TTL
    // Claimed atomically on stream connect (DELETE ... RETURNING):
    // single-use enforcement and lookup in one statement.
  };
}

/*
CLIENT STATE MODEL — two layers, one door:

The client keeps a CONFIRMED map of filesystem metadata:

  Map<Entry.Metadata["id"], Entry.Metadata>

The confirmed map is mutated ONLY by:
- the `entries` snapshot of an Initialize response (replace-all)
- Events.ServerSent.Stream events (create upserts; delete/name/parent set
  fields; every event also advances the entry's version)

Request responses NEVER mutate the confirmed map (the one-door rule). They
adjudicate the outbox: an ack or a failure evicts the transaction. The
exception that proves the rule: Create's ack yields the new entry's id —
identity, not state.

What the UI and the Pyodide filesystem read is the EFFECTIVE view:

  effective(id) = outbox.replayOver(confirmed)

So optimistic updates are not applied anywhere — they are DERIVED. When a
transaction is evicted because its stream event arrived, the confirmed
change and the overlay removal cancel exactly (no flicker). When it is
evicted by a failure, the effective view snaps back automatically — "undo on
failure" is not an operation, it is a recomputation.

OUTBOX LIFECYCLE:

Before sending any transactional request, the client persists it to the
outbox (IndexedDB). It is evicted when: (a) its response arrives (ack or
typed failure — failures route to the conflict UX), (b) its transaction id
is echoed on the stream, or (c) an Initialize response reports it applied or
rejected. A create is never persisted: it either round-trips online (with a
same-id retry on a lost ack) or fails loudly — with its content parked in
drafts.

DRAFTS (the parking lot):

The outbox guarantees no ACCEPTED work is lost; drafts guarantee no CONTENT
is lost when an operation must fail loudly. Offline create -> the call fails,
the bytes park in Client.Drafts. Write to a remotely-deleted entry -> the
typed failure evicts the transaction, the bytes park. On reconnect, drafts
are surfaced for one-click recovery (Create -> Store -> Write, replayed
online) and evicted only on success or explicit dismissal. Drafts carry no
version and cannot conflict — they live deliberately outside the sync
machinery, which is why they add no complexity to it.

SYNC LOOP (cold start == reconnect == recovery):

  loop:
    Initialize(workspace, outbox txn ids)      // adjudicates + snapshots
    evict applied/rejected; replace confirmed  // same server tx -> no flicker
    connect EventSource with the token         // single-use, position-bound
    consume events until failure/watchdog
    jittered exponential backoff; re-enter

Never let EventSource auto-reconnect (spent token). Reset backoff only on an
established stream. Re-enter the loop on visibilitychange-to-visible and
`online` as well — Initialize with an empty outbox against an unchanged tree
is a cheap no-op.

ORDERING NOTE: because responses carry no state, the old concern about
"response vs. stream event arriving in either order" dissolves — both paths
only evict from the outbox (idempotent), and state flows through exactly one
ordered channel.

FAILURE HANDLING remains the client's policy decision, e.g.:
- ignoring content-write failures when a live (yjs-backed) editor is open —
  the doc is the truth there, and all text mutations flow through it
- displaying a diff editor when a text write fails on a non-live editor
  (fetch Content at the failure's `version` for the other side of the diff)
- parking content in Client.Drafts when the failure would otherwise discard
  bytes (offline create, write to a deleted entry)
- letting a failed move/rename/delete snap back in the UI via eviction
*/
