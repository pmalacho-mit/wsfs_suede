/**
 * The durable outbox: IndexedDB, one database, everything scoped by workspace.
 *
 * Three stores, and the split is the point. `queued` holds the rows of
 * pointers -- what was asked for and has not been answered. `answers` holds
 * the three things a snapshot cannot speak to. `bytes` holds the payloads
 * those rows point at, under their own digests.
 *
 * A ROW PER TRANSACTION, not a document per workspace. Two tabs share this
 * storage, and each appends and removes its own rows without either of them
 * reading a whole outbox and writing back a version that forgot the other's
 * work. Nothing here assumes the tab that finds a row is the tab that wrote it.
 */
import { asText, digestOf, type Digest, type Store } from "./bytes";
import type { Id, Transaction } from "./contract";
import { referenced, type Kept, type Restored } from "./kept";
import type { Entry } from "./outbox";

const DATABASE = "wsfs";
const VERSION = 1;

const QUEUED = "queued";
const ANSWERS = "answers";
const BYTES = "bytes";

const WORKSPACE = "workspace";

/** Scoped by construction: no key can be formed without naming its workspace. */
const keyed = (workspace: Id, id: string) => `${workspace}:${id}`;

type Queued = {
  key: string;
  workspace: Id;
  transaction: Transaction;
  entry: Entry;
};
type Answer = { key: string; workspace: Id; transaction: Transaction };
type Bytes = { key: string; workspace: Id; digest: Digest; bytes: Uint8Array };

const awaited = <T>(request: IDBRequest<T>): Promise<T> =>
  new Promise((done, failed) => {
    request.onsuccess = () => done(request.result);
    request.onerror = () => failed(request.error);
  });

const opened = (): Promise<IDBDatabase> =>
  new Promise((done, failed) => {
    if (typeof indexedDB === "undefined")
      return failed(
        new Error(
          "IndexedDB is unavailable, so a queue cannot outlive the page. " +
            "Connect with `bytes: inMemory()` and no `kept` to accept that, " +
            "knowing unsent work dies with the tab.",
        ),
      );
    const request = indexedDB.open(DATABASE, VERSION);
    request.onupgradeneeded = () => {
      const database = request.result;
      for (const name of [QUEUED, ANSWERS, BYTES]) {
        if (database.objectStoreNames.contains(name)) continue;
        database
          .createObjectStore(name, { keyPath: "key" })
          .createIndex(WORKSPACE, WORKSPACE, { unique: false });
      }
    };
    request.onsuccess = () => done(request.result);
    request.onerror = () => failed(request.error);
  });

const everythingIn = <T>(
  database: IDBDatabase,
  store: string,
  workspace: Id,
): Promise<T[]> =>
  awaited(
    database
      .transaction(store, "readonly")
      .objectStore(store)
      .index(WORKSPACE)
      .getAll(IDBKeyRange.only(workspace)),
  ) as Promise<T[]>;

export type Keeping = {
  bytes: Store;
  kept: Kept;
  restored: Restored;
  /**
   * Every workspace with unsent work written down here.
   *
   * A queue is drained by the stream of the workspace it belongs to, and a
   * client follows one workspace at a time -- so work queued somewhere the
   * user has navigated away from waits, correctly, for them to come back.
   * This is what lets a consumer say so rather than leaving it silent.
   */
  waiting: () => Promise<Id[]>;
};

/**
 * Open the durable outbox for one workspace and read back what it holds.
 *
 * Awaited once, before `connect`, because a client that started serving reads
 * and then discovered it had queued work would have shown a view that was
 * missing its own.
 */
