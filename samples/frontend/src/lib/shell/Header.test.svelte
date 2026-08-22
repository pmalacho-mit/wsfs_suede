<script lang="ts">
  import Sweater from "sweater-vest-suede/Sweater.svelte";
  import Header from "./Header.svelte";

  const WORKSPACE = { title: "Workspace Example", event: "Example", course: "Example" };
</script>

<Sweater config category="Header" />

<Sweater
  name="names the workspace and the course event it belongs to"
  body={async ({ container, expect, capture, delay }) => {
    await delay({ frames: 2 });
    const identity = container.querySelector("[data-region='workspace-identity']");
    expect(identity?.textContent).toContain("Workspace Example");
    expect(identity?.textContent).toContain("Course event Example: Course Example");
    await capture("png").uri;
  }}
>
  {#snippet vest()}
    <div class="bg-background text-foreground h-full w-full">
      <Header {...WORKSPACE} />
    </div>
  {/snippet}
</Sweater>

<!--
  Dark is asked for inside the captured element on purpose: a capture resolves
  the palette against the subtree it copies, so a `.dark` further up the page
  is a class it never sees.
-->
<Sweater
  name="paints from the same tokens in dark"
  body={async ({ capture, delay }) => {
    await delay({ frames: 2 });
    await capture("png").uri;
  }}
>
  {#snippet vest()}
    <div class="dark bg-background text-foreground h-full w-full">
      <Header {...WORKSPACE} />
    </div>
  {/snippet}
</Sweater>
