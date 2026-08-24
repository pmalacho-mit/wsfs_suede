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
import { nothing, nowhere, type Kept, type Restored } from "./kept";
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
  /**
   * Whether a shared document here speaks for this entry.
   *
   * Answering yes closes `write` for it. Content that came out of an editor
   * moves as a CRDT update and reaches the file through the document that
   * holds it, because typing text in creates NEW characters and the same work
   * arriving twice survives twice. That is rule one, and until now it was a
   * convention -- nothing stopped a second route being added years later by
   * somebody who had not read this.
   *
   * No CRDT is named here. A consumer holding documents is the only party
   * that knows which entries have one.
   */
  shared?: (entry: Id) => boolean;
  /**
   * Where the queue is written down, and what it held when this client last
   * ran. Say nothing and the outbox lives and dies with the page, which loses
   * work and is the default only because a consumer must choose its storage.
   */
  kept?: Kept;
  restored?: Restored;
  /**
   * Queued work that can never be sent, because the bytes it named are gone.
   *
   * Reported rather than swallowed: it is the one loss this client cannot
   * undo, and a user who is told can retype a paragraph. One that is not told
   * finds out much later, from a file that is missing something.
   */
  lost?: (entries: outbox.Unreadable[]) => void;
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
   *
   * BY ENTRY, NOT BY PATH, and that is the case it exists for: a file being
   * deleted underneath somebody is exactly when their unstored work needs
   * keeping, and by then it has no path to name.
   */
  keep: (
    entry: Id,
    content: string | Uint8Array,
    mime?: string,
  ) => Submitting;
  /**
   * The write a shared document makes for the file it speaks for.
   *
   * The same write `write` makes, minus the refusal -- this is the route rule
   * one leaves open, and it takes an ENTRY because the document holds an id
   * and the file may have been renamed under it since.
   */
  shares: (
    entry: Id,
    content: string | Uint8Array,
    mime?: string,
  ) => Submitting;
  /**
   * These drafts' work has since reached everybody else.
   *
   * Told to the server rather than remembered here: the case worth reporting
   * is a machine that never came back, and a note kept only on that machine
   * goes with it.
   */
  cleared: (transactions: Transaction[]) => Promise<void>;
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
  const kept = options.kept ?? nowhere;
  const restored = options.restored ?? nothing;
  const queue = outbox.queue(restored.entries, kept);
  const listeners = new Set<Changed>();

  let map = confirmed.empty();
  let shown = effective.of(map, []);
  let index = paths.index(shown.view);

  /**
   * Every transaction this client sent that the server answered.
   *
   * The confirmed map says what each entry is at NOW, which is a different
   * question from what the server can rebuild, and three things fall through
   * the gap: a draft, a refusal, and an applied write that a later write has
   * since superseded. None of them is any entry's current version; all three
   * are on the server and rebuildable from it.
   *
   * An answer is the proof. Whatever the server decided, it wrote the
   * transaction down before saying so.
   *
   * Written down with the queue, and pruned against every snapshot: an answer
   * the confirmed map speaks for is one this set need not hold. What survives
   * is only the three the map cannot answer, which is what makes keeping it
   * across page loads cost almost nothing.
   */
  const recorded = new Set<Transaction>(restored.recorded);

  const answered = (transaction: Transaction) => {
    recorded.add(transaction);
    kept.answered([transaction]);
  };

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
    /**
     * Hashed, queued, and only then stored. The row that NAMES the payload
     * goes down first, because the two orders fail differently: bytes with no
     * row are work that is gone and cannot be noticed, a row with no bytes is
     * work that is gone and says so. Only one of those can be told to a user.
     */
    const digest = payload === undefined ? undefined : await digestOf(payload);
    queue.capture(request, digest);
    if (payload !== undefined) await bytes.put(payload, digest);
    if (payload !== undefined)
      content.remember(request.transaction, heldAs(payload, mime));
    recomputed();
    const response = await transport.submit(workspace, request);
    answered(request.transaction);
    if (settledHere(response)) {
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
    /**
     * The same door Initialize reports through. Which path FINDS the loss is
     * an accident of whether the stream happened to drop, so a consumer that
     * implements one has implemented both.
     */
    lost: options.lost,
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
      answered(transaction);
      return answer;
    })();
    return { transaction, settled };
  };

  const sync = loop.run(
    {
      reconcile: async () => {
        /**
         * What cannot be read is dropped BEFORE the batch goes, not after.
         * Its bytes are gone, so it can never be sent however many times this
         * comes round -- and leaving it in place used to stop everything
         * behind it from being sent either.
         */
        const { presented, unreadable } = await outbox.presenting(
          queue.entries(),
          queue,
          bytes,
        );
        if (unreadable.length > 0) {
          bytes.forget(
            queue.evict(unreadable.map(({ transaction }) => transaction)),
          );
          options.lost?.(unreadable);
        }
        const snapshot = await transport.initialize(workspace, presented);
        /**
         * Replay is an answer like any other, and it used to be the one that
         * was not written down. A draft sent during Initialize left the queue
         * and was recorded nowhere, so a client that had reloaded called its
         * own landed work unsettled for ever -- which is exactly the question
         * a consumer asks before handing a snapshot to anybody else.
         */
        const answers = [
          ...snapshot.applied,
          ...snapshot.rejected.map(({ transaction }) => transaction),
        ];
        answers.forEach(answered);
        bytes.forget(queue.evict(answers));
        map = confirmed.snapshot(snapshot.entries);
        forgetWhatTheMapNowAnswers();
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
      if (entry === undefined) return created(path, payload, mime);
      refuseIfShared(entry.id, path);
      return written(entry, payload, mime);
    },

    cleared: (transactions) => transport.cleared(workspace, transactions),

    keep: (entry, payload, mime = TEXT) => written(heldEntry(entry), payload, mime, true),

    shares: (entry, payload, mime = TEXT) =>
      written(heldEntry(entry), payload, mime),

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
     * Plus everything the server has answered for, which the confirmed map
     * cannot speak to: drafts, refusals, and writes a later write has moved
     * past.
     */
    unsettled: (transactions) => {
      const settled = currentVersions();
      for (const transaction of recorded) settled.add(transaction);
      return [...transactions].filter(
        (transaction) => !settled.has(transaction),
      );
    },

    stop: sync.stop,
    nudge: sync.nudge,
  };

  /**
   * A snapshot has just said where every entry stands, so any answer this set
   * holds that is also a current version is one it is keeping twice. What is
   * left is the three the map cannot speak to -- drafts, refusals, and writes
   * a later write moved past -- which is the only reason the set exists.
   */
  function forgetWhatTheMapNowAnswers(): void {
    const spoken = [...recorded].filter((transaction) =>
      currentVersions().has(transaction),
    );
    for (const transaction of spoken) recorded.delete(transaction);
    if (spoken.length > 0) kept.redundant(spoken);
  }

  function currentVersions(): Set<Transaction> {
    const held = new Set<Transaction>();
    for (const entry of map.values()) {
      held.add(entry.name_version);
      held.add(entry.parent_version);
      held.add(entry.deleted_version);
      if (entry.content_version != null) held.add(entry.content_version);
    }
    return held;
  }

  function heldEntry(entry: Id): Metadata {
    const held = shown.view.get(entry);
    if (held === undefined) throw new Error(`No such entry: ${entry}`);
    return held;
  }

  /**
   * Named rather than boolean, because the mistake this catches is somebody
   * reaching for the obvious method, and the error has to say which one is
   * not obvious.
   */
  function refuseIfShared(entry: Id, path: paths.Path): void {
    if (options.shared?.(entry) !== true) return;
    throw new Error(
      `${path} has a shared document open, so its text reaches the file ` +
        "through that document. Type into it, or call `shares` if you ARE " +
        "it. Writing text around it would say the same work twice.",
    );
  }

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