export const keeping = async (workspace: Id): Promise<Keeping> => {
  const database = await opened();

  /**
   * One chain, and everything that WRITES or reads-to-decide is on it.
   *
   * The queue in memory is already right, so no caller waits for a disk --
   * but the order matters between two of these. Evicting a queued write hands
   * the digest it was holding to the chained write behind it, and the byte
   * store then asks what is still referenced. Ask that before the hand-over
   * has landed and the answer is "nothing", the bytes go, and the delta
   * behind them can never be read back. That is not hypothetical: it is what
   * happened, in both browsers, the first time a real store was underneath.
   */
  let writing: Promise<unknown> = Promise.resolve();
  const inOrder = <T>(work: () => Promise<T>): Promise<T> => {
    const mine = writing.then(work, work);
    writing = mine.catch(() => undefined);
    return mine;
  };

  const put = (store: string, value: Queued | Answer) =>
    void inOrder(() =>
      awaited(
        database.transaction(store, "readwrite").objectStore(store).put(value),
      ),
    );

  const remove = (store: string, keys: string[]) =>
    void inOrder(async () => {
      const held = database.transaction(store, "readwrite").objectStore(store);
      await Promise.all(keys.map((key) => awaited(held.delete(key))));
    });

  const queued = await everythingIn<Queued>(database, QUEUED, workspace);
  const answers = await everythingIn<Answer>(database, ANSWERS, workspace);

  const row = (entry: Entry): Queued => ({
    key: keyed(workspace, entry.request.transaction),
    workspace,
    transaction: entry.request.transaction,
    entry,
  });

  const kept: Kept = {
    /**
     * ONE IndexedDB transaction, which is what makes it indivisible. The
     * amendment an eviction makes to the write behind it is the only thing
     * standing between that write and bytes it can no longer name, so it must
     * not be possible to observe the removal without it.
     */
    moved: ({ written = [], gone = [] }) =>
      void inOrder(async () => {
        const store = database
          .transaction(QUEUED, "readwrite")
          .objectStore(QUEUED);
        await Promise.all([
          ...written.map((entry) => awaited(store.put(row(entry)))),
          ...gone.map((one) => awaited(store.delete(keyed(workspace, one)))),
        ]);
      }),
    answered: (transactions) => {
      for (const transaction of transactions)
        put(ANSWERS, {
          key: keyed(workspace, transaction),
          workspace,
          transaction,
        });
    },
    redundant: (transactions) =>
      remove(
        ANSWERS,
        [...transactions].map((one) => keyed(workspace, one)),
      ),
  };

  /**
   * When each digest was last stored.
   *
   * A release is decided from what the queue held when it was ASKED for, and
   * it runs later. Between the two, the same bytes can be stored again --
   * routinely, because the store is content-addressed and identical text
   * hashes to one place. Deleting them then would take bytes a live entry has
   * just claimed, and the entry that named them would come back unreadable.
   */
  let tick = 0;
  const stamped = new Map<Digest, number>();

  const held = (digest: Digest) =>
    awaited(
      database
        .transaction(BYTES, "readonly")
        .objectStore(BYTES)
        .get(keyed(workspace, digest)),
    ) as Promise<Bytes | undefined>;

  const bytes: Store = {
    put: async (content) => {
      const digest = await digestOf(content);
      const stored =
        typeof content === "string"
          ? new TextEncoder().encode(content)
          : content;
      stamped.set(digest, (tick += 1));
      await awaited(
        database
          .transaction(BYTES, "readwrite")
          .objectStore(BYTES)
          .put({
            key: keyed(workspace, digest),
            workspace,
            digest,
            bytes: stored,
          }),
      );
      return digest;
    },
    read: async (digest) => (await held(digest))?.bytes,
    text: async (digest) => {
      const found = await held(digest);
      return found === undefined ? undefined : asText(found.bytes);
    },
    /**
     * Checked against what is WRITTEN DOWN, not against one queue in memory.
     * Another tab on this workspace has its own queue, and its chained writes
     * are deltas against bytes this one is about to call unreferenced.
     */
    forget: (digests) => {
      const wanted = [...digests];
      const asked = (tick += 1);
      return inOrder(async () => {
        if (wanted.length === 0) return;
        const still = referenced(
          (await everythingIn<Queued>(database, QUEUED, workspace)).map(
            (row) => row.entry,
          ),
        );
        const releasable = wanted.filter(
          (digest) => !still.has(digest) && (stamped.get(digest) ?? 0) < asked,
        );
        if (releasable.length === 0) return;
        const store = database
          .transaction(BYTES, "readwrite")
          .objectStore(BYTES);
        await Promise.all(
          releasable.map((digest) =>
            awaited(store.delete(keyed(workspace, digest))),
          ),
        );
        for (const digest of releasable) stamped.delete(digest);
      });
    },
  };

  return {
    bytes,
    kept,
    restored: {
      entries: queued.map((row) => row.entry),
      recorded: answers.map((row) => row.transaction),
    },
    waiting: async () => {
      const rows = (await awaited(
        database.transaction(QUEUED, "readonly").objectStore(QUEUED).getAll(),
      )) as Queued[];
      return [...new Set(rows.map((row) => row.workspace))];
    },
  };
};
