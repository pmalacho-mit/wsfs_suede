/**
 * One participant, as a test can drive one.
 *
 * The protocol itself is NOT here any more -- it is in `room.svelte.ts`, which
 * is the same code `Workspace.svelte` runs. That is the point: what these two
 * browsers prove is now a claim about the component a user touches rather than
 * about a second implementation that merely resembled it.
 *
 * What is left here is everything a scenario needs and a widget does not: the
 * identity to connect as, a network that can be taken away and given back, and
 * the snapshot/reconstruction round trip. It is still separate from
 * `Workspace.svelte` on purpose -- the claims are about what happens BETWEEN
 * two clients, and a monaco instance in the middle would only make a failure
 * harder to place.
 */
import { createClient } from "@liveblocks/client";
import { LiveblocksYjsProvider } from "@liveblocks/yjs";
import { IndexeddbPersistence, storeState } from "y-indexeddb";
import { Rooms, type Persist, type Host } from "./room.svelte";

type LiveblocksClient = ReturnType<typeof createClient>;

/**
 * Asking the backend to make an entry's room exist and return it's content.
 */
const settling = async (entry: string) => {
  const answer = await fetch(`/rooms/${encodeURIComponent(entry)}`, {
    method: "POST",
  });
  if (!answer.ok) throw new Error(`settling ${entry}: ${answer.status}`);
  return ((await answer.json()) as { base: string | null }).base;
};

/**
 * Asking the host to fill a room now, so opening the file later is instant.
 */
export const warmRoom = async (entry: string): Promise<void> => {
  await fetch(`/rooms/${encodeURIComponent(entry)}/warm`, { method: "POST" });
};

/**
 * Telling the backend a member of this room wrote the file.
 *
 * Cheap on purpose, and it is what makes everybody else's settle free: the
 * room already holds the text, so the host only has to be told where the file
 * now stands rather than go and look.
 */
const storedFromRoom = async (entry: string, version: string) => {
  const answer = await fetch(`/rooms/${encodeURIComponent(entry)}/stored`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ version }),
  });
  if (!answer.ok) throw new Error(`stored ${entry}: ${answer.status}`);
};

const synchronized = (provider: LiveblocksYjsProvider) =>
  provider.getStatus() === "synchronized";

/**
 * Settles once Liveblocks has confirmed everything this client is holding.
 *
 * Subscribed rather than polled, and it is the answer `#settling` used to
 * guess at with 600ms. What matters is that the SERVER has the changes, not
 * that other browsers have applied them: the host reads a room through the
 * same REST API, so once Liveblocks has them, a read will see them.
 */
export const untilSynchronized = (
  liveblocks: LiveblocksClient,
  provider: LiveblocksYjsProvider,
) =>
  new Promise<void>((done) => {
    if (synchronized(provider)) return done();
    const unsubscribe = liveblocks.events.syncStatus.subscribe(() => {
      if (!synchronized(provider)) return;
      unsubscribe();
      done();
    });
  });

/**
 * This machine's own copy, kept under the entry's id.
 *
 * Keyed by entry rather than by session so that the next tab to open the same
 * file finds it -- which is the whole point: work reaches here the moment it
 * is typed, and outlives the tab that typed it.
 */
export const persisting: Persist = (entry, doc) => {
  const kept = new IndexeddbPersistence(`wsfs:${entry}`, doc);
  return {
    loaded: kept.whenSynced.then(() => undefined),
    stop: async () => {
      /**
       * The flush is best effort, and it has to be.
       *
       * A store that is already closing -- a second teardown, a browser
       * tearing the page down around this -- throws from `storeState`, and
       * that throw used to travel: `Rooms.dispose` waits on all its rooms
       * together, so one room whose connection had gone abandoned the flush
       * of every OTHER room beside it. Losing one room's last update is bad;
       * losing everybody's because of it is the thing worth preventing.
       */
      try {
        await storeState(kept, true);
      } catch {
        /** Nothing to do about it, and nothing worth stopping for. */
      }
      try {
        await kept.destroy();
      } catch {
        /** Already gone, which is where this was trying to get to. */
      }
    },
  };
};

const handingOver = async (entry: string, update: Uint8Array) => {
  const answer = await fetch(`/rooms/${encodeURIComponent(entry)}/updates`, {
    method: "POST",
    headers: { "Content-Type": "application/octet-stream" },
    body: update as BodyInit,
  });
  if (!answer.ok) throw new Error(`handing over ${entry}: ${answer.status}`);
};

/** Everything a room asks of this host, in one place. */
export const hosted: Host = {
  settle: settling,
  stored: storedFromRoom,
  handOver: handingOver,
};

export const enteringWith = (liveblocks: LiveblocksClient) =>
  ((entry, doc) => {
    const entered = liveblocks.enterRoom(entry);
    const provider = new LiveblocksYjsProvider(entered.room, doc);
    return {
      provider: Object.assign(provider, {
        ahead: () => provider.getStatus() === "synchronizing",
        handedOver: () => untilSynchronized(liveblocks, provider),
        watch: (changed: () => void) =>
          liveblocks.events.syncStatus.subscribe(changed),
      }),
      leave: () => entered.leave(),
    };
  }) satisfies ConstructorParameters<typeof Rooms>[1];
