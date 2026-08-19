<script lang="ts">
  /**
   * One open file. What it is decides what shows: text goes to the editor,
   * bytes to a preview, and a `.py` file gets a terminal underneath it.
   *
   * The kind comes from the content the workspace actually holds, not from the
   * name -- the name only decides whether the file is worth running.
   */
  import type { IDockviewPanelProps } from "dockview";

  import Editor from "$lib/Editor.svelte";
  import Preview from "$lib/Preview.svelte";
  import Runner from "$lib/Runner.svelte";
  import type { Held } from "$wsfs";
  import type { Open } from "$lib/workspace.svelte";

  type Params = { workspace: Open; path: string };

  let { params }: IDockviewPanelProps<Params> = $props();
  const workspace = $derived(params.workspace);
  const path = $derived(params.path);

  let held = $state<Held | undefined>(undefined);
  let missing = $state(false);

  const runnable = $derived(path.endsWith(".py"));

  $effect(() => {
    let current = true;
    void workspace.workspace
      .read(path)
      .then((content) => current && ((held = content), (missing = content === undefined)))
      .catch(() => current && (missing = true));
    return () => (current = false);
  });
</script>

{#if missing}
  <p class="note">No such file: {path}</p>
{:else if !held}
  <p class="note">Opening {path}…</p>
{:else if held.kind === "binary"}
  <Preview {path} {held} />
{:else}
  <div class="text" class:runnable>
    <Editor {workspace} {path} />
    {#if runnable}
      <Runner {workspace} {path} />
    {/if}
  </div>
{/if}

<style>
  .text {
    display: grid;
    grid-template-rows: 1fr;
    height: 100%;
    min-height: 0;
  }
  .text.runnable {
    grid-template-rows: 1fr minmax(7rem, 30%);
  }
  .note {
    font: 0.85rem/1.6 ui-sans-serif, system-ui, sans-serif;
    color: var(--wsfs-muted, #6b7280);
    padding: 1rem;
  }
</style>
