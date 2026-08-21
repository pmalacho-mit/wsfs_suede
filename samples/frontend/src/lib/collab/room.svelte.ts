/**
 * The room protocol, once, for the widget and for the suite that proves it.
 *
 * `rooms.ts` in the release decides what a room OWES -- it is a pure rule over
 * two tokens and it holds no CRDT, on purpose. This is the other half: the
 * shared document those tokens describe, the provider underneath it, and the
 * acting-on-the-verdict that `rooms.ts` deliberately leaves to a caller.
 *
 * It lives here rather than in the release because it has opinions the release
 * refuses to have -- Yjs, a provider, a seeding election. It is one class
 * rather than two because the alternative was what this replaces: a protocol
 * proven in a test harness and a second, subtly different one in the component
 * a user actually touches. `Collaborator` and `SharedTextFile` are both thin
 * over this, so the two-browser suite proves the code that ships.
 *
 * TWO CHANNELS REACH A ROOM and either can be lost on its own. The provider
 * carries the document; the workspace stream carries what the server accepted.
 * Almost every rule below is about what to do when they disagree, or when one
 * of them is not there at all.
 */
import * as Y from "yjs";

import {
  contract,
  deltaBetween,
  editsFor,
  rooms,
  type Workspace,
} from "$wsfs";

/** What a room needs a provider to be able to do. */
export type Provider = {
  readonly synced: boolean;
  once: (event: "synced", handler: () => void) => void;
  destroy: () => void;
};

/**
 * Joining the shared document for one entry.
 *
 * The DOCUMENT IS THE ROOM'S, and is handed in rather than taken from the
 * provider. A room outlives its providers -- that is what makes a network
 * lapse survivable -- so a document owned by the provider would be thrown away
 * with it, taking everything typed during the lapse.
 */
export type Enter = (
  entry: string,
  doc: Y.Doc,
) => { provider: Provider; leave: () => void };

/** What a write that was not text did to a room showing text. */
export type Replacement = {
  entry: string;
  at: contract.Version;
  mime: string;
};

/** Why a room out of touch is not allowed to write the file back. */
export type Held = { held: true; why: string };

/**
 * A write on its way, named before it is answered.
 *
 * The transaction is known SYNCHRONOUSLY, because a caller describing what the
 * user is looking at needs it at the moment it asks -- waiting on the answer
 * would describe a later moment than the one it was asked about.
 */
export type Sending =
  | Held
  | {
      held: false;
      transaction: contract.Transaction;
      settled: Promise<contract.Response>;
    };

/** The same write, once the server has ruled on it. */
export type Stored =
  | Held
  | { held: false; transaction: contract.Transaction; rejected: boolean };

const STANDING = "standing";
const PRODUCED = "produced";
const CONTENT = "content";
const SEEDING = "seeding";

/**
 * How long a room waits to believe its document has reached the others.
 *
 * A GUESS AT A DURATION, not a fact, and the one piece of this that should be
 * replaced first: it wants to hang off an acknowledgement from the provider
 * rather than a timer. Short enough not to be felt, long enough for a claim to
 * come back from a provider that has already synced once.
 *
 * TWO CALLERS, and they want the same thing from opposite ends. Seeding waits
 * to find out whether somebody else claimed first; reattaching waits to find
 * out whether what it holds has been handed over. Both are asking "has this
 * document been round the room yet", which is the acknowledgement neither can
 * currently ask for.
 */
const CONVERGING = 600;

/**
 * Make a shared text say `next`, changing as little as possible.
 *
 * Never a replacement. The positions a CRDT hands out are what let two people
 * type in one paragraph at once, and clearing the text throws every one of
 * them away -- so a "replace" between two clients is how one of them silently
 * undoes the other.
 */
export const become = (text: Y.Text, next: string) => {
  apply(text, editsFor(deltaBetween(text.toString(), next)));
};

