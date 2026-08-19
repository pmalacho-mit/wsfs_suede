/**
 * Content-addressed bytes.
 *
 * An outbox entry is a row of pointers: the payload it would send lives here,
 * under its sha256. Two writes of the same content cost one copy, a blob is
 * verifiable against its own name, and a queue that has been offline all day
 * is a list of hashes rather than a list of documents.
 */
export type Digest = string;

export type Store = {
  put: (content: Uint8Array | string) => Promise<Digest>;
  read: (digest: Digest) => Promise<Uint8Array | undefined>;
  text: (digest: Digest) => Promise<string | undefined>;
  forget: (digests: Iterable<Digest>) => Promise<void>;
};

const encoder = new TextEncoder();
const decoder = new TextDecoder();

const bytesOf = (content: Uint8Array | string) =>
  typeof content === "string" ? encoder.encode(content) : content;

const hex = (buffer: ArrayBuffer) =>
  [...new Uint8Array(buffer)]
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");

export const digestOf = async (content: Uint8Array | string): Promise<Digest> =>
  hex(await crypto.subtle.digest("SHA-256", bytesOf(content) as BufferSource));

/**
 * The store the browser has before IndexedDB is wired up, and the one tests
 * use. Losing it loses queued payloads, which is why it is not the default
 * anywhere a user can reach.
 */
export const inMemory = (): Store => {
  const held = new Map<Digest, Uint8Array>();
  return {
    put: async (content) => {
      const digest = await digestOf(content);
      held.set(digest, bytesOf(content));
      return digest;
    },
    read: async (digest) => held.get(digest),
    text: async (digest) => {
      const bytes = held.get(digest);
      return bytes === undefined ? undefined : decoder.decode(bytes);
    },
    forget: async (digests) => {
      for (const digest of digests) held.delete(digest);
    },
  };
};

export const asText = (bytes: Uint8Array) => decoder.decode(bytes);
export const asBytes = (text: string) => encoder.encode(text);
