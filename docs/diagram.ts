/**
 * Diagrams for ARCHITECTURE.md, authored as TypeScript types.
 *
 * Every *exported* alias below is emitted as a Mermaid diagram and embedded
 * into the document at its `<!-- diagram: Name -->` marker:
 *
 *   ./typescript2mermaid-suede/cli.sh --embed docs/ARCHITECTURE.md
 *
 * (Sources default to this file — `diagram.ts` sitting next to the document.)
 *
 * Where a diagram describes *data*, it references the real declarations in
 * `filesystem-sync-contract.ts` and lets the type checker resolve their shapes
 * into the output: the class and ER diagrams below cannot drift from the
 * contract, and a rename there fails this file rather than silently producing
 * a lie. Flow and state diagrams use local marker aliases, since their nodes
 * are moments and components rather than payloads.
 *
 * Contract types are aliased locally before use — the alias name is the id
 * that reaches Mermaid, so `Client.Outbox.Entry` reads as `OutboxEntry` rather
 * than a bare `Entry` colliding with the tree's own. `Omit`/intersection
 * overrides are used only to keep a member from rendering as a multi-line
 * inline object literal (which Mermaid cannot parse); the members that remain
 * are the contract's own.
 */

import type {
  Class,
  Entity,
  Flowchart,
  Sequence,
  State,
} from "../typescript2mermaid-suede/index.js";

import type {
  Client,
  Entry,
  Events,
  Server,
} from "./filesystem-sync-contract.js";

/* ==================================================================== *
 * §1 — The two planes
 * ==================================================================== */

type Editor = {};
type YDoc = {};
type Liveblocks = {};
type Postgres = {};
type Outbox = {};
type ConfirmedMap = {};
type Stream = {};
type ReadPriority = {};
type WritePolicy = {};

export type TwoPlanes = Flowchart.Diagram<
  "topdown",
  [
    Flowchart.Node<Editor, "stadium", "Editor / Pyodide">,
    Flowchart.Subgraph<
      "Collaboration plane — concurrent, peer-shaped",
      [
        Flowchart.Node<YDoc, "rounded", "Y.Doc per open text file">,
        Flowchart.Node<Liveblocks, "rounded", "Liveblocks room">,
        Flowchart.Connect<YDoc, Liveblocks, "CRDT merge">,
      ]
    >,
    Flowchart.Subgraph<
      "Authority plane — server-authoritative, one ordered stream",
      [
        Flowchart.Node<Outbox, "database", "Outbox (IndexedDB)">,
        Flowchart.Node<ConfirmedMap, "rounded", "Confirmed map">,
        Flowchart.Node<Postgres, "database", "Postgres — the source of truth">,
        Flowchart.Node<Stream, "parallelogram", "SSE event stream">,
        Flowchart.Connect<Outbox, Postgres, "transactions">,
        Flowchart.Connect<Postgres, Stream, "events generated from the truth">,
        Flowchart.Connect<Stream, ConfirmedMap, "the one door">,
      ]
    >,
    Flowchart.Connect<Editor, YDoc, "open text file">,
    Flowchart.Connect<Editor, Outbox, "tree + content commits">,
    Flowchart.Subgraph<
      "The only two seams",
      [
        Flowchart.Node<
          ReadPriority,
          "hexagon",
          "1. Read priority — a live doc outranks everything"
        >,
        Flowchart.Node<
          WritePolicy,
          "hexagon",
          "2. Write failure ignored while a live editor is open"
        >,
      ]
    >,
    Flowchart.Connect<YDoc, ReadPriority, never, "dotted">,
    Flowchart.Connect<ConfirmedMap, ReadPriority, never, "dotted">,
    Flowchart.Connect<YDoc, WritePolicy, never, "dotted">,
    Flowchart.Connect<Outbox, WritePolicy, never, "dotted">,
    Flowchart.DefineClass<
      "collab",
      "fill:#e8f0fe,stroke:#4285f4,stroke-width:2px"
    >,
    Flowchart.DefineClass<
      "authority",
      "fill:#e6f4ea,stroke:#34a853,stroke-width:2px"
    >,
    Flowchart.DefineClass<"seam", "fill:#fef7e0,stroke:#f9ab00,stroke-width:2px">,
    Flowchart.ApplyClass<[YDoc, Liveblocks], "collab">,
    Flowchart.ApplyClass<[Outbox, ConfirmedMap, Postgres, Stream], "authority">,
    Flowchart.ApplyClass<[ReadPriority, WritePolicy], "seam">,
  ]
