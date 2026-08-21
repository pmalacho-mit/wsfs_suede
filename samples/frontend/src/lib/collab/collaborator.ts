/**
 * One participant, doing everything the design says a client should.
 *
 * This is the design under test rather than the widget that will eventually
 * embody it: a shared document per file, the workspace underneath it, and the
 * rule from `rooms` deciding whether the one still speaks for the other. It is
 * separate from `Workspace.svelte` on purpose -- the claims here are about
 * what happens BETWEEN two clients, and a monaco instance in the middle would
 * only make a failure harder to place.
 *
 * The CRDT is the only thing that mutates text. Everything else -- a write
 * from a script, a repair after somebody wrote around the room -- becomes
 * edits applied to the same `Y.Text`, which is what makes concurrent work
 * converge rather than take turns overwriting each other.
 */
import * as Y from "yjs";
import { createClient } from "@liveblocks/client";
import { LiveblocksYjsProvider } from "@liveblocks/yjs";

import {
  connect,
  deltaBetween,
  editsFor,
  http,
  inMemory,
  rooms,
  type Workspace,
} from "$wsfs";

import { emailOf, type Part } from "./collaboration";

type LiveblocksClient = ReturnType<typeof createClient>;
type Entered = ReturnType<LiveblocksClient["enterRoom"]>;

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
 * Make the document say `next`, changing as little as possible.
 *
 * Never a replacement. The positions a CRDT hands out are what let two people
 * type in one paragraph at once, and clearing the text throws every one of
 * them away -- so a "replace" between two clients is how one of them silently
 * undoes the other.
 */
export const become = (text: Y.Text, next: string) => {
  const edits = editsFor(deltaBetween(text.toString(), next));
  if (edits.length === 0) return;
  (text.doc as Y.Doc).transact(() => {
    for (const edit of edits) {
      if ("insert" in edit) text.insert(edit.at, edit.insert);
      else text.delete(edit.at, edit.remove);
    }
  });
};

const STANDING = "standing";
const PRODUCED = "produced";
const CONTENT = "content";

/** One file's room, and what it knows about the file underneath it. */
class Held {
  readonly doc = new Y.Doc();
  entered: Entered | undefined;
  provider: LiveblocksYjsProvider | undefined;

  constructor(readonly entry: string) {}

  get text() {
    return this.doc.getText(CONTENT);
  }

  /**
   * Where `rooms.Standing` lives.
   *
   * In the SHARED document, not in any one client: a second person opening the
   * file must not repair something the first has already repaired, and the
   * only way both can know that is for the fact to travel with the text.
   *
   * `produced` IS A MAP, KEYED BY TRANSACTION, and that is not a detail. It
   * was an array in one `Y.Map` slot to begin with, which made it
   * last-writer-wins: two clients storing at the same moment each wrote their
   * own one-element list, one of them survived, and the client whose entry was
   * lost then saw the other's write come back as a stranger's. Separate keys
   * merge; one key holding a list does not.
   */
  get standing(): rooms.Standing {
    return {
      base: (this.doc.getMap(STANDING).get("base") as string | undefined) ?? null,
      produced: [...this.doc.getMap(PRODUCED).keys()],
    };
  }

  set standing(next: rooms.Standing) {
    this.doc.transact(() => {
      this.doc.getMap(STANDING).set("base", next.base);
      const claimed = this.doc.getMap(PRODUCED);
      const wanted = new Set(next.produced);
      for (const held of [...claimed.keys()])
        if (!wanted.has(held)) claimed.delete(held);
      for (const transaction of wanted)
        if (!claimed.has(transaction)) claimed.set(transaction, true);
    });
  }
}

export class Collaborator {
  readonly part: Part;
  readonly email: string;
  readonly workspaceId: string;
  readonly workspace: Workspace;
  readonly liveblocks: LiveblocksClient;
  readonly held = new Map<string, Held>();

  /** Verdicts this client was handed, newest last -- what tests assert on. */
  readonly verdicts: rooms.Verdict[] = [];

  #watching: () => void;

