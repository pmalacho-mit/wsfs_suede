/**
 * Whether a shared document still speaks for its file.
 *
 * Almost every test here is about the same failure: repairing a room with a
 * change it already has. A CRDT merges inserts rather than deduplicating them,
 * so getting this wrong does not produce a conflict anybody can see -- it
 * produces a file with the same paragraph in it twice, and no way to tell
 * which copy was the real one.
 */
import { describe, expect, it } from "vitest";

import { mint } from "../../release/frontend/identity";
import {
  carried,
  emitting,
  fresh,
  opening,
  refused,
  settled,
} from "../../release/frontend/rooms";

describe("a room's standing", () => {
  it("stays current when its own write comes back", () => {
    const mine = mint();
    const standing = emitting(fresh(), mine);

    const answer = carried(standing, mine);

    expect(answer.verdict).toEqual({ kind: "current" });
    expect(answer.standing.base).toBe(mine);
    /** Gone, so the next stranger's write cannot be mistaken for it. */
    expect(answer.standing.produced).toEqual([]);
  });

  it("asks to be repaired when somebody else's write comes back", () => {
    const base = mint();
    const theirs = mint();
    const standing = carried(emitting(fresh(), base), base).standing;

    const answer = carried(standing, theirs);

    expect(answer.verdict).toEqual({ kind: "repair", from: base, to: theirs });
    expect(answer.standing.base).toBe(theirs);
  });

  it("repairs from the base it had, not from the write that displaced it", () => {
    /**
     * The direction that matters. `from` is what the room's text corresponds
     * to, so the edits it names are exactly what the other writer did -- and
     * nothing about what the user has been typing since, which the CRDT is
     * holding and which a diff from the document would describe as deletions.
     */
    const first = mint();
    const second = mint();
    const stranger = mint();

    let standing = carried(emitting(fresh(), first), first).standing;
    standing = carried(emitting(standing, second), second).standing;
    const answer = carried(standing, stranger);

    expect(answer.verdict).toEqual({ kind: "repair", from: second, to: stranger });
  });

  it("seeds rather than repairs when it has no history to diff against", () => {
    const landed = mint();

    const answer = carried(fresh(), landed);

    expect(answer.verdict).toEqual({ kind: "seed", at: landed });
  });

  it("does not treat a write it never made as its own", () => {
    const mine = mint();
    const theirs = mint();
    const standing = carried(emitting(emitting(fresh(), mine), mine), mine).standing;

    expect(carried(standing, theirs).verdict).toMatchObject({ kind: "repair" });
  });

  it("forgets a write the server refused", () => {
    /**
     * A refused write never became content, so the room's base did not move --
     * and leaving it claimed would make the room ignore the write that beat
     * it, which is the one it is actually missing.
     */
    const base = mint();
    const doomed = mint();
    const winner = mint();

    let standing = carried(emitting(fresh(), base), base).standing;
    standing = refused(emitting(standing, doomed), doomed);

    const answer = carried(standing, winner);
    expect(answer.verdict).toEqual({ kind: "repair", from: base, to: winner });
  });

  it("keeps a write in flight claimed until it is answered", () => {
    /**
     * Recorded before the answer on purpose: a write whose fate is unknown
     * must not be mistaken for a stranger's, because repairing against it
     * would apply the user's own text on top of itself.
     */
    const mine = mint();
    const standing = emitting(fresh(), mine);

    expect(standing.produced).toEqual([mine]);
    expect(carried(standing, mine).verdict).toEqual({ kind: "current" });
  });

  it("does not claim one write twice", () => {
    const mine = mint();
    expect(emitting(emitting(fresh(), mine), mine).produced).toEqual([mine]);
  });
});

describe("opening a room", () => {
  it("is current when the file is still at the room's base", () => {
    const base = mint();
    const standing = carried(emitting(fresh(), base), base).standing;

    expect(opening(standing, base).verdict).toEqual({ kind: "current" });
  });

  it("catches everything that happened while the room was shut", () => {
    /**
     * A room nobody has open hears no stream events at all, so this is the
     * only place a gap that opened while it was closed can be noticed. It
     * shows up as one repair however many writes went past.
     */
    const base = mint();
    const later = mint();
    const standing = carried(emitting(fresh(), base), base).standing;

    expect(opening(standing, later).verdict).toEqual({
      kind: "repair",
      from: base,
      to: later,
    });
  });

  it("is current when the file is at a write this room made but never saw land", () => {
    const mine = mint();
    const standing = emitting(fresh(), mine);

    const answer = opening(standing, mine);

    expect(answer.verdict).toEqual({ kind: "current" });
    expect(answer.standing.base).toBe(mine);
  });

  it("says nothing about a file that has no content yet", () => {
    expect(opening(fresh(), null).verdict).toEqual({ kind: "current" });
  });

  it("seeds a room opened on a file it has never held", () => {
    const landed = mint();
    expect(opening(fresh(), landed).verdict).toEqual({ kind: "seed", at: landed });
  });
});

describe("whether the room may be written back", () => {
  it("is settled only when nothing is owed", () => {
    const base = mint();
    const standing = carried(emitting(fresh(), base), base).standing;

    expect(settled(opening(standing, base).verdict)).toBe(true);
    expect(settled(opening(standing, mint()).verdict)).toBe(false);
    expect(settled(opening(fresh(), mint()).verdict)).toBe(false);
  });
});
