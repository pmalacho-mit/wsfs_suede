<script lang="ts">
  /**
   * One open file. What it is decides what shows: text goes to the editor,
   * bytes to a preview, and a `.py` file gets a terminal underneath it.
   *
   * The kind comes from the content the workspace actually holds, not from the
   * name -- the name only decides whether the file is worth running.
   */
  import type { IDockviewPanelProps } from "dockview";

  import { Editor } from "wsfs_suede.python-monaco-suede";
  import Preview from "$lib/Preview.svelte";
  import Runner from "$lib/Runner.svelte";
  import type { Workspace } from "$wsfs";
  import type { KernelPool, OpenFile } from "./Workspace.svelte";
  import type { Payload } from "../../../../release/frontend/content";
  import { onMount } from "svelte";

  type Params = {
    opened: OpenFile;
    workspace: Workspace;
    kernelPool: KernelPool;
  };

  let { params }: IDockviewPanelProps<Params> = $props();

  let binary = $state<Extract<Payload, { kind: "binary" }>>();

  const read = () => {
    params.workspace.read(params.opened.path).then((content) => {
      if (!content) return;
      if (content.kind === "text") params.opened.share(content.text);
      else binary = content;
    });
  };

  $effect(() => {
    const {
      opened: { sharedText, id },
      workspace,
    } = params;

    if (sharedText) return; // shared text can't become binary
    return workspace.watch((changes) => {
      if (changes.some(({ kind, entry }) => entry === id && kind === "written"))
        read();
    });
  });

  onMount(read);

  let runnable = $derived(params.opened.path.endsWith(".py"));
</script>

{#if binary}
  <Preview path={params.opened.path} held={binary} />
{:else if params.opened.sharedText}
  <div class="text" class:runnable>
    <!-- `props` is everything the editor was configured with and the file is
         the one thing that differs per panel. Spreading is what makes
         `onEditor` reach anybody -- it was being carried this far and dropped. -->
    <Editor.Component
      {...params.opened.sharedText.props}
      file={params.opened.sharedText.file}
    />
    {#if runnable}
      <Runner
        kernelPool={params.kernelPool}
        shared={params.opened.sharedText}
      />
    {/if}
  </div>
{:else}
  <p class="note">Opening {params.opened.path}…</p>
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
    font:
      0.85rem/1.6 ui-sans-serif,
      system-ui,
      sans-serif;
    color: var(--wsfs-muted, #6b7280);
    padding: 1rem;
  }
</style>
