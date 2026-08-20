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
  UNSOUND,
  type Body,
  type Id,
  type Metadata,
  type Response,
  type Submitted,
  type Transaction,
} from "./contract";
import * as effective from "./effective";
import { mint } from "./identity";
import * as loop from "./loop";
import * as outbox from "./outbox";
import * as paths from "./paths";
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
  write: (
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

  stop: () => void;
  nudge: () => void;
};

const TEXT = "text/plain";

const isText = (content: string | Uint8Array): content is string =>
  typeof content === "string";

const heldAs = (payload: string | Uint8Array, mime: string): Payload =>
  isText(payload)
    ? { kind: "text", text: payload }
    : { kind: "binary", bytes: payload, mime };

export const connect = (options: Options): Workspace => {
  const { workspace, transport } = options;
  const bytes = options.bytes ?? inMemory();
  const queue = outbox.queue(bytes);
  const listeners = new Set<Changed>();

  let map = confirmed.empty();
  let shown = effective.of(map, []);
  let index = paths.index(shown.view);

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
   * Queued work leaves the outbox when the STREAM carries it, not when the
   * response acknowledges it -- those are different moments, and dropping it
   * at the first one opens a window where the entry is in neither the outbox
   * nor the confirmed map, so a file blinks out of the tree just after it is
   * created. A rejection is the one answer no event will ever follow, so that
   * is the one this evicts itself.
   */
  const submit = async (
    request: Submitted,
    payload?: string | Uint8Array,
    mime = TEXT,
  ): Promise<Response> => {
    const digest = payload === undefined ? undefined : await bytes.put(payload);
    queue.capture(request, digest);
    if (payload !== undefined)
      content.remember(request.transaction, heldAs(payload, mime));
    recomputed();
    const response = await transport.submit(workspace, request);
    if (response.rejected) {
      if (response.reason === UNSOUND) sync.nudge();
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
  const written = (
    entry: Metadata,
    payload: string | Uint8Array,
    mime: string,
  ): Submitting => {
    const seen = entry.content_version;
    if (seen == null) throw new Error(`Not a file: ${entry.name}`);
    const transaction = mint();
    const settled = (async () =>
      submit(
        {
          op: "write",
          transaction,
          id: entry.id,
          content_version: seen,
          content: await staged(payload, mime),
        },
        payload,
        mime,
      ))();
    return { transaction, settled };
  };

  const sync = loop.run(
    {
      reconcile: async () => {
        const snapshot = await transport.initialize(
          workspace,
          outbox.presented(queue.entries()),
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

    write: (path, payload, mime = TEXT) => {
      const entry = index.at(path);
      return entry === undefined
        ? created(path, payload, mime)
        : written(entry, payload, mime);
    },

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
