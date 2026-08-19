/**
 * What the UI and the filesystem actually read.
 *
 *     effective = outbox.replayOver(confirmed)
 *
 * Optimistic updates are DERIVED, never applied. When a transaction is evicted
 * because its own event arrived, the confirmed change and the overlay's
 * removal cancel exactly and nothing flickers. When it is evicted by a
 * refusal, the view snaps back on its own -- undo is not an operation here,
 * it is a recomputation.
 */
import type { Confirmed } from "./confirmed";
import type {
  Create,
  Id,
  Metadata,
  Move,
  Occurrence,
  Rename,
  Reparent,
  Submitted,
} from "./contract";
import { mintedAt } from "./minted";
import type { Entry } from "./outbox";

export type View = ReadonlyMap<Id, Metadata>;

type Overlay = (entry: Metadata, request: Submitted) => Metadata;

/**
 * When a QUEUED transaction happened, as far as anyone can yet say.
 *
 * `accepted` is null, and that is the whole point of it being nullable: this
 * client acted, nobody has agreed yet, and a UI that wants to mark pending work
 * has the fact rather than having to consult the outbox for it. When the event
 * for this transaction arrives the overlay disappears and the confirmed entry
 * underneath carries a real `accepted` -- so the null resolves by the same
 * cancellation that makes every other optimistic change stop flickering.
 */
const pending = (request: Submitted): Occurrence => ({
  minted: mintedAt(request.transaction)?.toISOString() ?? null,
  offset: request.offset ?? null,
  accepted: null,
});

/**
 * Every overlay moves `modified`, including `write` -- which changes nothing
 * else about an entry and is therefore absent from the confirmed path, but is
 * the most ordinary reason a file's mtime moves. Only the mtime: a queued
 * write's own transaction is NOT laid over `content_version`, because that
 * token is what invalidates the content cache and the cache must not be told a
 * write landed before it did.
 */
const OVERLAYS: Record<string, Overlay> = {
  rename: (entry, request) => ({ ...entry, name: (request as Rename).name }),
  reparent: (entry, request) => ({
    ...entry,
    parent: (request as Reparent).parent ?? null,
  }),
  move: (entry, request) => ({
    ...entry,
    name: (request as Move).name,
    parent: (request as Move).parent ?? null,
  }),
  delete: (entry) => ({ ...entry, deleted: true }),
  write: (entry) => entry,
};

/**
 * A queued create has no confirmed entry to lay over, so it contributes one --
 * with its own transaction as every token, which is exactly what the server
 * will record if it accepts it.
 */
const proposed = (request: Create): Metadata => ({
  id: request.id,
  type: request.type,
  name: request.name,
  parent: request.parent ?? null,
  name_version: request.transaction,
  parent_version: request.transaction,
  deleted_version: request.transaction,
  content_version: request.content ? request.transaction : null,
  modified: pending(request),
});

const laidOver = (view: Map<Id, Metadata>, { request }: Entry) => {
  if (request.op === "create") return view.set(request.id, proposed(request));
  const entry = view.get(request.id);
  const overlay = OVERLAYS[request.op];
  if (entry === undefined || overlay === undefined) return view;
  return view.set(request.id, {
    ...overlay(entry, request),
    modified: pending(request),
  });
};

export const of = (confirmed: Confirmed, queued: Entry[]): View =>
  queued.reduce(laidOver, new Map(confirmed));

export const live = (view: View): Metadata[] =>
  [...view.values()].filter((entry) => !entry.deleted);
