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

import {
  connect,
  contract,
  http,
  inMemory,
  rooms,
  type Transport,
  type Workspace,
} from "$wsfs";

import { emailOf, type Part } from "./collaboration";
import {
  Rooms,
  become,
  type Replacement,
  type Room,
  type Stored,
} from "./room.svelte";

export { become } from "./room.svelte";
export type { Replacement, Stored } from "./room.svelte";

type LiveblocksClient = ReturnType<typeof createClient>;

const BACKEND = "/wsfs";

const asUser = (email: string) => async () => ({ "X-User-Email": email });

export const clientAs = (email: string): LiveblocksClient =>
  createClient({
    authEndpoint: async (room) => {
      const answer = await fetch(
        `/liveblocks/token?rooms=${encodeURIComponent(room ?? "")}`,
        { headers: { "X-User-Email": email } },
      );
      if (!answer.ok)
        throw new Error(`token: ${answer.status} ${await answer.text()}`);
      return (await answer.json()) as { token: string };
    },
  });

/**
 * Liveblocks, as `Rooms` wants it.
 *
 * The document is handed IN rather than taken from the provider -- see
 * `room.svelte.ts`. A document owned by the provider would be destroyed with
 * it, which is precisely the thing a network lapse must not do.
 */
export const enteringWith = (liveblocks: LiveblocksClient) =>
  ((entry, doc) => {
    const entered = liveblocks.enterRoom(entry);
    return {
      provider: new LiveblocksYjsProvider(entered.room, doc),
      leave: () => entered.leave(),
    };
  }) satisfies ConstructorParameters<typeof Rooms>[1];

export class Collaborator {
  readonly part: Part;
  readonly email: string;
  readonly workspaceId: string;
  readonly workspace: Workspace;
  readonly transport: Transport;
  readonly liveblocks: LiveblocksClient;
  readonly rooms: Rooms;

  constructor(part: Part, workspaceId: string) {
    this.part = part;
    this.workspaceId = workspaceId;
    this.email = emailOf(part);
    /**
     * Held as well as handed over, because reading a file at a version is
     * something a room needs for itself, and the transport already knows how
     * to tell text from bytes. A second reader written here would have to
     * learn that again, and would learn it wrong the first time a file turned
     * binary.
     */
    this.transport = http(BACKEND, asUser(this.email));
    this.workspace = connect({
      workspace: workspaceId,
      transport: this.transport,
      bytes: inMemory(),
    });
    this.liveblocks = clientAs(this.email);
    this.rooms = new Rooms(this.workspace, enteringWith(this.liveblocks));
  }

  /** Every verdict every room here settled on, in the order they arrived. */
  get verdicts(): rooms.Verdict[] {
    return [...this.rooms.held.values()].flatMap((room) => room.verdicts);
  }

  path(entry: string): string | undefined {
    const index = this.workspace.index();
    for (const path of index.paths())
      if (index.at(path)?.id === entry) return path;
    return undefined;
  }

  token(entry: string): string | null {
    return this.rooms.token(entry);
  }

  #room(entry: string): Room {
    const room = this.rooms.get(entry);
    if (room === undefined) throw new Error(`${entry} is not open here`);
    return room;
  }

  #path(entry: string): string {
    const path = this.path(entry);
    if (path === undefined) throw new Error(`${entry} has no path here`);
    return path;
  }

  async open(entry: string): Promise<rooms.Verdict> {
    const room = await this.rooms.open(entry);
    return room.verdicts[room.verdicts.length - 1] ?? { kind: "current" };
  }

  text(entry: string): string {
    return this.rooms.get(entry)?.text.toString() ?? "";
  }

  /** Whether this room may answer for the file, and write it back. */
  speaks(entry: string): boolean {
    return this.rooms.get(entry)?.speaks === true;
  }

  replacement(entry: string): Replacement | undefined {
    return this.rooms.get(entry)?.replaced;
  }

  /** Type, as the one writer a document is allowed to have. */
  type(entry: string, next: string) {
    become(this.#room(entry).text, next);
  }

  store(entry: string): Promise<Stored> {
    return this.#room(entry).store(this.#path(entry));
  }

  /** A write that does NOT go through the room -- a script, another tool. */
  writeAround(entry: string, text: string) {
    return this.workspace.write(this.#path(entry), text).settled;
  }

  /** Bytes over a file somebody may have open as text. */
  replace(entry: string, bytes: Uint8Array, mime: string) {
    return this.workspace.write(this.#path(entry), bytes, mime).settled;
  }

  goOffline(entry: string) {
    this.rooms.get(entry)?.detach();
  }

  comeBack(entry: string): Promise<void> {
    return this.#room(entry).reattach();
  }

  /**
   * The four tokens an entry stands at, as `reconstruction` asks for them.
   *
   * All four, not just the content one: together they ARE the entry -- what it
   * is called, where it lives, whether it is gone, and what is in it -- and a
   * snapshot naming all four can be rebuilt into the filesystem as it stood.
   */
  snapshot(entry: string): contract.Versions {
    const held = this.workspace.entries().get(entry);
    if (held === undefined) throw new Error(`${entry} is not in this workspace`);
    return {
      id: held.id,
      name_version: held.name_version,
      parent_version: held.parent_version,
      deleted_version: held.deleted_version,
      content_version: held.content_version ?? null,
    };
  }

  /**
   * Which of a snapshot's tokens have never left this machine.
   *
   * Empty is what makes a snapshot portable: anything else names work sitting
   * in this client's outbox, which nothing on the server can rebuild.
   */
  unsettled(taken: readonly contract.Versions[]): string[] {
    const tokens = taken.flatMap((entry) =>
      [
        entry.name_version,
        entry.parent_version,
        entry.deleted_version,
        entry.content_version,
      ].filter((token): token is string => typeof token === "string"),
    );
    return this.workspace.unsettled(tokens);
  }

  /** What the server says those transactions said. */
  async rebuild(
    taken: readonly contract.Versions[],
  ): Promise<contract.Reconstructed[]> {
    const answer = await fetch(
      `${BACKEND}/workspaces/${this.workspaceId}/reconstruction`,
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "X-User-Email": this.email,
        },
        body: JSON.stringify({ entries: taken }),
      },
    );
    if (!answer.ok)
      throw new Error(`reconstruction: ${answer.status} ${await answer.text()}`);
    return ((await answer.json()) as contract.ReconstructionResponse).entries;
  }

  dispose() {
    this.rooms.dispose();
    this.workspace.stop();
  }
}
