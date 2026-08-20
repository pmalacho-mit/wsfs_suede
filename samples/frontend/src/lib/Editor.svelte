<script lang="ts">
  /**
   * The editor for one open text file.
   *
   * Monaco is bound to the shared type itself rather than to a copy of its
   * text, so two people typing merge instead of overwriting. The workspace
   * flushes that document on a debounce, and anything reading the file
   * meanwhile -- the kernel included -- is answered by it rather than by the
   * last write that landed.
   */
  import { Editor } from "wsfs_suede.python-monaco-suede";
  import type { MonacoBinding } from "y-monaco";

  import type { Buffer } from "$lib/documents";
  import { holderOf, nameOf } from "$lib/paths";
  import type { Open } from "$lib/workspace.svelte";

  let { workspace, path }: { workspace: Open; path: string } = $props();

  type Shared = ConstructorParameters<typeof MonacoBinding>[0];

  let file = $state<Editor.Model | undefined>(undefined);

  $effect(() => {
    let current = true;
    void workspace.edit(path).then((document: Buffer) => {
      if (!current) return;
      file = new Editor.Model({
        name: nameOf(path),
        parent: { path: holderOf(path) },
        source: document.text(),
        sourceSync: document.shared as Shared | undefined,
      });
    });
    return () => {
      current = false;
      void workspace.close(path);
    };
  });
</script>

<div class="editor">
  {#if file}
    <Editor.Component {file} />
  {:else}
    <p class="note">Loading {path}…</p>
  {/if}
</div>

<style>
  .editor {
    min-height: 0;
    height: 100%;
  }
  .note {
    font: 0.85rem/1.6 ui-sans-serif, system-ui, sans-serif;
    color: var(--wsfs-muted, #6b7280);
    padding: 1rem;
  }
</style>
