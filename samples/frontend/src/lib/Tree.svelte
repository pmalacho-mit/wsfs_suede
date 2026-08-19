<script lang="ts">
  import type { IDockviewPanelProps } from "dockview";
  import { Tree } from "wsfs_suede.pierre-trees-svelte-suede";
  import { onDestroy } from "svelte";

  import { mirror } from "$wsfs";
  import type { Open } from "$lib/workspace.svelte";

  type Params = { workspace: Open; onopen: (path: string) => void };

  let { params }: IDockviewPanelProps<Params> = $props();
  const workspace = $derived(params.workspace);
  const onopen = $derived(params.onopen);

  let container = $state<HTMLElement | undefined>(undefined);
  let teardown: Array<() => void> = [];

  // Empty to begin with: `mirror` resets it to the workspace's paths the
  // moment it attaches, and every time they change after that.
  const model = new Tree.Model({ paths: [], renaming: true, dragAndDrop: true });

  /**
   * The tree emits full paths for both halves of a rename, which is already
   * what a move is -- so nothing here has to reassemble one.
   */
  const bridged = {
    reset: (paths: readonly string[]) => model.reset([...paths]),
    subscribe: (handlers: {
      moved?: (event: { from: string; to: string }) => void;
      removed?: (event: { path: string }) => void;
    }) =>
      model.subscribe({
        moved: ({ from, to }) => handlers.moved?.({ from, to }),
        renamed: ({ sourcePath, destinationPath }) =>
          handlers.moved?.({ from: sourcePath, to: destinationPath }),
        removed: ({ path }) => handlers.removed?.({ path }),
      }),
  };

  $effect(() => {
    if (!container) return;
    teardown.push(model.mount(container));
    teardown.push(mirror(workspace.workspace, bridged));
    teardown.push(
      model.subscribe({
        "selection changed": ([path]) => {
          if (path && !Tree.isDirectory(model.item(path))) onopen(path);
        },
      }),
    );
  });

  onDestroy(() => {
    teardown.forEach((stop) => stop());
    model.dispose();
  });
</script>

<div class="tree" bind:this={container}></div>

<style>
  .tree {
    height: 100%;
    overflow: auto;
    padding: 0.35rem 0.25rem;
  }
</style>
