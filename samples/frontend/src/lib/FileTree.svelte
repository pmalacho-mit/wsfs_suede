<script lang="ts">
  import { ContextMenu, Tree } from "wsfs_suede.pierre-trees-svelte-suede";
  import { onDestroy } from "svelte";

  import { mirror } from "$wsfs";
  import type { Open } from "$lib/workspace.svelte";

  type Props = { workspace: Open; onopen: (path: string) => void };

  let { workspace, onopen }: Props = $props();

  // Empty to begin with: `mirror` resets it to the workspace's paths the
  // moment it attaches, and every time their shape changes after that.
  const model = new Tree.Model({
    paths: [],
    renaming: true,
    dragAndDrop: true,
  });

  /**
   * The tree speaks in gestures and the workspace in transactions. Add,
   * rename, drag and delete all arrive here as full paths, which is already
   * the workspace's vocabulary -- so nothing has to be reassembled, and a
   * rename and a drag are the same event because they are the same change.
   */
  const bridged = {
    reset: (paths: readonly string[]) => model.reset([...paths]),
    subscribe: (handlers: {
      added?: (event: { path: string }) => void;
      moved?: (event: { from: string; to: string }) => void;
      removed?: (event: { path: string }) => void;
    }) =>
      model.subscribe({
        added: ({ path }) => handlers.added?.({ path }),
        moved: ({ from, to }) => handlers.moved?.({ from, to }),
        renamed: ({ sourcePath, destinationPath }) =>
          handlers.moved?.({ from: sourcePath, to: destinationPath }),
        removed: ({ path }) => handlers.removed?.({ path }),
      }),
  };

  $effect(() => {
    const stop = [
      mirror(workspace.workspace, bridged),
      model.subscribe({
        "selection changed": ([path]) => {
          if (path && !Tree.isDirectory(model.item(path))) onopen(path);
        },
      }),
    ];
    return () => stop.forEach((end) => end());
  });

  onDestroy(() => model.dispose());
</script>

<div class="tree">
  <Tree.Component {model}>
    {#snippet contextMenu(item, context)}
      <ContextMenu.Component
        {context}
        actions={ContextMenu.actions({ model, item, context })}
      />
    {/snippet}
  </Tree.Component>
</div>

<style>
  .tree {
    height: 100%;
    overflow: auto;
    padding: 0.35rem 0.25rem;
  }
</style>
