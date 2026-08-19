<script lang="ts" module>
  import { untrack, type Snippet } from "svelte";
  import Cell from "./notebook/Cell.svelte";
  import type { EditableFile } from "./models.svelte";
  import type { Notebook } from "./notebook/models.svelte";
  import { workspace } from "./workspace";
  import { debounce } from "./utils";

  const RESYNC_DELAY_MS = 150;

  const earliestChange = (
    cells: EditableFile[],
    seen: Map<EditableFile, string>,
  ) => cells.find((cell) => seen.get(cell) !== cell.source);

  export type Props = {
    notebook: Notebook;
    size?: number;
    minCellHeight?: number;
    below?: Snippet<[cell: EditableFile, index: number]>;
  };
</script>

<script lang="ts">
  let { notebook, size = 14, minCellHeight = 40, below }: Props = $props();

  const seen = new Map<EditableFile, string>();

  const resyncFrom = debounce(RESYNC_DELAY_MS, async (from: EditableFile) => {
    const { notebooks, client } = workspace;
    await notebooks.resyncAfter(notebook, from, await client);
  });

  $effect(() => workspace.notebooks.add(notebook));

  $effect(() => {
    const changed = earliestChange(notebook.cells, seen);
    notebook.cells.forEach((cell) => seen.set(cell, cell.source));
    if (changed) untrack(() => resyncFrom(changed));
  });
</script>

<div class="notebook">
  {#each notebook.cells as cell, index (cell)}
    <div class="cell">
      <Cell file={cell} {size} minHeight={minCellHeight} />
      {@render below?.(cell, index)}
    </div>
  {/each}
</div>

<style>
  .notebook {
    display: flex;
    flex-direction: column;
    gap: 0.5rem;
    width: 100%;
  }

  .cell {
    border: 1px solid color-mix(in srgb, currentColor 20%, transparent);
    border-radius: 4px;
    overflow: hidden;
  }
</style>
