import { describe, expect, it } from "vitest";

import * as confirmed from "../../release/frontend/confirmed";
import type { Metadata, Occurrence, StreamEvent } from "../../release/frontend/contract";
import * as effective from "../../release/frontend/effective";
import { mint } from "../../release/frontend/identity";
import { mintedAt } from "../../release/frontend/minted";
import { queue } from "../../release/frontend/outbox";

/** A server-accepted moment. These fixtures are about what changes, not when. */
const SETTLED = new Date("2026-01-01T00:00:00Z").toISOString();

/** Every event announces a transaction, and every transaction happened. */
const announced = (transaction: string): Occurrence => ({
  minted: mintedAt(transaction)!.toISOString(),
  accepted: SETTLED,
});

const entry = (over: Partial<Metadata> = {}): Metadata => {
  const born = mint();
  return {
    id: mint(),
    type: "file",
    name: "a.py",
    parent: null,
    name_version: born,
    parent_version: born,
    deleted_version: born,
    content_version: born,
    modified: { minted: mintedAt(born)!.toISOString(), accepted: SETTLED },
    ...over,
  };
};

describe("the confirmed map", () => {
  it("is replaced whole by a snapshot, tombstones included", () => {
    const gone = entry({ deleted: true });
    const map = confirmed.snapshot([entry(), gone]);
    expect(map.size).toBe(2);
    expect(map.get(gone.id)!.deleted).toBe(true);
  });

  it("advances the token of whichever property an event announced", () => {
    const file = entry();
    const naming = mint();
    const renaming: StreamEvent = {
      type: "name",
      id: file.id,
      transaction: naming,
      value: "b.py",
      at: announced(naming),
    };

    const after = confirmed.applied(confirmed.snapshot([file]), renaming);

    expect(after.get(file.id)).toMatchObject({
      name: "b.py",
      name_version: renaming.transaction,
      parent_version: file.parent_version,
    });
  });

  it("applies a move to both halves at once", () => {
    const file = entry();
    const folder = mint();
    const moved = mint();
    const moving: StreamEvent = {
      type: "move",
      id: file.id,
      transaction: moved,
      value: { name: "b.py", parent: folder },
      at: announced(moved),
    };

    const after = confirmed.applied(confirmed.snapshot([file]), moving);

    expect(after.get(file.id)).toMatchObject({
      name: "b.py",
      parent: folder,
      name_version: moving.transaction,
      parent_version: moving.transaction,
    });
  });

  it("leaves a caller's previous map alone", () => {
    const file = entry();
    const before = confirmed.snapshot([file]);
    const naming = mint();
    confirmed.applied(before, {
      type: "name",
      id: file.id,
      transaction: naming,
      value: "b.py",
      at: announced(naming),
    });
    expect(before.get(file.id)!.name).toBe("a.py");
  });
});

describe("the effective view", () => {
  it("shows queued work before the server has answered", () => {
    const file = entry();
    const items = queue();
    items.capture({
      op: "rename",
      transaction: mint(),
      id: file.id,
      name: "renamed.py",
      name_version: file.name_version,
    });

    const { view } = effective.of(confirmed.snapshot([file]), items.entries());

    expect(view.get(file.id)!.name).toBe("renamed.py");
  });

  it("shows an entry that exists nowhere but the queue", () => {
    const id = mint();
    const items = queue();
    items.capture({
      op: "create",
      transaction: mint(),
      id,
      type: "file",
      name: "new.py",
      parent: null,
      content: { type: "text", content: "" },
    });

    const { view } = effective.of(confirmed.empty(), items.entries());

    expect(view.get(id)).toMatchObject({ name: "new.py", type: "file" });
  });

  it("snaps back when the queue drops the work, with nothing to undo", () => {
    const file = entry();
    const items = queue();
    const request = {
      op: "rename" as const,
      transaction: mint(),
      id: file.id,
      name: "renamed.py",
      name_version: file.name_version,
    };
    items.capture(request);
    const map = confirmed.snapshot([file]);

    expect(effective.of(map, items.entries()).view.get(file.id)!.name).toBe("renamed.py");
    items.evict([request.transaction]);
    expect(effective.of(map, items.entries()).view.get(file.id)!.name).toBe("a.py");
  });
});
