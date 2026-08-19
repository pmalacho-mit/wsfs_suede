/**
 * One workspace, open.
 *
 * Everything a consumer touches hangs off this: the tree renders the effective
 * view, the editor and the kernel read content through the same chain, and all
 * three therefore cannot disagree about what a file contains.
 */
import { digestOf, inMemory, type Store } from "./bytes";
import * as confirmed from "./confirmed";
import { cache, type Content, type Held } from "./content";
import { UNSOUND, type Body, type Id, type Metadata, type Submitted } from "./contract";
import { MappedDebouncer } from "./debounce";
import * as documents from "./documents";
import * as effective from "./effective";
import { mint } from "./identity";
import * as loop from "./loop";
import * as outbox from "./outbox";
import * as paths from "./paths";
import type { Transport } from "./transport";

export type Options = {
  workspace: Id;
  transport: Transport;
  /** How an open text file is joined. Absent means nothing is ever open. */
  open?: documents.Open;
  bytes?: Store;
  timing?: loop.Timing;
  flushing?: { idleMs: number; maxWaitMs: number };
};

export type Changed = () => void;

export type Workspace = {
  entries: () => effective.View;
  index: () => paths.Index;
  watch: (changed: Changed) => () => void;

  read: (path: paths.Path) => Promise<Held | undefined>;
  holding: (path: paths.Path) => Held | undefined;
  write: (path: paths.Path, content: string | Uint8Array, mime?: string) => Promise<void>;
  create: (path: paths.Path, content: string | Uint8Array, mime?: string) => Promise<Id>;
  folder: (path: paths.Path) => Promise<Id>;
  move: (from: paths.Path, to: paths.Path) => Promise<void>;
  remove: (path: paths.Path) => Promise<void>;

  edit: (path: paths.Path) => Promise<documents.Document>;
  close: (path: paths.Path) => Promise<void>;

  stop: () => void;
  nudge: () => void;
};

const TEXT = "text/plain";

const isText = (content: string | Uint8Array): content is string =>
  typeof content === "string";

export const connect = (options: Options): Workspace => {
  const { workspace, transport } = options;
  const bytes = options.bytes ?? inMemory();
  const queue = outbox.queue(bytes);
  const docs = documents.registry(options.open ?? notOpenable);
  const listeners = new Set<Changed>();
  const flushes = new MappedDebouncer<Id>(options.flushing ?? {});

  let map = confirmed.empty();
  let view = effective.of(map, []);
  let index = paths.index(view);

  const content: Content = cache(docs, (entry, version) =>
    transport.content(workspace, entry, version),
  );

  const recomputed = () => {
    view = effective.of(map, queue.entries());
    index = paths.index(view);
    listeners.forEach((changed) => changed());
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
    if (event.type === "delete") void docs.evict(event.id);
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
  const submit = async (request: Submitted, payload?: string | Uint8Array) => {
    const digest = payload === undefined ? undefined : await bytes.put(payload);
    queue.capture(request, digest);
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
  const staged = async (payload: string | Uint8Array, mime: string): Promise<Body> => {
    if (isText(payload)) return { type: "text", content: payload };
    const hash = await digestOf(payload);
    await transport.store(workspace, hash, payload, mime);
    return { type: "binary", hash, size: payload.byteLength, mime };
  };

  const written = async (entry: Metadata, payload: string | Uint8Array, mime: string) => {
    if (entry.content_version == null) throw new Error(`Not a file: ${entry.name}`);
    await submit(
      {
        op: "write",
        transaction: mint(),
        id: entry.id,
        content_version: entry.content_version,
        content: await staged(payload, mime),
      },
      payload,
    );
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
      follow: (token, alive) =>
        new Promise<void>((ended) => {
          const subscription = transport.follow(workspace, token, {
            alive,
            event: applied,
            failed: () => (subscription.close(), ended()),
          });
        }),
    },
    options.timing,
  );

  return {
    entries: () => view,
    index: () => index,
    watch: (changed) => (listeners.add(changed), () => listeners.delete(changed)),

    read: (path) => content.read(entryAt(path)),
    holding: (path) => content.holding(entryAt(path)),

    write: async (path, payload, mime = TEXT) => {
      const entry = index.at(path);
      if (entry === undefined) {
        await created(path, payload, mime);
        return;
      }
      await written(entry, payload, mime);
    },

    create: (path, payload, mime = TEXT) => created(path, payload, mime),

    folder: async (path) => {
      const id = mint();
      await submit({
        op: "create",
        transaction: mint(),
        id,
        type: "folder",
        name: paths.base(path),
        parent: parentOf(path),
        content: null,
      });
      return id;
    },

    move: async (from, to) => {
      const entry = entryAt(from);
      await submit({
        op: "move",
        transaction: mint(),
        id: entry.id,
        name: paths.base(to),
        name_version: entry.name_version,
        parent: parentOf(to),
        parent_version: entry.parent_version,
      });
    },

    remove: async (path) => {
      const entry = entryAt(path);
      await submit({
        op: "delete",
        transaction: mint(),
        id: entry.id,
        seen: {
          name_version: entry.name_version,
          parent_version: entry.parent_version,
          deleted_version: entry.deleted_version,
          content_version: entry.content_version ?? null,
        },
      });
    },

    edit: async (path) => {
      const entry = entryAt(path);
      const document = await docs.attach(entry.id);
      document.watch(() => flushes.enqueue(entry.id, () => void flushed(entry.id)));
      return document;
    },

    close: async (path) => {
      const entry = entryAt(path);
      flushes.flush(entry.id);
      await docs.detach(entry.id);
    },

    stop: () => (flushes.dispose({ flush: true }), sync.stop()),
    nudge: sync.nudge,
  };

  function parentOf(path: paths.Path): Id | null {
    const holder = paths.parent(path);
    return holder === "" ? null : entryAt(holder).id;
  }

  async function created(path: paths.Path, payload: string | Uint8Array, mime: string) {
    const id = mint();
    await submit(
      {
        op: "create",
        transaction: mint(),
        id,
        type: "file",
        name: paths.base(path),
        parent: parentOf(path),
        content: await staged(payload, mime),
      },
      payload,
    );
    return id;
  }

  /**
   * An open file's truth is its document, so what reaches the server is
   * whatever the document says when the debounce fires -- not whatever the
   * keystroke that triggered it happened to produce.
   */
  async function flushed(entry: Id) {
    const document = docs.held(entry);
    const current = view.get(entry);
    if (document === undefined || current === undefined) return;
    await written(current, document.text(), TEXT);
  }
};

const notOpenable: documents.Open = () => {
  throw new Error("This workspace was connected without a way to open documents");
};
