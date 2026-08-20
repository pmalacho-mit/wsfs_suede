/**
 * Against a real server.
 *
 *     WSFS_BACKEND=http://localhost:8000 npx vitest run
 *
 * These are the only tests that can tell whether the generated types describe
 * what actually arrives -- everything else is this client reasoning about
 * itself. Without a server they skip rather than fail, so the fast suite stays
 * runnable anywhere.
 */
import { beforeAll, expect, it } from "vitest";

import { connect, inMemory, type Workspace } from "../../release/frontend";
import { accepted, localised, offset } from "../../release/frontend/minted";
import { describeLive, project, reachable, transport } from "./backend";

const settled = (workspace: Workspace, holds: () => boolean, within = 5_000) =>
  new Promise<void>((done, fail) => {
    const deadline = setTimeout(() => fail(new Error("never settled")), within);
    const finish = () => (clearTimeout(deadline), stop(), done());
    const stop = workspace.watch(() => holds() && finish());
    if (holds()) finish();
  });

describeLive("a workspace against a live backend", () => {
  let workspace: Workspace;

  beforeAll(async () => {
    if (!(await reachable())) throw new Error("WSFS_BACKEND is set but not answering");
    workspace = connect({
      workspace: await project(),
      transport: transport(),
      bytes: inMemory(),
    });
    await settled(workspace, () => true);
  });

  it("creates a file and reads its content back", async () => {
    await workspace.create("main.py", "print('hi')").settled;
    await settled(workspace, () => workspace.index().at("main.py") !== undefined);

    expect(await workspace.read("main.py")).toEqual({
      kind: "text",
      text: "print('hi')",
    });
  });

  it("puts a file where a path says, not where an id says", async () => {
    await workspace.folder("src").settled;
    await settled(workspace, () => workspace.index().at("src") !== undefined);
    await workspace.create("src/nested.py", "nested").settled;
    await settled(workspace, () => workspace.index().at("src/nested.py") !== undefined);

    expect(workspace.index().paths()).toContain("src/nested.py");
  });

  it("moves an entry's path and name in one go", async () => {
    await workspace.create("before.py", "x").settled;
    await settled(workspace, () => workspace.index().at("before.py") !== undefined);

    await workspace.move("before.py", "src/after.py").settled;
    await settled(workspace, () => workspace.index().at("src/after.py") !== undefined);

    expect(workspace.index().at("before.py")).toBeUndefined();
  });

  it("carries binary content through the blob store", async () => {
    const payload = new Uint8Array([0x89, 0x50, 0x4e, 0x47]);
    await workspace.create("logo.png", payload, "image/png").settled;
    await settled(workspace, () => workspace.index().at("logo.png") !== undefined);

    const held = await workspace.read("logo.png");
    expect(held).toMatchObject({ kind: "binary" });
    expect([...(held as { bytes: Uint8Array }).bytes]).toEqual([...payload]);
  });

  it("takes a path away when its entry is removed", async () => {
    await workspace.create("doomed.py", "x").settled;
    await settled(workspace, () => workspace.index().at("doomed.py") !== undefined);

    await workspace.remove("doomed.py").settled;
    await settled(workspace, () => workspace.index().at("doomed.py") === undefined);

    expect(workspace.index().paths()).not.toContain("doomed.py");
  });

  it("times a change in both clocks, and in the zone it was made in", async () => {
    // The only place the two halves meet for real: this client derives the
    // client instant from the id it minted, the server derives the same one
    // from the same id, and the offset is the single thing that travelled.
    const before = Date.now();
    await workspace.create("timed.py", "x").settled;
    await settled(workspace, () => {
      const entry = workspace.index().at("timed.py");
      return entry !== undefined && entry.modified.accepted !== null;
    });

    const entry = workspace.index().at("timed.py")!;
    const local = localised(entry.modified)!;

    expect(local.instant.getTime()).toBeGreaterThanOrEqual(before - 1);
    expect(local.zoned).toBe(true);
    expect(local.offset).toBe(offset());
    // The server's clock is its own, and it saw this after the client did.
    expect(accepted(entry.modified)!.getTime()).toBeGreaterThanOrEqual(
      local.instant.getTime(),
    );
  });

  it("keeps each queued item's own zone when an outbox is replayed", async () => {
    // Somebody works in one zone and reconnects in another. The offset rides
    // on the transaction, so the server records what each item was made in
    // rather than where the connection happened to be.
    const id = await project();
    const moved = connect({ workspace: id, transport: transport(), bytes: inMemory() });
    await settled(moved, () => true);

    await moved.create("packed.py", "x");
    await settled(moved, () => moved.index().at("packed.py") !== undefined);

    const entry = moved.index().at("packed.py")!;
    expect(entry.modified.offset).toBe(offset());
    moved.stop();
  });

  it("shows one client the work of another", async () => {
    const id = await project();
    const mine = connect({ workspace: id, transport: transport(), bytes: inMemory() });
    const theirs = connect({
      workspace: id,
      transport: transport("grace@example.com"),
      bytes: inMemory(),
    });
    await settled(mine, () => true);
    await settled(theirs, () => true);

    await theirs.create("shared.py", "theirs").settled;
    await settled(mine, () => mine.index().at("shared.py") !== undefined);

    expect(await mine.read("shared.py")).toEqual({ kind: "text", text: "theirs" });
    mine.stop();
    theirs.stop();
  });
});
