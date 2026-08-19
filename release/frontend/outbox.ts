/**
 * The queue of work this client has accepted and the server has not yet
 * answered.
 *
 * Two rules hold its size down, and neither is a compression scheme.
 *
 * Successive writes to one entry COALESCE: a later write supersedes an earlier
 * one, so a file edited a thousand times queues one item, not a thousand. The
 * survivor keeps its own content and inherits the DROPPED item's token,
 * because that is the token the server still knows about.
 *
 * And an item is a row of POINTERS: content lives in the byte store under its
 * hash, so a long offline session queues a list of hashes rather than a list
 * of documents.
 */
import type { Digest, Store } from "./bytes";
import { isWrite, type Id, type Submitted, type Transaction, type Write } from "./contract";
import { session } from "./identity";
import { mintedAt } from "./minted";

export type Entry = {
  /** Which page load queued this. An older one never reached the screen. */
  session: string;
  /**
   * When the user acted, ISO 8601 with an explicit Z: sortable, unambiguous,
   * and for humans.
   *
   * READ OUT OF THE REQUEST'S OWN ID rather than off the clock a second time.
   * The transaction is a UUIDv7, so it already carries the millisecond it was
   * minted -- and that is the number the server will derive when it records
   * this. Two clock reads here would be two answers to one question, and the
   * one this client showed would be the one nobody else could see.
   */
  at: string;
  request: Submitted;
  /** Set when the request's payload lives in the byte store. */
  content?: Digest;
};

export type Queue = {
  entries: () => Entry[];
  capture: (request: Submitted, content?: Digest) => Entry;
  evict: (transactions: Iterable<Transaction>) => Digest[];
  pendingFor: (entry: Id) => Entry | undefined;
  size: () => number;
};

const stamped = (request: Submitted, content?: Digest): Entry => ({
  session,
  at: (mintedAt(request.transaction) ?? new Date()).toISOString(),
  request,
  ...(content === undefined ? {} : { content }),
});

const supersedes = (queued: Entry, arriving: Submitted) =>
  isWrite(queued.request) && isWrite(arriving) && queued.request.id === arriving.id;

/**
 * The survivor presents the token the server has actually seen, which is the
 * one the item it replaced was going to present.
 */
const inheriting = (arriving: Write, dropped: Write): Write => ({
  ...arriving,
  content_version: dropped.content_version,
});

export const queue = (bytes: Store, held: Entry[] = []): Queue => {
  const items = [...held];

  const coalesced = (arriving: Submitted, content?: Digest) => {
    const at = items.findIndex((queued) => supersedes(queued, arriving));
    if (at < 0 || !isWrite(arriving)) return undefined;
    const dropped = items[at]!;
    const replacement = stamped(
      inheriting(arriving, dropped.request as Write),
      content,
    );
    items[at] = replacement;
    void bytes.forget(dropped.content === undefined ? [] : [dropped.content]);
    return replacement;
  };

  return {
    entries: () => [...items],
    size: () => items.length,
    pendingFor: (entry) => items.find(({ request }) => request.id === entry),
    capture: (request, content) => {
      const replaced = coalesced(request, content);
      if (replaced) return replaced;
      const captured = stamped(request, content);
      items.push(captured);
      return captured;
    },
    evict: (transactions) => {
      const answered = new Set(transactions);
      const released: Digest[] = [];
      for (let at = items.length - 1; at >= 0; at -= 1) {
        const item = items[at]!;
        if (!answered.has(item.request.transaction)) continue;
        if (item.content !== undefined) released.push(item.content);
        items.splice(at, 1);
      }
      return released;
    },
  };
};

/**
 * What Initialize is given: the requests themselves, in the order they were
 * queued, because replay depends on it.
 */
export const presented = (items: Entry[]): Submitted[] =>
  items.map(({ request }) => request);
