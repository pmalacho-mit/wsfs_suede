/**
 * A Liveblocks client for a room with nobody else in it.
 *
 * The editor binds monaco to a `Y.Doc`, and `LiveblocksYjsProvider` is what
 * carries that doc to everyone else. Carrying it somewhere needs an account,
 * a key and a network -- none of which a browser test has, and none of which
 * the sample needs to be useful on its own.
 *
 * So this is a real provider talking to a room that never connects. Nothing
 * is faked about the editing: the `Y.Doc` is genuine, the binding is genuine,
 * and edits persist through the workspace exactly as they do online. What is
 * missing is only the other people.
 *
 * It is written against what `LiveblocksYjsProvider` actually asks a room
 * for, which is a short list -- and one item on it, `kInternal`, is a symbol
 * the library does not consider public. That is the fragile part: a
 * Liveblocks upgrade can move it, and the failure will be a constructor
 * throwing rather than anything about collaboration.
 */
import { kInternal } from "@liveblocks/core";
import type { createClient } from "@liveblocks/client";

type Client = ReturnType<typeof createClient>;

/** Subscribing to something that never happens still has to be unsubscribable. */
const silence = () => ({ subscribe: (_listener: unknown) => () => undefined });

const room = (id: string) => ({
  id,
  // The provider hands itself over here, and asks for nothing back.
  [kInternal]: { setYjsProvider: (_provider: unknown) => undefined },
  events: {
    // Never "connected", so the provider never tries to sync. That is the
    // whole of being offline; everything else follows from it.
    status: silence(),
    ydoc: silence(),
    others: silence(),
    roomWillDestroy: silence(),
  },
  updatePresence: (_patch: unknown) => undefined,
  getOthers: () => [],
  getPresence: () => ({}),
  getSelf: () => null,
  fetchYDoc: (_vector: string, _guid?: string) => undefined,
  updateYDoc: (_update: string, _guid?: string) => undefined,
});

/**
 * Shaped like a client, and honest about being less than one: `enterRoom` is
 * all the editor uses, so it is all this has.
 */
export const solo = (): Client => {
  const rooms = new Map<string, ReturnType<typeof room>>();
  return {
    enterRoom: (id: string) => {
      const entered = rooms.get(id) ?? room(id);
      rooms.set(id, entered);
      return { room: entered, leave: () => rooms.delete(id) };
    },
  } as unknown as Client;
};