>;

/* ==================================================================== *
 * §2 — Vocabulary, resolved from the contract
 * ==================================================================== */

/** `type` is re-declared only so it prints as the union rather than `Typed`'s generic. */
type EntryMetadata = Omit<Entry.Metadata, "type"> & { type: Entry.Type };
type Versioned = Entry.Versioned;
/** The five event kinds share this envelope; the discriminant is elided. */
type StreamEvent = Omit<Events.ServerSent.Stream.Response, "type">;
/** The four queueable request shapes; named so they render on one line. */
type OutboxRequest =
  Events.ClientSent.Initialize.Request["outbox"][number];
type InitializeResponse = Omit<
  Events.ClientSent.Initialize.Response,
  "applied"
> & { applied: OutboxRequest[] };
type Rejection = Events.ClientSent.Initialize.Rejection;

export type Vocabulary = Class.Diagram<
  [
    Class.Composition<EntryMetadata, Versioned, "every mutation presents one">,
    Class.Association<StreamEvent, EntryMetadata, "the one door into the map">,
    Class.Association<
      InitializeResponse,
      EntryMetadata,
      "entries, the replace-all snapshot"
    >,
    Class.Composition<InitializeResponse, Rejection, "rejected">,
    Class.DependsOn<StreamEvent, Versioned, "carries the new CAS token">,
  ]
>;

/* ==================================================================== *
 * §3 — System inventory
 * ==================================================================== */

type SyncLoopDriver = {};
type EffectiveView = {};
type ContentCache = {};
type DraftsStore = {};
type YjsRegistry = {};
type PyodideBridge = {};
type UI = {};
type Controller = {};
type ChokePoint = {};
type SseHandler = {};
type BlobStore = {};

export type SystemInventory = Flowchart.Diagram<
  "leftright",
  [
    Flowchart.Subgraph<
      "Client",
      [
        Flowchart.Node<
          PyodideBridge,
          "hexagon",
          "Pyodide bridge — sync-over-async, deadline-bounded"
        >,
        Flowchart.Node<UI, "stadium", "UI">,
        Flowchart.Node<
          EffectiveView,
          "parallelogram",
          "Effective view = outbox.replayOver(confirmed)"
        >,
        Flowchart.Node<ConfirmedMap, "rounded", "Confirmed map (memory)">,
        Flowchart.Node<Outbox, "database", "Outbox + bytes-by-hash (IDB)">,
        Flowchart.Node<ContentCache, "database", "Content cache (IDB)">,
        Flowchart.Node<DraftsStore, "database", "Drafts (IDB)">,
        Flowchart.Node<YjsRegistry, "database", "Yjs registry + y-indexeddb">,
        Flowchart.Node<SyncLoopDriver, "circle", "Sync loop">,
        Flowchart.Connect<ConfirmedMap, EffectiveView, "base">,
        Flowchart.Connect<Outbox, EffectiveView, "overlay">,
        Flowchart.Connect<EffectiveView, UI, never, "line">,
        Flowchart.Connect<EffectiveView, PyodideBridge, never, "line">,
        Flowchart.Connect<PyodideBridge, ContentCache, "reads">,
        Flowchart.Connect<PyodideBridge, YjsRegistry, "reads live docs first">,
        Flowchart.Connect<SyncLoopDriver, ConfirmedMap, "snapshot + events">,
        Flowchart.Connect<
          SyncLoopDriver,
          DraftsStore,
          "surfaces on reconnect",
          "dotted"
        >,
      ]
    >,
    Flowchart.Subgraph<
      "Server",
      [
        Flowchart.Node<
          Controller,
          "hexagon",
          "Workspace controller — one per workspace per process"
        >,
        Flowchart.Node<
          ChokePoint,
          "diamond",
          "The choke point — mutation, position, transaction record and event row in one DB transaction"
        >,
        Flowchart.Node<
          Postgres,
          "database",
          "Postgres — entries, transactions, event buffer, tokens"
        >,
        Flowchart.Node<
          SseHandler,
          "parallelogram",
          "SSE handler — claim token, replay, follow"
        >,
        Flowchart.Node<BlobStore, "database", "Blob store, keyed by hash">,
        Flowchart.Connect<Controller, ChokePoint, "serialized submit">,
        Flowchart.Connect<ChokePoint, Postgres, "one commit">,
        Flowchart.Connect<Controller, SseHandler, "fan out after commit">,
      ]
    >,
    Flowchart.Subgraph<
      "Third-party",
      [Flowchart.Node<Liveblocks, "rounded", "Liveblocks — rooms + yjs sync">]
    >,
    Flowchart.Connect<SyncLoopDriver, Controller, "Initialize">,
    Flowchart.Connect<Outbox, Controller, "transactional requests">,
    Flowchart.Connect<SseHandler, SyncLoopDriver, "stream events">,
    Flowchart.Connect<
      ContentCache,
      Postgres,
      "Content — bypasses the controller",
      "dotted"
    >,
    Flowchart.Connect<Outbox, BlobStore, "PUT the bytes, keyed by hash">,
    Flowchart.Connect<YjsRegistry, Liveblocks, "open text files only">,
  ]
