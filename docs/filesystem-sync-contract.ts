namespace Utility {
  export type Expand<T> = T extends infer O ? { [K in keyof O]: O[K] } : never;

  export type Typed<T extends string, Obj = {}> = Utility.Expand<Obj & {
    type: T
  }>;
}

export namespace Entry {
  export type Type = "file" | "folder";

  /**
   * A version token: the id of the transaction that last set one property of
   * one entry. Comparable by EQUALITY ONLY — it is a compare-and-swap token,
   * not a counter, and there is no "newer than" relation on it.
   *
   * The client minted it, which is the whole point: it knows what token its
   * own operation will produce before the response arrives, so it can chain a
   * whole session's work offline without the server remapping anything.
   */
  export type Version = string;

  /**
   * Deliberately PURE NAMESPACE: no content descriptor (kind/mime/size/hash).
   * The content plane is revealed by Content fetches and cached client-side
   * (see Client.Content). Stream "write" events are pure invalidation signals.
   *
   * The four tokens are per-PROPERTY, and that independence is load-bearing:
   * a collaborator writing content does not invalidate your pending rename,
   * because the two present different tokens.
   */
  export type Metadata = Utility.Typed<Type, {
    /** Client-minted. See Identity below. */
    id: string;
    name: string;
    parent?: string; // absent = workspace root

    /**
     * Tombstone. Deleted entries remain present in snapshots, and deleting a
     * folder tombstones THE FOLDER ONLY — its children are untouched and
     * still carry `parent` pointers into it.
     *
     * REACHABILITY IS THE CLIENT'S TO COMPUTE, and it is not optional. A
     * snapshot therefore contains entries whose parent chain is interrupted
     * by a tombstone; rendering `deleted !== true` alone shows folders and
     * files that no longer exist as far as the tree is concerned. The rule
     * is: an entry is reachable when every ancestor up to the root exists and
     * none of them is tombstoned. It must be recomputed after every `delete`
     * and every `parent`/`move` event, because either can interrupt or
     * restore a whole subtree at once, and the events for that subtree's own
     * members never fire.
     *
     * The server holds nothing else: this is the whole of what a "deleted
     * folder" means, and the same walk is what refuses a create into an
     * unreachable folder ("parent was deleted").
     */
    deleted?: boolean;

    name_version: Version;
    parent_version: Version;
    deleted_version: Version;
    /** Absent for an entry that has never been written. */
    content_version?: Version;
  }>;

  /**
   * IDENTITY. Every id crossing this contract — entry ids and transaction ids
   * alike — is minted by the client, with a platform CSPRNG
   * (`crypto.randomUUID()`, never `Math.random()`). UUIDv7 is preferred: same
   * collision safety, better index locality on the server's append-only
   * tables, at the cost of leaking creation time (already visible here).
   *
   * Mint once and persist. A retry MUST reuse the same id — that is what
   * makes a retry free rather than a duplicate.
   *
   * The server does not remap. An entry id already in use is answered with a
   * typed refusal ("that id is already in use"), never with a "call it y
   * instead" instruction: a remap would reintroduce exactly the local-id →
   * server-id table that client-minted identity exists to delete, and every
   * queued item still holding the old id would be wrong.
   */
}

