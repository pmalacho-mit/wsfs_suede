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
import type { Create, Id, Metadata, Move, Rename, Reparent, Submitted } from "./contract";
import type { Entry } from "./outbox";

export type View = ReadonlyMap<Id, Metadata>;

type Overlay = (entry: Metadata, request: Submitted) => Metadata;

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
});

const laidOver = (view: Map<Id, Metadata>, { request }: Entry) => {
  if (request.op === "create") return view.set(request.id, proposed(request));
  const entry = view.get(request.id);
  const overlay = OVERLAYS[request.op];
  if (entry === undefined || overlay === undefined) return view;
  return view.set(request.id, overlay(entry, request));
};

export const of = (confirmed: Confirmed, queued: Entry[]): View =>
  queued.reduce(laidOver, new Map(confirmed));

export const live = (view: View): Metadata[] =>
  [...view.values()].filter((entry) => !entry.deleted);
