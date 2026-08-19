<script lang="ts">
  import type { IDockviewPanelProps } from "dockview";

  import FileTree from "$lib/FileTree.svelte";
  import type { Open } from "$lib/workspace.svelte";

  type Params = { workspace: Open; onopen: (path: string) => void };

  // Nothing but the panel seam. The tree itself takes a workspace and a
  // callback, so it can be rendered by anything -- a test, most of all.
  let { params }: IDockviewPanelProps<Params> = $props();
</script>

<FileTree workspace={params.workspace} onopen={params.onopen} />