export namespace Events {
  export type Transactioned<Obj = {}> = Utility.Expand<Obj & {
    /**
     * Client-minted transaction id, unique across all clients.
     *
     * It does three jobs at once: it is the dedup key the server answers a
     * retry from, it becomes the primary key of the row the server appends,
     * and once applied it IS the new version token for the property this
     * request changed. The client therefore knows the token its own work
     * produces at mint time, without a round trip.
     */
    transaction: string;
    /** The entry this request is about. */
    id: string;
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
   * A refusal every operation can produce, and the only one that is not an
   * ordinary conflict. A presented token is in one of three states:
   *
   *   current      → accepted
   *   superseded   → ordinary conflict; rebase onto the token in the refusal
   *   never issued → the client's state is unsound: discard it, re-Initialize
   *
   * Answering the third as an ordinary conflict sends a client into a retry
   * loop it cannot win, which is why it has its own reason.
   */
  export type Unsound = Failure<"the version presented was never issued">;

  /** The entry id names nothing this workspace has ever held. */
  export type Unknown = Failure<"no such entry">;

  /**
   * Assume that all client-sent requests (unless noted) are sent with an
   * authentication header, which encodes the user_id of the sender.
   *
   * ONE DOOR FOR STATE, without exception: the client's confirmed map is
   * mutated ONLY by ServerSent.Stream events and Initialize snapshots.
   * Responses never carry state — they exist to evict/adjudicate outbox
   * entries. (Create used to be the exception, because only the server could
   * mint an entry id. It no longer is.)
   */
  export namespace ClientSent {
    export namespace Create {
      /**
       * Queued like everything else. The client already knows the id, so an
       * offline create is an ordinary outbox entry rather than a failure with
       * its bytes parked in a draft.
       *
       * A lost ack is retried with the SAME transaction id AND the same entry
       * id; the server answers from its record instead of minting a second
       * entry.
       */
      export type Request = Transactioned<{
        type: Entry.Type;
        name: string;
        /** id only — the sole precondition is "parent still reachable" */
        parent?: string;
        /**
         * A file is born with its content; a folder is born with none.
         * Required either way, so "empty file" is something a client SAYS
         * (`{type: "text", content: ""}`) rather than something it omits.
         *
         * An entry therefore never exists in a contentless state, which is
         * what lets every Write present a content token that is really there
         * — and what lets a twenty-minute Pyodide computation finishing
         * offline become one queued transaction rather than two.
         */
        content: Write.Text | Write.Binary | null;
      }>

      /**
       * NAME COLLISIONS ARE NOT REFUSED HERE. A create has no prior version
       * to compare against, so refusing it would be the only thing standing
       * between two offline clients and a lost `notes.md`.
       *
       * Instead the create is applied UNDER THE REQUESTED NAME, and the
       * controller renames it to " (2)", " (3)" … in the same database
       * transaction. Two events reach the stream — a `create` carrying the
       * name that was asked for, then a `name` carrying the one that settled
       * — so the client learns the outcome through the ordinary one door
       * rather than through a special case in the create response.
       *
       * NAMES SETTLE AT THE END OF THE CALL, not at the create. So a queued
       * `create notes.md` followed by a queued `rename report.md` produces NO
       * controller rename at all: by the time names settle the entry is
       * called `report.md` and nothing collides. That is the ordinary offline
       * gesture — make a file, then type its name — and it costs nothing.
       *
       * When two entries do end up holding one name, the one whose name is
       * older keeps it.
       *
       * The one identity failure: an entry id already in use. Checked
       * globally, and answered without saying anything else, so an id cannot
       * be used to probe for entries in workspaces the caller cannot see.
       */
      export type Response =
        | Acknowledged
        | Failure<"that id is already in use">
        | Failure<"parent was deleted">
        /**
         * A parent that never existed, which client-minted ids make routine:
         * every create queued behind a REFUSED create points at a folder
         * nobody made. Distinct from "parent was deleted", which describes a
         * deletion that in this case never happened.
         */
        | Failure<"no such parent">
        | Failure<"that parent is not a folder">
        | Failure<"content bytes were never stored">
        | Failure<"that name is not permitted">
        | Failure<"that destination is nested too deeply">
        | Failure<"that folder already holds too many entries">;
    }

    export namespace Delete {
      /**
       * Delete is the destructive operation, so it presents everything it was
       * looking at rather than just the property it changes. "Has the deleted
       * flag moved" is almost never the useful question; "is this still the
       * thing I was told to destroy" is.
       */
      export type Seen = {
        name_version: Entry.Version;
        parent_version: Entry.Version;
        deleted_version: Entry.Version;
        /** Required, and null for a folder, which holds none. */
        content_version: Entry.Version | null;
      };

      export type Request = Transactioned<{ seen: Seen }>;

      /**
       * Deleting what is already deleted is ACKNOWLEDGED, not refused: it is
       * what the caller asked for, and there is no honest reason string for
       * it. A move counts as a change of "name" below — both change where the
       * entry lives in the namespace.
       */
      export type Response =
        | Acknowledged
        | Unknown
        | Unsound
        | Failure<`later versions modified the ${"content" | "name" | "content and name"} of the entry`>;
    }

    export namespace Move {
      /**
       * A rename and a reparent as one transaction.
       *
       * A filesystem `mv` changes where an entry lives and what it is called
       * at once, and doing that as two transactions can half-succeed: the
       * rename lands, the reparent is refused, and the entry ends up somewhere
       * nobody asked for. This presents BOTH tokens and takes both positions
       * or neither, and it arrives as ONE `move` event rather than as a pair
       * a client would have to recognise as belonging together.
       */
      export type Request = Transactioned<{
        name: string;
        name_version: Entry.Version;
        parent?: string;
        parent_version: Entry.Version;
      }>;

      export type Response = Acknowledged | Unknown | Unsound | Failure<
        | "entry was deleted"
        | "entry was already renamed"
        | "entry had already been moved"
        | "the destination was deleted"
        | "no such destination"
        | "that destination is not a folder"
        | "the destination is inside the entry"
        | "entry with name already exists within destination"
        | "that name is not permitted"
        | "that destination is nested too deeply"
        | "that folder already holds too many entries"
      >;
    }

    export namespace Reparent {
      export type Request = Transactioned<{
        /**
         * Destination id only — no version. The only destination-related
         * failures are structural; requiring its version would make unrelated
         * sibling activity spuriously invalidate this move.
         */
        parent?: string;
        parent_version: Entry.Version;
      }>;

      export type Response = Acknowledged | Unknown | Unsound | Failure<
        | "entry was deleted"
        | "the destination was deleted"
        | "no such destination"
        | "that destination is not a folder"
        | "the destination is inside the entry"
        | "entry with name already exists within destination"
        | "entry had already been moved"
        | "that destination is nested too deeply"
        | "that folder already holds too many entries"
      >;
    }

    export namespace Rename {
      export type Request = Transactioned<{
        /** The new desired name */
        name: string;
        name_version: Entry.Version;
      }>;

      /**
       * Unlike a create, a rename IS refused on collision: the user typed a
       * specific name and deserves to be told, rather than silently given
       * `notes (2).md`.
       */
      export type Response = Acknowledged | Unknown | Unsound | Failure<
        | "entry was deleted"
        | "entry with name already exists within destination"
        | "entry was already renamed"
        | "that name is not permitted"
      >;
    }

    export namespace Store {
      /**
       * NOT a JSON request — this is a raw HTTP transfer:
       *
       *   PUT /workspaces/{workspace}/blobs/{hash}
       *   Content-Type: {mime}
       *   Content-Length: {size}
       *   <bytes as the request body>
       *
       * The server verifies sha256(body) === hash before accepting.
       * Idempotent by construction: if the hash is already stored the server
       * acks immediately without reading the body — which is also the retry
       * story (retrying a Store can never double-store).
       *
       * Content-Length is REQUIRED: without it the body's size is unknown
       * until it has been buffered, which is the thing the limit exists to
       * prevent.
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

      export type Response = Acknowledged | Failure<"hash mismatch" | "too large">;
    }

    export namespace Write {
      export type Text = Utility.Typed<"text", {
        content: string;
      }>;

      export type Binary = Utility.Typed<"binary", Pick<Store.Request, "hash" | "size" | "mime">>;

      export type Request = Transactioned<{
        /**
         * Never null: a file is born with content, so there is always a token
         * to present. A folder has none, and a write to one is refused for
         * being a folder before its token is ever considered.
         */
        content_version: Entry.Version;
      } & (Text | Binary)>;

      export type Response =
        | Acknowledged
        | Unknown
        | Unsound
        | Failure<"content was already updated", {
            // The newer content token this request is conflicting with —
            // fetch Content by (id, content_version) for the diff editor.
            version: Entry.Version;
          }>
        // The target was deleted out from under the write (e.g. remotely,
        // while this client was offline). The transaction is evicted like
        // any typed failure, but the CONTENT routes to Client.Drafts rather
        // than evaporating with it.
        | Failure<"entry was deleted">
        | Failure<"content cannot be written to a folder">
        | Failure<"content bytes were never stored">;
    }

    export namespace Content {
      /**
       * Non-transactional content fetch:
       *
       *   GET /workspaces/{ws}/entries/{id}/content[?content={content_version}]
       *
       * Omitting `content` requests the entry's newest. The token comes
       * straight out of Entry.Metadata, so a client fetches with what it
       * already holds.
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
      export type Request = {
        id: string;
        content_version?: Entry.Version;
      };

      /**
       * Text is returned as JSON. Binary is returned as raw bytes with
       * Content-Type: {mime} and ETag: {content_version} (or a short-lived
       * redirect to object storage) — the Binary shape below describes the
       * *parsed* result, not a JSON body carrying bytes.
       */
      type Binary = Utility.Typed<"binary", Omit<Store.Request, "bytes"> & { bytes: Blob }>;
      type Text = Write.Text;

      export type Response = (Binary | Text) & {
        version: Entry.Version;
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
         * after a tab closes — the server adjudicates them no matter who
         * presents them).
         *
         * NOTHING IS REWRITTEN SERVER-SIDE. Each queued item presents the
         * token it expects, and for a chain on one entry that token is the
         * previous item's own transaction id — which the client minted. An
         * outbox that would conflict with itself is a client bug, not
         * something the server patches up mid-replay.
         *
         * If a queued Create is refused, every later item naming that entry
         * is refused with "the create this depends on was refused" rather
         * than being attempted and producing a cascade of "no such entry".
         */
        outbox: Array<
          | Create.Request
          | Delete.Request
          | Rename.Request
          | Reparent.Request
          | Move.Request
          | Write.Request
        >;
      }

      export type Rejection = {
        transaction: string;
        /** The typed reason, computed at adjudication time */
        reason: string;
        /** Current token of the property the request lost, when applicable —
         *  the material the conflict UX (diff editor, undo) needs NOW, not
         *  the state at the historical moment of rejection. A Delete gets
         *  none: it presented four tokens, so what it needs back is a fresh
         *  look at the entry, which `entries` already gave it. */
        version?: Entry.Version;
      };

      /**
       * All fields are produced inside ONE database transaction, serialized
       * against every other write to this workspace: outbox adjudication
       * (unseen transactions are applied in order as part of this call),
       * snapshot, and the stream position bound into the token. This is what
       * guarantees evict + replace on the client cancel exactly, with no
       * flicker and no gap.
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
        /** Transaction ids, which is all an eviction needs. */
        applied: string[];
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
       * Every event carries `transaction`, which does both jobs: it is the id
       * of the transaction that caused the change (seeing one you own = evict
       * that outbox entry) AND it is the new version token for the property
       * the event changed. The client's rule is uniform: on an event for
       * property P, set the value and set P's token to `transaction`.
       *
       * "write" is a PURE INVALIDATION SIGNAL: it carries no value by
       * design. It means "cached content and content-metadata (including
       * kind) for this id are stale"; the next Content fetch reveals the
       * rest. "create" is the one upsert-shaped event, since a new entry must
       * arrive whole — and its metadata rides in `value` like every other
       * event's payload, because spreading it over the event would shadow the
       * entry's own `type` ("file"/"folder") with the event's.
       */
      export type Response = Utility.Expand<Traceable & {
        id: string;
        transaction: string;
      } & (
        | Utility.Typed<"create", Valued<Entry.Metadata>>
        | Utility.Typed<"write">
        | Utility.Typed<"delete", Valued<boolean>>
        | Utility.Typed<"name", Valued<string>>
        | Utility.Typed<"parent", Valued<string | undefined>> // undefined = moved to workspace root
        | Utility.Typed<"move", Valued<{ name: string; parent?: string }>>
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
       * Creates ARE queued: the client minted the id, so nothing downstream
       * of a create has to wait for a response to know what to reference.
       * Store entries keep only {hash, mime, size} here; the bytes live in a
       * separate IndexedDB store keyed by hash. Large Write.Text payloads may
       * use the same trick. Successive Writes to the same entry coalesce (the
       * later supersedes) — and because the later one presents the earlier
       * one's transaction id as its token, coalescing means inheriting the
       * SURVIVOR's content and the DROPPED entry's token.
       */
      request:
      | Events.ClientSent.Create.Request
      | Events.ClientSent.Delete.Request
      | Events.ClientSent.Rename.Request
      | Events.ClientSent.Reparent.Request
      | Events.ClientSent.Move.Request
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
     * Web Locks lock named for that client id and presenting its requests in
     * the next Initialize. Leader election (one loop for all tabs, fan-out
     * via BroadcastChannel) is a later optimization, not a correctness
     * requirement.
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
     * precisely because its content has nowhere to live server-side.
     *
     * It is now down to ONE intent. The offline-create case is gone: a
     * client mints the entry id itself, so an offline create is an ordinary
     * queued transaction and its content is an ordinary queued write.
     *
     * What remains is the case with genuinely nowhere to go: a Write refused
     * with "entry was deleted". The typed failure evicts the transaction as
     * usual, but the BYTES route here rather than evaporating with it.
     *
     * On reconnect (the sync loop re-entering Initialize is the natural
     * hook), surface pending drafts ("2 files couldn't be saved") with
     * one-click recovery: mint a new entry id, replay Create -> Store (a
     * no-op if the hash is already stored) -> Write. The original id is a
     * tombstone and stays one. Evict a draft only on successful recovery or
     * explicit user dismissal — never silently.
     */
    export type Draft = {
      id: string;        // GUID for the draft itself
      /** Page-load session GUID — same semantics as Outbox.Entry.session */
      session: string;
      /** ISO 8601 UTC with explicit Z */
      timestamp: string;
      workspace: string;
      /** The entry that was deleted out from under the write */
      entry: Entry.Metadata["id"];
      /** Path at capture time, for display and for re-creation */
      path: string;
      content: {
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
   * An entry is pure identity. Its name, its parent, its deletion and its
   * content each live in their own append-only log, and each row records the
   * workspace position it landed at. Current state is the newest row per log;
   * there is no materialised "version" row, because there is nothing it would
   * hold that those rows do not.
   *
   * There is no separate transaction table either. A transaction that was
   * APPLIED is the row it appended — its client-minted id is that row's
   * primary key, so dedup is primary-key identity rather than a secondary
   * index somebody has to remember to keep.
   *
   * A transaction that was REFUSED is recorded nowhere, because nothing
   * happened. Adjudication is a pure function of the workspace, so presenting
   * a refused transaction again recomputes its reason — against the workspace
   * as it stands, which is the answer the client can actually act on.
   */

  /**
   * Internal per-workspace monotonic stream position:
   * - assigned under a per-workspace lock and stamped onto the rows the
   *   transaction appends, in one database transaction — those rows ARE the
   *   event stream, so there is no second write to fail independently
   * - one transaction takes exactly one position, and WHICH LOG its rows
   *   landed in is which event it was. Only a create writes more than one log
   *   at a position, which is what makes a birth recognisable from a change
   * - orders the SSE stream and anchors tokens
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
  a field and that field's token)

Request responses NEVER mutate the confirmed map. They adjudicate the outbox:
an ack or a failure evicts the transaction. There is no exception to this — a
create's id came from the client, so an ack has nothing to add.

What the UI and the Pyodide filesystem read is the EFFECTIVE view:

  effective(id) = outbox.replayOver(confirmed)

So optimistic updates are not applied anywhere — they are DERIVED. When a
transaction is evicted because its stream event arrived, the confirmed
change and the overlay removal cancel exactly (no flicker). When it is
evicted by a failure, the effective view snaps back automatically — "undo on
failure" is not an operation, it is a recomputation.

TOKENS, AND CHAINING OFFLINE:

Because the client mints the transaction id, and that id becomes the property's
token, a queued chain needs no server help:

  rename A  (transaction T1, name_version = whatever the client held)
  rename A  (transaction T2, name_version = T1)
  rename A  (transaction T3, name_version = T2)

All three apply in order on replay. The same holds across operations: a queued
create with transaction C is followed by a write presenting content_version C,
and a rename presenting name_version C — because a create sets ALL FOUR of an
entry's tokens to its own transaction id. A create whose name has to be
deduped is the only thing that moves a token nobody minted, and it settles
after the whole outbox — so a rename queued behind it has already won by then.

The per-property split is what keeps this from being over-eager: a
collaborator's write moves content_version and nothing else, so a queued
rename still applies.

OUTBOX LIFECYCLE:

Before sending any transactional request, the client persists it to the
outbox (IndexedDB). It is evicted when: (a) its response arrives (ack or
typed failure — failures route to the conflict UX), (b) its transaction id
is echoed on the stream, or (c) an Initialize response reports it applied or
rejected.

SYNC LOOP (cold start == reconnect == recovery):

  loop:
    Initialize(workspace, outbox)              // adjudicates + snapshots
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
- parking content in Client.Drafts when a write is refused because its entry
  was deleted
- letting a failed move/rename/delete snap back in the UI via eviction
- treating "the version presented was never issued" as a HARD RESYNC signal
  rather than a conflict: discard local state and re-enter the loop
*/
