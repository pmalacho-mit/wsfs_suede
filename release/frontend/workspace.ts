/**
 * One workspace, open.
 *
 * Everything a consumer touches hangs off this: the tree renders the effective
 * view, the editor and the kernel read content through the same chain, and all
 * three therefore cannot disagree about what a file contains.
 */
import { digestOf, inMemory, type Store } from "./bytes";
import * as changes from "./changes";
import * as confirmed from "./confirmed";
import { cache, type Content, type Payload } from "./content";
import {
  settledHere,
  UNSOUND,
  type Body,
  type Id,
  type Metadata,
  type Response,
  type Submitted,
  type Transaction,
  type Version,
  type Write,
} from "./contract";
import * as effective from "./effective";
import { mint } from "./identity";
import { offset } from "./minted";
import * as loop from "./loop";
import * as outbox from "./outbox";
import * as paths from "./paths";
import * as writes from "./writes";
import { heldAs } from "./writes";
import type { Transport } from "./transport";

export type Options = {
  workspace: Id;
  transport: Transport;
  bytes?: Store;
  timing?: loop.Timing;
};

/**
 * A listener is handed what changed. Consumers that only need to know THAT
 * something did can keep ignoring the argument.
 */
export type Changed = changes.Watching;

/**
 * A submitted transaction: its id, available before anything is announced,
 * and the server's answer, available much later.
 *
 * The id has to come back synchronously. Queueing the request recomputes the
 * view and announces the change it makes, and that happens before the request
 * is even sent -- so a caller that only learned its transaction id when the
 * promise resolved would learn it after being told about its own work.
 *
 * `settled` does not reject on a refusal: a refused transaction is taken back
 * by the same recomputation that showed it, and the reason is in the response
 * for a caller that wants to say something about it.
 */
export type Submitting = {
  transaction: Transaction;
  settled: Promise<Response>;
};

/** A create also names the entry it is bringing into existence. */
export type Creating = Submitting & { entry: Id };

export type Workspace = {
  entries: () => effective.View;
  index: () => paths.Index;
  watch: (changed: Changed) => () => void;

  read: (path: paths.Path) => Promise<Payload | undefined>;
  holding: (path: paths.Path) => Payload | undefined;
  /**
   * What one file held at one version.
   *
   * `read` answers for a file as it stands, which is what almost everything
   * wants. This answers for a version by name, which is what a consumer
   * RECONCILING needs -- and it needs two of them at once, both older than
   * anything it is showing. A shared document catching up with a write that
   * did not go through it applies the difference between two SERVER versions,
   * because diffing from the document instead would describe the user's own
   * unsent work as text to delete. See `rooms.ts`.
   *
   * By entry rather than by path: the caller is holding a room open on an id,
   * and the file may have been renamed since the version it is asking about.
   */
  at: (entry: Id, version: Version) => Promise<Payload>;
  write: (
    path: paths.Path,
    content: string | Uint8Array,
    mime?: string,
  ) => Submitting;
  /**
   * Record this without making it the file's content.
   *
   * For a client whose text has reached nobody else. The token it presents is
   * not consumed and nothing rebases under it, so the write that eventually
   * shares the work presents the same one.
   */
  keep: (
    path: paths.Path,
    content: string | Uint8Array,
    mime?: string,
  ) => Submitting;
  create: (
    path: paths.Path,
    content: string | Uint8Array,
    mime?: string,
  ) => Creating;
  folder: (path: paths.Path) => Creating;
  move: (from: paths.Path, to: paths.Path) => Submitting;
  remove: (path: paths.Path) => Submitting;

  /**
   * Which of these transactions this client has not yet heard the server
   * confirm -- queued, in flight, or answered but not yet carried by the
   * stream.
   *
   * A snapshot names transactions, and a client shows its own work the
   * instant it makes it, so a snapshot can name work that has never left this
   * machine. Nothing anywhere else can rebuild that: the bytes are here and
   * nowhere. A consumer handing a snapshot to something that will read it
   * elsewhere asks this first, and an empty answer is what makes the snapshot
   * portable.
   */
  unsettled: (transactions: Iterable<Transaction>) => Transaction[];

  stop: () => void;
  nudge: () => void;
};

const TEXT = "text/plain";

const isText = (content: string | Uint8Array): content is string =>
  typeof content === "string";

