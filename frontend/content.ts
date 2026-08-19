/**
 * Reading a file, in the order the answers are trustworthy.
 *
 *   1. an open document -- the CRDT is the truth while somebody is editing
 *   2. the cache, keyed by the content token the last event announced
 *   3. the server
 *
 * Step 2 is keyed by TOKEN rather than by id, which is what makes it correct
 * without an invalidation step: a `write` event advances the token, so the
 * cache line for the old one simply stops being asked for.
 */
import { asText } from "./bytes";
import type { Id, Metadata, Version } from "./contract";
import type { Registry } from "./documents";

export type Held =
  | { kind: "text"; text: string }
  | { kind: "binary"; bytes: Uint8Array; mime: string };

export type Fetch = (entry: Id, version: Version) => Promise<Held>;

export type Content = {
  /** What the file holds now, from wherever can answer soonest. */
  read: (entry: Metadata) => Promise<Held | undefined>;
  /** What is already in hand, with no network and no waiting. */
  holding: (entry: Metadata) => Held | undefined;
  /**
   * Pull an entry's content into the cache before anybody asks for it, so the
   * kernel's synchronous filesystem calls can be answered out of state rather
   * than out of a request it would have to block on.
   */
  prefetch: (entry: Metadata) => Promise<void>;
  forget: (entry: Id) => void;
};

const keyed = (entry: Metadata) => entry.content_version ?? undefined;

export const cache = (documents: Registry, fetch: Fetch): Content => {
  const held = new Map<Version, Held>();
  const byEntry = new Map<Id, Version>();
  const arriving = new Map<Version, Promise<Held>>();

  const edited = (entry: Metadata): Held | undefined => {
    const document = documents.held(entry.id);
    return document === undefined ? undefined : { kind: "text", text: document.text() };
  };

  const cached = (version: Version | undefined) =>
    version === undefined ? undefined : held.get(version);

  const fetched = async (entry: Metadata, version: Version) => {
    const already = arriving.get(version);
    if (already) return already;
    const request = fetch(entry.id, version).then((content) => {
      held.set(version, content);
      byEntry.set(entry.id, version);
      arriving.delete(version);
      return content;
    });
    arriving.set(version, request);
    return request;
  };

  const holding = (entry: Metadata) => edited(entry) ?? cached(keyed(entry));

  return {
    holding,
    forget: (entry) => {
      const version = byEntry.get(entry);
      if (version !== undefined) held.delete(version);
      byEntry.delete(entry);
    },
    read: async (entry) => {
      const inHand = holding(entry);
      if (inHand) return inHand;
      const version = keyed(entry);
      return version === undefined ? undefined : fetched(entry, version);
    },
    prefetch: async (entry) => {
      if (holding(entry)) return;
      const version = keyed(entry);
      if (version !== undefined) await fetched(entry, version).catch(() => undefined);
    },
  };
};

export const textOf = (content: Held) =>
  content.kind === "text" ? content.text : asText(content.bytes);