const apply = (text: Y.Text, edits: ReturnType<typeof editsFor>) => {
  if (edits.length === 0) return;
  (text.doc as Y.Doc).transact(() => {
    for (const edit of edits) {
      if ("insert" in edit) text.insert(edit.at, edit.insert);
      else text.delete(edit.at, edit.remove);
    }
  });
};

/** One file's room, and what it knows about the file underneath it. */
export class Room {
  readonly doc = new Y.Doc();

  /** Verdicts this room settled on, newest last -- diagnostics, and tests. */
  readonly verdicts: rooms.Verdict[] = [];

  /**
   * Whether an editor may bind to this room's text.
   *
   * FALSE UNTIL THE DOCUMENT HAS BEEN RECEIVED AND RECONCILED, and that is the
   * whole reason it exists. `MonacoBinding` makes the editor say whatever the
   * `Y.Text` says the moment it is constructed -- so binding an empty document
   * does not show an empty file, it MAKES one, and the next store writes that
   * over the real thing.
   */
  ready = $state(false);

  /**
   * Set once the file stopped being text this room could show.
   *
   * Terminal, and not a repair: a room holding a `Y.Text` has nothing to merge
   * bytes into. What the user is looking at is now a picture of a file that no
   * longer exists, and this is what says so.
   */
  replaced = $state<Replacement | undefined>(undefined);

  /** Reaching the others right now. Reactive, because a banner depends on it. */
  attached = $state(false);

  /**
   * Just back, and not yet sure anybody has heard what it holds.
   *
   * THE HALF OF FINDING 4 THAT WAS MISSING. Not writing while detached is
   * necessary and it is not sufficient: `synced` is the provider saying this
   * client has RECEIVED the room, which says nothing about whether the room
   * has received this client. Store in that window and the write reaches the
   * others through the SERVER while the text behind it is still in flight
   * through the DOCUMENT -- so they see a token they have no bookkeeping for,
   * carrying text they do not yet hold, and repair towards it. Then the merge
   * lands and says the same thing a second time.
   *
   * Observed, not reasoned: `holds a store while the room is not reaching
   * anybody` failed four times out of four on the member who stayed, once as
   * "kept\nada while away\nada while away\n".
   */
  #settling = $state(false);

  /**
   * Heard something while detached, and has not reconciled since.
   *
   * Nothing more is remembered, deliberately: whatever happened while the room
   * was away is ONE gap between its base and the token the file is at now, and
   * `rooms.opening` is the question that reads a gap of any size.
   */
  #missed = false;

  /**
   * What this room still owes the file.
   *
   * `current` almost always; anything else only between hearing that the room
   * fell behind and having carried the difference in. That window is small and
   * it is real, and one keystroke inside it is enough to write somebody else's
   * work away -- which is why `speaks` asks.
   */
  #owes: rooms.Verdict = { kind: "current" };

  #provider: Provider | undefined;
  #leave: (() => void) | undefined;
  /**
   * The attach in flight, so that a second caller waits for the first.
   *
   * Returning early on "a provider exists" is not the same question: a
   * provider that has been constructed but has not yet received the document
   * is exactly the state everything here is careful not to act in, and a
   * second `open` that returned then would reconcile against an empty
   * document and seed a file that was about to arrive.
   */
  #attaching: Promise<void> | undefined;

  constructor(
    readonly entry: string,
    readonly held: Rooms,
  ) {}

  get text(): Y.Text {
    return this.doc.getText(CONTENT);
  }

  /**
   * Whether this room may answer for the file, and write it back.
   *
   * Both halves of `rooms.speaking`, plus the one thing that ends a room
   * outright. A room whose file turned binary is not behind -- there is
   * nothing it could catch up to.
   */
  get speaks(): boolean {
    if (this.replaced !== undefined) return false;
    if (this.#settling) return false;
    return rooms.speaking({
      attached: this.attached,
      behind: this.#missed || !rooms.settled(this.#owes),
    });
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
      base:
        (this.doc.getMap(STANDING).get("base") as string | undefined) ?? null,
      produced: [...this.doc.getMap(PRODUCED).keys()],
    };
  }