>;

/* ---- the request surface (§9: 7 request types, plus Initialize) ------ */

type CreateRequest = Events.ClientSent.Create.Request;
type DeleteRequest = Events.ClientSent.Delete.Request;
type RenameRequest = Events.ClientSent.Rename.Request;
type ReparentRequest = Events.ClientSent.Reparent.Request;
/** Bytes travel as the raw HTTP body, so only the descriptor renders. */
type StoreRequest = Omit<Events.ClientSent.Store.Request, "bytes">;
type WriteText = Omit<Events.ClientSent.Write.Text, "type">;
type WriteBinary = Omit<Events.ClientSent.Write.Binary, "type">;
type ContentRequest = Events.ClientSent.Content.Request;
type InitializeRequest = Omit<
  Events.ClientSent.Initialize.Request,
  "outbox"
> & { outbox: OutboxRequest[] };

export type RequestSurface = Class.Diagram<
  [
    Class.DependsOn<CreateRequest, Versioned, "online-only, so there is no version to present">,
    Class.Composition<DeleteRequest, Versioned, "CAS">,
    Class.Composition<RenameRequest, Versioned, "CAS">,
    Class.Composition<ReparentRequest, Versioned, "CAS">,
    Class.Composition<ContentRequest, Versioned, "version optional = latest">,
    Class.Class<StoreRequest>,
    Class.Class<WriteText>,
    Class.Class<WriteBinary>,
    Class.Association<WriteBinary, StoreRequest, "hash must be stored first">,
    Class.Association<InitializeRequest, DeleteRequest, "outbox">,
    Class.Association<InitializeRequest, RenameRequest, "outbox">,
    Class.Association<InitializeRequest, ReparentRequest, "outbox">,
    Class.Association<InitializeRequest, WriteText, "outbox">,
    Class.Association<InitializeResponse, InitializeRequest, "adjudicates">,
  ]
>;

/* ---- the four client persistent stores (§9) -------------------------- */

type DraftContent = NonNullable<Client.Drafts.Draft["content"]>;
/** `intent` is a two-arm inline union; it is shown by the draft lifecycle instead. */
type Draft = Omit<Client.Drafts.Draft, "intent" | "content"> & {
  content?: DraftContent;
};
/** `request` is the five-arm union above; the association below carries it. */
type OutboxEntry = Omit<Client.Outbox.Entry, "request">;
type ContentResponse = Omit<Events.ClientSent.Content.Response, "type">;

