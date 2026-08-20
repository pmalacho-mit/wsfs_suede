/**
 * A Liveblocks client for a room with nobody else in it.
 *
 * The editor binds monaco to a `Y.Doc`, and `LiveblocksYjsProvider` is what
 * carries that doc to everyone else. Carrying it somewhere needs an account,
 * a key and a network -- none of which a browser test has, and none of which
 * the sample needs to be useful on its own.
 *
 * So this is a real provider talking to a room that is genuinely empty. Not a
 * room that never answers: an empty room that ANSWERS, which is a different
 * thing and the one that matters. A file is only ever filled from the
 * workspace once the room has said it holds nothing, so a room that stayed
 * silent would leave every file looking empty forever.
 *
 * It is written against what `LiveblocksYjsProvider` actually asks a room
 * for, which is a short list -- and two items on it, `kInternal` and the ydoc
 * message shape, are not things the library considers public. That is the
 * fragile part: a Liveblocks upgrade can move them, and the failure will look
 * like a constructor throwing or a file that never opens.
 */
import { kInternal, ServerMsgCode } from "@liveblocks/core";
import type { createClient } from "@liveblocks/client";
import * as Y from "yjs";

type Client = ReturnType<typeof createClient>;

const base64 = (bytes: Uint8Array) =>
  btoa(String.fromCharCode(...bytes));

/** What an empty document looks like on the wire, computed once. */
const NOTHING = new Y.Doc();
const NO_CHANGES = base64(Y.encodeStateAsUpdate(NOTHING));
const NO_STATE = base64(Y.encodeStateVector(NOTHING));

type Listener<T> = (event: T) => void;

/** The smallest thing that can be subscribed to and later spoken through. */
const channel = <T>() => {
  const listeners = new Set<Listener<T>>();
  return {
    subscribe: (listener: Listener<T>) => (
      listeners.add(listener), () => listeners.delete(listener)
    ),
    say: (event: T) => listeners.forEach((listener) => listener(event)),
  };
};

const room = (id: string) => {
  const status = channel<string>();
  const ydoc = channel<Record<string, unknown>>();

  const entered = {
    id,
    // The provider hands itself over here, and asks for nothing back.
    [kInternal]: { setYjsProvider: (_provider: unknown) => undefined },
    events: {
      status: { subscribe: status.subscribe },
      ydoc: { subscribe: ydoc.subscribe },
      others: { subscribe: () => () => undefined },
      roomWillDestroy: { subscribe: () => () => undefined },
    },
    updatePresence: (_patch: unknown) => undefined,
    getOthers: () => [],
    getPresence: () => ({}),
    getSelf: () => null,

    /**
     * The answer that makes the room empty rather than absent.
     *
     * A `stateVector` in the reply is what the provider treats as "the room
     * has told me everything it has" -- so this is the whole handshake, and
     * `synced` becomes true on the back of it.
     */
    fetchYDoc: (_vector: string, guid?: string) =>
      queueMicrotask(() =>
        ydoc.say({
          type: ServerMsgCode.UPDATE_YDOC,
          update: NO_CHANGES,
          stateVector: NO_STATE,
          guid,
          v2: false,
        }),
      ),

    /** Nobody to send it to. */
    updateYDoc: (_update: string, _guid?: string) => undefined,
  };

  // After the provider has subscribed, so it hears this rather than missing it.
  queueMicrotask(() => status.say("connected"));
  return entered;
};

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
