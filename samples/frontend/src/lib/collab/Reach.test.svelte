<script lang="ts">
  /**
   * Can a browser under test reach Liveblocks at all?
   *
   * Asked on its own, and first, because everything else in this folder is
   * built on it. The browsers run in their own containers; the host proxies
   * the token mint. A websocket to Liveblocks is the one hop nothing else in
   * this repository has ever needed, so it is the one worth failing loudly and
   * by itself rather than as nine timeouts.
   */
  import { Sweater } from "sweater-vest-suede";
  import { createClient } from "@liveblocks/client";
  import { getYjsProviderForRoom } from "@liveblocks/yjs";

  import { agree, browser, iAm, me } from "./collaboration";

  class Pocket {
    status = $state("(nothing yet)");
    who = $state("");
  }

  const clientAs = (email: string) =>
    createClient({
      authEndpoint: async (room) => {
        const answer = await fetch(
          `/liveblocks/token?rooms=${encodeURIComponent(room ?? "")}`,
          { headers: { "X-User-Email": email } },
        );
        if (!answer.ok) throw new Error(`token: ${answer.status} ${await answer.text()}`);
        return (await answer.json()) as { token: string };
      },
    });

  const connected = (room: ReturnType<ReturnType<typeof createClient>["enterRoom"]>) =>
    new Promise<string>((reached, gaveUp) => {
      const timer = setTimeout(() => gaveUp(new Error("never connected")), 25_000);
      const stop = room.room.subscribe("status", (status) => {
        if (status !== "connected") return;
        clearTimeout(timer);
        stop();
        reached(status);
      });
    });
</script>

<Sweater config category="Collaboration" orientation="vertical" mode="serial" />

<Sweater
  name="mints a room token for this browser's user"
  body={async (harness) => {
    const pocket = harness.set(new Pocket());
    pocket.who = `${browser()} / ${me()} / ${iAm}`;
    const answer = await fetch(`/liveblocks/token?rooms=reach-${me()}`, {
      headers: { "X-User-Email": iAm },
    });
    harness.expect(answer.status).toBe(200);
    const { token } = (await answer.json()) as { token: string };
    harness.expect(token.length).toBeGreaterThan(100);
    pocket.status = "token minted";
  }}
>
  {#snippet vest(pocket: Pocket)}
    <p>{pocket.who}</p>
    <p>{pocket.status}</p>
  {/snippet}
</Sweater>

<Sweater
  name="opens a websocket to a real room"
  body={async (harness) => {
    const pocket = harness.set(new Pocket());
    pocket.who = browser();
    const room = agree("reach", `room-${Date.now()}`);
    const client = clientAs(iAm);
    const entered = client.enterRoom(await room);
    harness.onAbort(() => entered.leave());

    pocket.status = "connecting...";
    pocket.status = await connected(entered);
    harness.expect(pocket.status).toBe("connected");

    /** And the provider both browsers will actually share. */
    const provider = getYjsProviderForRoom(entered.room);
    harness.expect(provider.getYDoc()).toBeTruthy();
  }}
>
  {#snippet vest(pocket: Pocket)}
    <p>{pocket.who}: {pocket.status}</p>
  {/snippet}
</Sweater>