export type ClientStores = Class.Diagram<
  [
    Class.Association<OutboxEntry, DeleteRequest, "request (one of five)">,
    Class.Association<OutboxEntry, WriteText, "request (one of five)">,
    Class.Association<OutboxEntry, StoreRequest, "bytes live by hash, not here">,
    Class.Composition<Draft, DraftContent, "a pointer, so drafts stay cheap">,
    Class.Association<Draft, StoreRequest, "recovery replays Create, Store, Write">,
    Class.Class<ContentResponse>,
    Class.DependsOn<ContentResponse, EntryMetadata, "cached per entry id">,
  ]
>;

/* ---- the three server tables beyond the domain schema (§3, §9) ------- */

type TransactionRow = Omit<Server.Transaction, "id" | "outcome"> & {
  id: Entity.Key.Primary<Entity.Text>;
  /** `{rejected} | {rejected, reason}` in the contract; one column here. */
  outcome: Entity.Text;
};
type TokenRow = Omit<Server.Token, "token"> & {
  token: Entity.Key.Primary<Entity.Text>;
};
type EntryRow = Omit<Entry.Metadata, "id" | "parent" | "type"> & {
  id: Entity.Key.Primary<Entity.Text>;
  parent?: Entity.Key.Foreign<Entity.Text>;
  type: Entity.Text;
};

export type ServerTables = Entity.Diagram<
  [
    Entity.Relation<
      TransactionRow,
      EntryRow,
      "one-to-zero-or-many",
      "adjudicated against"
    >,
    Entity.Relation<
      TokenRow,
      TransactionRow,
      "one-to-one",
      "stream position anchors after"
    >,
    Entity.Relation<EntryRow, EntryRow, "one-to-zero-or-many", "parent of">,
  ]
>;

/* ==================================================================== *
 * §4 — State machines
 * ==================================================================== */

type Captured = {};
type InFlight = {};
type Applied = {};
type Rejected = {};
type Evicted = {};

export type TransactionLifecycle = State.Diagram<
  [
    State.Transition<State.Start, Captured, "persisted to the outbox">,
    State.Transition<Captured, InFlight, "request sent">,
    State.Transition<InFlight, Captured, "timeout — remains queued">,
    State.Transition<
      InFlight,
      Applied,
      "response, stream echo, or Initialize verdict"
    >,
    State.Transition<InFlight, Rejected, "typed failure">,
    State.Transition<
      Applied,
      Evicted,
      "confirmed change and overlay removal cancel exactly"
    >,
    State.Transition<Rejected, Evicted, "routed to the failure policy">,
    State.Transition<Evicted, State.End>,
    State.Note<
      Captured,
      "right",
      "Capture before send — the bytes are durable before the network is involved"
    >,
    State.Note<
      Evicted,
      "left",
      "Any one eviction trigger suffices: response received, own transaction id echoed on the stream, or reported by Initialize"
    >,
  ]
>;

type Absent = {};
type Live = {};
type Tombstoned = {};

export type EntryLifecycle = State.Diagram<
  [
    State.Transition<State.Start, Absent>,
    State.Transition<
      Absent,
      Live,
      "Create — the ack yields the id, the stream event yields the entry"
    >,
    State.Transition<
      Live,
      Live,
      "rename / reparent / write — each advances version"
    >,
    State.Transition<Live, Tombstoned, "delete">,
    State.Transition<Tombstoned, State.End, "terminal — a restore is a fresh Create">,
    State.Note<
      Tombstoned,
      "right",
      "Tombstones are load-bearing: reconciliation cannot tell deleted from unchanged without them"
    >,
  ]
>;

type Parked = {};
type Recovering = {};
type Dismissed = {};