  constructor(part: Part, workspaceId: string) {
    this.part = part;
    this.workspaceId = workspaceId;
    this.email = emailOf(part);
    this.workspace = connect({
      workspace: workspaceId,
      transport: http(BACKEND, asUser(this.email)),
      bytes: inMemory(),
    });
    this.liveblocks = clientAs(this.email);

    /**
     * The stream is how a room hears that somebody wrote around it. Every
     * content token that moves is either this room's own work coming home or
     * a stranger's, and `rooms.carried` is what tells them apart.
     */
    this.#watching = this.workspace.watch((changes) => {
      for (const change of changes) {
        if (change.kind !== "written") continue;
        const room = this.held.get(change.entry);
        if (room === undefined) continue;
        const answer = rooms.carried(room.standing, change.by);
        room.standing = answer.standing;
        void this.#act(room, answer.verdict);
      }
    });
  }

  path(entry: string): string | undefined {
    const index = this.workspace.index();
    for (const path of index.paths())
      if (index.at(path)?.id === entry) return path;
    return undefined;
  }

  token(entry: string): string | null {
    return this.workspace.entries().get(entry)?.content_version ?? null;
  }

  /** What the server holds at one version -- the base a repair diffs from. */
  async contentAt(entry: string, version: string): Promise<string> {
    const answer = await fetch(
      `${BACKEND}/workspaces/${this.workspaceId}/entries/${entry}/content?content=${version}`,
      { headers: { "X-User-Email": this.email } },
    );
    if (!answer.ok) throw new Error(`content ${version}: ${answer.status}`);
    return ((await answer.json()) as { content: string }).content;
  }

  /**
   * Open a file's room and make it trustworthy before anything is typed.
   *
   * SYNC FIRST, ALWAYS. A document that has not received its own content is
   * indistinguishable from an empty one, and seeding an empty-looking document
   * that was about to be filled is how a file ends up saying everything twice.
   */
  async open(entry: string): Promise<rooms.Verdict> {
    const room = this.held.get(entry) ?? new Held(entry);
    this.held.set(entry, room);
    await this.attach(room);

    const answer = rooms.opening(room.standing, this.token(entry));
    room.standing = answer.standing;
    return this.#act(room, answer.verdict);
  }

  /**
   * Confirm the verdict against the file before acting on it.
   *
   * `rooms` decides from bookkeeping -- which writes this room remembers
   * making -- and that bookkeeping travels to the other members through the
   * ROOM while the write itself travels through the SERVER. Two channels, no
   * ordering between them: a member can be told a write landed before being
   * told the room is the one that made it, and will call its own text a
   * stranger's.
   *
   * So the bookkeeping is treated as a hypothesis and the content as the
   * authority. If the room already says what the server says, there was
   * nothing to carry in, whatever the paperwork thinks. That costs one fetch
   * on a token the room did not recognise, which is rare, and it holds no
   * matter which channel is running late.
   */
  async #act(room: Held, verdict: rooms.Verdict): Promise<rooms.Verdict> {
    const settled = await this.#confirmed(room, verdict);
    this.verdicts.push(settled);
    await this.#mend(room, settled);
    return settled;
  }

  async #confirmed(room: Held, verdict: rooms.Verdict): Promise<rooms.Verdict> {
    if (verdict.kind === "current") return verdict;
    const landed = verdict.kind === "seed" ? verdict.at : verdict.to;
    const held = await this.contentAt(room.entry, landed);
    return room.text.toString() === held ? { kind: "current" } : verdict;
  }

  async #mend(room: Held, verdict: rooms.Verdict) {
    if (verdict.kind === "current") return;

    if (verdict.kind === "seed") {
      await this.#seed(room, verdict.at);
      return;
    }

    /**
     * The direction that matters. Both sides of this diff are SERVER versions,
     * so what it describes is only what the other writer did. Diffing from the
     * document instead would describe this user's own unsent work as text to
     * delete -- and applying that would delete it.
     */
    const [before, after] = await Promise.all([
      this.contentAt(room.entry, verdict.from),
      this.contentAt(room.entry, verdict.to),
    ]);

    /**
     * Nothing to carry in if the document already says it.
     *
     * The guard exists because the verdict can be wrong in one direction: a
     * write made in this room reaches the server, and the server's event can
     * beat the room's own note of what it did back to the other members. They
     * would call it a stranger's and repair against text they are already
     * holding -- which does not conflict, it DUPLICATES. Being sure there is a
     * difference before describing one is cheap, and the alternative is a file
     * that quietly says everything twice.
     */
    if (room.text.toString() === after) return;
    /**
     * Applied as EDITS, at the places they occupied in `before` -- not as a
     * target string. The document may hold work of this user's own that no
     * server version has ever seen, and handing the CRDT positioned edits is
     * what lets it keep that while taking the other writer's change in.
     */
    const patch = editsFor(deltaBetween(before, after));
    if (patch.length === 0) return;
    room.doc.transact(() => {
      for (const edit of patch) {
        if ("insert" in edit) room.text.insert(edit.at, edit.insert);
        else room.text.delete(edit.at, edit.remove);
      }
    });
  }

  /**
   * Fill a room that has never held this file -- exactly once, however many
   * clients open it at the same moment.
   *
   * "The document is empty" is true for BOTH of two clients opening together,
   * so seeding on that alone puts the file in twice. It cannot be settled
   * locally either: a CRDT merges two inserts, it does not notice they say the
   * same thing.
   *
   * So it is claimed first and acted on second. The claim is one last-writer-
   * wins slot, which is the one thing a `Y.Map` key is good at -- after the
   * room converges every client agrees who holds it, and only that one writes.
   * The wait is what makes "after the room converges" true, and it is a guess
   * at a duration rather than a fact: whoever wires this into a real client
   * should hang it off an acknowledgement instead.
   */
  async #seed(room: Held, at: string) {
    if (room.text.length > 0) return;
    const held = room.doc.getMap(STANDING);
    if (!held.has("seeding")) held.set("seeding", room.doc.clientID);

    await new Promise((carry) => setTimeout(carry, 600));

    if (room.text.length > 0) return;
    if (held.get("seeding") !== room.doc.clientID) return;
    become(room.text, await this.contentAt(room.entry, at));
  }

  text(entry: string): string {
    return this.held.get(entry)?.text.toString() ?? "";
  }

  /** Type, as the one writer a document is allowed to have. */
  type(entry: string, next: string) {
    const room = this.held.get(entry);
    if (room === undefined) throw new Error(`${entry} is not open here`);
    become(room.text, next);
  }

  /**
   * Store what the document says as a version.
   *
   * Claimed before it is sent, because the answer may never come -- and a
   * write whose fate is unknown must not be mistaken for a stranger's when the
   * stream eventually mentions it.
   */
  async store(entry: string): Promise<{ transaction: string; rejected: boolean }> {
    const room = this.held.get(entry);
    if (room === undefined) throw new Error(`${entry} is not open here`);
    const path = this.path(entry);
    if (path === undefined) throw new Error(`${entry} has no path here`);

    const { transaction, settled } = this.workspace.write(path, room.text.toString());
    room.standing = rooms.emitting(room.standing, transaction);
    const answer = await settled;
    if (answer.rejected) room.standing = rooms.refused(room.standing, transaction);
    return { transaction, rejected: answer.rejected };
  }

  /** A write that does NOT go through the room -- a script, another tool. */
  async writeAround(entry: string, text: string) {
    const path = this.path(entry);
    if (path === undefined) throw new Error(`${entry} has no path here`);
    return this.workspace.write(path, text).settled;
  }

  async attach(room: Held) {
    if (room.provider !== undefined) return;
    room.entered = this.liveblocks.enterRoom(room.entry);
    room.provider = new LiveblocksYjsProvider(room.entered.room, room.doc);
    await new Promise<void>((synced, gaveUp) => {
      const timer = setTimeout(() => gaveUp(new Error("never synced")), 30_000);
      const ready = () => {
        clearTimeout(timer);
        synced();
      };
      if (room.provider!.synced) return ready();
      room.provider!.once("synced", ready);
    });
  }

  /**
   * The network goes away, and the document does not.
   *
   * Only the provider is torn down. The `Y.Doc` is this client's own, so it
   * keeps taking edits, and when a provider is attached again every one of
   * them syncs -- which is exactly what an unnoticed lapse looks like.
   */
  goOffline(entry: string) {
    const room = this.held.get(entry);
    if (room === undefined) return;
    room.provider?.destroy();
    room.entered?.leave();
    room.provider = undefined;
    room.entered = undefined;
  }

  async comeBack(entry: string) {
    const room = this.held.get(entry);
    if (room === undefined) return;
    await this.attach(room);
  }

  dispose() {
    this.#watching();
    for (const room of this.held.values()) {
      room.provider?.destroy();
      room.entered?.leave();
    }
    this.workspace.stop();
  }
}

