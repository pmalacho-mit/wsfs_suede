import { describe, expect, it, vi } from "vitest";

import { run } from "../../release/frontend/loop";

const settled = () => new Promise<void>((done) => setTimeout(done, 0));

describe("the sync loop", () => {
  it("re-enters at Initialize whenever a stream ends", async () => {
    const reconcile = vi.fn(async () => "token");
    let endStream: () => void = () => {};
    const loop = run(
      {
        reconcile,
        follow: () => new Promise<void>((ended) => (endStream = ended)),
      },
      { watchdogMs: 10_000, minBackoffMs: 0, maxBackoffMs: 0 },
    );

    await settled();
    expect(reconcile).toHaveBeenCalledTimes(1);

    endStream();
    await settled();
    await settled();
    expect(reconcile.mock.calls.length).toBeGreaterThan(1);

    loop.stop();
  });

  it("treats a silent stream as a failed one", async () => {
    const reconcile = vi.fn(async () => "token");
    const loop = run(
      { reconcile, follow: () => new Promise<void>(() => {}) },
      { watchdogMs: 5, minBackoffMs: 0, maxBackoffMs: 0 },
    );

    await new Promise((done) => setTimeout(done, 60));
    loop.stop();

    // A stream nothing ever arrives on is indistinguishable from no stream,
    // which is the failure the watchdog exists for.
    expect(reconcile.mock.calls.length).toBeGreaterThan(1);
  });

  it("stays alive while traffic keeps arriving", async () => {
    const reconcile = vi.fn(async () => "token");
    const loop = run(
      {
        reconcile,
        follow: (_token, alive) =>
          new Promise<void>(() => {
            const beat = setInterval(alive, 5);
            setTimeout(() => clearInterval(beat), 200);
          }),
      },
      { watchdogMs: 40, minBackoffMs: 0, maxBackoffMs: 0 },
    );

    await new Promise((done) => setTimeout(done, 100));
    loop.stop();

    expect(reconcile).toHaveBeenCalledTimes(1);
  });

  it("reports a failure instead of stopping over it", async () => {
    const failed = vi.fn();
    let attempts = 0;
    const loop = run(
      {
        reconcile: async () => {
          attempts += 1;
          if (attempts === 1) throw new Error("offline");
          return "token";
        },
        follow: () => new Promise<void>(() => {}),
        failed,
      },
      { watchdogMs: 10_000, minBackoffMs: 0, maxBackoffMs: 0 },
    );

    await new Promise((done) => setTimeout(done, 30));
    loop.stop();

    expect(failed).toHaveBeenCalledOnce();
    expect(attempts).toBeGreaterThan(1);
  });
});