export type DraftLifecycle = State.Diagram<
  [
    State.Transition<
      State.Start,
      Parked,
      "intent + hash persisted before the error is raised"
    >,
    State.Transition<Parked, Recovering, "user accepts, online">,
    State.Transition<Parked, Dismissed, "explicit dismissal">,
    State.Transition<Recovering, Parked, "failure — never silently dropped">,
    State.Transition<Recovering, Evicted, "Create, Store, Write replayed in order">,
    State.Transition<Dismissed, State.End>,
    State.Transition<Evicted, State.End>,
    State.Note<
      Parked,
      "right",
      "No version, cannot conflict, never touches the stream — deliberately outside the sync machinery"
    >,
  ]
>;

type Cold = {};
type Cached = {};
type LiveConnection = {};
type Degraded = {};

export type ConnectionStates = State.Diagram<
  [
    State.Transition<State.Start, Cold, "page load">,
    State.Transition<Cold, Cached, "IndexedDB tree loads">,
    State.Transition<Cold, LiveConnection, "Initialize succeeds">,
    State.Transition<Cached, LiveConnection, "loop re-enters successfully">,
    State.Transition<LiveConnection, Cached, "error event or watchdog expiry">,
    State.Transition<
      LiveConnection,
      Degraded,
      "acks succeed but the stream will not establish"
    >,
    State.Transition<Degraded, LiveConnection, "stream recovers">,
    State.Transition<Degraded, Degraded, "meanwhile the loop degrades into polling">,
    State.Note<
      Cold,
      "right",
      "Cold start, reconnect and recovery are the same path — every disruption re-enters at Initialize"
    >,
    State.Note<
      Degraded,
      "left",
      "A proxy is eating SSE: surface live updates unavailable"
    >,
  ]
>;

type Closed = {};
type Attaching = {};
type Open = {};
type Flushing = {};
type EvictedDoc = {};

export type YjsDocLifecycle = State.Diagram<
  [
    State.Transition<State.Start, Closed>,
    State.Transition<Closed, Attaching, "first reference">,
    State.Transition<
      Attaching,
      Open,
      "y-indexeddb loads first, then the room connects"
    >,
    State.Transition<Open, Open, "references added and released (refcounted)">,
    State.Transition<
      Open,
      Flushing,
      "last reference released with unsynced changes"
    >,
    State.Transition<Flushing, Closed, "the server has everything">,
    State.Transition<Open, Closed, "last reference released, nothing pending">,
    State.Transition<Open, EvictedDoc, "file deleted">,
    State.Transition<Closed, EvictedDoc, "file deleted">,
    State.Transition<
      EvictedDoc,
      State.End,
      "local state wiped — stale CRDT state can never resurrect"
    >,
    State.Note<Flushing, "right", "Detach never discards">,
    State.Note<Closed, "left", "Local state kept as a warm cache">,
  ]
>;

/* ==================================================================== *
 * §5 — Content model
 * ==================================================================== */

type CachedKind = {};
type TextRoute = {};
type BinaryRoute = {};
type UnknownKind = {};
type LiveEditable = {};
type WriteAsText = {};
type WriteAsBinary = {};
type Invalidate = {};

export type ContentModel = Flowchart.Diagram<
  "topdown",
  [
    Flowchart.Node<CachedKind, "diamond", "Cached kind for this id?">,
    Flowchart.Node<TextRoute, "rounded", "text — inline string">,
    Flowchart.Node<BinaryRoute, "rounded", "binary — hash + size + mime">,
    Flowchart.Node<
      UnknownKind,
      "hexagon",
      "UNKNOWN — offline with a cold cache; say so in the UI"
    >,
    Flowchart.Node<
      LiveEditable,
      "diamond",
      "text + within size budget + editor opened?"
    >,
    Flowchart.Node<WriteAsText, "parallelogram", "Write(text)">,
    Flowchart.Node<WriteAsBinary, "parallelogram", "Store bytes, then Write(binary)">,
    Flowchart.Node<
      Invalidate,
      "stadium",
      "stream write signal invalidates content AND kind"
    >,
    Flowchart.Connect<CachedKind, TextRoute, "text">,
    Flowchart.Connect<CachedKind, BinaryRoute, "binary">,
    Flowchart.Connect<CachedKind, UnknownKind, "cold cache, offline">,
    Flowchart.Connect<TextRoute, LiveEditable>,
    Flowchart.Connect<LiveEditable, YDoc, "yes — a client-side determination">,
    Flowchart.Connect<LiveEditable, WriteAsText, "no">,
    Flowchart.Connect<BinaryRoute, WriteAsBinary>,
    Flowchart.Connect<
      WriteAsText,
      Invalidate,
      "a write of the other kind IS the transition",
      "thick"
    >,
    Flowchart.Connect<WriteAsBinary, Invalidate, never, "thick">,
    Flowchart.Connect<
      Invalidate,
      CachedKind,
      "the next Content fetch reveals the new kind",
      "dotted"
    >,
  ]
