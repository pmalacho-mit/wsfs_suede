<script lang="ts">
  import Sweater from "sweater-vest-suede/Sweater.svelte";
  import Assistant from "../../../../../release/frontend/svelte/assistant/Assistant.svelte";
  import { Conversation } from "../../../../../release/frontend/svelte/assistant/conversation.svelte";

  const IN_VIEW = ["/notebooks/analysis.py", "/data/readings.csv"];
  /** The same files, as the component wants them: with what goes along. */
  const ATTACHED = IN_VIEW.map((path) => ({ path, executions: 0 }));

  class Pocket {
    readonly conversation = new Conversation();
    attached = $state<{ path: string; executions: number }[]>(ATTACHED);
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

<Sweater
  name="says how many runs go with each attached file"
  body={async ({ set, container, expect, capture, delay }: any) => {
    /**
     * What goes with the question, not just which files. A script that has
     * been run three times carries three runs' output, and the person asking
     * should be able to see that before they send it.
     */
    const pocket = set(new Pocket());
    pocket.attached = [
      { path: "/notebooks/analysis.py", executions: 3 },
      { path: "/data/readings.csv", executions: 0 },
    ];
    await delay({ frames: 2 });

    const badges = [...container.querySelectorAll("[data-path]")];
    expect(badges).toHaveLength(2);
    const said = (element: Element) =>
      element.textContent!.replace(/\s+/g, " ").trim();
    expect(said(badges[0]!)).toContain("3 runs");
    /** Nothing said for a file nobody has run: a zero is noise. */
    expect(said(badges[1]!)).not.toContain("run");
    await capture("png").uri;

    /** And it follows the file, so clearing the output window shows here. */
    pocket.attached = [
      { path: "/notebooks/analysis.py", executions: 0 },
      { path: "/data/readings.csv", executions: 0 },
    ];
    await delay({ frames: 2 });
    expect(
      container.querySelectorAll("[data-region='attached-runs']"),
    ).toHaveLength(0);

    /** One run reads as one run rather than "1 runs". */
    pocket.attached = [{ path: "/notebooks/analysis.py", executions: 1 }];
    await delay({ frames: 2 });
    expect(said(container.querySelector("[data-region='attached-runs']")!)).toContain(
      "1 run",
    );
    await capture("png").uri;
  }}
>
  {#snippet vest(pocket: Pocket)}
    <div class="bg-background h-[28rem] w-full">
      <Assistant conversation={pocket.conversation} attached={pocket.attached} />
    </div>
  {/snippet}
</Sweater>
