/**
 * Open text files, and who owns their contents while they are open.
 *
 * An open file's truth is its Y.Doc, not this client's cache and not the
 * server's last accepted write. That is the whole reason the collaboration
 * plane exists: edits there are genuinely concurrent and peer-shaped, and a
 * CRDT is the only thing that merges them without losing somebody's typing.
 *
 * The seam is deliberately this thin. This module knows that a document has
 * text, that it can be watched, and that it must be flushed before it is let
 * go. It does not know about rooms, providers, or awareness -- `Documents`
 * is satisfied by anything that can answer those three questions, which is
 * what keeps Liveblocks out of every other file in this package.
 */
import type { Id } from "./contract";

export type Document = {
  text: () => string;
  watch: (changed: () => void) => () => void;
  /** Leave the room, having first made sure the server has everything. */
  release: () => Promise<void>;
  /**
   * The shared type an editor binds to, for editors that can.
   *
   * `text()` is enough for everything that only reads -- the kernel, a
   * preview, the debounced flush -- but an editor bound directly to the CRDT
   * merges keystrokes rather than reconciling snapshots of them. Deliberately
   * untyped: naming it would make this package depend on the collaboration
   * library, which is the one thing this seam exists to avoid.
   */
  shared?: unknown;
};

export type Open = (entry: Id) => Document | Promise<Document>;

export type Registry = {
  /** The doc for an entry, if this client has one open. */
  held: (entry: Id) => Document | undefined;
  attach: (entry: Id) => Promise<Document>;
  detach: (entry: Id) => Promise<void>;
  /** Deleting an entry wipes its doc, so stale CRDT state cannot resurrect. */
  evict: (entry: Id) => Promise<void>;
  open: () => Id[];
};

type Held = { document: Document; references: number };

export const registry = (open: Open): Registry => {
  const held = new Map<Id, Held>();
  const opening = new Map<Id, Promise<Document>>();

  const dropped = async (entry: Id, release: boolean) => {
    const holding = held.get(entry);
    if (holding === undefined) return;
    held.delete(entry);
    if (release) await holding.document.release();
  };

  return {
    held: (entry) => held.get(entry)?.document,
    open: () => [...held.keys()],

    attach: async (entry) => {
      const holding = held.get(entry);
      if (holding) return (holding.references += 1), holding.document;
      const arriving = opening.get(entry) ?? Promise.resolve(open(entry));
      opening.set(entry, arriving);
      const document = await arriving;
      opening.delete(entry);
      held.set(entry, { document, references: (held.get(entry)?.references ?? 0) + 1 });
      return document;
    },

    detach: async (entry) => {
      const holding = held.get(entry);
      if (holding === undefined) return;
      holding.references -= 1;
      if (holding.references > 0) return;
      await dropped(entry, true);
    },

    evict: (entry) => dropped(entry, true),
  };
};