>;

/* ==================================================================== *
 * §6 — Data flows
 * ==================================================================== */

type ActiveBuffer = {};
type ContentFetch = {};
type Serve = {};
type FsError = {};

export type ReadFlow = Flowchart.Diagram<
  "topdown",
  [
    Flowchart.Node<
      PyodideBridge,
      "stadium",
      "readFile — Pyodide bridge or viewer"
    >,
    Flowchart.Node<YDoc, "diamond", "1. live yjs doc open on this client?">,
    Flowchart.Node<ActiveBuffer, "diamond", "2. active non-yjs editor buffer?">,
    Flowchart.Node<ContentCache, "diamond", "3. content cache hit for this id?">,
    Flowchart.Node<ContentFetch, "diamond", "4. fetch Content, deadline-bounded">,
    Flowchart.Node<Serve, "stadium", "serve">,
    Flowchart.Node<
      FsError,
      "hexagon",
      "5. clean filesystem error — never a hang"
    >,
    Flowchart.Connect<PyodideBridge, YDoc>,
    Flowchart.Connect<YDoc, Serve, "yes — the doc is the truth">,
    Flowchart.Connect<YDoc, ActiveBuffer, "no">,
    Flowchart.Connect<ActiveBuffer, Serve, "yes — visible or dirty this session">,
    Flowchart.Connect<ActiveBuffer, ContentCache, "no">,
    Flowchart.Connect<ContentCache, Serve, "hit">,
    Flowchart.Connect<ContentCache, ContentFetch, "miss">,
    Flowchart.Connect<ContentFetch, Serve, "ok — populate the cache">,
    Flowchart.Connect<ContentFetch, FsError, "offline or deadline exceeded">,
  ]
>;

type WriteCall = {};
type YjsDiff = {};
type Capture = {};
type StoreBytes = {};
type SubmitWrite = {};
type FailurePolicy = {};

export type WriteFlow = Flowchart.Diagram<
  "topdown",
  [
    Flowchart.Node<WriteCall, "stadium", "writeFile">,
    Flowchart.Node<CachedKind, "diamond", "route on the cached kind">,
    Flowchart.Node<YDoc, "diamond", "text with a live doc open?">,
    Flowchart.Node<
      YjsDiff,
      "rounded",
      "minimal yjs diff — one delete and one insert around the common prefix and suffix"
    >,
    Flowchart.Node<
      Capture,
      "database",
      "capture the transaction to the outbox, before sending"
    >,
    Flowchart.Node<StoreBytes, "rounded", "binary — Store the bytes by hash first">,
    Flowchart.Node<
      SubmitWrite,
      "parallelogram",
      "submit Write with the entry's current version (CAS)"
    >,
    Flowchart.Node<FailurePolicy, "hexagon", "failure policy">,
    Flowchart.Connect<WriteCall, CachedKind>,
    Flowchart.Connect<CachedKind, YDoc>,
    Flowchart.Connect<YDoc, YjsDiff, "yes — concurrent human edits merge">,
    Flowchart.Connect<YDoc, Capture, "no">,
    Flowchart.Connect<Capture, StoreBytes, "binary">,
    Flowchart.Connect<Capture, SubmitWrite, "text">,
    Flowchart.Connect<StoreBytes, SubmitWrite, "ack required first">,
    Flowchart.Connect<SubmitWrite, FailurePolicy, "rejected", "dotted">,
  ]
