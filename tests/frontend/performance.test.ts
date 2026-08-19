/**
 * Measurements, not assertions.
 *
 *     WSFS_BACKEND=http://localhost:8099 npx vitest run performance
 *
 * The point is a number to compare against the same number after a change, so
 * this prints a table and asserts only that nothing hung. Thresholds would
 * make it a flaky test on a shared machine; a recorded number makes it
 * evidence.
 */
import { beforeAll, expect, it } from "vitest";

import { connect, inMemory, type Workspace } from "../../release/frontend";
import { describeLive, project, reachable, transport } from "./backend";

type Measured = { what: string; runs: number; totalMs: number };

const measurements: Measured[] = [];

const timed = async (what: string, runs: number, work: () => Promise<unknown>) => {
  const started = performance.now();
  await work();
  const totalMs = performance.now() - started;
  measurements.push({ what, runs, totalMs });
  return totalMs;
};

const settled = (workspace: Workspace, holds: () => boolean, within = 30_000) =>
  new Promise<void>((done, fail) => {
    const deadline = setTimeout(() => fail(new Error(`never settled`)), within);
    const finish = () => (clearTimeout(deadline), stop(), done());
    const stop = workspace.watch(() => holds() && finish());
    if (holds()) finish();
  });

const opened = async () =>
  connect({ workspace: await project(), transport: transport(), bytes: inMemory() });

const padded = (value: string, width: number) => value.padEnd(width);

const report = () => {
  const widest = Math.max(...measurements.map(({ what }) => what.length));
  const lines = measurements.map(
    ({ what, runs, totalMs }) =>
      `  ${padded(what, widest)}  ${totalMs.toFixed(1).padStart(9)} ms` +
      `  ${(totalMs / runs).toFixed(2).padStart(8)} ms/run`,
  );
  process.stdout.write(`\nwsfs cost\n${lines.join("\n")}\n\n`);
};

describeLive("cost", () => {
  beforeAll(async () => {
    if (!(await reachable())) throw new Error("WSFS_BACKEND is set but not answering");
  });

  it("measures a cold connect against an empty workspace", async () => {
    const workspace = await opened();
    const elapsed = await timed("connect, empty workspace", 1, () =>
      settled(workspace, () => true),
    );
    workspace.stop();
    expect(elapsed).toBeGreaterThan(0);
  });

  it("measures creates, and the connect that has to snapshot them", async () => {
    const id = await project();
    const workspace = connect({
      workspace: id,
      transport: transport(),
      bytes: inMemory(),
    });
    await settled(workspace, () => true);

    const count = 50;
    await timed(`create x${count}`, count, async () => {
      for (let n = 0; n < count; n += 1) {
        await workspace.create(`file-${n}.py`, `# file ${n}\n`);
      }
      await settled(workspace, () => workspace.index().paths().length >= count);
    });
    workspace.stop();

    const rejoining = connect({
      workspace: id,
      transport: transport(),
      bytes: inMemory(),
    });
    const elapsed = await timed(`connect, ${count} entries`, 1, () =>
      settled(rejoining, () => rejoining.index().paths().length >= count),
    );
    rejoining.stop();
    expect(elapsed).toBeGreaterThan(0);
  });

  it("measures the path index over a wide tree", async () => {
    const workspace = await opened();
    await settled(workspace, () => true);

    const count = 100;
    for (let n = 0; n < count; n += 1) {
      await workspace.create(`wide-${n}.py`, "x");
    }
    await settled(workspace, () => workspace.index().paths().length >= count);

    await timed(`index over ${count} entries x200`, 200, async () => {
      for (let n = 0; n < 200; n += 1) workspace.index().paths();
    });

    workspace.stop();
    report();
  });
});
