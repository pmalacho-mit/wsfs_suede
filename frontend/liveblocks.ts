/**
 * Open text files, joined through Liveblocks.
 *
 * One room and one `Y.Doc` per open entry, keyed by the entry's id -- which is
 * client-minted, so a room can be entered before the server has acknowledged
 * the file that names it.
 *
 * This is the only file in the package that knows Liveblocks exists. Everything
 * else asks a `Document` three questions, which is what keeps the collaboration
 * plane from leaking into the authority plane.
 */
import type { Document, Open } from "./documents";

export type Doc = {
  getText: (name: string) => { toString: () => string; observe: (fn: () => void) => void; unobserve: (fn: () => void) => void };
  destroy: () => void;
};

export type Provider = {
  destroy: () => void;
  /** Resolves once the server has everything this doc holds. */
  synced?: boolean;
  on?: (event: string, handler: () => void) => void;
  off?: (event: string, handler: () => void) => void;
};

export type Joining = (entry: string) => {
  doc: Doc;
  provider: Provider;
  leave: () => void;
};

export const TEXT = "content";

/**
 * Detaching never discards: a document with unsynced changes stays in its room
 * until the server has it, and only then leaves.
 */
const flushed = (provider: Provider) =>
  new Promise<void>((done) => {
    if (provider.synced || provider.on === undefined) return done();
    const settle = () => (provider.off?.("synced", settle), done());
    provider.on("synced", settle);
  });

export const documents = (join: Joining): Open => (entry) => {
  const { doc, provider, leave } = join(entry);
  const text = doc.getText(TEXT);

  const document: Document = {
    shared: text,
    text: () => text.toString(),
    watch: (changed) => (text.observe(changed), () => text.unobserve(changed)),
    release: async () => {
      await flushed(provider);
      provider.destroy();
      doc.destroy();
      leave();
    },
  };
  return document;
};