>;

type Caller = {};
type ServerSide = {};
type DraftsLot = {};

export type CreateFlow = Sequence.Diagram<
  [
    Sequence.Actor<Caller, "Caller (UI or Pyodide)">,
    Sequence.Participant<ServerSide, "Server">,
    Sequence.Participant<ConfirmedMap, "Confirmed map">,
    Sequence.Participant<DraftsLot, "Drafts">,
    Sequence.NoteOver<
      [Caller, DraftsLot],
      "Create is online-only — it is never queued in the outbox, and neither is anything depending on an unacknowledged create"
    >,
    Sequence.Alternative<
      "online",
      [
        Sequence.Message<
          Caller,
          ServerSide,
          "Create(transaction, type, name, parent?)",
          "activate"
        >,
        Sequence.Reply<
          ServerSide,
          Caller,
          "ack { id } — identity, not state",
          "deactivate"
        >,
        Sequence.NoteRight<
          Caller,
          "Dependent operations may now proceed against that id"
        >,
        Sequence.Async<
          ServerSide,
          ConfirmedMap,
          "stream create event — the entry enters the map here, and only here"
        >,
        Sequence.Optional<
          "ack lost",
          [
            Sequence.Message<
              Caller,
              ServerSide,
              "retry with the SAME transaction id"
            >,
            Sequence.Reply<
              ServerSide,
              Caller,
              "deduped — the one place a duplicate would mint a duplicate entry"
            >,
          ]
        >,
      ],
      "offline",
      [
        Sequence.Lost<Caller, ServerSide, "Create">,
        Sequence.Message<Caller, DraftsLot, "park the content as a draft">,
        Sequence.Reply<DraftsLot, Caller, "parked — now fail loudly">,
      ]
    >,
  ]
>;

type SyncLoop = {};
type EventStream = {};

export type SyncLoopFlow = Sequence.Diagram<
  [
    Sequence.Participant<SyncLoop, "Sync loop">,
    Sequence.Participant<Outbox, "Outbox">,
    Sequence.Participant<ServerSide, "Server">,
    Sequence.Participant<ConfirmedMap, "Confirmed map">,
    Sequence.Participant<EventStream, "EventSource">,
    Sequence.NoteOver<
      [SyncLoop, EventStream],
      "Cold start, reconnect and recovery are the same path"
    >,
    Sequence.Loop<
      "forever",
      [
        Sequence.Message<
          SyncLoop,
          Outbox,
          "read pending transactions, in counter order"
        >,
        Sequence.Message<
          SyncLoop,
          ServerSide,
          "POST Initialize(workspace, outbox)",
          "activate"
        >,
        Sequence.NoteRight<
          ServerSide,
          "ONE repeatable-read transaction: adjudicate the outbox in order, snapshot entries, read position, mint token"
        >,
        Sequence.Reply<
          ServerSide,
          SyncLoop,
          "{ token, entries, applied, rejected }",
          "deactivate"
        >,
        Sequence.Message<SyncLoop, Outbox, "evict applied and rejected">,
        Sequence.Message<
          SyncLoop,
          ConfirmedMap,
          "replace-all from the snapshot — same server transaction, so no gap and no flicker"
        >,
        Sequence.Message<
          SyncLoop,
          EventStream,
          "connect with the single-use token",
          "activate"
        >,
        Sequence.Message<
          EventStream,
          ServerSide,
          "claim the token atomically (DELETE ... RETURNING)"
        >,
        Sequence.Reply<
          ServerSide,
          EventStream,
          "replay events after token.position, then follow live"
        >,
        Sequence.Loop<
          "until error or watchdog expiry",
          [
            Sequence.Async<
              EventStream,
              ConfirmedMap,
              "create / write / delete / name / parent"
            >,
            Sequence.Async<ServerSide, EventStream, "comment heartbeat, ~15s">,
          ]
        >,
        Sequence.Lost<EventStream, SyncLoop, "error, or watchdog expiry at ~45s">,
        Sequence.NoteOver<
          [SyncLoop, EventStream],
          "close() — never rely on EventSource auto-reconnect: it replays a spent token"
        >,
        Sequence.Message<
          SyncLoop,
          SyncLoop,
          "jittered exponential backoff — reset only on an established stream"
        >,
      ]
    >,
    Sequence.NoteOver<
      [SyncLoop, Outbox],
      "Also re-enter on visibilitychange-to-visible and online — Initialize with an empty outbox is a cheap no-op"
    >,
  ]
