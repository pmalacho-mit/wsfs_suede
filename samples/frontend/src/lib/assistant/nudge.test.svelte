<script lang="ts">
  import Sweater from "sweater-vest-suede/Sweater.svelte";
  import { Toaster } from "../../../../../release/frontend/svelte/shadcn/ui/sonner";
  import Assistant from "../../../../../release/frontend/svelte/assistant/Assistant.svelte";
  import { Conversation } from ".../../../../../release/frontend/svelte/assistant/conversation.svelte";
  import { Nudge } from "../../../../../release/frontend/svelte/assistant/nudge";

  const IN_VIEW = ["/notebooks/analysis.py"];
  const STUCK = "My last run ended in an error. Can you help?";

  class Pocket {
    readonly conversation = new Conversation();
    readonly nudge = new Nudge();

    /** What the workspace does when a run fails, minus the workspace. */
    offerHelp() {
      this.nudge.offer(() => this.conversation.ask(STUCK, IN_VIEW));
    }
  }

  /** An offer on its way out is still in the document, and does not count. */
  const offered = (container: HTMLElement) =>
    container.querySelector("[data-sonner-toast]:not([data-removed='true'])");

  const takeOffer = (container: HTMLElement) =>
    [...(offered(container)?.querySelectorAll("button") ?? [])].find(
      (button) => button.textContent?.trim() === "Ask the assistant",
    );
</script>

<!--
  Serial, and each test leaves the screen empty. Every toaster on the page
  draws every toast, so two of these running at once would each be looking at
  an offer the other one made.
-->
<Sweater config category="Nudge" mode="serial" />

<Sweater
  name="offers help when a run ends in an error"
  body={async ({ set, container, expect, capture, delay }) => {
    const pocket = set(new Pocket());
    pocket.offerHelp();
    await delay({ seconds: 1 });

    expect(pocket.nudge.offered).toBe(true);
    expect(offered(container)?.textContent).toContain(
      "Looks like you're stuck",
    );

    await capture("png").uri;

    pocket.nudge.withdraw();
    await delay({ seconds: 1 });
  }}
>
  {#snippet vest(pocket: Pocket)}
    {@render stage(pocket)}
  {/snippet}
</Sweater>

<Sweater
  name="taking the offer sends a message to the assistant"
  body={async ({ set, container, expect, capture, delay, withUserFocus }) => {
    const pocket = set(new Pocket());
    pocket.offerHelp();
    await delay({ seconds: 1 });

    const take = takeOffer(container);
    expect(take).toBeDefined();

    await withUserFocus(async (user) => {
      await user.click(take!);
    });
    await delay({ frames: 4 });

    expect(pocket.conversation.turns[0]).toMatchObject({
      from: "user",
      text: STUCK,
    });
    expect(pocket.nudge.offered).toBe(false);

    await delay({ seconds: 2 });
    expect(pocket.conversation.turns).toHaveLength(2);
    expect(pocket.conversation.turns[1].from).toBe("assistant");
    await capture("png").uri;
  }}
>
  {#snippet vest(pocket: Pocket)}
    {@render darkStage(pocket)}
  {/snippet}
</Sweater>

<Sweater
  name="withdraws the offer once the person is typing again"
  body={async ({ set, container, expect, delay }) => {
    const pocket = set(new Pocket());
    pocket.offerHelp();
    await delay({ seconds: 1 });
    expect(offered(container)).not.toBeNull();

    pocket.nudge.withdraw();
    await delay({ seconds: 2 });

    expect(pocket.nudge.offered).toBe(false);
    expect(offered(container)).toBeNull();
  }}
>
  {#snippet vest(pocket: Pocket)}
    {@render stage(pocket)}
  {/snippet}
</Sweater>

{#snippet stage(pocket: Pocket)}
  {@render lit(pocket, "")}
{/snippet}

<!--
  Dark is asked for inside the captured element on purpose: a capture resolves
  the palette against the subtree it copies, so a `.dark` further up the page
  is a class it never sees.
-->
{#snippet darkStage(pocket: Pocket)}
  {@render lit(pocket, "dark")}
{/snippet}

{#snippet lit(pocket: Pocket, mode: string)}
  <div
    class="bg-background text-foreground relative h-full w-full overflow-hidden {mode}"
    data-region="toast-stage"
  >
    <Toaster position="top-center" richColors closeButton />
    <Assistant conversation={pocket.conversation} attached={IN_VIEW} />
  </div>
{/snippet}

<style>
  /* A toaster is fixed to the viewport, and a capture only sees the vest.
     Pinning it to this stage is what puts the offer in the picture. */
  :global([data-region="toast-stage"] [data-sonner-toaster]) {
    position: absolute;
  }
</style>
