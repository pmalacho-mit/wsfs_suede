/**
 * One queued write that can never be sent, and what it costs.
 *
 * Its bytes are gone -- the browser cleared the store, or the tab died between
 * the payload landing and the row that names it. That transaction is lost and
 * nothing can undo it. The question this file answers is what it costs
 * EVERYTHING ELSE, and the answer used to be: everything. Initialize threw,
 * the loop backed off and re-entered at Initialize, and threw the same way for
 * ever, so a single unreadable write stopped the workspace draining again.
 */
import { describe, expect, it } from "vitest";

import { inMemory } from "../../release/frontend/bytes";
import { remembering } from "../../release/frontend/kept";
import type { Unreadable } from "../../release/frontend/outbox";
import { connect } from "../../release/frontend/workspace";
import { server } from "./fake";

const settle = () => new Promise((done) => setTimeout(done, 60));
const quickly = { watchdogMs: 45_000, minBackoffMs: 5, maxBackoffMs: 20 };

describe("a queued write whose bytes are gone", () => {
  it("costs that transaction and nothing else", async () => {
    const wire = server();
    let store = remembering();
    const lost: Unreadable[] = [];

    const open = (over = inMemory()) => {
      const held = remembering(store.restored());
      store = held;
      return connect({
        workspace: "alpha",
        transport: wire,
        bytes: over,
        kept: held.kept,
        restored: held.restored(),
        timing: quickly,
        lost: (entries) => lost.push(...entries),
      });
    };

    const bytes = inMemory();
    const first = open(bytes);
    await settle();
    const { entry } = first.create("notes.py", "start\n");
    await settle();

    wire.reachable(false);
    const stranded = first.write("notes.py", "start\nwanted\n");
    void stranded.settled.catch(() => undefined);
    await settle();
    first.stop();

    /** The queue comes back. The bytes it points at do not. */
    wire.reachable(true);
    const again = open(inMemory());
    await settle();
    await settle();

    /** Said, not swallowed: a user who is told can retype a paragraph. */
    expect(lost.map(({ transaction }) => transaction)).toContain(
      stranded.transaction,
    );
    expect(lost[0]!.why).toMatch(/bytes/);

    /** And it is gone from the queue, so it is not tried for ever. */
    expect(store.restored().entries).toHaveLength(0);

    /** Above all, the workspace still works. */
    const after = again.write("notes.py", "start\nlater\n");
    await after.settled;
    await settle();
    expect(wire.text(entry)).toContain("later");
    again.stop();
  });
});