  set standing(next: rooms.Standing) {
    this.doc.transact(() => {
      this.doc.getMap(STANDING).set("base", next.base);
      const claimed = this.doc.getMap(PRODUCED);
      const wanted = new Set(next.produced);
      for (const one of [...claimed.keys()])
        if (!wanted.has(one)) claimed.delete(one);
      for (const transaction of wanted)
        if (!claimed.has(transaction)) claimed.set(transaction, true);
    });
  }

  /**
   * The stream says this entry's content moved.
   *
   * A DETACHED ROOM DOES NOT ACT, and does not write down that it heard.
   * Repairing means inserting somebody else's text into this document, and
   * this document is about to be merged with theirs -- so the insert would
   * arrive twice and the file would say everything twice. Advancing `base`
   * would be worse: it is one last-writer-wins slot in a document that has not
   * merged for a while, and this client's guess at it would win over what the
   * room agreed while it was away.
   */
  heard(transaction: contract.Transaction) {
    if (!this.attached) {
      this.#missed = true;
      return;
    }
    const answer = rooms.carried(this.standing, transaction);
    this.standing = answer.standing;
    void this.#act(answer.verdict);
  }

  /**
   * Ask the one question that covers any length of absence.
   *
   * A room nobody had open hears no stream events at all, and a room that was
   * detached deliberately ignored the ones it heard. Both come to the same
   * place: whatever happened is the gap between this room's base and the token
   * the file is at now.
   */
  async reconcile(): Promise<rooms.Verdict> {
    const answer = rooms.opening(this.standing, this.held.token(this.entry));
    this.standing = answer.standing;
    this.#missed = false;
    const settled = await this.#act(answer.verdict);
    this.ready = true;
    return settled;
  }

  /**
   * Confirm a verdict against the file before acting on it.
   *
   * `rooms` decides from bookkeeping -- which writes this room remembers
   * making -- and that bookkeeping travels to the other members through the
   * DOCUMENT while the write itself travels through the SERVER. Two channels,
   * no ordering between them: a member can be told a write landed before being
   * told its own room made it, and will call its own text a stranger's.
   *
   * So the bookkeeping is a hypothesis and the content is the authority. If
   * the room already says what the server says, there was nothing to carry in,
   * whatever the paperwork thinks. That costs one read on a token the room did
   * not recognise, which is rare, and it holds no matter which channel is late.
   *
   * READING THE FILE IS ALSO HOW A ROOM FINDS OUT IT IS OVER. Nothing in a
   * token says whether it names text or bytes, so this read is the first
   * moment anybody here can know.
   */
  async #act(verdict: rooms.Verdict): Promise<rooms.Verdict> {
    if (verdict.kind === "current") {
      this.verdicts.push(verdict);
      return verdict;
    }

    const landed = verdict.kind === "seed" ? verdict.at : verdict.to;
    const held = await this.held.workspace.at(this.entry, landed);

    if (held.kind === "binary") {
      this.replaced = { entry: this.entry, at: landed, mime: held.mime };
      /**
       * `current` because there is nothing left to carry in, NOT because the
       * room is well -- `speaks` is what says it is not. The base has already
       * moved to the token that ended it, so a later write making the file
       * text again is one ordinary gap rather than a repair reaching back
       * past the bytes.
       */
      this.verdicts.push({ kind: "current" });
      return { kind: "current" };
    }

