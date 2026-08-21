/**
 * Whether a shared document still speaks for the file underneath it.
 *
 * A CRDT is only the truth while everything that changed the file went through
 * it. One write that did not -- a script producing output, a machine with the
 * file closed, anything server-side -- and the document is quietly describing a
 * file that has moved on. Nothing about the document itself shows this: it is
 * perfectly consistent, perfectly synced, and wrong.
 *
 * So a room carries two facts about the world outside it, and this decides what
 * they mean. There is no CRDT here on purpose: the rule is small, it is easy to
 * get subtly wrong, and it is worth being able to test without a network.
 *
 * A VERDICT IS A HYPOTHESIS, NOT A FACT -- confirm it against the file before
 * acting on it. This is the one thing two-browser testing turned up that no
 * amount of reasoning here would have: the bookkeeping below travels between
 * clients through the SHARED DOCUMENT, and the write it is about travels
 * through the SERVER, and nothing orders those two against each other. A
 * member can be told a write landed before being told its own room is what
 * made it, and will call its own text a stranger's. So a caller handed
 * anything but `current` should read the file at the token in question and do
 * nothing if the document already says it. What is here makes the common case
 * free; the comparison is what makes it correct.
 *
 * WHERE `Standing` IS KEPT MATTERS TOO. It belongs in the shared document, so
 * that a second person opening a file does not repair what the first already
 * repaired -- and it has to be held in structures that MERGE. `produced` as a
 * list in one slot is last-writer-wins: two clients storing at the same moment
 * each write their own one-element list, one survives, and the client whose
 * entry was lost then treats the other's write as a stranger's. A key per
 * transaction merges; one key holding a list does not.
 *
 * AND A ROOM NOBODY CAN HEAR MUST NOT WRITE EITHER. The second thing two
 * browsers turned up, and the one that is hardest to reason your way to. A
 * member that loses the room keeps its document -- that is what a CRDT is for
 * -- and it keeps its connection to the SERVER as well, so storing still
 * works. It must not. The text it would store is text the others have not been
 * given, so they repair towards it; then the lapse ends, the documents merge,
 * and the same text arrives a second time as edits nothing can deduplicate.
 * Neither member did anything wrong and the file says everything twice. The
 * two channels are used together or not at all: see `speaking`.
 *
 * THE TRAP THIS EXISTS TO AVOID. Repair means applying somebody else's change
 * into the document as edits. Apply a change the document ALREADY has and the
 * text appears twice -- a CRDT does not deduplicate inserts, it merges them.
 * That is why `produced` is tracked rather than inferred: a room has to be able
 * to recognise its own work coming back to it. The same trap is why the repair
 * this hands out is a diff between two SERVER versions rather than between the
 * document and the server. See `Repair`.
 */
import type { Transaction, Version } from "./contract";

/**
 * What a room knows about where its text came from.
 *
 * Held in the shared document rather than in any one client, so that every
 * member agrees -- a second person joining must not repair something the first
 * has already repaired.
 */
export type Standing = {
  /**
   * The content token this room's text corresponds to: the last write of its
   * own that the server confirmed.
   */
  base: Version | null;
  /**
   * Writes this room has emitted and not yet seen confirmed.
   *
   * Bounded by what is in flight, and pruned as the stream carries each one.
   * It exists so a write coming back over the stream can be told from
   * somebody else's -- the difference between advancing the base and repairing
   * against it, which is the difference between correct text and doubled text.
   */
  produced: readonly Transaction[];
};

export const fresh = (): Standing => ({ base: null, produced: [] });

/**
 * What to do before trusting the room again.
 *
 * `seed` is for a room with no history at all. IT MUST ONLY BE ACTED ON WHEN
 * THE DOCUMENT IS EMPTY, and empty is only knowable after every provider has
 * synced -- local storage as well as the network. Seeding a document that was
 * about to receive its own content is how the same text ends up in it twice.
 *
 * `repair` names two SERVER versions, and the edits to apply are the difference
 * between those two texts -- not between the document and the newer one. The
 * document holds work nobody else has seen yet; diffing from it would describe
 * that work as something to delete, and applying that would delete it. Diffing
 * `from -> to` describes only what the other writer did, which is what the
 * document is missing, and the CRDT places it around whatever the user has been
 * typing.
 */
