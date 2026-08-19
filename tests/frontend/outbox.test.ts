import { describe, expect, it } from "vitest";

import { inMemory } from "../../release/frontend";
import { mint } from "../../release/frontend/identity";
import { presented, queue } from "../../release/frontend/outbox";
import type { Write } from "../../release/frontend/contract";

const writing = (entry: string, content: string, token: string): Write => ({
  op: "write",
  transaction: mint(),
  id: entry,
  content_version: token,
  content: { type: "text", content },
});

describe("the outbox", () => {
  it("keeps one item per entry however many times it is written", async () => {
    const items = queue(inMemory());
    const entry = mint();
    const first = writing(entry, "one", "v0");

    items.capture(first);
    for (const text of ["two", "three", "four"]) {
      items.capture(writing(entry, text, "unseen-by-the-server"));
    }

    expect(items.size()).toBe(1);
  });

  it("keeps the survivor's content and the dropped item's token", async () => {
    const items = queue(inMemory());
    const entry = mint();

    items.capture(writing(entry, "first", "the-token-the-server-knows"));
    items.capture(writing(entry, "second", "a-token-only-this-client-has-seen"));

    const [survivor] = items.entries();
    const request = survivor!.request as Write;
    expect(request.content).toEqual({ type: "text", content: "second" });
    expect(request.content_version).toBe("the-token-the-server-knows");
  });

  it("does not coalesce writes to different entries", async () => {
    const items = queue(inMemory());
    items.capture(writing(mint(), "a", "v0"));
    items.capture(writing(mint(), "b", "v0"));
    expect(items.size()).toBe(2);
  });

  it("releases the bytes an evicted item was holding", async () => {
    const bytes = inMemory();
    const items = queue(bytes);
    const request = writing(mint(), "payload", "v0");
    const digest = await bytes.put("payload");

    items.capture(request, digest);
    const released = items.evict([request.transaction]);

    expect(released).toEqual([digest]);
    expect(items.size()).toBe(0);
  });

  it("presents what it holds in the order it was queued", () => {
    const items = queue(inMemory());
    const requests = [mint(), mint(), mint()].map((id) => writing(id, "x", "v0"));
    requests.forEach((request) => items.capture(request));

    expect(presented(items.entries()).map((r) => r.transaction)).toEqual(
      requests.map((r) => r.transaction),
    );
  });
});