    const settled: rooms.Verdict =
      this.text.toString() === held.text ? { kind: "current" } : verdict;
    this.verdicts.push(settled);
    this.#owes = settled;
    await this.#mend(settled, held.text);
    this.#owes = { kind: "current" };
    return settled;
  }

  async #mend(verdict: rooms.Verdict, after: string) {
    if (verdict.kind === "current") return;
    if (verdict.kind === "seed") return this.#seed(after);

    /**
     * The direction that matters. Both sides of this diff are SERVER versions,
     * so what it describes is only what the other writer did. Diffing from the
     * document instead would describe this user's own unsent work as text to
     * delete -- and applying that would delete it.
     *
     * `after` is already in hand from confirming the verdict; only the older
     * side has to be read.
     */
    const before = await this.held.workspace.at(this.entry, verdict.from);
    /**
     * A repair reaching back past bytes has no text to start from. It cannot
     * happen to a live room -- the write that made the file binary ends the
     * room on its way past -- but a room reconciling after an absence can be
     * handed a `from` it never saw. Nothing to diff, so nothing is done: the
     * room stays behind, which is at least honest.
     */
    if (before.kind === "binary") return;

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
    if (this.text.toString() === after) return;

    /**
     * Applied as EDITS, at the places they occupied in the older text -- not
     * as a target string. The document may hold work of this user's own that
     * no server version has ever seen, and handing the CRDT positioned edits
     * is what lets it keep that while taking the other writer's change in.
     */
    apply(this.text, editsFor(deltaBetween(before.text, after)));
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
   * wins slot, which is the one thing a `Y.Map` key is good at -- once the
   * room converges every client agrees who holds it, and only that one writes.
   */
  async #seed(content: string) {
    if (this.text.length > 0) return;
    const claim = this.doc.getMap(STANDING);
    if (!claim.has(SEEDING)) claim.set(SEEDING, this.doc.clientID);

    await new Promise((carry) => setTimeout(carry, CONVERGING));

    if (this.text.length > 0) return;
    if (claim.get(SEEDING) !== this.doc.clientID) return;
    become(this.text, content);
  }

  /**
   * Store what the document says as a version.
   *
   * The write is claimed BEFORE it is sent, because the answer may never come
   * -- and a write whose fate is unknown must not be mistaken for a
   * stranger's when the stream eventually mentions it.
   *
   * HELD WHILE THE ROOM IS OUT OF TOUCH. See `rooms.speaking`: what this
   * document says is then one member's guess at the file, the others cannot
   * see the guess yet, and sending it makes them repair towards text they are
   * about to be handed anyway. Nothing is lost by holding -- the work stays in
   * the document and goes when the room comes back.
   */
  send(path: string): Sending {
    if (this.replaced !== undefined)
      return { held: true, why: "the file stopped being this room's text" };
    if (!this.speaks)
      return {
        held: true,
        why: this.#settling
          ? "the room has not finished handing over what it holds"
          : this.attached
            ? "the room owes a repair"
            : "the room is not reaching anybody",
      };

    const { transaction, settled } = this.held.workspace.write(
      path,
      this.text.toString(),
    );
    this.standing = rooms.emitting(this.standing, transaction);
    /**
     * Taken back here rather than by whoever awaits, so that a caller which
     * never awaits at all still leaves the bookkeeping straight. A refusal
     * never became content, so nothing about the room's base changed -- and
     * leaving it in `produced` would make the room ignore a stranger's write
     * that happened to be next.
     */
    void settled.then((answer) => {
      if (answer.rejected)
        this.standing = rooms.refused(this.standing, transaction);
    });
    return { held: false, transaction, settled };
  }

  async store(path: string): Promise<Stored> {
    const sent = this.send(path);
    if (sent.held) return sent;
    const answer = await sent.settled;
    return { held: false, transaction: sent.transaction, rejected: answer.rejected };
  }

  /**
   * Bytes landing over this file from somewhere local -- a kernel, a tool.
   *
   * The remote case arrives through `heard` and is found out by reading the
   * file. This is the same conclusion reached one step earlier, by a caller
   * that already has the bytes in its hand and knows they are not text.
   */
  tookAway(at: contract.Version, mime: string) {
    this.replaced = { entry: this.entry, at, mime };
  }

  attach(): Promise<void> {
    return (this.#attaching ??= this.#attached());
  }

  async #attached(): Promise<void> {
    const { provider, leave } = this.held.enter(this.entry, this.doc);
    this.#provider = provider;
    this.#leave = leave;
    try {
      await new Promise<void>((synced, gaveUp) => {
        const timer = setTimeout(
          () => gaveUp(new Error("never synced")),
          30_000,
        );
        const ready = () => {
          clearTimeout(timer);
          synced();
        };
        if (provider.synced) return ready();
        provider.once("synced", ready);
      });
    } catch (reason) {
      // Cleared so a later attempt is allowed to try again rather than
      // resolving instantly against the promise that failed.
      this.#attaching = undefined;
      throw reason;
    }
    this.attached = true;
  }

  /**
   * The network goes away, and the document does not.
   *
   * Only the provider is torn down. The `Y.Doc` is this client's own, so it
   * goes on taking edits, and when a provider is attached again every one of
   * them syncs -- which is exactly what an unnoticed lapse looks like.
   */
  detach() {
    this.#provider?.destroy();
    this.#leave?.();
    this.#provider = undefined;
    this.#leave = undefined;
    this.#attaching = undefined;
    this.attached = false;
  }

  /**
   * The network comes back, and the room asks what it missed.
   *
   * Reconciling rather than trusting the merge is the point: while this room
   * was away the file may have moved on through the SERVER, and nothing about
   * reattaching a provider carries that.
   */
  async reattach(): Promise<void> {
    await this.attach();
    /**
     * Held back until what this room slept on has had a chance to go out.
     *
     * The order matters and it is the whole fix: reconciling first would let
     * `speaks` turn true the moment the verdict settled, which is before the
     * document this room is about to write has been anywhere. A member that
     * stayed would then meet the write as a stranger's.
     *
     * A TIMER STANDING IN FOR AN ACKNOWLEDGEMENT, exactly as `CONVERGING`
     * says. Correctness rests on a duration here, which is not where it
     * should rest -- but the alternative on offer is a rule that is wrong.
     */
    this.#settling = true;
    try {
      await new Promise((carry) => setTimeout(carry, CONVERGING));
      await this.reconcile();
    } finally {
      this.#settling = false;
    }
  }

  dispose() {
    this.detach();
    this.doc.destroy();
  }
}