export const connect = (options: Options): Workspace => {
  const { workspace, transport } = options;
  const bytes = options.bytes ?? inMemory();
  const queue = outbox.queue();
  const listeners = new Set<Changed>();

  let map = confirmed.empty();
  let shown = effective.of(map, []);
  let index = paths.index(shown.view);

  /**
   * Transactions the server recorded without applying them.
   *
   * A refusal and a draft both leave a row that names what was ASKED, and
   * both are rebuildable from it -- but neither is ever an entry's version,
   * so the confirmed map that `unsettled` reads has no way to know about
   * them and would call them unreachable for ever.
   *
   * Held in memory only. A reload loses it, which understates what the server
   * can rebuild rather than overstating it.
   */
  const recorded = new Set<Transaction>();

  const content: Content = cache((entry, version) =>
    transport.content(workspace, entry, version),
  );

  /**
   * The one door state leaves by. What is announced is the difference between
   * the view that was showing and the one now showing -- so a recomputation
   * that changes nothing a consumer can see announces nothing, whatever
   * prompted it.
   */
  const recomputed = () => {
    const before = shown;
    shown = effective.of(map, queue.entries());
    index = paths.index(shown.view);
    const what = changes.between(before, shown);
    if (what.length === 0) return;
    listeners.forEach((changed) => changed(what));
  };

  /**
   * Content arrives before it is asked for, so the kernel's filesystem calls
   * are answered out of state rather than out of a request it must wait on.
   */
  const readied = (entry: Metadata | undefined) => {
    if (entry && entry.type === "file") void content.prefetch(entry);
  };

  const applied = (event: import("./contract").StreamEvent) => {
    map = confirmed.applied(map, event);
    if (event.type === "write") content.forget(event.id);
    bytes.forget(queue.evict([event.transaction]));
    recomputed();
    readied(map.get(event.id));
  };

  const entryAt = (path: paths.Path) => {
    const entry = index.at(path);
    if (entry === undefined) throw new Error(`No such entry: ${path}`);
    return entry;
  };

  /**
   * The offset is stamped HERE rather than at each mint, so that every
   * transaction this client sends carries one and none can be forgotten. It is
   * per-transaction and not per-connection because an outbox filled offline in
   * one zone may only be replayed after landing in another -- see
   * `Transacted.offset` on the wire.
   *
   * Queued work leaves the outbox when the STREAM carries it, not when the
   * response acknowledges it -- those are different moments, and dropping it
   * at the first one opens a window where the entry is in neither the outbox
   * nor the confirmed map, so a file blinks out of the tree just after it is
   * created. A rejection is the one answer no event will ever follow, so that
   * is one of the two this evicts itself; a draft, which was never going to
   * become content, is the other.
   */
  const submit = async (
    submitted: Submitted,
    payload?: string | Uint8Array,
    mime = TEXT,
  ): Promise<Response> => {
    const request = { ...submitted, offset: offset() };
    const digest = payload === undefined ? undefined : await bytes.put(payload);
    queue.capture(request, digest);
    if (payload !== undefined)
      content.remember(request.transaction, heldAs(payload, mime));
    recomputed();
    const response = await transport.submit(workspace, request);
    if (settledHere(response)) {
      recorded.add(request.transaction);
      if (response.rejected && response.reason === UNSOUND) sync.nudge();
      bytes.forget(queue.evict([request.transaction]));
      recomputed();
    }
    return response;
  };

  /**
   * A write names bytes by hash, so the bytes have to be stored before the
   * write that names them -- and storing is idempotent, so a retry is free.
   */
  const staged = async (
    payload: string | Uint8Array,
    mime: string,
  ): Promise<Body> => {
    if (isText(payload)) return { type: "text", content: payload };
    const hash = await digestOf(payload);
    await transport.store(workspace, hash, payload, mime);
    return { type: "binary", hash, size: payload.byteLength, mime };
  };

  /**
   * Every mutation is minted, then sent. The two halves are separate because
   * the caller needs the first before the second has happened: `submit`
   * announces the change it makes before the request leaves.
   */
  /**
   * Content writes go through here rather than straight to `submit`, because
   * they are the one op whose token can be invalidated by this client's OWN
   * work in flight. See `writes.ts`.
   */
  const flight = writes.pump({
    queue,
    bytes,
    send: (request) => transport.submit(workspace, request),
    announced: recomputed,
    remembered: content.remember,
    token: (entry) => map.get(entry)?.content_version ?? null,
    unsound: () => sync.nudge(),
  });

  const written = (
    entry: Metadata,
    payload: string | Uint8Array,
    mime: string,
    draft = false,
  ): Submitting => {
    const seen = entry.content_version;
    if (seen == null) throw new Error(`Not a file: ${entry.name}`);
    const transaction = mint();
    /**
     * The token here is the one the CACHE knows, and it is only a starting
     * point: `flight` chooses what actually goes on the wire, because by the
     * time this leaves there may be a write of this client's own in front of
     * it that the confirmed view has not heard about yet.
     */
    const settled = (async () => {
      const answer = await flight.write(
        entry.id,
        {
          op: "write",
          transaction,
          id: entry.id,
          content_version: seen,
          content: await staged(payload, mime),
          draft,
        } as Write,
        payload,
        mime,
      );
      if (settledHere(answer)) recorded.add(transaction);
      return answer;
    })();
    return { transaction, settled };
  };

  const sync = loop.run(
    {
      reconcile: async () => {
        const snapshot = await transport.initialize(
          workspace,
          await outbox.presenting(queue.entries(), queue, bytes),
        );
        bytes.forget(
          queue.evict([
            ...snapshot.applied,
            ...snapshot.rejected.map(({ transaction }) => transaction),
          ]),
        );
        map = confirmed.snapshot(snapshot.entries);
        recomputed();
        snapshot.entries.forEach(readied);
        flight.resume();
        return snapshot.token;
      },
      follow: (token, alive, until) =>
        new Promise<void>((ended) => {
          const done = () => (subscription.close(), ended());
          const subscription = transport.follow(workspace, token, {
            alive,
            event: applied,
            failed: done,
          });
          until.addEventListener("abort", done, { once: true });
        }),
    },
    options.timing,
  );

  return {
    entries: () => shown.view,
    index: () => index,
    watch: (changed) => (
      listeners.add(changed),
      () => listeners.delete(changed)
    ),

    read: (path) => content.read(entryAt(path)),
    holding: (path) => content.holding(entryAt(path)),
    /**
     * Straight to the transport, past the cache. The cache is keyed by the
     * token an entry is CURRENTLY at, which is exactly the version this is
     * never asked about -- and reconciling is rare enough that a read costs
     * less than a second cache keyed a second way.
     */
    at: (entry, version) => transport.content(workspace, entry, version),

    write: (path, payload, mime = TEXT) => {
      const entry = index.at(path);
      return entry === undefined
        ? created(path, payload, mime)
        : written(entry, payload, mime);
    },

    keep: (path, payload, mime = TEXT) =>
      written(entryAt(path), payload, mime, true),

    create: (path, payload, mime = TEXT) => created(path, payload, mime),

    folder: (path) => {
      const entry = mint();
      const transaction = mint();
      const settled = submit({
        op: "create",
        transaction,
        id: entry,
        type: "folder",
        name: paths.base(path),
        parent: parentOf(path),
        content: null,
      });
      return { entry, transaction, settled };
    },

    move: (from, to) => {
      const entry = entryAt(from);
      const transaction = mint();
      const settled = submit({
        op: "move",
        transaction,
        id: entry.id,
        name: paths.base(to),
        name_version: entry.name_version,
        parent: parentOf(to),
        parent_version: entry.parent_version,
      });
      return { transaction, settled };
    },

    remove: (path) => {
      const entry = entryAt(path);
      const transaction = mint();
      const settled = submit({
        op: "delete",
        transaction,
        id: entry.id,
        seen: {
          name_version: entry.name_version,
          parent_version: entry.parent_version,
          deleted_version: entry.deleted_version,
          content_version: entry.content_version ?? null,
        },
      });
      return { transaction, settled };
    },

    /**
     * Read off the CONFIRMED map rather than off the outbox, and the
     * difference matters. A transaction the outbox has never heard of is not
     * settled -- it is one this client has not got round to queueing, or one
     * whose bytes died with a tab, and answering "portable" for either would
     * be answering for something that does not exist anywhere.
     *
     * Every transaction a snapshot names is a property token of something it
     * was showing, so a token standing in the confirmed map is exactly the
     * question "has the server told me about this", asked completely.
     *
     * Plus what was recorded without being applied -- refusals and drafts.
     * Neither is ever an entry's version, and the server can rebuild both.
     */
    unsettled: (transactions) => {
      const confirmed = new Set<Transaction>(recorded);
      for (const entry of map.values()) {
        confirmed.add(entry.name_version);
        confirmed.add(entry.parent_version);
        confirmed.add(entry.deleted_version);
        if (entry.content_version != null) confirmed.add(entry.content_version);
      }
      return [...transactions].filter(
        (transaction) => !confirmed.has(transaction),
      );
    },

    stop: sync.stop,
    nudge: sync.nudge,
  };

  function parentOf(path: paths.Path): Id | null {
    const holder = paths.parent(path);
    return holder === "" ? null : entryAt(holder).id;
  }

  function created(
    path: paths.Path,
    payload: string | Uint8Array,
    mime: string,
  ): Creating {
    const entry = mint();
    const transaction = mint();
    const parent = parentOf(path);
    const settled = (async () =>
      submit(
        {
          op: "create",
          transaction,
          id: entry,
          type: "file",
          name: paths.base(path),
          parent,
          content: await staged(payload, mime),
        },
        payload,
        mime,
      ))();
    return { entry, transaction, settled };
  }
};
