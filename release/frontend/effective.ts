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
 *
 * An overlay never advances a version token: the token it presents has to stay
 * the one the SERVER has seen, or the next request would compare against a
 * value that was never issued. So the tokens cannot say who is responsible for
 * an optimistic value, and `overlaid` is what says it instead.
 */
import type { Confirmed } from "./confirmed";
import type {
  Create,
  Id,
  Metadata,
  Move,
  Rename,
  Reparent,
  Submitted,
  Transaction,
} from "./contract";
import type { Entry } from "./outbox";

export type View = ReadonlyMap<Id, Metadata>;

/** The four things about an entry that can move independently. */
export type Property = "name" | "parent" | "deleted" | "content";

/**
 * Which queued transaction is responsible for each property it overlays.
 * A property absent here is showing the confirmed value, and the confirmed
 * value carries its own token.
 */
export type Overlaid = ReadonlyMap<Id, Partial<Record<Property, Transaction>>>;

export type Effective = {
  view: View;
  overlaid: Overlaid;
  /** Every transaction still waiting. A change whose author has left this set
   *  since is not taking effect -- it is being taken back. */
  queued: ReadonlySet<Transaction>;
};

/**
 * What an op does, and what it does it to, in one place -- so a reader asking
 * "who set this" and a reader asking "what does it say" cannot disagree.
 */
type Overlay = {
  touches: readonly Property[];
  apply: (entry: Metadata, request: Submitted) => Metadata;
};

const OVERLAYS: Record<string, Overlay> = {
  rename: {
    touches: ["name"],
    apply: (entry, request) => ({ ...entry, name: (request as Rename).name }),
  },
  reparent: {
    touches: ["parent"],
    apply: (entry, request) => ({
      ...entry,
      parent: (request as Reparent).parent ?? null,
    }),
  },
  move: {
    touches: ["name", "parent"],
    apply: (entry, request) => ({
      ...entry,
      name: (request as Move).name,
      parent: (request as Move).parent ?? null,
    }),
  },
  delete: {
    touches: ["deleted"],
    apply: (entry) => ({ ...entry, deleted: true }),
  },
  write: { touches: ["content"], apply: (entry) => entry },
};

/** A create contributes an entry, so it is responsible for all of it. */
const CREATED: readonly Property[] = ["name", "parent", "deleted", "content"];

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
});

const credit = (
  overlaid: Map<Id, Partial<Record<Property, Transaction>>>,
  entry: Id,
  properties: readonly Property[],
  transaction: Transaction,
) => {
  const already = overlaid.get(entry) ?? {};
  for (const property of properties) already[property] = transaction;
  overlaid.set(entry, already);
};

export const of = (confirmed: Confirmed, queued: Entry[]): Effective => {
  const view = new Map(confirmed);
  const overlaid = new Map<Id, Partial<Record<Property, Transaction>>>();
  const waiting = new Set<Transaction>();

  for (const { request } of queued) {
    waiting.add(request.transaction);
    if (request.op === "create") {
      view.set(request.id, proposed(request));
      credit(overlaid, request.id, CREATED, request.transaction);
      continue;
    }
    const entry = view.get(request.id);
    const overlay = OVERLAYS[request.op];
    if (entry === undefined || overlay === undefined) continue;
    view.set(request.id, overlay.apply(entry, request));
    credit(overlaid, request.id, overlay.touches, request.transaction);
  }

  return { view, overlaid, queued: waiting };
};

export const live = (view: View): Metadata[] =>
  [...view.values()].filter((entry) => !entry.deleted);
