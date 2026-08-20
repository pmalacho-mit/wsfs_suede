<script lang="ts">
  import {
    DockView,
    GridView,
    Orientation,
    type PanelProps,
    themes,
    type ViewAPI,
  } from "wsfs_suede.dockview-svelte-suede";
  import "wsfs_suede.dockview-svelte-suede/styles/dockview.css";
  import { LayoutPriority } from "dockview";
  import FileTree, { Model as FileTreeModel } from "$lib/FileTree.svelte";
  import { appearance } from "$lib/appearance.svelte";
  import { nameOf } from "$lib/paths";
  import type { Open } from "$lib/workspace.svelte";
  import FileView from "./FileView.svelte";
  import { onDestroy } from "svelte";

  let { workspace }: { workspace: Open } = $props();

  const chrome = $derived(themes[appearance.theme].className);

  const snippets = { explorer, dock, assistant };
  const tabs = { file: FileView };
  type Grid = ViewAPI<"grid", typeof snippets>;

  const cleanup = Object.assign(
    () => {
      for (const fn of cleanup.set) fn();
      cleanup.set.clear();
    },
    {
      set: new Set<() => void>(),
      add: (fn: () => void) => cleanup.set.add(fn),
    },
  );

  const onAPI = async (api: Grid) => {
    cleanup();

    const tree = new FileTreeModel(workspace.workspace);

    type TabsAPI = ViewAPI<"dock", typeof tabs>;
    let tabsAPI: TabsAPI | undefined = undefined;

    const dock = await api.addSnippetPanel(
      "dock",
      { onready: (api) => (tabsAPI = api) },
      {
        priority: LayoutPriority.High,
      },
    );

    const [explorer, assistant] = await Promise.all([
      api.addSnippetPanel(
        "explorer",
        { model: tree },
        {
          size: 260,
          minimumWidth: 170,
          maximumWidth: 520,
          position: { direction: "left", referencePanel: dock.reference },
        },
      ),
      api.addSnippetPanel(
        "assistant",
        {},
        {
          size: 340,
          minimumWidth: 200,
          maximumWidth: 640,
          position: { direction: "right", referencePanel: dock.reference },
        },
      ),
    ]);

    if (tabsAPI === undefined)
      throw new Error("Tabs API did not initialize in time");

    const tab = (idOrEntry: FileTreeModel.Entry | FileTreeModel.Entry["id"]) =>
      tabsAPI!.getPanel(
        typeof idOrEntry === "string" ? idOrEntry : idOrEntry.id,
      );

    cleanup.add(
      tree.subscribe({
        open: async ({ id, path }) => {
          const panel = tab(id);
          if (panel) return panel.api.setActive();
          const title = nameOf(path);
          await tabsAPI!.addComponentPanel(
            "file",
            { path, workspace },
            { id, title },
          );
        },
        renamed: ({ id, path }) => {
          const panel = tab(id);
          if (panel === undefined) return;
          panel.api.updateParameters({ workspace, path });
          panel.api.setTitle(nameOf(path));
        },
        removed: (entry) => tab(entry)?.api.close(),
      }),
    );
  };

  onDestroy(cleanup);
</script>

{#snippet explorer({
  params: { model },
}: PanelProps<"grid", { model: FileTreeModel }>)}
  <section class="explorer" data-region="explorer">
    <h2>Explorer</h2>
    <FileTree {model} />
  </section>
{/snippet}

{#snippet dock({
  params: { onready },
}: PanelProps<
  "grid",
  { onready: (api: ViewAPI<"dock", typeof tabs>) => void }
>)}
  <div class="documents" data-region="documents">
    <DockView
      theme={appearance.theme}
      components={tabs}
      onReady={({ api }) => onready(api)}
    />
  </div>
{/snippet}

{#snippet assistant({}: PanelProps<"grid", {}>)}
  <section class="assistant" data-region="assistant">
    <h2>AI Chat</h2>
    <p>Nothing here yet.</p>
  </section>
{/snippet}

<div class="shell {chrome}" data-region="shell">
  <GridView
    {snippets}
    orientation={Orientation.HORIZONTAL}
    proportionalLayout={false}
    onReady={({ api }) => onAPI(api)}
  />
</div>

<style>
  .shell {
    height: 100%;
    width: 100%;
    min-height: 0;
    background: var(--wsfs-ground, #f7f7f9);
  }

  :global(:root) {
    --wsfs-ground: #f7f7f9;
    --wsfs-raised: #ffffff;
    --wsfs-sunken: #fbfbfd;
    --wsfs-line: #e5e7eb;
    --wsfs-muted: #6b7280;
  }

  @media (prefers-color-scheme: dark) {
    :global(:root:not([data-theme="light"])) {
      --wsfs-ground: #131316;
      --wsfs-raised: #1a1a1f;
      --wsfs-sunken: #17171b;
      --wsfs-line: #2a2a31;
      --wsfs-muted: #9ca3af;
    }
  }

  .explorer {
    display: grid;
    grid-template-rows: auto minmax(0, 1fr);
    height: 100%;
    min-height: 0;
    background: var(--wsfs-sunken, #fbfbfd);
    border-right: 1px solid var(--wsfs-line, #e5e7eb);
  }

  .explorer h2 {
    margin: 0;
    padding: 0.6rem 0.75rem 0.5rem;
    font:
      600 0.68rem/1 ui-sans-serif,
      system-ui,
      sans-serif;
    letter-spacing: 0.08em;
    text-transform: uppercase;
    color: var(--wsfs-muted, #6b7280);
  }

  .documents {
    height: 100%;
    width: 100%;
    min-width: 0;
    min-height: 0;
  }

  .assistant {
    display: grid;
    grid-template-rows: auto minmax(0, 1fr);
    height: 100%;
    min-height: 0;
    background: var(--wsfs-sunken, #fbfbfd);
    border-left: 1px solid var(--wsfs-line, #e5e7eb);
  }

  .assistant h2 {
    margin: 0;
    padding: 0.6rem 0.75rem 0.5rem;
    font:
      600 0.68rem/1 ui-sans-serif,
      system-ui,
      sans-serif;
    letter-spacing: 0.08em;
    text-transform: uppercase;
    color: var(--wsfs-muted, #6b7280);
  }

  .assistant p {
    margin: 0;
    padding: 0.75rem;
    font:
      0.85rem/1.6 ui-sans-serif,
      system-ui,
      sans-serif;
    color: var(--wsfs-muted, #6b7280);
  }
</style>