/**
 * Every room one workspace is holding, and the stream that feeds them.
 *
 * ONE subscription for all of them rather than one each: the stream is a fact
 * about the workspace, and a room that subscribed for itself would have to be
 * open before it could hear anything -- which is exactly the case `opening`
 * exists to cover.
 */
export class Rooms {
  readonly held = new Map<string, Room>();

  #watching: () => void;

  constructor(
    readonly workspace: Workspace,
    readonly enter: Enter,
  ) {
    this.#watching = workspace.watch((changes) => {
      for (const change of changes) {
        if (change.kind !== "written") continue;
        this.held.get(change.entry)?.heard(change.by);
      }
    });
  }

  /** The version the workspace believes this entry's content is at. */
  token(entry: string): contract.Version | null {
    return this.workspace.entries().get(entry)?.content_version ?? null;
  }

  get(entry: string): Room | undefined {
    return this.held.get(entry);
  }

  /**
   * Open a file's room and make it trustworthy before anything is shown.
   *
   * SYNC FIRST, ALWAYS. A document that has not received its own content is
   * indistinguishable from an empty one, and seeding an empty-looking document
   * that was about to be filled is how a file ends up saying everything twice.
   */
  async open(entry: string): Promise<Room> {
    const room = this.held.get(entry) ?? new Room(entry, this);
    this.held.set(entry, room);
    await room.attach();
    await room.reconcile();
    return room;
  }

  close(entry: string) {
    this.held.get(entry)?.dispose();
    this.held.delete(entry);
  }

  dispose() {
    this.#watching();
    for (const room of this.held.values()) room.dispose();
    this.held.clear();
  }
}
