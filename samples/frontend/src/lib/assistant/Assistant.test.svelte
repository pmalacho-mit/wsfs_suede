<script lang="ts">
  import Sweater from "sweater-vest-suede/Sweater.svelte";
  import Assistant from "../../../../../release/frontend/svelte/assistant/Assistant.svelte";
  import { Conversation } from "../../../../../release/frontend/svelte/assistant/conversation.svelte";

  const IN_VIEW = ["/notebooks/analysis.py", "/data/readings.csv"];

  class Pocket {
    readonly conversation = new Conversation();
    attached = $state<string[]>(IN_VIEW);
  }
</script>

<!-- Side by side, so each panel is a column the width of a real sidebar. -->
<Sweater config category="Assistant" />

<Sweater
  name="names the files a question would carry"
  body={async ({ set, container, expect, capture, delay }) => {
    const pocket = set(new Pocket());
    await delay({ frames: 2 });

    const attached = () =>
      container.querySelector("[data-region='attached-files']");
    expect(attached()?.textContent).toContain("analysis.py");
    expect(attached()?.textContent).toContain("readings.csv");
    expect(
      container.querySelectorAll("[data-region='attached-files'] [data-path]"),
    ).toHaveLength(2);
    // Awaited, because the next line changes what a later read would find.
    await capture("png").uri;

    pocket.attached = [];
    await delay({ frames: 2 });
    expect(
      container.querySelector("[data-region='attached-none']"),
    ).not.toBeNull();
  }}
>
  {#snippet vest(pocket: Pocket)}
    {@render panel(pocket)}
  {/snippet}
</Sweater>

<Sweater
  name="a sent question keeps the files that were in view"
  body={async ({ set, container, expect, capture, delay, withUserFocus }) => {
    const pocket = set(new Pocket());
    await delay({ frames: 2 });
    const box = container.querySelector("textarea");
    expect(box).not.toBeNull();

    await withUserFocus(async (user) => {
      await user.click(box!);
      await user.type(box!, "Why is this slow?");
    });
    capture("png");

    await withUserFocus(async (user) => {
      await user.type(box!, "{Enter}");
    });
    await delay({ frames: 4 });

    expect(pocket.conversation.turns[0]).toMatchObject({
      from: "user",
      text: "Why is this slow?",
      sent: IN_VIEW,
    });

    await delay({ seconds: 2 });
    expect(pocket.conversation.turns).toHaveLength(2);
    expect(pocket.conversation.turns[1].from).toBe("assistant");
    expect(pocket.conversation.status).toBe("ready");
    capture("png");
  }}
>
  {#snippet vest(pocket: Pocket)}
    {@render panel(pocket)}
  {/snippet}
</Sweater>

<Sweater
  name="a suggestion asks the same way typing does"
  body={async ({ set, container, expect, delay, withUserFocus }) => {
    const pocket = set(new Pocket());
    await delay({ frames: 2 });
    const suggestion = container.querySelector("button");
    await withUserFocus(async (user) => {
      await user.click(suggestion!);
    });
    await delay({ seconds: 2 });
    expect(pocket.conversation.turns[0].sent).toEqual(IN_VIEW);
  }}
>
  {#snippet vest(pocket: Pocket)}
    {@render panel(pocket)}
  {/snippet}
</Sweater>

<!--
  Dark is asked for inside the captured element on purpose: a capture resolves
  the palette against the subtree it copies, so a `.dark` further up the page
  is a class it never sees.
-->
<Sweater
  name="paints from the same tokens in dark"
  body={async ({ set, capture, delay }) => {
    const pocket = set(new Pocket());
    pocket.conversation.ask("What does this file do?", IN_VIEW);
    await delay({ seconds: 2 });
    await capture("png").uri;
  }}
>
  {#snippet vest(pocket: Pocket)}
    <div class="dark bg-background text-foreground h-full w-full">
      <Assistant
        conversation={pocket.conversation}
        attached={pocket.attached}
      />
    </div>
  {/snippet}
</Sweater>

{#snippet panel(pocket: Pocket)}
  <div class="bg-background h-full w-full">
    <Assistant conversation={pocket.conversation} attached={pocket.attached} />
  </div>
{/snippet}