export type Verdict =
  | { kind: "current" }
  | { kind: "seed"; at: Version }
  | { kind: "repair"; from: Version; to: Version };

/**
 * A write of this room's own, about to be sent.
 *
 * Recorded BEFORE the answer, because the answer may never come -- and a write
 * whose fate is unknown must not be mistaken for a stranger's when the stream
 * eventually mentions it.
 */
export const emitting = (
  standing: Standing,
  transaction: Transaction,
): Standing =>
  standing.produced.includes(transaction)
    ? standing
    : { ...standing, produced: [...standing.produced, transaction] };

/**
 * A write this room emitted that the server refused.
 *
 * Dropped rather than confirmed: it never became content, so nothing about the
 * room's base changed, and leaving it in `produced` would make the room ignore
 * a stranger's write that happened to be next.
 */
export const refused = (
  standing: Standing,
  transaction: Transaction,
): Standing => ({
  ...standing,
  produced: standing.produced.filter((held) => held !== transaction),
});

/**
 * The stream said this entry's content is now at `transaction`.
 *
 * Two cases, and telling them apart is the whole job. Ours: the base moves up
 * and the room is current, because the text that landed is the text the room
 * already holds. Somebody else's: the room is behind by exactly one write, and
 * `base -> transaction` is what it is missing.
 */
export const carried = (
  standing: Standing,
  transaction: Transaction,
): { standing: Standing; verdict: Verdict } => {
  if (standing.produced.includes(transaction)) {
    return {
      standing: {
        base: transaction,
        produced: standing.produced.filter((held) => held !== transaction),
      },
      verdict: { kind: "current" },
    };
  }
  return {
    standing: { ...standing, base: transaction },
    verdict:
      standing.base === null
        ? { kind: "seed", at: transaction }
        : { kind: "repair", from: standing.base, to: transaction },
  };
};

/**
 * Opening the room against whatever the server currently holds.
 *
 * The same question `carried` answers, asked at the one other moment it
 * matters -- and it has to be asked here too, because a room nobody had open
 * hears no stream events at all. Everything that happened while it was shut
 * shows up as one gap between its base and the token the file is at now.
 */
export const opening = (
  standing: Standing,
  current: Version | null,
): { standing: Standing; verdict: Verdict } => {
  if (current === null || current === standing.base)
    return { standing, verdict: { kind: "current" } };
  if (standing.produced.includes(current))
    return {
      standing: {
        base: current,
        produced: standing.produced.filter((held) => held !== current),
      },
      verdict: { kind: "current" },
    };
  return carried(standing, current);
};

/**
 * Whether this room may be trusted to answer for the file right now.
 *
 * A room that owes a repair is showing text that is missing somebody else's
 * work, so anything it writes back would erase it. The window between hearing
 * about the gap and closing it is small and it is real -- one keystroke is
 * enough -- which is why this is a question a caller can ask rather than
 * something it has to remember to have done.
 */
export const settled = (verdict: Verdict) => verdict.kind === "current";

/** Where a room stands with respect to everybody else holding the file. */
export type Reach = {
  /** Whether this room is reaching the others right now. */
  attached: boolean;
  /** Whether it knows of anything it has not carried in yet -- `settled`. */
  behind: boolean;
};

/**
 * Whether this room may write the file back to the server right now.
 *
 * `behind` is the half `settled` answers, and the obvious one. `attached` is
 * the half that is not obvious at all, and it is the reason this function
 * exists rather than callers just asking `settled`.
 *
 * A member that has lost the room can still reach the server perfectly well,
 * and what it holds is not wrong -- it is simply not shared yet. Storing it
 * publishes one member's private state as the file, which makes every other
 * member repair towards text they are about to be handed anyway when the lapse
 * ends. The repair inserts it; the merge inserts it again; a CRDT does not
 * notice the two say the same thing.
 *
 * So a lapse costs the right to write around the room as well as the right to
 * be told about it. The work is not lost -- it stays in the document, and it
 * goes when the room comes back.
 */
export const speaking = ({ attached, behind }: Reach) => attached && !behind;