>;

type ClientSide = {};
type Blobs = {};

export type BlobTransfer = Sequence.Diagram<
  [
    Sequence.Participant<ClientSide, "Client">,
    Sequence.Participant<Blobs, "Blob store">,
    Sequence.Message<
      ClientSide,
      Blobs,
      "PUT /blobs/{hash} — raw bytes as the body",
      "activate"
    >,
    Sequence.Alternative<
      "hash already stored",
      [
        Sequence.NoteRight<
          Blobs,
          "ack immediately, without reading the body — this is the retry story"
        >,
      ],
      "new bytes",
      [Sequence.NoteRight<Blobs, "verify sha256(body) === hash">]
    >,
    Sequence.Reply<
      Blobs,
      ClientSide,
      "ack, or a typed failure: hash mismatch / too large",
      "deactivate"
    >,
    Sequence.Message<ClientSide, Blobs, "GET the bytes">,
    Sequence.Reply<
      Blobs,
      ClientSide,
      "raw bytes with Content-Type: {mime} and ETag: {version}, or a redirect to object storage"
    >,
    Sequence.NoteOver<
      [ClientSide, Blobs],
      "Blobs are immutable: a cached blob by hash can never be wrong — only pointers go stale"
    >,
  ]
>;

/* ==================================================================== *
 * §7 — Failure policy
 * ==================================================================== */

type Failure = {};
type LiveEditorOpen = {};
type IgnoreIt = {};
type DiffEditor = {};
type ParkDraft = {};
type SnapBack = {};
type SurfaceIt = {};

export type FailurePolicyRouting = Flowchart.Diagram<
  "leftright",
  [
    Flowchart.Node<Failure, "stadium", "an operation fails">,
    Flowchart.Node<
      LiveEditorOpen,
      "diamond",
      "content write conflict — is a live editor open?"
    >,
    Flowchart.Node<IgnoreIt, "rounded", "ignore — the yjs doc is the truth">,
    Flowchart.Node<
      DiffEditor,
      "rounded",
      "diff editor — fetch Content at the conflicting version for the other side"
    >,
    Flowchart.Node<ParkDraft, "rounded", "evict; park the content as a draft">,
    Flowchart.Node<
      SnapBack,
      "rounded",
      "evict; the effective view snaps back — recomputation, not an undo operation"
    >,
    Flowchart.Node<
      SurfaceIt,
      "rounded",
      "surface; do not retry blindly — the bytes are wrong or oversized, not the network"
    >,
    Flowchart.Connect<Failure, LiveEditorOpen, "Write rejected">,
    Flowchart.Connect<LiveEditorOpen, IgnoreIt, "yes">,
    Flowchart.Connect<LiveEditorOpen, DiffEditor, "no">,
    Flowchart.Connect<Failure, ParkDraft, "write to a deleted entry, or create offline">,
    Flowchart.Connect<Failure, SnapBack, "move, rename or delete rejected">,
    Flowchart.Connect<Failure, SurfaceIt, "Store hash mismatch or too large">,
    Flowchart.DefineClass<"quiet", "fill:#e6f4ea,stroke:#34a853,stroke-width:2px">,
    Flowchart.DefineClass<"loud", "fill:#fce8e6,stroke:#d93025,stroke-width:2px">,
    Flowchart.ApplyClass<[IgnoreIt, SnapBack], "quiet">,
    Flowchart.ApplyClass<[DiffEditor, ParkDraft, SurfaceIt], "loud">,
  ]
>;
